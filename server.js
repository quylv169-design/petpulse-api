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

function profileBlock(p = {}) {
  return [
    `Pet name: ${safeText(p.petName) || "Unknown"}`,
    `Species: ${safeText(p.species) || "Unknown"}`,
    `Breed: ${safeText(p.breed) || "Unknown"}`,
    `Sex: ${safeText(p.petGender) || "Unknown"}`,
    `Age: ${p.age ?? "Unknown"}`,
    `Weight (lb): ${p.weightLb ?? "Unknown"}`,
    `Location: ${safeText(p.city) || "Unknown"}, ${safeText(p.country) || "Unknown"}`,
  ].join("\n");
}

/**
 * OpenAI Responses API helper
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

// ---------- constants ----------
const STEP1_LEVELS = ["NHE", "TRUNGBINH", "KHA_NANG", "NANG", "KHAN_CAP"]; // Step 1 concern levels

// ---------- small validators ----------
function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}
function isStringArray(x, min = 1) {
  return Array.isArray(x) && x.filter((t) => typeof t === "string" && t.trim().length > 0).length >= min;
}
function hasPlanShape(obj) {
  return (
    obj &&
    obj.result_type === "PLAN" &&
    ["HOME", "MONITOR_24H", "VET_NOW"].includes(obj.urgency) &&
    isNonEmptyString(obj.headline) &&
    isStringArray(obj.why, 2) &&
    isStringArray(obj.do_now, 3) &&
    isStringArray(obj.avoid, 2) &&
    isStringArray(obj.red_flags, 3) &&
    isNonEmptyString(obj.disclaimer)
  );
}
function hasNeedMoreInfoShape(obj) {
  return (
    obj &&
    obj.result_type === "NEED_MORE_INFO" &&
    isNonEmptyString(obj.selected_issue_title) &&
    isNonEmptyString(obj.reason) &&
    Array.isArray(obj.questions) &&
    obj.questions.length >= 2 &&
    obj.questions.length <= 3
  );
}

function safeFallbackPlan() {
  return {
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
      "Track symptom frequency, energy level, appetite, and stool changes.",
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
  };
}

// ---------- routes ----------
app.get("/health", (req, res) => res.status(200).send("ok"));

/**
 * STEP 1
 * POST /tips
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
            required: ["id", "title", "level", "why", "do_today", "watch"],
            properties: {
              id: { type: "string" },
              title: { type: "string" }, // must include "(possible)"
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
      schemaName: "petpulse_step1_triage_v2",
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
 * STEP 2
 * POST /confirm
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
 *
 * FIXED: remove `allOf` (OpenAI schema rejects it)
 * We keep a "union-like" schema by making fields optional,
 * then validate server-side and fallback safely.
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

    // ✅ IMPORTANT: No allOf/anyOf/oneOf. Keep schema flat.
    // We enforce correctness via prompt + server-side validation.
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["result_type"],
      properties: {
        result_type: { type: "string", enum: ["PLAN", "NEED_MORE_INFO"] },

        // PLAN payload (optional in schema; validated server-side)
        urgency: { type: "string", enum: ["HOME", "MONITOR_24H", "VET_NOW"] },
        headline: { type: "string" },
        why: { type: "array", minItems: 0, maxItems: 6, items: { type: "string" } },
        do_now: { type: "array", minItems: 0, maxItems: 10, items: { type: "string" } },
        avoid: { type: "array", minItems: 0, maxItems: 8, items: { type: "string" } },
        red_flags: { type: "array", minItems: 0, maxItems: 12, items: { type: "string" } },
        disclaimer: { type: "string" },

        // NEED_MORE_INFO payload (optional in schema; validated server-side)
        selected_issue_title: { type: "string" },
        reason: { type: "string" },
        questions: {
          type: "array",
          minItems: 0,
          maxItems: 3,
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

OPTION A — Return a clear action recommendation with:
result_type="PLAN"
and ONE urgency bucket: HOME / MONITOR_24H / VET_NOW

OPTION B — If and only if information is still insufficient to choose urgency safely,
ask 2–3 more questions with:
result_type="NEED_MORE_INFO"
Include: selected_issue_title, reason, questions (2–3 items)

STRICT RULES
- No diagnosis. No certainty. Use cautious language.
- If round=2, you MUST return PLAN (do NOT ask more questions).
- Keep plan practical and calm.
- Red flags should be specific but not alarming.
- Avoid giving medication instructions. Avoid overly specific “home treatment recipes”.

OUTPUT REQUIREMENTS
- If result_type="PLAN": include urgency, headline, why(2–4), do_now(3–6), avoid(2–4), red_flags(3–6), disclaimer.
- If result_type="NEED_MORE_INFO": include selected_issue_title, reason, questions(2–3).
    `.trim();

    const data = await openaiJson({
      schemaName: "petpulse_step3_decision_v2",
      schema,
      system,
      user,
    });

    // ✅ Hard rule: round 2 must return PLAN
    if (r === 2) {
      if (!data || data.result_type !== "PLAN" || !hasPlanShape(data)) {
        return res.status(200).json(safeFallbackPlan());
      }
      return res.status(200).json(data);
    }

    // ✅ Round 1: accept either, but validate
    if (hasPlanShape(data)) {
      return res.status(200).json(data);
    }
    if (hasNeedMoreInfoShape(data)) {
      return res.status(200).json(data);
    }

    // If model returned something malformed, protect UX
    return res.status(200).json(safeFallbackPlan());
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`PetPulse API listening on ${PORT}`);
});
