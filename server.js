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
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
}

function safeText(v) {
  return typeof v === "string" ? v.trim() : "";
}

function toInt(v, fallback = null) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return n;
  return Math.max(min, Math.min(max, n));
}

function normalizeProfile(p = {}) {
  return {
    petName: safeText(p.petName),
    species: safeText(p.species),
    breed: safeText(p.breed),
    petGender: safeText(p.petGender),
    ageYears: clamp(toInt(p.ageYears ?? p.age, null), 0, 50),
    ageMonths: clamp(toInt(p.ageMonths, null), 0, 11),
    weightLb: p.weightLb ?? "Unknown",
    city: safeText(p.city),
    country: safeText(p.country),
  };
}

function formatPetAge(y, m) {
  if (y === null && m === null) return "Unknown";
  if (y > 0 && m > 0) return `${y} years ${m} months`;
  if (y > 0) return `${y} years`;
  return `${m} months`;
}

function profileBlock(p = {}) {
  const prof = normalizeProfile(p);
  return [
    `Pet name: ${prof.petName || "Unknown"}`,
    `Species: ${prof.species || "Unknown"}`,
    `Breed: ${prof.breed || "Unknown"}`,
    `Sex: ${prof.petGender || "Unknown"}`,
    `Age: ${formatPetAge(prof.ageYears, prof.ageMonths)}`,
    `Weight (lb): ${prof.weightLb}`,
    `Location: ${prof.city || "Unknown"}, ${prof.country || "Unknown"}`,
  ].join("\n");
}

function contextualWeatherBlock(profile = {}) {
  const city = safeText(profile.city) || "Unknown city";
  const country = safeText(profile.country) || "Unknown country";
  const today = new Date().toISOString().split("T")[0];

  return `
CONTEXT — WEATHER & ENVIRONMENT
The pet is located in ${city}, ${country}.
Today is ${today}.

Consider typical current weather and seasonal conditions
(e.g. heat, humidity, rain, cold, seasonal transitions),
and whether these factors could influence the symptoms.
`.trim();
}

// ---------- OpenAI helpers ----------
async function openaiJson({ schemaName, schema, system, user }) {
  mustEnv();

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
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
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 800));

  const json = JSON.parse(text);
  const out = json?.output_text || json?.output?.[0]?.content?.[0]?.text;
  return JSON.parse(out);
}

async function openaiJsonObject({ system, user }) {
  mustEnv();

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      text: { format: { type: "json_object" } },
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 800));

  const json = JSON.parse(text);
  const out = json?.output_text || json?.output?.[0]?.content?.[0]?.text;
  return JSON.parse(out);
}

// ---------- constants ----------
const STEP1_LEVELS = ["NHE", "TRUNGBINH", "KHA_NANG", "NANG", "KHAN_CAP"];

// ---------- routes ----------
app.post("/tips", async (req, res) => {
  try {
    const { profile, symptoms } = req.body || {};
    if (!safeText(symptoms)) return res.status(400).json({ error: "Missing symptoms" });

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
              title: { type: "string" },
              rank: { type: "integer", minimum: 1, maximum: 5 },
              level: { type: "string", enum: STEP1_LEVELS },
              why: { type: "array", items: { type: "string" } },
              do_today: { type: "array", items: { type: "string" } },
              watch: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    };

    const data = await openaiJson({
      schemaName: "petpulse_step1",
      schema,
      system: "You are a calm veterinary assistant.",
      user: `
${profileBlock(profile)}

${contextualWeatherBlock(profile)}

OWNER NOTES
${safeText(symptoms)}

TASK
Return 3–5 DISTINCT POSSIBLE issues (not diagnoses), grounded in the notes.

HARD REQUIREMENTS
- You MUST return between 3 and 5 issues (min 3, max 5).
- Sort issues from MOST LIKELY to LEAST LIKELY.
- Assign unique sequential rank starting at 1 (no gaps).
`.trim(),
    });

    // Defensive enforcement: sort + normalize rank, keep max 5
    if (data?.issues && Array.isArray(data.issues)) {
      data.issues = data.issues
        .slice(0, 5)
        .sort((a, b) => (Number(a.rank) || 999) - (Number(b.rank) || 999))
        .map((it, idx) => ({ ...it, rank: idx + 1 }));
    }

    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/confirm", async (req, res) => {
  try {
    const { profile, symptoms, selected_issue_title } = req.body || {};
    if (!safeText(symptoms)) return res.status(400).json({ error: "Missing symptoms" });

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["selected_issue_title", "questions"],
      properties: {
        selected_issue_title: { type: "string" },
        questions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "text", "type", "options"],
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              type: { type: "string" },
              options: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    };

    const data = await openaiJson({
      schemaName: "petpulse_step2",
      schema,
      system: "You are a calm veterinary assistant.",
      user: `
${profileBlock(profile)}

${contextualWeatherBlock(profile)}

OWNER NOTES
${safeText(symptoms)}

SELECTED ISSUE
${safeText(selected_issue_title)}
`,
    });

    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * STEP 3 — /plan
 */
function sanitizeQuestions(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw.map((q, i) => ({
    id: safeText(q?.id) || `q_${i + 1}`,
    text: safeText(q?.text) || "Please share a bit more detail.",
    type: ["yes_no", "single_choice", "short_text"].includes(q?.type) ? q.type : "short_text",
    options: Array.isArray(q?.options) ? q.options.map((o) => safeText(o)).filter(Boolean) : [],
  }));
}

app.post("/plan", async (req, res) => {
  try {
    const {
      profile,
      symptoms,
      selected_issue_title,
      followup_answers,
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
No diagnosis. No certainty.
Decision support only.
You MUST return valid JSON.
If round=2 you MUST return PLAN.
`.trim();

    const user = `
PET PROFILE
${profileBlock(profile)}

${contextualWeatherBlock(profile)}

OWNER NOTES
${notes}

SELECTED POSSIBLE ISSUE
${issueTitle}

FOLLOW-UP ROUND
${r}

PREVIOUS QUESTIONS
${JSON.stringify(previous_questions || [], null, 2)}

PREVIOUS ANSWERS
${JSON.stringify(previous_answers || {}, null, 2)}

CURRENT ANSWERS
${JSON.stringify(followup_answers || {}, null, 2)}

TASK
Return ONLY valid JSON.
`.trim();

    const data = await openaiJsonObject({ system, user });

    if (data?.result_type === "NEED_MORE_INFO") {
      const cleanQs = sanitizeQuestions(data.questions);
      if (r === 1 && cleanQs.length > 0) {
        return res.json({
          result_type: "NEED_MORE_INFO",
          selected_issue_title: issueTitle,
          reason: safeText(data.reason) || "A bit more detail will help.",
          questions: cleanQs,
        });
      }
    }

    return res.json({
      result_type: "PLAN",
      urgency: data?.urgency || "MONITOR_24H",
      headline: data?.headline || "Monitor closely and consider contacting a vet if needed",
      why: Array.isArray(data?.why) ? data.why : [],
      do_now: Array.isArray(data?.do_now) ? data.do_now : [],
      avoid: Array.isArray(data?.avoid) ? data.avoid : [],
      red_flags: Array.isArray(data?.red_flags) ? data.red_flags : [],
      disclaimer:
        data?.disclaimer ||
        "This is not a diagnosis. If symptoms worsen or red flags appear, contact a veterinarian.",
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`PetPulse API listening on ${PORT}`);
});
