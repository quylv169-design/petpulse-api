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

  if (years === null && months === null) return "Unknown";

  const y = years ?? 0;
  const m = months ?? 0;

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

function contextualWeatherBlock(profile = {}) {
  const city = safeText(profile.city) || "Unknown city";
  const country = safeText(profile.country) || "Unknown country";
  const today = new Date().toISOString().split("T")[0];

  return `
CONTEXT — WEATHER & ENVIRONMENT
The pet is located in ${city}, ${country}.
Today is ${today}.

Without using exact measurements, consider the typical current weather
and seasonal conditions at this location and time
(e.g. heat or cold, humidity, rain, seasonal transitions),
and whether these environmental factors could reasonably influence
or worsen the symptoms described below.
`.trim();
}

/**
 * OpenAI Responses API helper (JSON Schema)
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

  const json = JSON.parse(text);
  const outputText = json?.output_text || json?.output?.[0]?.content?.[0]?.text || "";
  if (!outputText) throw new Error("OpenAI returned empty structured output.");

  return JSON.parse(outputText);
}

/**
 * OpenAI Responses API helper (JSON Object)
 */
async function openaiJsonObject({ system, user, model = "gpt-4.1-mini" }) {
  mustEnv();

  const body = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    text: { format: { type: "json_object" } },
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

  const json = JSON.parse(text);
  const outputText = json?.output_text || json?.output?.[0]?.content?.[0]?.text || "";
  if (!outputText) throw new Error("OpenAI returned empty JSON output.");

  return JSON.parse(outputText);
}

// ---------- constants ----------
const STEP1_LEVELS = ["NHE", "TRUNGBINH", "KHA_NANG", "NANG", "KHAN_CAP"];

// ---------- routes ----------
app.get("/health", (req, res) => res.status(200).send("ok"));

/**
 * STEP 1 — /tips
 */
app.post("/tips", async (req, res) => {
  try {
    const { profile, symptoms } = req.body || {};
    const notes = safeText(symptoms);
    if (!notes) return res.status(400).json({ error: "Missing symptoms" });

    const system = `
You are a calm, friendly veterinary assistant.
You do NOT diagnose. You avoid certainty.
Use cautious language: may / could / possible / consistent with.
Your goal is to reduce anxiety and help the owner decide next steps.
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

    const user = `
PET PROFILE
${profileBlock(profile)}

${contextualWeatherBlock(profile)}

OWNER NOTES
${notes}

TASK
Return 3–5 DISTINCT POSSIBLE issues (not diagnoses), ranked by likelihood.
    `.trim();

    const data = await openaiJson({
      schemaName: "petpulse_step1_triage_v4_contextual_weather",
      schema,
      system,
      user,
    });

    data.issues.sort((a, b) => a.rank - b.rank);
    data.issues = data.issues.map((it, i) => ({ ...it, rank: i + 1 }));

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * STEP 2 — /confirm
 */
app.post("/confirm", async (req, res) => {
  try {
    const { profile, symptoms, selected_issue_title } = req.body || {};
    const notes = safeText(symptoms);
    const issueTitle = safeText(selected_issue_title);

    if (!notes) return res.status(400).json({ error: "Missing symptoms" });
    if (!issueTitle) return res.status(400).json({ error: "Missing selected issue" });

    const system = `
You are a calm veterinary assistant.
Ask only the minimum necessary follow-up questions.
No diagnosis. Avoid certainty.
`.trim();

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

    const user = `
PET PROFILE
${profileBlock(profile)}

${contextualWeatherBlock(profile)}

OWNER NOTES
${notes}

SELECTED POSSIBLE ISSUE
${issueTitle}
    `.trim();

    const data = await openaiJson({
      schemaName: "petpulse_step2_questions_v3_contextual_weather",
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
 * STEP 3 — /plan
 */
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

    if (!notes || !issueTitle) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const system = `
You are a calm veterinary assistant.
No diagnosis. Decision support only.
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
    `.trim();

    const data = await openaiJsonObject({ system, user });

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`PetPulse API listening on ${PORT}`);
});
