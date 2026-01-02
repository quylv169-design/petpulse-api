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
      required: ["title", "intro", "issues", "disclaimer"],
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        intro: { type: "string" },
        disclaimer: { type: "string" },
        issues: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title", "rank", "level", "why", "do_today", "watch"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              rank: { type: "integer" },
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
      schemaName: "step1",
      schema,
      system: "You are a calm veterinary assistant.",
      user: `
${profileBlock(profile)}

${contextualWeatherBlock(profile)}

OWNER NOTES
${safeText(symptoms)}
`,
    });

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
      required: ["selected_issue_title", "questions"],
      additionalProperties: false,
      properties: {
        selected_issue_title: { type: "string" },
        questions: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "text", "type", "options"],
            additionalProperties: false,
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
      schemaName: "step2",
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

    if (!safeText(symptoms) || !safeText(selected_issue_title)) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const data = await openaiJsonObject({
      system: "You are a calm veterinary assistant.",
      user: `
${profileBlock(profile)}

${contextualWeatherBlock(profile)}

OWNER NOTES
${safeText(symptoms)}

SELECTED ISSUE
${safeText(selected_issue_title)}

FOLLOW-UP ROUND: ${round}

ANSWERS
${JSON.stringify(followup_answers || {}, null, 2)}
`,
    });

    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`PetPulse API listening on ${PORT}`);
});
