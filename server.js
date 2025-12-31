import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.status(200).type("text/plain").send("petpulse-api ok");
});

// ✅ Flutter will call POST /tips
app.post("/tips", async (req, res) => {
  try {
    const { symptoms, messages, profile } = req.body || {};

    if (!symptoms || String(symptoms).trim().length === 0) {
      return res.status(400).type("text/plain").send("Missing symptoms.");
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).type("text/plain").send("Missing OPENAI_API_KEY on server.");
    }

    // If client passed messages, we can use them directly.
    // Otherwise build a minimal prompt from profile + symptoms.
    const inputMessages =
      Array.isArray(messages) && messages.length
        ? messages
        : [
            {
              role: "system",
              content:
                "You are a helpful veterinary assistant. You must not diagnose. Use cautious language and practical advice.",
            },
            {
              role: "user",
              content: `Pet profile: ${JSON.stringify(profile || {})}\n\nOwner notes:\n${String(
                symptoms
              )}\n\nReturn plain text with headings and bullets.`,
            },
          ];

    // OpenAI Responses API
    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: inputMessages,
        temperature: 0.6,
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      return res
        .status(502)
        .type("text/plain")
        .send(`OpenAI error ${openaiRes.status}: ${errText}`);
    }

    const data = await openaiRes.json();

    // Extract text from Responses API
    const text =
      data?.output_text ??
      data?.output?.[0]?.content?.[0]?.text ??
      "";

    if (!text || typeof text !== "string") {
      return res.status(502).type("text/plain").send("OpenAI returned no text.");
    }

    // Return RAW TEXT for Flutter UI parser
    return res.status(200).type("text/plain").send(text.trim());
  } catch (e) {
    return res.status(500).type("text/plain").send(`Server error: ${e?.message ?? String(e)}`);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Listening on", port));
