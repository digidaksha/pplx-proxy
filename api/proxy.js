module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { service, ...body } = req.body;

    // ── DB: save audit record ──────────────────────────────────────────
    if (service === "db-save") {
      const { record, auditText, aiText } = body;
      const url = process.env.KV_REST_API_URL;
      const token = process.env.KV_REST_API_TOKEN;
      if (!url || !token) return res.status(500).json({ error: "DB not configured" });

      const key = `audit:${record.brand_name.toLowerCase().replace(/\s+/g, "_")}_${Date.now()}`;

      // Save full audit text
      await fetch(`${url}/set/${encodeURIComponent(key + ":full")}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ value: JSON.stringify({ auditText, aiText }) }),
      });

      // Save record summary
      await fetch(`${url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ value: JSON.stringify(record) }),
      });

      // Maintain index of all audit keys
      const indexRes = await fetch(`${url}/get/audit:index`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const indexData = await indexRes.json();
      const index = indexData.result ? JSON.parse(indexData.result) : [];
      index.push(key);
      await fetch(`${url}/set/audit:index`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ value: JSON.stringify(index) }),
      });

      return res.status(200).json({ success: true, key });
    }

    // ── DB: load all records ───────────────────────────────────────────
    if (service === "db-load") {
      const url = process.env.KV_REST_API_URL;
      const token = process.env.KV_REST_API_TOKEN;
      if (!url || !token) return res.status(500).json({ error: "DB not configured" });

      const indexRes = await fetch(`${url}/get/audit:index`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const indexData = await indexRes.json();
      const index = indexData.result ? JSON.parse(indexData.result) : [];

      const records = await Promise.all(index.map(async (key) => {
        const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json();
        return d.result ? JSON.parse(d.result) : null;
      }));

      return res.status(200).json({ records: records.filter(Boolean) });
    }

    // ── DB: load full audit ────────────────────────────────────────────
    if (service === "db-load-full") {
      const { key } = body;
      const url = process.env.KV_REST_API_URL;
      const token = process.env.KV_REST_API_TOKEN;

      const r = await fetch(`${url}/get/${encodeURIComponent(key + ":full")}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      const full = d.result ? JSON.parse(d.result) : null;
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

    // ── Perplexity ─────────────────────────────────────────────────────
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
