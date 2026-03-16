module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { service, ...body } = req.body;

    if (service === "claude") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "Anthropic API key not configured" });

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      try {
        return res.status(response.status).json(JSON.parse(text));
      } catch {
        return res.status(500).json({ error: "Claude non-JSON", raw: text.slice(0, 300) });
      }
    }

    const pplxKey = process.env.PPLX_API_KEY;
    if (!pplxKey) return res.status(500).json({ error: "Perplexity key not configured" });

    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + pplxKey,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    try {
      return res.status(response.status).json(JSON.parse(text));
    } catch {
      return res.status(500).json({ error: "Perplexity non-JSON", raw: text.slice(0, 300) });
    }

  } catch (err) {
    return res.status(500).json({ error: "Proxy error", detail: err.message });
  }
};
