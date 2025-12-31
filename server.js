import express from "express";

const app = express();

// ✅ capture raw body even if JSON parsing fails
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = buf?.toString("utf8") ?? "";
    },
  })
);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ---------- helpers ----------
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function pickSymptoms(body) {
  if (!body || typeof body !== "object") return "";

  // accept multiple possible keys
  const candidates = [
    body.symptoms,
    body.healthNotes,
    body.notes,
    body.ownerNotes,
    body.concerns,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }

  // fallback: try to derive from messages
  const msgs = body.messages;
  if (Array.isArray(msgs)) {
    const userMsg = msgs.find((m) => m?.role === "user" && typeof m?.content === "string");
    if (userMsg?.content?.trim()) return userMsg.content.trim();
  }

  return "";
}

function normalizeToPossibleFormat(raw) {
  const lines = raw.split("\n").map((l) => l.trimRight());
  const out = [];

  // Keep title/intro/disclaimer as-is, but ensure issue headers contain "(possible)"
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) {
      out.push(lines[i]);
      continue;
    }

    const lower = line.toLowerCase();

    const isBullet = line.startsWith("•") || line.startsWith("- ");
    const isDisclaimer = lower.startsWith("educational guidance only.");
    const looksLikeHeader =
      !isBullet &&
      !isDisclaimer &&
      !lower.startsWith("things to watch") &&
      !lower.startsWith("based on what you shared") &&
      !lower.startsWith("intro") &&
      !lower.startsWith("title") &&
      line.length < 60; // heuristic

    if (looksLikeHeader && !lower.includes("(possible)")) {
      out.push(`${line} (possible)`);
    } else {
      out.push(lines[i]);
    }
  }

  return out.join("\n").trim();
}

// ---------- route ----------
app.post("/", async (req, res) => {
  // ✅ robust body recovery
  let body = req.body && typeof req.body === "object" ? req.body : null;
  if (!body || Object.keys(body).length === 0) {
    const recovered = safeJsonParse(req.rawBody || "");
    if (recovered && typeof recovered === "object") body = recovered;
  }

  // ✅ log to Render so you can verify the payload
  console.log("---- INCOMING REQUEST ----");
  console.log("content-type:", req.headers["content-type"]);
  console.log("rawBody length:", (req.rawBody || "").length);
  console.log("parsed keys:", body ? Object.keys(body) : null);

  const symptoms = pickSymptoms(body);
  const messages = body?.messages;

  if (!symptoms) {
    console.log("❌ Missing symptoms. Body preview:", JSON.stringify(body)?.slice(0, 300));
    return res.status(400).type("text/plain").send("Missing symptoms.");
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    console.log("❌ Missing messages. Body preview:", JSON.stringify(body)?.slice(0, 300));
    return res.status(400).type("text/plain").send("Missing messages.");
  }

  if (!OPENAI_API_KEY) {
    return res.status(500).type("text/plain").send("Server missing OPENAI_API_KEY.");
  }

  try {
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
      console.log("❌ OpenAI error:", openaiRes.status, errText?.slice(0, 300));
      return res.status(502).type("text/plain").send(`OpenAI error ${openaiRes.status}: ${errText}`);
    }

    const data = await openaiRes.json();
    const text = data?.choices?.[0]?.message?.content?.trim() ?? "";

    if (!text) {
      console.log("❌ OpenAI returned empty text:", JSON.stringify(data)?.slice(0, 300));
      return res.status(502).type("text/plain").send("OpenAI returned no text.");
    }

    const normalized = normalizeToPossibleFormat(text);
    return res.status(200).type("text/plain").send(normalized);
  } catch (e) {
    console.log("❌ Server exception:", e);
    return res.status(500).type("text/plain").send(`Server error: ${e.message ?? String(e)}`);
  }
});

// ---------- start ----------
const port = process.env.PORT || 10000;
app.listen(port, () => console.log("✅ Listening on", port));
