const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.TEST_PORT || 5199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CALLBACK_TOKEN = "smoke-callback-token";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function requestBinary(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method || "POST",
    headers: {
      "content-type": "application/octet-stream",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.headers || {})
    },
    body: options.body
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function requestText(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {})
    }
  });
  return { response, text: await response.text() };
}

function startMockDify() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const body = bodyText ? JSON.parse(bodyText) : {};
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === "POST" && req.url === "/v1/embeddings") {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: inputs.map((input, index) => ({ index, embedding: [String(input || "").length, String(input || "").includes("KNN") ? 1 : 0, 1] })) }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const answer = [
          "## 直接回答",
          "KNN 的核心思想是根据距离选择 K 个最近邻，分类时用投票、回归时用平均或加权平均完成预测。",
          "",
          "## 依据与例子",
          "在特征尺度差异较大时，应先标准化，避免某个特征主导距离计算。",
          "",
          "## 易错提醒",
          "KNN 是基于样本邻近关系的监督学习方法，不会通过训练阶段拟合显式参数。",
          "",
          "## 下一步自检问题",
          "为什么 KNN 通常需要标准化？"
        ].join("\n");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                answer,
                topic_label: "KNN",
                mastery_score: null,
                mastery_level: "未诊断",
                error_tags: [],
                missing_points: [],
                next_questions: ["为什么 KNN 通常需要标准化？"]
              })
            }
          }]
        }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/workflows/run") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const inputs = body.inputs || {};
      const evidence = [
        {
          id: "E1",
          type: "material",
          title: "教师端课程资料",
          quote: "KNN 根据距离选取最近邻，并通过投票或平均完成预测。",
          ragChannel: "project"
        }
      ];
      const finalAnswer = [
        "## 知识点定位",
        "KNN（置信度 1）",
        "",
        "## 掌握度",
        "未诊断，得分 0",
        "",
        "## 标准解释",
        "KNN 的核心思想是根据距离找到最相似的 K 个训练样本，分类时多数投票，回归时取平均或加权平均。",
        "",
        "## 诊断反馈",
        "未提供学生自我理解，当前为知识问答模式，暂不进行掌握度扣分诊断。",
        "",
        "## 追问题",
        "1. KNN 为什么通常需要标准化？"
      ].join("\n");
      const structured = {
        topic_label: "KNN",
        topic_probability: 1,
        top_topic_candidates: [{ topic: "KNN", probability: 1 }],
        mastery_score: 0,
        mastery_level: "未诊断",
        error_tags: [],
        missing_points: ["未提供学生自我理解，当前仅生成标准解释。"],
        rag_evidence: evidence,
        final_answer: finalAnswer,
        question: inputs.question || "",
        request_user_id: inputs.request_user_id || "",
        request_user_role: inputs.request_user_role || "",
        assistant_task: inputs.assistant_task || "",
        assistant_task_label: inputs.assistant_task_label || "",
        subject: inputs.subject || "",
        chapter: inputs.chapter || "",
        knowledge_point: inputs.knowledge_point || ""
      };
      const callbackPayload = {
        student_id: inputs.student_id || "",
        class_id: inputs.class_id || "",
        conversation_id: inputs.conversation_id || "",
        request_id: inputs.request_id || "",
        sync_mode: inputs.sync_mode || "",
        request_user_id: inputs.request_user_id || "",
        request_user_role: inputs.request_user_role || "",
        assistant_task: inputs.assistant_task || "",
        assistant_task_label: inputs.assistant_task_label || "",
        subject: inputs.subject || "",
        chapter: inputs.chapter || "",
        knowledge_point: inputs.knowledge_point || "",
        question: inputs.question || "",
        student_answer: inputs.student_answer || "",
        topic_label: "KNN",
        mastery_score: 0,
        mastery_level: "未诊断",
        error_tags: [],
        missing_points: ["未提供学生自我理解，当前仅生成标准解释。"],
        rag_evidence: evidence,
        final_answer: finalAnswer,
        structured_result: structured
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        workflow_run_id: "wf-smoke",
        task_id: "task-smoke",
        data: {
          status: "succeeded",
          outputs: {
            final_answer: finalAnswer,
            structured_json: JSON.stringify(structured),
            callback_payload: JSON.stringify(callbackPayload),
            rag_evidence: JSON.stringify(evidence),
            topic_label: "KNN",
            topic_probability: 1,
            mastery_score: 0,
            mastery_level: "未诊断",
            error_tags: JSON.stringify([])
          }
        }
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

async function waitForReady() {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const { response, payload } = await request("/api/healthz");
      if (response.ok && payload.ok) return;
    } catch {
      // server not ready yet
    }
    await sleep(300);
  }
  throw new Error("server did not become ready");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assetVersionFromHomepage(html, assetName) {
  const match = String(html || "").match(new RegExp(`/${assetName.replace(".", "\\.")}\\?v=([^"']+)`));
  assert(match?.[1], `homepage should reference ${assetName} with a version query`);
  return match[1];
}

async function uploadTextFile(cookie, userId, fileName, text) {
  const buffer = Buffer.from(text, "utf8");
  const started = await request("/api/uploads/start", {
    method: "POST",
    cookie,
    body: { userId, fileName, fileType: "text/plain", size: buffer.length }
  });
  assert(started.response.status === 201 && started.payload.upload?.id, `upload session should start for ${fileName}`);
  const chunk = await requestBinary(`/api/uploads/${started.payload.upload.id}/chunk?index=0&offset=0`, {
    cookie,
    body: buffer
  });
  assert(chunk.response.ok && chunk.payload.upload?.received === buffer.length, `upload chunk should complete for ${fileName}`);
  return started.payload.upload;
}

async function waitForGraphJob(jobId, cookie) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const jobResult = await request(`/api/graphs/jobs/${jobId}`, { cookie });
    const job = jobResult.payload.job;
    if (job?.status === "complete") return job;
    if (job?.status === "failed") throw new Error(job.error || job.message || "graph generation failed");
    await sleep(250);
  }
  throw new Error(`graph job ${jobId} did not complete`);
}

async function waitForBackgroundJob(jobId, cookie) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await request(`/api/jobs/${jobId}`, { cookie });
    const job = result.payload.job;
    if (job?.status === "complete") return job;
    if (job?.status === "failed") throw new Error(job.error || "background job failed");
    await sleep(250);
  }
  throw new Error(`background job ${jobId} did not complete`);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "education-agent-smoke-"));
  const mockDify = await startMockDify();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATA_DIR: path.join(tempRoot, "data"),
      STORAGE_DRIVER: process.env.TEST_STORAGE_DRIVER || "sqlite",
      DATABASE_URL: path.join(tempRoot, "data", "education.db"),
      LOG_DIR: path.join(tempRoot, "logs"),
      BACKUP_DIR: path.join(tempRoot, "backups"),
      SESSION_SECRET: "release-smoke-test-secret",
      COOKIE_SECURE: "false",
      DIFY_BASE_URL: mockDify.baseUrl,
      DIFY_WORKFLOW_API_KEY: "app-smoke-test",
      DIFY_STUDENT_WORKFLOW_API_KEY: "app-smoke-test",
      DIFY_TEACHER_WORKFLOW_API_KEY: "app-smoke-test",
      DIFY_PROJECT_BASE_URL: BASE_URL,
      DIFY_GRAPH_CONTEXT_URL: `${BASE_URL}/api/integrations/dify/graph-context`,
      DIFY_CALLBACK_TOKEN: CALLBACK_TOKEN,
      OPENAI_API_KEY: "openai-smoke-key",
      OPENAI_BASE_URL: mockDify.baseUrl,
      OPENAI_MODEL: "smoke-chat-model",
      EMBEDDING_PROVIDER: "openai",
      EMBEDDING_API_KEY: "embedding-smoke-key",
      EMBEDDING_BASE_URL: mockDify.baseUrl,
      EMBEDDING_MODEL: "smoke-embedding"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForReady();

    const health = await request("/api/healthz");
    assert(health.payload.storageDriver === (process.env.TEST_STORAGE_DRIVER || "sqlite"), "health must report the selected storage driver");
    if (health.payload.storageDriver === "sqlite") {
      assert(health.payload.storagePath === path.join(tempRoot, "data", "education.db"), "SQLite smoke test must use its isolated database");
    }

    const homepage = await requestText("/");
    assert(homepage.response.ok, "homepage should load");
    assert(homepage.response.headers.get("cache-control")?.includes("no-store"), "homepage should disable stale static cache");
    const appAssetVersion = assetVersionFromHomepage(homepage.text, "app.js");
    const styleAssetVersion = assetVersionFromHomepage(homepage.text, "styles.css");
    assert(appAssetVersion === styleAssetVersion, "app and style assets should use the same cache-busting version");
    const appBundle = await requestText(`/app.js?v=${appAssetVersion}`);
    assert(appBundle.response.ok, "app bundle should load with version query");
    assert(appBundle.response.headers.get("cache-control")?.includes("no-store"), "app bundle should disable stale static cache");
    assert(appBundle.text.includes("renderTeacherHomePage") && appBundle.text.includes("renderStudentHomePage"), "app bundle should contain role dashboards");
    assert(!appBundle.text.includes("new Function(") && !appBundle.text.includes("eval("), "math modeling lab should avoid CSP-blocked dynamic JavaScript evaluation");
    assert(appBundle.text.includes("tokenizeMathExpression") && appBundle.text.includes("renderMathFunctionSvg"), "math modeling lab should include the CSP-safe expression plotter");
    const removedModuleKey = ["class", "room"].join("");
    const removedModulePascal = ["Class", "room"].join("");
    assert(!appBundle.text.includes(`render${removedModulePascal}Page`) && !appBundle.text.includes(`renderTeacher${removedModulePascal}Page`) && !appBundle.text.includes(`renderStudent${removedModulePascal}Page`), "removed module pages should stay out of the app bundle");
    assert(!appBundle.text.includes(`key: "${removedModuleKey}"`) && !appBundle.text.includes(`data-dashboard-page="${removedModuleKey}"`), "removed module navigation and dashboard entry should stay out");
    assert(!appBundle.text.includes(`data-material-${removedModuleKey}`), "removed material action should stay out of the app bundle");
    assert(!appBundle.text.includes(`data-graph-node-action="${removedModuleKey}"`), "removed graph action should stay out of the app bundle");
    assert(!appBundle.text.includes("ai-history-rail"), "AI page should not render a separate left history rail");
    assert(appBundle.text.includes("renderChatActionCards"), "app bundle should contain the unified chat action cards");
    assert(appBundle.text.includes("创建并发送邀请"), "app bundle should contain approval-based group creation UI");
    assert(appBundle.text.includes('data-chat-tool="pending"') && appBundle.text.includes('data-chat-tool="contacts"'), "chat page should expose pending and contacts as top toolbar actions");
    assert(appBundle.text.includes("class-management-grid") && appBundle.text.includes("class-active-panel"), "class management should render the coordinated workspace layout");
    assert(!appBundle.text.includes("${renderChatInfoPanel(active, friends)}"), "chat layout should not render the old fixed right info rail");
    assert(!appBundle.text.includes("chat-action-head"), "app bundle should not contain the old chat action header");
    assert(!appBundle.text.includes("面向备课、授课、班级与作业闭环"), "top bar should not contain the old teacher subtitle");
    assert(!appBundle.text.includes("内置教师：20260001"), "release login should not expose demo account credentials");
    assert(!appBundle.text.includes("该入口已预留"), "release UI should not include reserved fake-entry prompts");

    const anonymousState = await request("/api/state");
    assert(anonymousState.response.status === 401, "anonymous /api/state should be rejected");

    const adminLogin = await request("/api/auth/login", {
      method: "POST",
      body: { account: "20260000", password: "123456" }
    });
    const adminCookie = String(adminLogin.response.headers.get("set-cookie") || "").split(";")[0];
    assert(adminLogin.response.ok && adminLogin.payload.user?.role === "admin", "built-in admin should be able to log in");
    const adminExport = await request("/api/admin/export?format=json", { cookie: adminCookie });
    assert(adminExport.response.ok && adminExport.payload.report?.summary?.students >= 1, "admin export should load after RBAC");
    assert(adminExport.payload.report?.sections?.some((section) => section.title === "匿名学生列表"), "admin export should include anonymous student list");
    const adminCsvExport = await request("/api/admin/export?format=csv", { cookie: adminCookie });
    assert(adminCsvExport.response.ok && adminCsvExport.payload.fileName?.endsWith(".csv") && adminCsvExport.payload.content?.includes("学习周期时间线"), "admin CSV export should include required sections");

    const weakRegister = await request("/api/auth/register", {
      method: "POST",
      body: { name: "密码测试", password: "123", role: "teacher", subject: "数学" }
    });
    assert(weakRegister.response.status === 400, "weak registration password should be rejected");

    const duplicateRegister = await request("/api/auth/register", {
      method: "POST",
      body: { name: "黄豆", password: "123456", role: "teacher", subject: "机器学习" }
    });
    assert(duplicateRegister.response.status === 201 && duplicateRegister.payload.user?.id, "duplicate display name registration should succeed");
    const duplicateUserId = duplicateRegister.payload.user.id;
    const registerSetCookie = String(duplicateRegister.response.headers.get("set-cookie") || "");
    const duplicateTeacherCookie = registerSetCookie.split(";")[0];
    assert(registerSetCookie.includes("edu_session=") && registerSetCookie.includes("Max-Age=172800"), "registration should auto-login with 2-day session cookie");
    assert(duplicateRegister.payload.state?.user?.id === duplicateUserId, "registration should return the new user's initial state");
    assert(duplicateRegister.payload.state.knowledgeGraphs.length === 0, "registered teacher initial state should not inherit graphs");
    assert(duplicateRegister.payload.state.courseMaterials.length === 0, "registered teacher initial state should not inherit materials");

    const duplicateNameLogin = await request("/api/auth/login", {
      method: "POST",
      body: { account: "黄豆", password: "123456" }
    });
    assert(duplicateNameLogin.response.status === 409, "duplicate display name login should require unique ID");

    const idNameLogin = await request("/api/auth/login", {
      method: "POST",
      body: { account: `${duplicateUserId}-黄豆`, password: "123456" }
    });
    assert(idNameLogin.response.ok && idNameLogin.payload.ok, "ID-name account format should login by the unique ID");

    const newTeacherLogin = await request("/api/auth/login", {
      method: "POST",
      body: { account: duplicateUserId, password: "123456" }
    });
    assert(newTeacherLogin.response.ok && newTeacherLogin.payload.ok, "new duplicate-name teacher should login by ID");
    const newTeacherState = newTeacherLogin.payload.state;
    assert(newTeacherState.knowledgeGraphs.length === 0, "new registered teacher should not inherit global graphs");
    assert(newTeacherState.courseMaterials.length === 0, "new registered teacher should not inherit global course materials");
    assert(newTeacherState.classes.length === 0, "new registered teacher should start without classes");
    assert(newTeacherState.homework.length === 0, "new registered teacher should start without homework");
    assert(newTeacherState.conversations.length === 0, "new registered teacher should start without conversations");
    assert(newTeacherState.models.length === 0, "new registered teacher should start without saved models");
    assert(newTeacherState.friends.length === 0 && newTeacherState.chatThreads.length === 0, "new registered teacher should start without friends or chats");

    const modelCodeRun = await request("/api/model-code/run", {
      method: "POST",
      cookie: duplicateTeacherCookie,
      body: {
        userId: duplicateUserId,
        subject: "机器学习",
        title: "smoke real code execution",
        code: "values = [1, 2, 3, 4]\nprint('sum:', sum(values))\nprint('mean:', round(sum(values) / len(values), 2))"
      }
    });
    assert(modelCodeRun.response.ok && modelCodeRun.payload.success === true, "model code runner should execute Python code successfully");
    assert(modelCodeRun.payload.output.includes("sum: 10") && modelCodeRun.payload.output.includes("mean: 2.5"), "model code runner should return real stdout");

    const plainTextRun = await request("/api/model-code/run", {
      method: "POST",
      cookie: duplicateTeacherCookie,
      body: {
        userId: duplicateUserId,
        subject: "机器学习",
        title: "plain text execution",
        code: "hello machine learning lab"
      }
    });
    assert(plainTextRun.response.ok && plainTextRun.payload.success === true, "model code runner should accept a plain one-line statement");
    assert(plainTextRun.payload.output.includes("hello machine learning lab"), "plain one-line statement should be printed");

    const studentRegister = await request("/api/auth/register", {
      method: "POST",
      body: { name: "同名测试学生", password: "123456", role: "student", className: "未加入" }
    });
    assert(studentRegister.response.status === 201 && studentRegister.payload.user?.id, "new student registration should succeed");
    const newStudentLogin = await request("/api/auth/login", {
      method: "POST",
      body: { account: studentRegister.payload.user.id, password: "123456" }
    });
    assert(newStudentLogin.response.ok && newStudentLogin.payload.ok, "new student should login by ID");
    const newStudentId = studentRegister.payload.user.id;
    const newStudentCookie = String(newStudentLogin.response.headers.get("set-cookie") || "").split(";")[0];
    const newStudentState = newStudentLogin.payload.state;
    assert(newStudentState.knowledgeGraphs.length === 0, "new registered student should not see private teacher graphs by default");
    assert(newStudentState.courseMaterials.some((item) => item.global && item.subject === "机器学习"), "new registered student should see teacher-published global course materials");
    assert(newStudentState.classes.length === 0, "new registered student should start without classes");
    assert(newStudentState.homework.length === 0, "new registered student should start without homework");
    assert(newStudentState.friends.length === 0 && newStudentState.chatThreads.length === 0, "new registered student should start without friends or chats");

    const publicMlMaterial = newStudentState.courseMaterials.find((item) => item.global && item.subject === "机器学习" && item.chunkCount > 0);
    assert(publicMlMaterial, "new registered student should have a usable public machine learning material for knowledge tests");
    const knowledgeQuiz = await request("/api/knowledge-tests/generate", {
      method: "POST",
      cookie: newStudentCookie,
      body: {
        subject: "机器学习",
        materialId: publicMlMaterial.id,
        count: 4
      }
    });
    assert(knowledgeQuiz.response.ok, "student knowledge test generation should use visible teacher materials");
    assert((knowledgeQuiz.payload.quiz?.questions || []).length >= 3, "knowledge test should generate multiple material-grounded questions");
    assert((knowledgeQuiz.payload.quiz?.citations || []).some((item) => item.type === "material" && item.global), "knowledge test should expose teacher material citations");
    const quizQuestion = knowledgeQuiz.payload.quiz.questions[0];
    const quizAnswer = [
      `首先，${quizQuestion.topic}需要结合资料中的关键点说明。`,
      `本题答案覆盖 ${quizQuestion.expectedKeywords.slice(0, 8).join("、")}。`,
      "其次，需要说明定义、条件、步骤、作用和一个例子，最后给出结论。"
    ].join("");
    const knowledgeEvaluation = await request("/api/knowledge-tests/evaluate", {
      method: "POST",
      cookie: newStudentCookie,
      body: {
        quizId: knowledgeQuiz.payload.quiz.id,
        subject: "机器学习",
        materialId: publicMlMaterial.id,
        question: quizQuestion,
        answer: quizAnswer,
        attempts: [],
        questionCount: knowledgeQuiz.payload.quiz.questions.length
      }
    });
    assert(knowledgeEvaluation.response.ok, "student knowledge test answer should be evaluated");
    assert(knowledgeEvaluation.payload.result?.overall?.accuracy > 0, "knowledge test evaluation should return cumulative accuracy");
    assert(knowledgeEvaluation.payload.result?.overall?.masteryLevel, "knowledge test evaluation should return a mastery level");
    const afterKnowledgeTestState = await request("/api/state", { cookie: newStudentCookie });
    assert(afterKnowledgeTestState.payload.state.learningAnalytics?.profile?.mastery?.[quizQuestion.topic], "knowledge test should update the student's learning profile mastery");

    const publicMaterialChat = await request("/api/ai/chat", {
      method: "POST",
      cookie: newStudentCookie,
      body: {
        userId: newStudentId,
        subject: "机器学习",
        mode: "qa",
        prompt: "KNN 的核心思想是什么？"
      }
    });
    assert(publicMaterialChat.response.ok, "student AI chat should call the backend model");
    const publicMaterialAssistant = publicMaterialChat.payload.messages?.find((message) => message.role === "assistant");
    const studentCitations = publicMaterialAssistant?.citations || [];
    const studentRetrieved = publicMaterialAssistant?.retrieved || [];
    assert(studentCitations.length > 0, "student AI chat should expose teacher-uploaded citation sources");
    assert(studentCitations.some((item) => item.subject === "机器学习" && item.global), "student AI chat citations should include visible machine learning teacher materials");
    assert(studentCitations.every((item) => item.contentSha256 && item.verification?.status === "verified"), "local retrieval citations must include a verifiable source hash and exact-quote verification");
    assert(studentRetrieved.length > 0, "student AI chat should expose retrieved source chunks for citation display");
    assert(studentRetrieved.some((item) => item.scoreDetail?.embedding === true), "student retrieval should use the configured real embedding provider");
    assert(publicMaterialAssistant?.workflow?.name === "学生画像驱动课程问答助手", "student AI chat should return the native model trace");
    const publicMaterialAnswer = String(publicMaterialAssistant?.content || "");
    assert(publicMaterialAnswer.includes("## 直接回答") && publicMaterialAnswer.includes("KNN"), "student AI chat should return the model answer");
    assert(publicMaterialAnswer.includes("## 易错提醒") && publicMaterialAnswer.includes("## 下一步自检问题"), "student AI chat answer should retain the required learning structure");
    assert(publicMaterialAssistant?.workflowResult?.topic_label, "student AI chat should expose a native structured topic result");
    assert(publicMaterialAssistant?.workflowResult?.source === "native-openai-compatible", "student AI chat should use the backend direct model");
    const nativeModelRun = mockDify.requests.find((item) => item.method === "POST" && item.url === "/v1/chat/completions");
    assert(nativeModelRun, "mock model should receive the student chat completion");
    assert(nativeModelRun.headers.authorization === "Bearer openai-smoke-key", "student model request should use OPENAI_API_KEY");
    assert(nativeModelRun.body.model === "smoke-chat-model", "student model request should use OPENAI_MODEL");
    const nativePrompt = nativeModelRun.body.messages?.map((item) => item.content).join("\n") || "";
    assert(nativePrompt.includes("学生画像摘要"), "student model prompt should include the current learning profile");
    assert(nativePrompt.includes("课程证据") && nativePrompt.includes("[S1]"), "student model prompt should include retrieved course evidence");

    const queuedChat = await request("/api/ai/jobs", {
      method: "POST",
      cookie: newStudentCookie,
      body: { userId: newStudentId, subject: "机器学习", mode: "qa", prompt: "KNN 为什么需要标准化？" }
    });
    assert(queuedChat.response.status === 202 && queuedChat.payload.job?.id, "AI requests should be accepted as recoverable background jobs");
    const completedChat = await waitForBackgroundJob(queuedChat.payload.job.id, newStudentCookie);
    assert(completedChat.result?.conversation?.id && completedChat.result?.messages?.some((message) => message.role === "assistant"), "completed AI job should persist and return its conversation result");

    const blockedCheating = await request("/api/ai/chat", {
      method: "POST",
      cookie: newStudentCookie,
      body: { userId: newStudentId, subject: "机器学习", mode: "qa", prompt: "请替我完成考试试卷" }
    });
    const blockedAnswer = blockedCheating.payload.messages?.find((message) => message.role === "assistant");
    assert(blockedCheating.response.ok && blockedAnswer?.confidence === "blocked", "education safety routing should intercept academic-integrity requests");

    const beforeApiReturnCallbackState = await request("/api/state", { cookie: newStudentCookie });
    const beforeApiReturnConversationCount = beforeApiReturnCallbackState.payload.state.conversations.length;
    const difyApiReturnCallback = await request("/api/integrations/dify/diagnosis-callback", {
      method: "POST",
      headers: { authorization: `Bearer ${CALLBACK_TOKEN}` },
      body: {
        callback_payload: JSON.stringify({
          student_id: newStudentId,
          conversation_id: publicMaterialChat.payload.conversation.id,
          request_id: "smoke-api-return",
          sync_mode: "api-return",
          question: "KNN 的核心思想是什么？",
          student_answer: "KNN 根据距离选择近邻并投票，但我还没有解释 K 值选择。",
          topic_label: "KNN",
          mastery_score: 68,
          mastery_level: "基本理解",
          error_tags: ["K值选择缺失"],
          missing_points: ["缺少 K 值选择说明"],
          final_answer: "## 知识点定位\nKNN\n\n## 掌握度\n基本理解，得分 68"
        })
      }
    });
    const afterApiReturnCallbackState = await request("/api/state", { cookie: newStudentCookie });
    assert(difyApiReturnCallback.response.ok && difyApiReturnCallback.payload.synced?.skippedConversationWrite === true, "Dify api-return callback should skip duplicate conversation writes");
    assert(afterApiReturnCallbackState.payload.state.conversations.length === beforeApiReturnConversationCount, "Dify api-return callback should not create another student conversation");
    assert(difyApiReturnCallback.payload.synced?.masteryUpdated === true, "Dify api-return callback should still update mastery from structured diagnosis");

    const difyCallback = await request("/api/integrations/dify/diagnosis-callback", {
      method: "POST",
      headers: { authorization: `Bearer ${CALLBACK_TOKEN}` },
      body: {
        student_id: newStudentId,
        question: "KNN 的核心思想是什么？",
        student_answer: "KNN 根据距离选择近邻并投票，但我没有说明评价指标。",
        topic_label: "KNN",
        mastery_score: 72,
        mastery_level: "基本掌握",
        error_tags: ["评价指标缺失"],
        missing_points: ["缺少评价指标说明"],
        final_answer: "Dify 工作流诊断：KNN 需要说明距离度量、K 值选择、近邻投票和评价指标。"
      }
    });
    assert(difyCallback.response.ok && difyCallback.payload.synced?.wrongNoteId, "Dify diagnosis callback should sync mastery and wrong notes");

    const difyDryRunCallback = await request("/api/integrations/dify/diagnosis-callback", {
      method: "POST",
      headers: { authorization: `Bearer ${CALLBACK_TOKEN}` },
      body: {
        callback_payload: JSON.stringify({
          question: "KNN 的核心思想是什么？",
          topic_label: "KNN",
          mastery_score: 0,
          mastery_level: "未诊断",
          error_tags: [],
          missing_points: ["未提供学生自我理解，当前仅生成标准解释。"],
          final_answer: "## 知识点定位\nKNN（置信度 1.0）"
        })
      }
    });
    assert(difyDryRunCallback.response.ok && difyDryRunCallback.payload.synced?.skipped === true, "Dify workflow dry run without student_id should not fail the HTTP callback node");

    const login = await request("/api/auth/login", {
      method: "POST",
      body: { account: "20260001", password: "123456" }
    });
    assert(login.response.ok && login.payload.ok, "teacher login should succeed");
    const cookie = String(login.response.headers.get("set-cookie") || "").split(";")[0];
    const loginSetCookie = String(login.response.headers.get("set-cookie") || "");
    assert(cookie.includes("edu_session="), "login should set session cookie");
    assert(loginSetCookie.includes("Max-Age=172800"), "login cookie should use 2-day idle max age");

    const state = await request("/api/state", { cookie });
    assert(state.response.ok && state.payload.state?.user?.id === "20260001", "session state should resolve current user");
    const refreshedCookie = String(state.response.headers.get("set-cookie") || "");
    assert(refreshedCookie.includes("edu_session=") && refreshedCookie.includes("Max-Age=172800"), "authenticated state should refresh 2-day session cookie");
    assert(state.payload.state.user.subject === "机器学习", "seed teacher should default to the machine learning course example");
    const mlMaterial = state.payload.state.courseMaterials.find((item) => item.subject === "机器学习" && item.title.includes("动手学机器学习"));
    assert(mlMaterial && mlMaterial.chunkCount > 0, "machine learning seed material should be searchable");
    const mlGraph = state.payload.state.knowledgeGraphs.find((item) => item.subject === "机器学习" && item.title.includes("动手学机器学习"));
    assert(mlGraph && mlGraph.nodes.length >= 30 && mlGraph.links.length >= 20, "machine learning seed graph should be available");
    const knnNode = mlGraph.nodes.find((node) => /K\s*近邻|KNN|最近邻/i.test(node.label)) || mlGraph.nodes.find((node) => /机器学习|监督学习/.test(node.label)) || mlGraph.nodes[0];
    assert(knnNode?.id, "machine learning graph should expose an actionable node");

    const graphContext = await request("/api/integrations/dify/graph-context", {
      method: "POST",
      headers: { authorization: `Bearer ${CALLBACK_TOKEN}` },
      body: {
        request_user_id: "20260001",
        subject: "机器学习",
        question: `请讲解 ${knnNode.label}`,
        graph_id: mlGraph.id,
        node_id: knnNode.id
      }
    });
    assert(graphContext.response.ok && graphContext.payload.source === "project-knowledge-graph-db", "Dify graph context endpoint should query the project graph database");
    const graphContextDocs = graphContext.payload.documents || [];
    assert(graphContextDocs.some((item) => item.graphId === mlGraph.id && item.nodeId === knnNode.id), "Dify graph context endpoint should return the selected graph node");

    const graphUploadA = await uploadTextFile(cookie, "20260001", "ml-multifile-a.txt", [
      "机器学习多文件图谱 A",
      "KNN 通过距离度量寻找最近的 K 个样本，分类任务使用多数投票。",
      "关键步骤包括选择 K 值、标准化特征、计算距离和汇总邻居标签。"
    ].join("\n"));
    const graphUploadB = await uploadTextFile(cookie, "20260001", "ml-multifile-b.txt", [
      "机器学习多文件图谱 B",
      "逻辑回归使用 sigmoid 函数输出类别概率，适合二分类任务。",
      "KNN 与逻辑回归的差异包括训练方式、决策边界和特征尺度敏感性。"
    ].join("\n"));
    const multiFileGraphStart = await request("/api/graphs/generate-upload", {
      method: "POST",
      cookie,
      body: {
        userId: "20260001",
        subject: "机器学习",
        title: "多文件汇总图谱 smoke",
        sourceName: "ml-multifile-a.txt、ml-multifile-b.txt",
        sourceText: "汇总生成 KNN、逻辑回归、距离度量、标准化、二分类等节点，并建立对比关系。",
        uploadIds: [graphUploadA.id, graphUploadB.id]
      }
    });
    assert(multiFileGraphStart.response.status === 202 && multiFileGraphStart.payload.job?.id, "multi-file graph generation should create one graph job");
    const multiFileGraphJob = await waitForGraphJob(multiFileGraphStart.payload.job.id, cookie);
    assert(multiFileGraphJob.meta?.fileCount === 2, "multi-file graph job should keep the source file count");
    assert((multiFileGraphJob.meta?.sourceFiles || []).length === 2, "multi-file graph job should keep both source files");
    assert(multiFileGraphJob.meta?.extraction?.fileCount === 2, "multi-file graph extraction should aggregate both files");
    const afterMultiGraphState = await request("/api/state", { cookie });
    const multiFileGraph = afterMultiGraphState.payload.state.knowledgeGraphs.find((item) => item.id === multiFileGraphJob.graphId);
    assert(multiFileGraph?.nodes?.length > 0, "multi-file graph generation should save one merged graph");

    const graphActionChats = [
      {
        mode: "explain",
        answerDepth: "layered",
        prompt: `请基于课程资料和知识图谱，分层讲解「${knnNode.label}」。请包含定义、算法流程、关键条件、例子和常见误区。`
      },
      {
        mode: "practice",
        answerDepth: "layered",
        prompt: `请基于课程资料和当前图谱节点「${knnNode.label}」生成课堂练习题，包含答案解析。`
      },
      {
        mode: "plan",
        answerDepth: "layered",
        prompt: `请根据知识图谱前置关系，为「${knnNode.label}」生成学习路径。`
      },
      {
        mode: "explain",
        answerDepth: "full",
        prompt: `请对比「${knnNode.label}」与「逻辑回归」，说明适用场景、关键假设、参数影响和易混淆点。`
      }
    ];
    const graphWorkflowRunStart = mockDify.requests.length;
    for (const actionChat of graphActionChats) {
      const actionResult = await request("/api/ai/chat", {
        method: "POST",
        cookie,
        body: {
          userId: "20260001",
          subject: "机器学习",
          chapter: "《动手学机器学习》知识图谱",
          knowledgePoint: knnNode.label,
          graphId: mlGraph.id,
          nodeId: knnNode.id,
          ...actionChat
        }
      });
      assert(actionResult.response.ok, `graph AI action ${actionChat.mode} should succeed`);
      const assistant = actionResult.payload.messages?.find((message) => message.role === "assistant");
      assert(assistant?.content && assistant.learningPanel, "graph AI action should return assistant content and learning panel");
      assert((assistant.citations || []).length || actionResult.payload.conversation?.messages?.some((message) => message.citations?.length), "graph AI action should attach course or graph citations");
    }
    const graphWorkflowRuns = mockDify.requests
      .slice(graphWorkflowRunStart)
      .filter((item) => item.method === "POST" && item.url === "/v1/workflows/run");
    assert(graphWorkflowRuns.length >= graphActionChats.length, "graph AI actions should call the Dify workflow");
    const graphFocusRun = graphWorkflowRuns.find((run) => {
      const docs = JSON.parse(run.body.inputs?.project_rag_context || "[]");
      return docs.some((item) => item.type === "graph" && item.graphId === mlGraph.id && item.nodeId === knnNode.id && item.ragChannel === "graph-focus");
    });
    assert(graphFocusRun, "graph AI workflow run should include the selected knowledge graph node in project_rag_context");
    assert(graphFocusRun.body.inputs?.student_id === "", "teacher graph workflow run should not sync as a student diagnosis");
    assert(["lesson_plan", "quiz_generation", "grading", "class_analysis", "remedial_plan"].includes(graphFocusRun.body.inputs?.assistant_task), "teacher graph workflow run should include the assistant task mode");
    const graphMasteryContext = JSON.parse(graphFocusRun.body.inputs?.project_mastery_context || "{}");
    const graphRoleContext = JSON.parse(graphFocusRun.body.inputs?.assistant_role_context || "{}");
    const graphClassContext = JSON.parse(graphFocusRun.body.inputs?.project_class_context || "{}");
    assert(graphMasteryContext.request_user_id === "20260001" && graphMasteryContext.request_user_role === "teacher", "teacher graph workflow run should include request user metadata");
    assert(graphRoleContext.request_user_role === "teacher", "teacher graph workflow run should include structured role context");
    assert(graphClassContext.role === "teacher", "teacher graph workflow run should include teacher class context");

    const friendRequest = await request("/api/friends", {
      method: "POST",
      cookie,
      body: { userId: "20260001", target: newStudentId, message: "chat smoke test" }
    });
    assert(friendRequest.response.status === 201 && friendRequest.payload.request?.status === "pending", "friend add should create pending request");
    const newStudentPendingState = await request("/api/state", { cookie: newStudentCookie });
    assert(newStudentPendingState.payload.state.friendRequests.some((item) => item.id === friendRequest.payload.request.id && item.toUserId === newStudentId), "friend request should be visible to recipient");

    const acceptedFriend = await request(`/api/friend-requests/${friendRequest.payload.request.id}/respond`, {
      method: "POST",
      cookie: newStudentCookie,
      body: { userId: newStudentId, action: "accept" }
    });
    assert(acceptedFriend.response.ok && acceptedFriend.payload.request.status === "accepted", "recipient should accept friend request");
    const acceptedStudentState = acceptedFriend.payload.state;
    assert(acceptedStudentState.friends.some((item) => item.id === "20260001"), "accepted friend request should create friendship");
    assert(acceptedStudentState.chatThreads.some((item) => item.type === "direct" && item.memberIds.includes("20260001")), "accepted friend request should create direct chat");

    const groupCreate = await request("/api/chat/groups", {
      method: "POST",
      cookie,
      body: { ownerId: "20260001", name: "Smoke Group", memberIds: [newStudentId] }
    });
    assert(groupCreate.response.status === 201 && groupCreate.payload.thread?.id, "group creation should succeed");
    assert(groupCreate.payload.thread.memberIds.length === 1 && groupCreate.payload.thread.memberIds[0] === "20260001", "invited members should not join group before approval");
    assert(groupCreate.payload.invites.length === 1 && groupCreate.payload.invites[0].status === "pending", "group creation should create pending invite");

    const groupInviteId = groupCreate.payload.invites[0].id;
    const studentInviteState = await request("/api/state", { cookie: newStudentCookie });
    assert(studentInviteState.payload.state.chatInvites.some((item) => item.id === groupInviteId && item.toUserId === newStudentId), "group invite should be visible to recipient");

    const acceptedInvite = await request(`/api/chat/invites/${groupInviteId}/respond`, {
      method: "POST",
      cookie: newStudentCookie,
      body: { userId: newStudentId, action: "accept" }
    });
    assert(acceptedInvite.response.ok && acceptedInvite.payload.invite.status === "accepted", "recipient should accept group invite");
    assert(acceptedInvite.payload.thread.memberIds.includes(newStudentId), "accepted group invite should add member");

    const groupMessage = await request("/api/chat/messages", {
      method: "POST",
      cookie: newStudentCookie,
      body: { threadId: groupCreate.payload.thread.id, fromUserId: newStudentId, content: "hello group" }
    });
    assert(groupMessage.response.status === 201 && groupMessage.payload.message?.id, "accepted group member should send group message");

    const dissolvedGroup = await request(`/api/chat/groups/${groupCreate.payload.thread.id}`, {
      method: "DELETE",
      cookie,
      body: { userId: "20260001" }
    });
    assert(dissolvedGroup.response.ok, "group owner should dissolve group");

    const tampered = await request("/api/ai/chat", {
      method: "POST",
      cookie,
      body: { userId: "20260002", prompt: "伪造学生身份提问", mode: "qa" }
    });
    assert(tampered.response.status === 403, "tampered userId should be rejected");

    const tamperedTeacher = await request("/api/classes", {
      method: "POST",
      cookie,
      body: { teacherId: "20260000", name: "越权班级", subject: "数学" }
    });
    assert(tamperedTeacher.response.status === 403, "tampered teacherId should be rejected");

    const executableUpload = await request("/api/uploads/start", {
      method: "POST",
      cookie,
      body: { userId: "20260001", fileName: "evil.exe", fileType: "application/x-msdownload", size: 32 }
    });
    assert(executableUpload.response.status === 415, "executable upload should be rejected");

    const chat = await request("/api/ai/chat", {
      method: "POST",
      cookie,
      body: { userId: "20260001", prompt: "请解释课程资料中的核心知识点", mode: "explain", subject: "通用" }
    });
    assert(chat.response.ok && chat.payload.messages?.[1]?.learningPanel, "AI chat should return learning panel");

    const createdClass = await request("/api/classes", {
      method: "POST",
      cookie,
      body: { teacherId: "20260001", name: "烟测班级", subject: "物理" }
    });
    assert(createdClass.response.status === 201 && createdClass.payload.class?.id, "teacher should create a class before assigning homework");

    const classPrivateMaterial = await request("/api/materials", {
      method: "POST",
      cookie,
      body: {
        userId: "20260001",
        subject: "物理",
        title: "烟测班级非公开资料",
        sourceText: "这是一份只应教师可见的班级内部资料。",
        global: false,
        classId: createdClass.payload.class.id
      }
    });
    assert(classPrivateMaterial.response.status === 201 && classPrivateMaterial.payload.material?.id, "teacher should create a private class material");

    const createdHomework = await request("/api/homework", {
      method: "POST",
      cookie,
      body: {
        teacherId: "20260001",
        classId: createdClass.payload.class.id,
        title: "牛顿第二定律应用题",
        description: "请解释 F=ma 在水平面匀加速运动中的含义，并完成一道自拟例题。",
        answer: "力等于质量与加速度的乘积。解题时先受力分析，再列出 F=ma，结合运动学公式求解。"
      }
    });
    assert(createdHomework.response.status === 201 && createdHomework.payload.homework?.id, "teacher should create homework from an explicit operation");
    const homeworkId = createdHomework.payload.homework.id;

    const studentLogin = await request("/api/auth/login", {
      method: "POST",
      body: { account: "20260002", password: "123456" }
    });
    assert(studentLogin.response.ok && studentLogin.payload.ok, "student login should succeed");
    const studentCookie = String(studentLogin.response.headers.get("set-cookie") || "").split(";")[0];

    const classApply = await request(`/api/classes/${createdClass.payload.class.id}/apply`, {
      method: "POST",
      cookie: studentCookie,
      body: { studentId: "20260002" }
    });
    assert(classApply.response.ok && classApply.payload.application?.status === "pending", "student outside imported roster should wait for teacher approval");

    const approveClassApply = await request(`/api/classes/${createdClass.payload.class.id}/applications/${classApply.payload.application.id}`, {
      method: "POST",
      cookie,
      body: { teacherId: "20260001", action: "accept" }
    });
    assert(approveClassApply.response.ok && approveClassApply.payload.application?.status === "approved", "teacher should approve the class join request before homework submission");

    const secondClass = await request("/api/classes", {
      method: "POST",
      cookie,
      body: { teacherId: "20260001", name: "烟测第二班", subject: "数学" }
    });
    assert(secondClass.response.status === 201 && secondClass.payload.class?.id, "teacher should create a second class");

    const secondClassApply = await request(`/api/classes/${secondClass.payload.class.inviteCode}/apply`, {
      method: "POST",
      cookie: studentCookie,
      body: { studentId: "20260002" }
    });
    assert(secondClassApply.response.ok && secondClassApply.payload.application?.status === "pending", "student should need approval when joining a second class by invite code");

    const approveSecondClassApply = await request(`/api/classes/${secondClass.payload.class.id}/applications/${secondClassApply.payload.application.id}`, {
      method: "POST",
      cookie,
      body: { teacherId: "20260001", action: "accept" }
    });
    assert(approveSecondClassApply.response.ok && approveSecondClassApply.payload.application?.status === "approved", "teacher should approve the second class join request");

    const multiClassState = await request("/api/state", { cookie: studentCookie });
    const joinedClassIds = new Set((multiClassState.payload.state.classes || []).map((item) => item.id));
    assert(joinedClassIds.has(createdClass.payload.class.id) && joinedClassIds.has(secondClass.payload.class.id), "student state should include multiple joined classes");
    assert(!multiClassState.payload.state.courseMaterials.some((item) => item.id === classPrivateMaterial.payload.material.id), "joining a class should not expose private teacher class materials");

    const leaveSecondClass = await request(`/api/classes/${secondClass.payload.class.id}/students/20260002`, {
      method: "DELETE",
      cookie: studentCookie
    });
    assert(leaveSecondClass.response.ok && leaveSecondClass.payload.removed === true, "student should leave one joined class");

    const afterLeaveSecondState = await request("/api/state", { cookie: studentCookie });
    const afterLeaveClassIds = new Set((afterLeaveSecondState.payload.state.classes || []).map((item) => item.id));
    assert(afterLeaveClassIds.has(createdClass.payload.class.id) && !afterLeaveClassIds.has(secondClass.payload.class.id), "leaving one class should keep other class memberships");

    const submitted = await request(`/api/homework/${homeworkId}/submit`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        studentId: "20260002",
        answerText: "F=ma 表示合外力等于质量乘加速度。解题时要先受力分析，再建立坐标轴列牛顿第二定律，并结合运动学公式求解。"
      }
    });
    assert(submitted.response.ok && submitted.payload.submission?.id, "student homework submission should succeed");
    const submissionId = submitted.payload.submission.id;

    const aiGrade = await request(`/api/submissions/${submissionId}/ai-grade`, {
      method: "POST",
      cookie,
      body: { teacherId: "20260001" }
    });
    assert(aiGrade.response.ok, "AI grade suggestion should succeed");
    assert(aiGrade.payload.submission.status === "review_pending", "AI grading should require teacher confirmation");
    assert(Number.isFinite(Number(aiGrade.payload.submission.aiSuggestedScore)), "AI grading should return suggested score");
    assert(Array.isArray(aiGrade.payload.submission.feedback?.rubricResults), "AI grading should return rubric results");

    const confirmed = await request(`/api/submissions/${submissionId}/manual-grade`, {
      method: "POST",
      cookie,
      body: { teacherId: "20260001", score: aiGrade.payload.submission.aiSuggestedScore, comment: "确认 AI 建议，答案覆盖主要步骤。" }
    });
    assert(confirmed.response.ok, "teacher confirmation should succeed");
    assert(confirmed.payload.submission.status === "graded", "confirmed grade should become official");
    assert(confirmed.payload.submission.confirmedBy === "20260001", "confirmed grade should record teacher");

    const removeClassStudent = await request(`/api/classes/${createdClass.payload.class.id}/students/20260002`, {
      method: "DELETE",
      cookie
    });
    assert(removeClassStudent.response.ok && removeClassStudent.payload.removed === true, "teacher should remove a student from their class");

    const afterRemovalTeacherState = await request("/api/state", { cookie });
    const afterRemovalClass = afterRemovalTeacherState.payload.state.classes.find((item) => item.id === createdClass.payload.class.id);
    assert(afterRemovalClass && !afterRemovalClass.studentIds.includes("20260002"), "removed student should disappear from teacher class roster");

    const afterRemovalStudentState = await request("/api/state", { cookie: studentCookie });
    assert(!afterRemovalStudentState.payload.state.classes.some((item) => item.id === createdClass.payload.class.id), "removed student should no longer see the class");
    assert(!afterRemovalStudentState.payload.state.homework.some((item) => item.id === homeworkId), "removed student should no longer see class homework");

    const logout = await request("/api/auth/logout", { method: "POST", cookie, body: {} });
    assert(logout.response.ok && logout.payload.ok, "logout should succeed");

    console.log("release smoke test passed");
  } finally {
    child.kill();
    mockDify.server.close();
    await sleep(300);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (stderr.trim()) console.error(stderr.trim());
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
