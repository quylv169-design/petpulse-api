import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/", (req, res) => res.status(200).send("PetPulse API OK"));

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function petName(profile) {
  const n = (profile?.petName || "").trim();
  return n.length ? n : "your pet";
}

// --- PROMPTS (Step 1 only for now) ---
function buildInitialAdvicePrompt({ profile, symptoms }) {
  const pet = petName(profile);

  return {
    system: `
You are PetPulse Care Guide.
You help pet owners make calm, practical decisions.
You MUST NOT provide a medical diagnosis.
Use cautious language: may/could/possible/might. Never say the pet "has" something.
Avoid alarming tone. Be easy to skim.
`,
    user: `
PET PROFILE
- Pet name: ${profile?.petName || ""}
- Species: ${profile?.species || ""}
- Breed: ${profile?.breed || ""}
- Sex: ${profile?.petGender || ""}
- Age: ${profile?.age ?? ""}
- Weight: ${profile?.weightLb ?? ""} lb
- Location: ${profile?.city || ""}, ${profile?.country || ""}

OWNER NOTES (symptoms / concerns):
${symptoms}

TASK:
Return 3–5 POSSIBLE ISSUES (min 3, max 5).
IMPORTANT: Each issue title line MUST contain the exact string "(possible)".

OUTPUT FORMAT (MUST follow exactly):

TITLE:
Things to watch for ${pet} today

INTRO (1 short sentence):
Based on what you shared, ${pet} may be experiencing one or more of the following.

ISSUE SECTIONS (3–5 sections):
Each section MUST start with an emoji + a short title + " (possible)"
Then exactly 3 bullet lines, in this style (one line each):
• Why this could fit: ...
• What you can do today: ...
• Watch closely for: ...

DISCLAIMER (last line, exactly one paragraph starting with "Educational guidance only."):
Educational guidance only. Not a medical diagnosis. If symptoms worsen, persist, or you’re concerned, contact a licensed veterinarian.

Extra rules:
- No extra headings beyond what’s specified.
- No blank “possible issues” without content.
- Keep each bullet short, practical.
`.trim(),
  };
}

// --- OpenAI call (Responses API) ---
async function callOpenAI({ system, user }) {
  const apiKey = mustEnv("OPENAI_API_KEY");

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
    }),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`OpenAI error ${r.status}: ${errText}`);
  }

  const data = await r.json();

  // Safe extract text from Responses API
  const text =
    data?.output_text ??
    data?.output?.[0]?.content?.[0]?.text ??
    "";

  if (!text || typeof text !== "string") {
    throw new Error("OpenAI returned no text.");
  }
  return text.trim();
}

// --- Main route ---
app.post("/", async (req, res) => {
  try {
    const step = (req.body?.step || "initial_advice").toString();
    const profile = req.body?.profile || {};
    const symptoms = (req.body?.symptoms || "").toString().trim();

    if (!symptoms) {
      return res.status(400).type("text/plain").send("Missing symptoms.");
    }

    // Step 1 only (initial advice)
    if (step !== "initial_advice") {
      return res
        .status(400)
        .type("text/plain")
        .send(`Unsupported step: ${step}`);
    }

    const { system, user } = buildInitialAdvicePrompt({ profile, symptoms });
    const text = await callOpenAI({ system, user });

    // Return RAW TEXT for Flutter parser
    return res.status(200).set("Content-Type", "text/plain; charset=utf-8").send(text);
  } catch (e) {
    return res
      .status(502)
      .set("Content-Type", "text/plain; charset=utf-8")
      .send(`Server error: ${e?.message ?? String(e)}`);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
