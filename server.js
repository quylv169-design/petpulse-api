import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/", async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length < 2) {
      return res.status(400).send("Bad Request: missing `messages` array.");
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).send("Missing OPENAI_API_KEY");

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: messages,
        temperature: 0.6,
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).send(`OpenAI error ${r.status}: ${t}`);
    }

    const data = await r.json();
    const text =
      data?.output_text ?? data?.output?.[0]?.content?.[0]?.text ?? "";

    if (!text || typeof text !== "string") {
      return res.status(502).send("OpenAI returned no text.");
    }

    return res.status(200).type("text/plain").send(text.trim());
  } catch (e) {
    return res
      .status(500)
      .type("text/plain")
      .send(`Server error: ${e?.message ?? String(e)}`);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
