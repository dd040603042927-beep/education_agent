const { openStorage } = require("./storage_cli");
const { createEmbeddingProvider } = require("../storage/embeddingProvider");

const BATCH_SIZE = Math.max(1, Math.min(64, Number(process.env.EMBEDDING_BATCH_SIZE || 32)));

async function main() {
  const store = openStorage();
  const provider = createEmbeddingProvider();
  if (!provider.enabled) throw new Error("未配置真实 Embedding。请设置 EMBEDDING_PROVIDER=openai 和 EMBEDDING_API_KEY，或配置 OPENAI_API_KEY。");
  try {
    const rows = store.readKnowledgeChunks();
    let indexed = 0;
    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE);
      const result = await provider.embedTexts(batch.map((row) => row.content));
      store.updateKnowledgeChunkEmbeddings(batch.map((row, index) => ({
        id: row.id,
        contentSha256: row.contentSha256,
        embedding: result.embeddings[index],
        provider: result.provider,
        model: result.model
      })));
      indexed += batch.length;
      console.log(`embedded ${indexed}/${rows.length}`);
    }
    console.log(JSON.stringify({ ...store.knowledgeChunkStats(), provider: provider.provider, model: provider.model }, null, 2));
  } finally {
    store.close?.();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
