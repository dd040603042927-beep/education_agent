function isConfiguredSecret(value) {
  return Boolean(value && !/replace-with|change-me|your-|^sk-\.\.\.$/i.test(String(value)));
}

function normalizeEmbedding(value) {
  if (!Array.isArray(value) || !value.length || value.some((item) => !Number.isFinite(Number(item)))) {
    throw new Error("Embedding 服务返回了无效向量。");
  }
  return value.map(Number);
}

function createEmbeddingProvider(options = {}) {
  const provider = String(options.provider || process.env.EMBEDDING_PROVIDER || "auto").trim().toLowerCase();
  const apiKey = String(options.apiKey || process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  const baseUrl = String(options.baseUrl || process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = String(options.model || process.env.EMBEDDING_MODEL || process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small").trim();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || process.env.EMBEDDING_TIMEOUT_MS || 30000));
  const enabled = provider === "openai" || (provider === "auto" && isConfiguredSecret(apiKey));

  async function embedTexts(inputs) {
    const texts = (Array.isArray(inputs) ? inputs : [inputs]).map((item) => String(item || "").slice(0, 12000));
    if (!texts.length || texts.some((item) => !item.trim())) throw new Error("Embedding 输入不能为空。");
    if (!enabled) return { provider: "legacy-hash", model: "legacy-64", embeddings: null, reason: "Embedding provider is not configured" };
    if (!isConfiguredSecret(apiKey)) throw new Error("已启用真实 Embedding，但未配置 EMBEDDING_API_KEY 或 OPENAI_API_KEY。");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: texts, encoding_format: "float" }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Embedding 接口返回 ${response.status}：${JSON.stringify(payload).slice(0, 300)}`);
      const rows = Array.isArray(payload.data) ? payload.data.slice().sort((left, right) => Number(left.index || 0) - Number(right.index || 0)) : [];
      if (rows.length !== texts.length) throw new Error("Embedding 服务返回的向量数量与输入不一致。");
      const embeddings = rows.map((row) => normalizeEmbedding(row.embedding));
      const dimension = embeddings[0].length;
      if (embeddings.some((embedding) => embedding.length !== dimension)) throw new Error("Embedding 服务返回了不同维度的向量。");
      return { provider: "openai-compatible", model, embeddings, dimension };
    } catch (error) {
      throw new Error(`Embedding 请求失败（${baseUrl}/embeddings，model=${model}）：${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    provider: enabled ? "openai-compatible" : "legacy-hash",
    model: enabled ? model : "legacy-64",
    enabled,
    baseUrl,
    embedTexts
  };
}

module.exports = { createEmbeddingProvider, isConfiguredSecret, normalizeEmbedding };
