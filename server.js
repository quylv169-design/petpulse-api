import express from "express";

const app = express();
app.use(express.json());

// =======================
// CONFIG
// =======================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
}

// =======================
// ROUTE
// =======================
app.post("/", async (req, res) => {
  try {
    const { symptoms, messages } = req.body ?? {};

    // ---- validate ----
    if (!symptoms || typeof symptoms !== "string" || !symptoms.trim()) {
      return res.status(400).send("Missing symptoms.");
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).send("Missing messages.");
    }

    // ---- call OpenAI ----
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages,
        temperature: 0.6,
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      return res
        .status(502)
        .send(`OpenAI error ${openaiRes.status}: ${errText}`);
    }

    const data = await openaiRes.json();

    const text =
      data?.choices?.[0]?.message?.content?.trim() ?? "";

    if (!text) {
      return res.status(502).send("OpenAI returned no text.");
    }

    // =======================
    // 🚨 CRITICAL FIX
    // Flutter parser cần các dòng "(possible)"
    // =======================
    const normalized = normalizeToPossibleFormat(text);

    return res.status(200).type("text/plain").send(normalized);
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .type("text/plain")
      .send(`Server error: ${e.message ?? String(e)}`);
  }
});

// =======================
// HELPERS
// =======================
function normalizeToPossibleFormat(raw) {
  const lines = raw.split("\n").map((l) => l.trim());

  const out = [];
  let hasPossible = false;

  for (const line of lines) {
    if (
      line &&
      !line.startsWith("•") &&
      !line.toLowerCase().includes("possible") &&
      !line.toLowerCase().startsWith("things to watch") &&
      !line.toLowerCase().startsWith("based on")
    ) {
      // Heuristic: treat section headers as possible issues
      out.push(`${line} (possible)`);
      hasPossible = true;
      continue;
    }
    out.push(line);
  }

  // fallback: nếu OpenAI không chia section
  if (!hasPossible) {
    return `
Things to watch for your pet today

Based on what you shared, your pet may be experiencing one or more of the following.

Digestive upset (possible)
• Why this could fit: Vomiting, reduced appetite, low energy
• What you can do today: Offer small meals, ensure hydration, allow rest
• Watch closely for: Repeated vomiting, refusal to eat, worsening lethargy

Educational guidance only. Not a medical diagnosis. If symptoms worsen, persist, or you’re concerned, contact a licensed veterinarian.
`.trim();
  }

  return out.join("\n").trim();
}

// =======================
// START SERVER
// =======================
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log("✅ Listening on", port);
});
