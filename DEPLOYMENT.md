# 智慧教育智能体平台部署说明

本项目当前适合“校内演示 / 小范围内测”。正式多学校、多班级长期运行前，仍应按 `RELEASE_CHECKLIST.md` 推进数据库、任务队列、真实 RAG、监控和备份。

## 1. 本地或局域网启动

复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

修改 `.env`，至少设置强随机 `SESSION_SECRET`。本机运行时保持：

```text
HOST=127.0.0.1
PORT=5107
DATA_DIR=./data
LOG_DIR=./logs
COOKIE_SECURE=false
SESSION_IDLE_TIMEOUT_MS=172800000
```

登录态最长 2 天无活动过期；即使旧配置里 `SESSION_TTL_MS` 大于 2 天，服务也会按 2 天上限处理。

启动：

```powershell
node server.js
```

本机访问：

```text
http://127.0.0.1:5107
```

## 2. OCR 说明

本地运行可以处理文本层 PDF、Office 文档和文本资料；扫描版 PDF 的完整 OCR 需要安装 Python、PyMuPDF、PaddleOCR 等依赖。

本机运行时可通过环境变量指定 Python：

```text
PDF_AGENT_PYTHON=python
```

OCR 页数和超时时间可在 `.env` 中调整：

```text
PDF_AGENT_OCR_MAX_PAGES=80
PDF_AGENT_OCR_LEADING_PAGES=40
PDF_AGENT_TIMEOUT_MS=1200000
```

## 3. 发布前检查

每次发布前至少执行：

```powershell
node --check server.js
node --check public\app.js
npm.cmd test
```

`npm test` 在部分 Windows PowerShell 环境会被执行策略拦截，可改用 `npm.cmd test`。

## 4. 备份与恢复

当前版本仍使用 JSON 数据文件。小范围内测时必须定期备份：

```text
data/db.json
data/uploads/
data/runtime/
logs/audit.log
```

可以直接运行：

```powershell
npm run backup
```

备份会生成到：

```text
backups/backup-时间戳/
```

恢复时停止服务，替换 `data/` 和 `logs/` 后重新启动。多人并发和长期运行建议尽快迁移到 SQLite WAL 或 PostgreSQL。
