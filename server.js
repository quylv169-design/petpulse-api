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
  if (yearsRaw === null && monthsRaw === null) return "Unknown";
  const y = yearsRaw ?? 0;
  const m = monthsRaw ?? 0;
  if (y === 0 && m > 0) return `${m} months`;
  if (y > 0 && m === 0) return `${y} years`;
  return `${y} years ${m} months`;
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

Consider the typical current weather and seasonal conditions at this location
(e.g. heat, humidity, rain, cold, seasonal transitions),
and whether these factors could influence the symptoms below.
`.trim();
}

// ---------- OpenAI helpers ----------
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
  if (!res.ok) throw new Error(text.slice(0, 800));

  const json = JSON.parse(text);
  const outputText = json?.output_text || json?.output?.[0]?.content?.[0]?.text;
  return JSON.parse(outputText);
}

// ---------- routes ----------
app.post("/confirm", async (req, res) => {
  try {
    const { profile, symptoms, selected_issue_title } = req.body || {};
    if (!safeText(symptoms)) return res.status(400).json({ error: "Missing symptoms" });

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
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false, // 🔴 FIX BẮT BUỘC
            required: ["id", "text", "type", "options"],
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              type: { type: "string", enum: ["single_choice", "yes_no", "short_text"] },
              options: {
                type: "array",
                items: { type: "string" },
              },
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
${safeText(symptoms)}

SELECTED POSSIBLE ISSUE
${safeText(selected_issue_title)}
    `.trim();

    const data = await openaiJson({
      schemaName: "petpulse_step2_questions_v4_fixed",
      schema,
      system,
      user,
    });

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`PetPulse API listening on ${PORT}`);
});
