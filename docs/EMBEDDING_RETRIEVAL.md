# 真实 Embedding 与混合检索

## 当前实现

- 课程资料切块仍由后端完成；每个片段同步写入 SQLite `knowledge_chunks`。
- `knowledge_chunks.embedding_json` 保存向量，`embedding_provider` 和 `embedding_model` 记录来源，`content_sha256` 防止文本变化后误复用旧向量。
- `EMBEDDING_PROVIDER=auto` 时，有有效 `EMBEDDING_API_KEY` 或 `OPENAI_API_KEY` 才调用真实 Embedding；没有密钥时保留旧的 64 维哈希向量，明确作为兼容降级，不把它标记为真实语义向量。
- Embedding 接口采用 OpenAI-compatible `POST /embeddings`，因此可接 OpenAI 或内部兼容服务；查询向量与资料向量必须使用同一模型和维度。
- 课程检索融合关键词重叠、真实向量相似度、标题/章节/精确匹配、知识图谱结果和学生低掌握度知识点；真实向量分支权重高于兼容哈希向量。
- 结果的 `scoreDetail.embedding`、`scoreDetail.embeddingModel`、`scoreDetail.mastery` 会暴露检索证据，便于检索测试和回归分析。

## 配置

在项目 `.env` 中设置：

```ini
EMBEDDING_PROVIDER=openai
EMBEDDING_API_KEY=你的Embedding服务Key
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_TIMEOUT_MS=30000
EMBEDDING_BATCH_SIZE=32
```

如果 Embedding 服务与聊天模型共用 OpenAI Key，可以省略 `EMBEDDING_API_KEY`，自动读取 `OPENAI_API_KEY`。生产环境建议显式设置 `EMBEDDING_PROVIDER=openai`：这样未配置 Key 时会暴露配置错误，而不是悄悄回退。

启动后检查：

```powershell
Invoke-RestMethod http://127.0.0.1:5107/api/healthz
```

重点查看 `embedding.enabled`、`embedding.model` 和 `embedding.chunks.embedded`。`/api/readyz` 在仍使用兼容哈希向量时会给出 warning；开发环境不会因此阻断启动，生产 ready 规则仍由现有安全配置控制。

## 为现有资料重建

配置好 Key 后，在单服务写入窗口执行：

```powershell
npm run embeddings:reindex
```

命令按批次读取 `knowledge_chunks`，调用 Embedding 服务，并按 `id + content_sha256` 更新向量。失败时不会清空旧向量；如果文本已经变化，旧向量不会匹配新哈希，也不会被误用。新上传资料会在保存后自动尝试索引；服务不可达时资料仍保存，检索暂时使用兼容向量并在日志中记录原因。

## 检索链路

```text
教材/PDF
  -> 文本提取
  -> 重叠切块
  -> knowledge_chunks 元数据
  -> Embedding 批量索引
  -> 查询向量 + 关键词召回
  -> 知识图谱召回
  -> 学生低掌握度知识点加权
  -> 来源/章节多样性重排
  -> LLM 或 Dify 生成
```

目前“重排”是可解释的本地打分，不是独立 Cross-Encoder Reranker。后续接入 Reranker 时，应保留当前各通道分数，并把模型分数作为额外字段，避免把课程资料、图谱和掌握度证据覆盖掉。

## 回滚与注意事项

- 切换 Embedding 模型前先备份 SQLite；不同模型的向量不可混用。
- 修改 `EMBEDDING_MODEL` 后必须执行 `npm run embeddings:reindex`，否则旧模型向量会被查询逻辑跳过并暂时回退。
- `data/db.json` 不是 SQLite 向量索引的来源；不要手工把 `embedding_json` 写回 JSON。
- 外部 Embedding 服务不可用时，系统不会伪造真实向量；健康检查和检索 `scoreDetail` 会显示当前是否真实召回。
