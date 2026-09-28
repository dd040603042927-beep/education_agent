# “知学伴”：机器学习课程学习诊断与个性化干预智能体

本项目是一个不依赖外网安装的本地全栈案例原型，后端使用原生 Node.js，前端是静态 SPA。

## 案例定位

知学伴面向某高校人工智能/计算机专业机器学习课程，聚焦一个可验证的学习闭环：

1. 学生通过前测、问答和作业，定位自己薄弱的机器学习知识点；
2. AI 结合知识图谱分析“为什么错”，给出可解释的错因和纠正建议；
3. 系统按诊断结果生成个性化练习，教师在班级看板中掌握差异并进行分层干预。

参赛展示建议以“诊断一名学生的逻辑回归/损失函数学习困难”为主线，模型实验、聊天等能力作为支撑资源，不作为并列卖点。

## 启动

```powershell
node server.js
```

默认访问地址：

```text
http://127.0.0.1:5107
```

## 竞赛部署

如果这是第三届全球数智教育创新大赛赛组四的参赛版本，建议直接阅读 [COMPETITION_DEPLOYMENT_PLAN.md](./COMPETITION_DEPLOYMENT_PLAN.md)。

上线前可先跑：

```powershell
npm run readiness
```

如需指定端口：

```powershell
$env:PORT=5108
node server.js
```

项目启动时会自动读取根目录 `.env`。建议复制 `.env.example` 为 `.env`，至少设置强随机 `SESSION_SECRET`。如果通过 HTTPS 反向代理公开访问，请设置 `COOKIE_SECURE=true`。

## Dify 工作流对接

项目 AI 助教保留统一入口 `/api/ai/chat`，但后端会按角色拆分工作流：学生端继续对接学习诊断工作流 `dify/ml_learning_diagnosis/ml_learning_diagnosis_assistant_upgraded_0_6_0.yml`，教师端对接独立的“教师教学工作流”。导入并发布对应 Dify App 后，在 Dify 的“访问 API”里创建 App API Key，并在项目 `.env` 中配置：

```env
DIFY_BASE_URL=http://127.0.0.1:8080/v1
DIFY_WORKFLOW_API_KEY=app-xxx
DIFY_STUDENT_WORKFLOW_API_KEY=app-xxx
DIFY_TEACHER_WORKFLOW_API_KEY=app-xxx
DIFY_TEACHER_WORKFLOW_NAME=teacher_teaching_assistant
DIFY_WORKFLOW_USER_PREFIX=education-agent
DIFY_WORKFLOW_TIMEOUT_MS=60000
DIFY_PROJECT_BASE_URL=http://127.0.0.1:5107
DIFY_GRAPH_CONTEXT_URL=http://127.0.0.1:5107/api/integrations/dify/graph-context
DIFY_CALLBACK_URL=http://127.0.0.1:5107/api/integrations/dify/diagnosis-callback
DIFY_CALLBACK_TOKEN=replace-me-with-long-random-token
```

`DIFY_STUDENT_WORKFLOW_API_KEY` 是学生端学习诊断工作流 key；未配置时会兼容读取旧的 `DIFY_WORKFLOW_API_KEY`。`DIFY_TEACHER_WORKFLOW_API_KEY` 是教师端教学工作流 key，教师端不会再复用学生学习诊断工作流。任一角色的工作流未配置时，该角色 AI 助教会返回明确的配置错误，不再回落到本地答案。

学生端请求会自动带上当前登录学生账号作为 `student_id`，用于诊断回调同步学习画像、错题和会话记录。教师端请求会带上 `teacher_id/request_user_id/request_user_role`，并使用更明确的教师 schema：`task/task_type`、`class_id`、`selected_material_ids`、`selected_graph_id`、`selected_node_id`、`homework_id`、`student_submission_id`、`rubric`、`project_rag_context`、`project_class_context` 和 `output_format`。教师工作流返回应至少包含 `final_answer`、`task_type`、`structured_result`、`citations`、`warnings`、`follow_up_actions` 和 `teacher_review_required`。

`DIFY_CALLBACK_TOKEN` 必须设置为强随机值；默认占位值和 `change-me` 会被后端视为未配置，Dify HTTP 回调将被拒绝。若 AI 助教返回 Dify HTTP 401，请检查 `.env` 中的 `DIFY_WORKFLOW_API_KEY` 是否来自已发布的 Dify 工作流 App。

工作流的项目资料输入来自教师端上传并发布的课程资料和知识图谱：后端会把当前用户可见、且匹配学科的课程资料、图谱节点和错因资料以 `project_rag_context`、`project_misconception_context`、`project_mastery_context` 传给工作流，并额外传入 `assistant_task`、`assistant_role_context`、`project_class_context`。学生端会引用对应学科教师上传并发布给学生可见的资料；教师端会按“备课、出题、批改、学情分析、课堂生成”任务传入班级、资料、图谱、作业和提交上下文。教师工作流默认使用 `sync_mode=teacher-api-return`，不会调用现有学生诊断回调写入学生学习画像；即使批改任务绑定了学生提交，也只返回 AI 建议，最终成绩仍需教师在作业模块确认。

新版学生诊断工作流内置“项目知识图谱数据库_HTTP节点”，会用 `DIFY_GRAPH_CONTEXT_URL` 和 `DIFY_CALLBACK_TOKEN` 直接调用项目后端 `/api/integrations/dify/graph-context`，按 `request_user_id`、`graph_id`、`node_id`、`knowledge_point` 查询当前用户可见的知识图谱数据库。Dify 内部知识库可以继续作为补充。Dify 工作流中的“项目数据库同步_HTTP节点”URL 应使用学生端请求传入的 `callback_url`；本地默认地址为 `http://127.0.0.1:5107`。

```text
POST http://127.0.0.1:5107/api/integrations/dify/diagnosis-callback
Authorization: Bearer <DIFY_CALLBACK_TOKEN>
Body: {"callback_payload":"{{#json_output.callback_payload#}}"}
```

手动测试学生诊断工作流或教师端调用时未填写学生 ID，项目会返回 `skipped: true`，不会让工作流失败；学生从前端 AI 助教触发时会自动带上学生 ID 并同步学习画像、错题和会话记录。

从前端 AI 助教触发的请求会传入 `sync_mode=api-return`：前端 `/api/ai/chat` 负责保存本轮问答会话，Dify HTTP 回调负责同步结构化诊断结果、掌握度、错题和运行记录，并跳过重复会话写入。

图谱生成支持一次选择多个 PDF/TXT/EPUB/Markdown 文件。前端会逐个分块上传，后端在一个图谱任务中解析多个文件并汇总文本、文件名、OCR 结果和补充目录，最终生成一个融合图谱。

## 内置账号

- 管理员：`20260000` / `123456`
- 教师：`20260001` / `123456`
- 学生：`20260002` / `123456`

注册新账号时会自动分配 8 位 ID。

## 发行基线

当前版本已补齐小范围内测所需的第一批安全与运维基线：

- 登录态使用后端签名的 `HttpOnly` session cookie，后端不再信任前端伪造的 `userId`。
- 注册账号会持久保存到后端数据文件；注册成功后自动建立登录态，用户未主动注销或管理员未删除时，账号不会因为登录态过期而消失。
- 注册用户名允许重复，系统分配的 8 位 ID 才是唯一账号标识；重名用户登录、加好友等操作应使用 8 位 ID，登录框也支持 `8位ID-姓名` 格式。
- 新注册教师默认不继承系统示例、总图谱、课程资料、班级、作业、好友或历史对话；学生可直接检索教师发布为“学生可检索”的公开课程资料，公开图谱同样会对学生可见，班级、作业、好友和历史对话仍需加入或创建后才出现。
- 登录态采用 2 天无活动自动过期策略；2 天内刷新页面或正常使用平台会自动续期并免去重新登录。
- 密码使用 Node 内置 `scrypt` 哈希存储，旧明文密码会自动迁移。
- 后端执行基础 RBAC，支持 `admin`、`teacher`、`student` 角色。
- 初始化数据包含内置管理员账号，旧数据启动时会自动补齐管理员用户。
- 登录失败次数限制和冷却保护。
- 敏感操作审计日志写入 `data/db.json` 的 `auditLogs`，同时追加到 `logs/audit.log`。
- API 和静态资源带基础安全响应头。
- 健康检查接口：`/api/healthz`、`/api/readyz`。
- `data/db.json` 写入改为临时文件 + rename 的原子写入方式。
- 上传会话和图谱生成任务持久化到 `data/runtime/`，服务重启后不会直接丢失任务状态。
- 上传入口增加后端文件格式白名单和基础文件头校验，阻断可执行文件、脚本类文件和伪装格式。
- 课程资料 RAG 增强为关键词召回 + 本地语义指纹 + 重排，回答引用来源更稳定。
- 作业批改增加 rubric 分项评分，AI 只生成建议分，教师确认后才成为正式成绩并更新学习画像。
- 增加 `npm run backup`，可备份 `data/` 和 `logs/` 到 `backups/`。

检查和烟测：

```powershell
npm run check
npm test
npm run backup
```

`npm test` 会临时启动一个测试端口，验证健康检查、登录 cookie、会话恢复、越权阻断、恶意上传拦截、机器学习代码真实执行和 AI 对话结构。

部署说明见 [DEPLOYMENT.md](./DEPLOYMENT.md)。当前默认绑定 `127.0.0.1`，仅供本机访问。

## 已实现模块

- 注册/登录：教师端、学生端按身份自动分流。
- 教师端：教学工作台、导入书本生成知识图谱、教学指导、历史对话、模型显示、聊天信息、班级管理、作业管理、个人信息。
- 学生端：学习首页、学科知识图谱、发起对话、历史对话、模型显示、聊天信息、作业提交、个人信息。
- 发行化 UI：登录页不再暴露演示账号；登录后默认进入角色工作台；侧边导航按总览、教学/学习、资源、管理、沟通、账户分组；未实现的对话预留入口已隐藏。
- 聊天信息：支持好友申请审批、私聊、群聊邀请审批、群成员邀请/移出、退出群聊、群主解散群聊和个人消息记录删除。
- 知识图谱：生成、JSON 导入、SVG 渲染、导出、删除、上传总图谱。
- 图谱交互：支持按钮/滚轮缩放、节点拖拽、双击节点查看该节点下的知识点。
- 书本识别：教师端可输入任意学科名称；上传 PDF 时默认使用 AI 自动图谱智能体抽取文本层内容，扫描版图片 PDF 会做有限 OCR，并和目录、文件名、补充知识点一起生成图谱。
- 大文件处理：PDF 上传改为 6MB 分块上传和后台任务，默认不再设置固定总上传大小，不把文件转成 Base64 JSON；生成时显示上传、解析、抽取、生成、保存进度，并对单个分块、图片流、解压输出和文本量做保护。
- 高级 PDF/OCR 智能体：后端优先调用 Python 的 PyMuPDF 读取 PDF 文本层，失败时再尝试 pdfplumber、pypdf；如果文本层不足，会用 PyMuPDF 渲染页面并调用 PaddleOCR 识别扫描版内容，最后才回退到 Node 轻量解析器。
- AI 对话：按讲解/出题/方案或学习方向生成回答，并保存历史。
- 模型显示：拖拉组件构建学科模型，支持真实/理想状态、保存、下载、删除；机器学习算法实验室可在画布代码编辑器中运行当前 Python 代码，真实返回 stdout/stderr/退出码/耗时，而不是固定展示预设结果。
- 聊天：按 ID 或姓名加好友、私聊、群聊、删除好友、删除选中消息。
- 班级：创建多学科班级、导入学生、邀请码申请加入、自动处理名单。
- 作业：发布文字/图片/视频作业与答案，学生提交多媒体答案，教师 AI 批改或手动批改。

数据保存在 `data/db.json`，首次启动会自动生成演示数据。

正式多班级、多学校长期运行前，仍建议把 `data/db.json` 迁移到 SQLite WAL 或 PostgreSQL，并引入任务队列、真实向量检索、真实 LLM、备份恢复、监控和端到端测试。发行路线和剩余清单见 [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md)。

说明：项目已忽略 `*.pdf`，避免把教材文件误提交到 GitHub。默认 AI 自动图谱智能体不限制总文件大小，但仍采用 6MB 分块上传和有限文本/OCR 处理来防止浏览器或后端崩溃；如需人为设置总上传上限，可配置 `MAX_UPLOAD_SIZE_BYTES`。扫描版 PDF 的高级 OCR 工具默认最多识别 80 页，其中优先识别前 40 页并抽样后续页面，可通过 `PDF_AGENT_OCR_MAX_PAGES`、`PDF_AGENT_OCR_LEADING_PAGES`、`PDF_AGENT_OCR_SCALE`、`PDF_AGENT_TIMEOUT_MS` 调整；AI 自动图谱智能体可通过 `AI_PDF_AGENT_OCR_MAX_PAGES`、`AI_PDF_AGENT_OCR_LEADING_PAGES`、`AI_PDF_AGENT_TIMEOUT_MS` 单独调节。
