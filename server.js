import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("PetPulse API OK");
});

app.post("/", async (req, res) => {
  try {
    const { symptoms, messages } = req.body;

    // ✅ FIX CHÍNH Ở ĐÂY
    if (!symptoms || typeof symptoms !== "string" || symptoms.trim() === "") {
      return res.status(400).send("Missing symptoms.");
    }

    // Nếu Flutter gửi messages → ưu tiên dùng
    const inputMessages =
      Array.isArray(messages) && messages.length > 0
        ? messages
        : [
            {
              role: "user",
              content: symptoms,
            },
          ];

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: inputMessages,
        temperature: 0.6,
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).send(`OpenAI error ${r.status}: ${t}`);
    }

    const data = await r.json();

    const text =
      data.output_text ??
      data.output?.[0]?.content?.[0]?.text ??
      "";

    if (!text || typeof text !== "string") {
      return res.status(502).send("OpenAI returned no text.");
    }

    // 👉 TRẢ RAW TEXT để Flutter parser render issue cards
    res.status(200).type("text/plain").send(text.trim());
  } catch (e) {
    res.status(500).send(`Server error: ${e.message ?? String(e)}`);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Listening on", port);
});
