module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { service, ...body } = req.body;
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    // ── Helper: get a key from Redis ───────────────────────────────────
    async function kvGet(key) {
      const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      });
      const d = await r.json();
      if (!d.result) return null;
      try { return JSON.parse(d.result); } catch { return d.result; }
    }

    // ── Helper: set a key in Redis ─────────────────────────────────────
    async function kvSet(key, value) {
      await fetch(`${kvUrl}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${kvToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ value: JSON.stringify(value) }),
      });
    }

    // ── DB: save audit record ──────────────────────────────────────────
    if (service === "db-save") {
      const { record, auditText, aiText } = body;
      if (!kvUrl || !kvToken) return res.status(500).json({ error: "DB not configured" });

      const key = `audit:${record.brand_name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${Date.now()}`;

      // Save full audit text separately
      await kvSet(key + ":full", { auditText, aiText });

      // Save record summary
      record._key = key;
      await kvSet(key, record);

      // Update index — safely handle any existing value
      let index = await kvGet("audit:index");
      if (!Array.isArray(index)) index = [];
      index.push(key);
      await kvSet("audit:index", index);

      return res.status(200).json({ success: true, key });
    }

    // ── DB: load all records ───────────────────────────────────────────
    if (service === "db-load") {
      if (!kvUrl || !kvToken) return res.status(500).json({ error: "DB not configured" });

      let index = await kvGet("audit:index");
      if (!Array.isArray(index)) index = [];

      const records = await Promise.all(
        index.map(async (key) => {
          try {
            const r = await kvGet(key);
            return r && typeof r === "object" ? r : null;
          } catch { return null; }
        })
      );

      return res.status(200).json({ records: records.filter(Boolean) });
    }

    // ── DB: load full audit ────────────────────────────────────────────
    if (service === "db-load-full") {
      const { key } = body;
      if (!kvUrl || !kvToken) return res.status(500).json({ error: "DB not configured" });
      const full = await kvGet(key + ":full");
      return res.status(200).json({ full });
    }

    // ── Claude ─────────────────────────────────────────────────────────
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
      try { return res.status(response.status).json(JSON.parse(text)); }
      catch { return res.status(500).json({ error: "Claude non-JSON", raw: text.slice(0, 300) }); }
    }

    // ── Perplexity (default) ───────────────────────────────────────────
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
    try { return res.status(response.status).json(JSON.parse(text)); }
    catch { return res.status(500).json({ error: "Perplexity non-JSON", raw: text.slice(0, 300) }); }

  } catch (err) {
    return res.status(500).json({ error: "Proxy error", detail: err.message });
  }
};
