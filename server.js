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

async function openaiJson({ schemaName, schema, system, user, model = "gpt-4.1-mini" }) {
  mustEnv();

  const body = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // Force structured JSON output (most stable for app parsing)
    response_format: {
      type: "json_schema",
      json_schema: {
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
    throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 500)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Could not parse OpenAI response JSON envelope: ${e}`);
  }

  // Responses API returns output array; extract the JSON string content
  // When using json_schema, the model output is returned as a "message" with JSON string
  const outputText =
    json?.output?.[0]?.content?.[0]?.text ||
    json?.output_text; // fallback

  if (!outputText || typeof outputText !== "string") {
    throw new Error("OpenAI returned empty structured output.");
  }

  try {
    return JSON.parse(outputText);
  } catch (e) {
    throw new Error(`Could not parse structured JSON result: ${e}. Raw: ${outputText.slice(0, 400)}`);
  }
}

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
You do NOT diagnose. You use cautious language: may/could/possible.
You reduce anxiety and help the owner decide next actions.
Never claim certainty. Never use alarming tone.
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
            required: ["id", "title", "urgency", "why", "do_today", "watch"],
            properties: {
              id: { type: "string" },
              title: { type: "string" }, // must include "(possible)"
              urgency: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
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
Return 3–5 POSSIBLE issues (not diagnoses). Each issue should feel distinct and grounded in the notes.

OUTPUT RULES
- Issue title MUST contain "(possible)".
- Add an urgency tag per issue:
  LOW = likely home care/monitor
  MEDIUM = monitor closely (24h) / consider vet if not improving
  HIGH = stronger red-flags → consider vet sooner (still cautious wording)
- Keep bullets short and practical.

Also return:
- title (one line)
- intro (one line)
- disclaimer (one paragraph, calm)
    `.trim();

    const data = await openaiJson({
      schemaName: "petpulse_step1_triage",
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
Generate the minimum necessary follow-up questions to decide urgency.
No diagnosis. No alarming language.
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
Ask 2–4 contextual follow-up questions to determine whether the owner should:
- stay home care
- monitor closely (24h)
- seek vet care now

OUTPUT RULES
- Questions must directly reduce uncertainty for urgency.
- Avoid medical jargon.
- Prefer yes/no or single-choice when possible.
    `.trim();

    const data = await openaiJson({
      schemaName: "petpulse_step2_questions",
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
 * STEP 3
 * POST /plan
 * body: { profile, symptoms, selected_issue_title, followup_answers, weather? }
 * returns: { urgency, headline, why, do_now, avoid, red_flags, disclaimer }
 */
app.post("/plan", async (req, res) => {
  try {
    const { profile, symptoms, selected_issue_title, followup_answers, weather } = req.body || {};
    const notes = safeText(symptoms);
    const issueTitle = safeText(selected_issue_title);

    if (!notes) return res.status(400).json({ error: "Missing symptoms" });
    if (!issueTitle) return res.status(400).json({ error: "Missing selected_issue_title" });

    const system = `
You are a calm veterinary assistant.
No diagnosis. No certainty. Decision support only.
Be reassuring, practical, and clear.
    `.trim();

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["urgency", "headline", "why", "do_now", "avoid", "red_flags", "disclaimer"],
      properties: {
        urgency: { type: "string", enum: ["HOME", "MONITOR_24H", "VET_NOW"] },
        headline: { type: "string" },
        why: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
        do_now: { type: "array", minItems: 3, maxItems: 6, items: { type: "string" } },
        avoid: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
        red_flags: { type: "array", minItems: 3, maxItems: 6, items: { type: "string" } },
        disclaimer: { type: "string" },
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

FOLLOW-UP ANSWERS (owner responses)
${JSON.stringify(followup_answers || {}, null, 2)}

TASK
Return a clear action recommendation with one urgency bucket:
- HOME (home care may be appropriate)
- MONITOR_24H (monitor closely and reassess within 24 hours)
- VET_NOW (seek veterinary care now)

OUTPUT RULES
- Be calm and non-alarming.
- Give a practical plan the owner can follow today.
- Include specific red flags that should trigger vet care.
- End disclaimer as one paragraph.
    `.trim();

    const data = await openaiJson({
      schemaName: "petpulse_step3_plan",
      schema,
      system,
      user,
    });

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`PetPulse API listening on ${PORT}`);
});
