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
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title", "rank", "level", "why", "do_today", "watch"],
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
      schemaName: "petpulse_step1",
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
 * Enforce max 2 rounds:
 * - round 1: PLAN or NEED_MORE_INFO
 * - round 2: MUST return PLAN
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

    if (![1, 2].includes(r)) {
      return res.status(400).json({ error: "round must be 1 or 2" });
    }

    const system = `
You are a calm veterinary assistant.
No diagnosis. No certainty.
Decision support only.
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
You have two options:

OPTION A — Return a clear action recommendation (result_type="PLAN") with urgency:
HOME | MONITOR_24H | VET_NOW

OPTION B — If and only if this is round 1 AND information is insufficient,
ask 2–3 more questions (result_type="NEED_MORE_INFO").

STRICT RULES
- If round = 2, you MUST return PLAN.
- No diagnosis. Use cautious language.
- Return ONLY valid JSON.
`.trim();

    const data = await openaiJsonObject({ system, user });

    // ---------- ENFORCEMENT ----------
    if (r === 2 && data?.result_type !== "PLAN") {
      return res.json({
        result_type: "PLAN",
        urgency: "MONITOR_24H",
        headline: "Monitor closely and consider contacting a vet if symptoms persist",
        why: [
          "Some details remain unclear, but there are no immediate red flags.",
          "Monitoring closely over the next 24 hours is a cautious next step.",
        ],
        do_now: [
          "Ensure your pet has access to fresh water and a quiet place to rest.",
          "Monitor appetite, energy level, and any vomiting or diarrhea.",
        ],
        avoid: [
          "Avoid giving human medications unless directed by a veterinarian.",
        ],
        red_flags: [
          "Repeated vomiting or inability to keep water down",
          "Blood in vomit or stool",
          "Severe lethargy or collapse",
        ],
        disclaimer:
          "This is not a diagnosis. If your pet worsens or you notice red flags, contact a veterinarian promptly.",
      });
    }

    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`PetPulse API listening on ${PORT}`);
});
