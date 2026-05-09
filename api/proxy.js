module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { service, ...body } = req.body;
    const kvUrl = process.env.UPSTASH_KV_REST_API_URL;
    const kvToken = process.env.UPSTASH_KV_REST_API_TOKEN;

    // ── Simple Redis helpers using Upstash REST API ────────────────────
    async function redisCmd(...args) {
      const r = await fetch(`${kvUrl}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${kvToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
      });
      const d = await r.json();
      return d.result;
    }

    async function rGet(key) {
      const result = await redisCmd("GET", key);
      if (!result) return null;
      try { return JSON.parse(result); } catch { return result; }
    }

    async function rSet(key, value) {
      await redisCmd("SET", key, typeof value === "string" ? value : JSON.stringify(value));
    }

    // ── DB: save audit record ──────────────────────────────────────────
    if (service === "db-save") {
      const { record, auditText, aiText } = body;
      if (!kvUrl || !kvToken) return res.status(500).json({ error: "DB not configured" });

      const key = `audit:${record.brand_name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${Date.now()}`;
      record._key = key;

      // Save record and full audit
      await rSet(key, record);
      await rSet(`${key}:full`, { auditText, aiText });

      // Update index
      let index = await rGet("audit:index");
      if (!Array.isArray(index)) index = [];
      index.push(key);
      await rSet("audit:index", index);

      return res.status(200).json({ success: true, key });
    }

    // ── DB: load all records ───────────────────────────────────────────
    if (service === "db-load") {
      if (!kvUrl || !kvToken) return res.status(500).json({ error: "DB not configured" });

      let index = await rGet("audit:index");
      if (!Array.isArray(index)) index = [];

      const records = await Promise.all(
        index.map(async (key) => {
          try {
            const r = await rGet(key);
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
      const full = await rGet(`${key}:full`);
      return res.status(200).json({ full });
    }

    // ── DB: rebuild index ──────────────────────────────────────────────
    if (service === "db-rebuild-index") {
      if (!kvUrl || !kvToken) return res.status(500).json({ error: "DB not configured" });
      const keys = await redisCmd("KEYS", "audit:*");
      const recordKeys = (keys || []).filter(k => !k.endsWith(":full") && k !== "audit:index");
      await rSet("audit:index", recordKeys);
      return res.status(200).json({ success: true, rebuiltIndex: recordKeys });
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
