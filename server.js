// server.js
import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ---------- helpers ----------
function mustEnv() {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY env var on Render.");
  }
}

function safeText(v) {
  if (typeof v !== "string") return "";
  return v.trim();
}

function toInt(v, fallback = null) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return n;
  return Math.max(min, Math.min(max, n));
}

// Normalize profile to support multiple client payload shapes
function normalizeProfile(p = {}) {
  // Preferred: ageYears + ageMonths
  // Accept snake_case: age_years + age_months
  // Backward-compatible: age (years only)
  const ageYears = p.ageYears ?? p.age_years ?? p.age ?? null;
  const ageMonths = p.ageMonths ?? p.age_months ?? null;

  return {
    petName: safeText(p.petName),
    species: safeText(p.species),
    breed: safeText(p.breed),
    petGender: safeText(p.petGender),
    ageYears: clamp(toInt(ageYears, null), 0, 50),
    ageMonths: clamp(toInt(ageMonths, null), 0, 11),
    weightLb: p.weightLb ?? p.weight_lb ?? "Unknown",
    city: safeText(p.city),
    country: safeText(p.country),
  };
}

function formatPetAge(yearsRaw, monthsRaw) {
  const years = yearsRaw === null ? null : clamp(toInt(yearsRaw, 0), 0, 50);
  const months = monthsRaw === null ? null : clamp(toInt(monthsRaw, 0), 0, 11);

  // If both missing -> Unknown
  if (years === null && months === null) return "Unknown";

  const y = years ?? 0;
  const m = months ?? 0;

  // Prefer month-only display if < 1 year
  if (y === 0 && m > 0) return `${m} month${m === 1 ? "" : "s"}`;
  if (y > 0 && m === 0) return `${y} year${y === 1 ? "" : "s"}`;
  if (y === 0 && m === 0) return "0 months";
  return `${y} year${y === 1 ? "" : "s"} ${m} month${m === 1 ? "" : "s"}`;
}

function profileBlock(p = {}) {
  const prof = normalizeProfile(p);

  return [
    `Pet name: ${prof.petName || "Unknown"}`,
    `Species: ${prof.species || "Unknown"}`,
    `Breed: ${prof.breed || "Unknown"}`,
    `Sex: ${prof.petGender || "Unknown"}`,
    `Age: ${formatPetAge(prof.ageYears, prof.ageMonths)}`,
    `Weight (lb): ${prof.weightLb ?? "Unknown"}`,
    `Location: ${prof.city || "Unknown"}, ${prof.country || "Unknown"}`,
  ].join("\n");
}

/**
 * OpenAI Responses API helper (JSON Schema)
 * NOTE: OpenAI changed `response_format` -> `text.format`
 */
async function openaiJson({ schemaName, schema, system, user, model = "gpt-4.1-mini" }) {
  mustEnv();

  const body = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        schema,
        strict: true,
      },
    },
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 800)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Could not parse OpenAI response JSON envelope: ${e}`);
  }

  const outputText = json?.output_text || json?.output?.[0]?.content?.[0]?.text || "";
  if (!outputText || typeof outputText !== "string") {
    throw new Error("OpenAI returned empty structured output.");
  }

  try {
    return JSON.parse(outputText);
  } catch (e) {
    throw new Error(`Could not parse structured JSON result: ${e}. Raw: ${outputText.slice(0, 600)}`);
  }
}

/**
 * OpenAI Responses API helper (JSON Object)
 * Use this for Step 3 because strict json_schema now enforces
 * "required must include every key in properties", which breaks conditional schemas.
 */
async function openaiJsonObject({ system, user, model = "gpt-4.1-mini" }) {
  mustEnv();

  const body = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    text: {
      format: { type: "json_object" },
    },
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 800)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Could not parse OpenAI response JSON envelope: ${e}`);
  }

  const outputText = json?.output_text || json?.output?.[0]?.content?.[0]?.text || "";
  if (!outputText || typeof outputText !== "string") {
    throw new Error("OpenAI returned empty JSON output.");
  }

  try {
    return JSON.parse(outputText);
  } catch (e) {
    throw new Error(`Could not parse JSON result: ${e}. Raw: ${outputText.slice(0, 600)}`);
  }
}

// ---------- constants ----------
const STEP1_LEVELS = ["NHE", "TRUNGBINH", "KHA_NANG", "NANG", "KHAN_CAP"]; // for badges in Step 1

// ---------- routes ----------
app.get("/health", (req, res) => res.status(200).send("ok"));

/**
 * STEP 1
 * POST /tips
 * body: { profile, symptoms, weather? }
 * returns: { title, intro, issues:[...], disclaimer }
 */
app.post("/tips", async (req, res) => {
  try {
    const { profile, symptoms, weather } = req.body || {};
    const notes = safeText(symptoms);
    if (!notes) return res.status(400).json({ error: "Missing symptoms" });

    const system = `
You are a calm, friendly veterinary assistant.
You do NOT diagnose. You avoid certainty.
Use cautious language: may / could / possible / consistent with.
Your goal is to reduce anxiety and help the owner decide next steps.
Never use alarming tone unless describing clear red flags, and still stay calm.
    `.trim();

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["title", "intro", "issues", "disclaimer"],
      properties: {
        title: { type: "string" },
        intro: { type: "string" },
        disclaimer: { type: "string" },
        issues: {
          type: "array",
          minItems: 3,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title", "rank", "level", "why", "do_today", "watch"],
            properties: {
              id: { type: "string" },
              title: { type: "string" }, // must include "(possible)"
              rank: { type: "integer", minimum: 1, maximum: 5 },
              level: { type: "string", enum: STEP1_LEVELS },
              why: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
              do_today: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
              watch: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
            },
          },
        },
      },
    };

    const user = `
PET PROFILE
${profileBlock(profile)}

WEATHER (optional)
${safeText(weather) || "Unavailable (MVP)"}

OWNER NOTES
${notes}

TASK
Return 3–5 DISTINCT POSSIBLE issues (not diagnoses). Keep it grounded in the notes.

ORDERING + RANKING
- Sort issues from MOST LIKELY to LEAST LIKELY based on the notes.
- Assign rank=1 to the most likely issue, then 2, 3... up to N (N <= 5).
- rank must be unique and sequential (no gaps).

OUTPUT RULES
- Issue title MUST contain "(possible)".
- Provide a "level" badge per issue (this is NOT an action, just concern level):
  NHE = mild concern
  TRUNGBINH = moderate
  KHA_NANG = somewhat concerning
  NANG = severe concern
  KHAN_CAP = urgent concern (still cautious wording)
- Avoid absolute language. Use "may/could/possible/consistent with".
- Keep bullets short and practical.

Also return:
- title (one line)
- intro (one line)
- disclaimer (one calm paragraph)
    `.trim();

    const data = await openaiJson({
      schemaName: "petpulse_step1_triage_v3_ranked",
      schema,
      system,
      user,
    });

    if (data?.issues && Array.isArray(data.issues)) {
      data.issues.sort((a, b) => (Number(a.rank) || 999) - (Number(b.rank) || 999));
      data.issues = data.issues.map((it, idx) => ({ ...it, rank: idx + 1 }));
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * STEP 2 (Round 1 confirm)
 * POST /confirm
 * body: { profile, symptoms, selected_issue_id, selected_issue_title, weather? }
 * returns: { selected_issue_title, questions:[...] }
 */
app.post("/confirm", async (req, res) => {
  try {
    const { profile, symptoms, selected_issue_id, selected_issue_title, weather } = req.body || {};
    const notes = safeText(symptoms);
    const issueTitle = safeText(selected_issue_title);
    const issueId = safeText(selected_issue_id);

    if (!notes) return res.status(400).json({ error: "Missing symptoms" });
    if (!issueTitle && !issueId) return res.status(400).json({ error: "Missing selected issue" });

    const system = `
You are a calm veterinary assistant.
Ask only the minimum necessary follow-up questions to reduce uncertainty.
No diagnosis. Avoid certainty. Avoid alarming tone.
Questions must be short and easy to answer.
    `.trim();

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["selected_issue_title", "questions"],
      properties: {
        selected_issue_title: { type: "string" },
        questions: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "text", "type", "options"],
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              type: { type: "string", enum: ["single_choice", "yes_no", "short_text"] },
              options: { type: "array", minItems: 0, maxItems: 6, items: { type: "string" } },
            },
          },
        },
      },
    };

    const user = `
PET PROFILE
${profileBlock(profile)}

WEATHER (optional)
${safeText(weather) || "Unavailable (MVP)"}

OWNER NOTES
${notes}

SELECTED POSSIBLE ISSUE
${issueTitle || issueId}

TASK
Ask 2–4 contextual follow-up questions to determine urgency and what to do next.

PRIORITY TOPICS (choose only what’s needed)
- Timeline & frequency (when started, how often)
- Hydration & ability to keep water down
- Diarrhea / blood in vomit or stool
- Possible toxin/foreign object exposure (chocolate, meds, plants, toy, bones, trash)
- Ability to stand/walk normally, severe lethargy

OUTPUT RULES
- Prefer yes/no or single-choice when possible.
- Avoid medical jargon.
- Avoid certainty in phrasing.
    `.trim();

    const data = await openaiJson({
      schemaName: "petpulse_step2_questions_v2",
      schema,
      system,
      user,
    });

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * STEP 3 (Decision engine)
 * POST /plan
 * returns either PLAN or NEED_MORE_INFO (max 2 rounds total)
 */
app.post("/plan", async (req, res) => {
  try {
    const {
      profile,
      symptoms,
      selected_issue_title,
      followup_answers,
      weather,
      round,
      previous_questions,
      previous_answers,
    } = req.body || {};

    const notes = safeText(symptoms);
    const issueTitle = safeText(selected_issue_title);
    const r = Number(round || 1);

    if (!notes) return res.status(400).json({ error: "Missing symptoms" });
    if (!issueTitle) return res.status(400).json({ error: "Missing selected_issue_title" });
    if (![1, 2].includes(r)) return res.status(400).json({ error: "round must be 1 or 2" });

    const system = `
You are a calm veterinary assistant.
No diagnosis. No certainty. Decision support only.
Be reassuring, practical, and clear.
If information is insufficient, you may ask a few additional questions — but only if truly necessary.
    `.trim();

    const user = `
PET PROFILE
${profileBlock(profile)}

WEATHER (optional)
${safeText(weather) || "Unavailable (MVP)"}

OWNER NOTES
${notes}

SELECTED POSSIBLE ISSUE
${issueTitle}

CONTEXT
- This is follow-up round: ${r} (max 2 rounds total)
- Previous questions (optional):
${JSON.stringify(previous_questions || [], null, 2)}
- Previous answers (optional):
${JSON.stringify(previous_answers || {}, null, 2)}

CURRENT FOLLOW-UP ANSWERS (owner responses)
${JSON.stringify(followup_answers || {}, null, 2)}

TASK
You have two options:

OPTION A — Return a clear action recommendation (result_type="PLAN") with ONE urgency bucket:
- HOME
- MONITOR_24H
- VET_NOW

OPTION B — If and only if information is still insufficient to choose urgency safely,
ask 2–3 more questions (result_type="NEED_MORE_INFO") to reduce uncertainty.
Only use this option if truly necessary.

STRICT RULES
- No diagnosis. No certainty. Use cautious language.
- If round=2, you MUST return PLAN (do NOT ask more questions).
- Keep plan practical and calm.
- Red flags should be specific but not alarming.
- Avoid giving medication instructions. Avoid overly specific home treatment recipes.

OUTPUT FORMAT (VERY IMPORTANT)
- Return ONLY valid JSON (no markdown, no extra text).
- If result_type="PLAN", include keys:
  result_type, urgency, headline, why, do_now, avoid, red_flags, disclaimer
- If result_type="NEED_MORE_INFO", include keys:
  result_type, selected_issue_title, reason, questions
- questions items must include: id, text, type, options
    `.trim();

    // ✅ Use json_object for Step 3 to avoid strict json_schema enforcement changes
    const data = await openaiJsonObject({
      system,
      user,
    });

    // ✅ Server-side validation by result_type (since Step 3 is json_object)
    const hasAll = (obj, keys) => keys.every((k) => obj?.[k] !== undefined && obj?.[k] !== null);

    const planRequired = ["urgency", "headline", "why", "do_now", "avoid", "red_flags", "disclaimer"];
    const needMoreRequired = ["selected_issue_title", "questions", "reason"];

    // round=2 hard rule: must be PLAN (your original safety net stays)
    if (r === 2 && data?.result_type !== "PLAN") {
      return res.status(200).json({
        result_type: "PLAN",
        urgency: "MONITOR_24H",
        headline: "Monitor closely and consider contacting a vet if things don’t improve",
        why: [
          "Based on the information provided, this could still be a mild, self-limiting issue.",
          "Because some details remain unclear, it’s safest to reassess within 24 hours or sooner if red flags appear.",
        ],
        do_now: [
          "Offer small amounts of water frequently and observe whether your pet keeps it down.",
          "Keep activity low and provide a quiet place to rest.",
          "Track vomiting frequency, energy level, appetite, and stool changes.",
        ],
        avoid: [
          "Avoid giving human medications unless a veterinarian specifically instructs you.",
          "Avoid forcing food or water if your pet refuses or vomits after drinking.",
        ],
        red_flags: [
          "Repeated vomiting or inability to keep water down",
          "Blood in vomit or stool",
          "Severe lethargy, collapse, or signs of significant pain",
          "Bloated abdomen or repeated retching with little coming up",
        ],
        disclaimer:
          "This is not a diagnosis. If you notice any red flags or your pet worsens at any time, contact a veterinarian promptly.",
      });
    }

    // If model says PLAN but misses required fields → fallback safe PLAN
    if (data?.result_type === "PLAN" && !hasAll(data, planRequired)) {
      return res.status(200).json({
        result_type: "PLAN",
        urgency: data?.urgency || "MONITOR_24H",
        headline: data?.headline || "Here’s a calm, practical next-step plan",
        why: Array.isArray(data?.why) && data.why.length ? data.why : [
          "Based on the information provided, this may be consistent with a mild issue.",
          "It’s safest to monitor closely and reassess if anything worsens.",
        ],
        do_now: Array.isArray(data?.do_now) && data.do_now.length ? data.do_now : [
          "Offer small amounts of water frequently and observe whether your pet keeps it down.",
          "Keep activity low and provide a quiet place to rest.",
          "Track key changes: energy, appetite, vomiting/diarrhea, and hydration.",
        ],
        avoid: Array.isArray(data?.avoid) && data.avoid.length ? data.avoid : [
          "Avoid giving human medications unless a veterinarian instructs you.",
          "Avoid forcing food or water if vomiting continues.",
        ],
        red_flags: Array.isArray(data?.red_flags) && data.red_flags.length ? data.red_flags : [
          "Repeated vomiting or inability to keep water down",
          "Blood in vomit or stool",
          "Severe lethargy, collapse, or signs of significant pain",
        ],
        disclaimer: data?.disclaimer ||
          "This is not a diagnosis. If you notice red flags or your pet worsens at any time, contact a veterinarian promptly.",
      });
    }

    // If model says NEED_MORE_INFO but misses fields → fallback safe PLAN (don’t block UX)
    if (data?.result_type === "NEED_MORE_INFO" && !hasAll(data, needMoreRequired)) {
      return res.status(200).json({
        result_type: "PLAN",
        urgency: "MONITOR_24H",
        headline: "Monitor closely and consider contacting a vet if things don’t improve",
        why: [
          "Some details are unclear, and it’s safer not to delay a basic monitoring plan.",
          "If any red flags appear, getting veterinary help sooner is the safest choice.",
        ],
        do_now: [
          "Offer small amounts of water frequently and observe whether your pet keeps it down.",
          "Keep activity low and provide a quiet place to rest.",
          "Track symptoms and reassess within 24 hours or sooner if worsening.",
        ],
        avoid: [
          "Avoid giving human medications unless a veterinarian instructs you.",
          "Avoid forcing food or water if vomiting continues.",
        ],
        red_flags: [
          "Repeated vomiting or inability to keep water down",
          "Blood in vomit or stool",
          "Severe lethargy, collapse, or signs of significant pain",
          "Bloated abdomen or repeated retching with little coming up",
        ],
        disclaimer:
          "This is not a diagnosis. If you notice any red flags or your pet worsens at any time, contact a veterinarian promptly.",
      });
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`PetPulse API listening on ${PORT}`);
});
