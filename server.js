const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn, execFileSync } = require("child_process");
const { createStorage } = require("./storage");
const { createEmbeddingProvider } = require("./storage/embeddingProvider");
const { routeEducationalRequest } = require("./services/educationRouter");
const { verifiedCitationsFromHits, verifyExternalCitations } = require("./services/citationVerifier");
const { applyWeightedMasteryEvidence } = require("./services/mastery");
const { RecoverableQueue } = require("./services/recoverableQueue");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) return;
    const index = clean.indexOf("=");
    if (index <= 0) return;
    const key = clean.slice(0, index).trim();
    let value = clean.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

loadEnvFile();

const PORT = Number(process.env.PORT || 5107);
// Local-only default. Override HOST explicitly if LAN access is ever needed.
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(ROOT, "logs"));
const DB_PATH = path.join(DATA_DIR, "db.json");
const STORAGE_DRIVER = process.env.STORAGE_DRIVER || "sqlite";
const DATABASE_URL = process.env.DATABASE_URL || process.env.SQLITE_PATH || "";
const STORAGE_SCHEMA_PATH = path.join(ROOT, "storage", "schema.sql");
const AUDIT_LOG_PATH = path.join(LOG_DIR, "audit.log");
const GRAPH_JOBS_PATH = path.join(RUNTIME_DIR, "graph_jobs.json");
const UPLOAD_SESSIONS_PATH = path.join(RUNTIME_DIR, "upload_sessions.json");
const MAX_BODY_SIZE = 30 * 1024 * 1024;
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE_BYTES || Number.MAX_SAFE_INTEGER);
const MAX_UPLOAD_CHUNK_SIZE = 12 * 1024 * 1024;
const MAX_GRAPH_SOURCE_CHARS = 320000;
const RAG_CHUNK_CHARS = 900;
const RAG_CHUNK_OVERLAP = 160;
const RAG_MAX_CONTEXT_CHUNKS = 5;
const RAG_VECTOR_DIM = 64;
const EMBEDDING_BATCH_SIZE = Math.max(1, Math.min(64, Number(process.env.EMBEDDING_BATCH_SIZE || 32)));
const AI_UNLIMITED_EXTRACTOR = "ai-unlimited-pdf-graph-agent";
const AI_AGENT_TIMEOUT_MS = Math.max(60 * 1000, Number(process.env.AI_PDF_AGENT_TIMEOUT_MS || 8 * 60 * 1000));
const PDF_LIMITS = {
  maxFileBytes: 300 * 1024 * 1024,
  maxStreams: 1400,
  maxCompressedStreamBytes: 12 * 1024 * 1024,
  maxInflatedStreamBytes: 5 * 1024 * 1024,
  maxCollectedStreamChars: 14 * 1024 * 1024,
  maxExtractedTextChars: 260000
};
const PDF_AGENT_TIMEOUT_MS = Math.max(4 * 60 * 1000, Number(process.env.PDF_AGENT_TIMEOUT_MS || 20 * 60 * 1000));
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "edu_session";
const SESSION_SECRET_CONFIGURED = Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET !== "replace-with-a-long-random-secret");
const SESSION_SECRET = SESSION_SECRET_CONFIGURED ? process.env.SESSION_SECRET : crypto.createHash("sha256").update(`${ROOT}:education-agent-dev-secret`).digest("hex");
const SESSION_MAX_IDLE_TIMEOUT_MS = 2 * 24 * 60 * 60 * 1000;
const REQUESTED_SESSION_IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_TIMEOUT_MS || process.env.SESSION_TTL_MS || SESSION_MAX_IDLE_TIMEOUT_MS);
const SESSION_IDLE_TIMEOUT_MS = Math.max(30 * 60 * 1000, Math.min(SESSION_MAX_IDLE_TIMEOUT_MS, REQUESTED_SESSION_IDLE_TIMEOUT_MS));
const SESSION_TTL_MS = SESSION_IDLE_TIMEOUT_MS;
const LOGIN_MAX_FAILURES = Math.max(3, Number(process.env.LOGIN_MAX_FAILURES || 5));
const LOGIN_COOLDOWN_MS = Math.max(60 * 1000, Number(process.env.LOGIN_COOLDOWN_MS || 10 * 60 * 1000));
const MODEL_CODE_TIMEOUT_MS = Math.max(1000, Math.min(30 * 1000, Number(process.env.MODEL_CODE_TIMEOUT_MS || 10 * 1000)));
const MODEL_CODE_MAX_CHARS = Math.max(1000, Math.min(200000, Number(process.env.MODEL_CODE_MAX_CHARS || 80000)));
const MODEL_CODE_MAX_OUTPUT_CHARS = Math.max(2000, Math.min(200000, Number(process.env.MODEL_CODE_MAX_OUTPUT_CHARS || 30000)));
const MODEL_CODE_REPAIR_MAX_ATTEMPTS = Math.max(0, Math.min(3, Number(process.env.MODEL_CODE_REPAIR_MAX_ATTEMPTS || 2)));
const MODEL_CODE_ALLOWED_IMPORTS = new Set(String(process.env.MODEL_CODE_ALLOWED_IMPORTS || "math,random,statistics,collections,itertools,functools,operator,heapq,bisect,decimal,fractions,typing,dataclasses")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean));
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = Math.max(5000, Math.min(60 * 1000, Number(process.env.OPENAI_TIMEOUT_MS || 25 * 1000)));
const DIFY_BASE_URL = String(process.env.DIFY_BASE_URL || "http://127.0.0.1:8080/v1").replace(/\/+$/, "");
const DIFY_WORKFLOW_API_KEY = process.env.DIFY_WORKFLOW_API_KEY || "";
const DIFY_STUDENT_WORKFLOW_API_KEY = process.env.DIFY_STUDENT_WORKFLOW_API_KEY || DIFY_WORKFLOW_API_KEY;
const DIFY_TEACHER_WORKFLOW_API_KEY = process.env.DIFY_TEACHER_WORKFLOW_API_KEY || "";
const DIFY_TEACHER_WORKFLOW_NAME = process.env.DIFY_TEACHER_WORKFLOW_NAME || "teacher_teaching_assistant";
const DIFY_WORKFLOW_USER_PREFIX = process.env.DIFY_WORKFLOW_USER_PREFIX || "education-agent";
const DIFY_WORKFLOW_TIMEOUT_MS = Math.max(3000, Math.min(60 * 1000, Number(process.env.DIFY_WORKFLOW_TIMEOUT_MS || 60 * 1000)));
const DIFY_CALLBACK_TOKEN = process.env.DIFY_CALLBACK_TOKEN || "change-me";
const DIFY_PROJECT_BASE_URL = String(process.env.DIFY_PROJECT_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const DIFY_GRAPH_CONTEXT_URL = String(process.env.DIFY_GRAPH_CONTEXT_URL || `${DIFY_PROJECT_BASE_URL}/api/integrations/dify/graph-context`);
const DIFY_CALLBACK_URL = String(process.env.DIFY_CALLBACK_URL || `${DIFY_PROJECT_BASE_URL}/api/integrations/dify/diagnosis-callback`);
const SUPPORTED_UPLOAD_EXTENSIONS = new Set([".pdf", ".txt", ".md", ".csv", ".json", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const TEXT_UPLOAD_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json"]);
const ZIP_OFFICE_EXTENSIONS = new Set([".docx", ".pptx", ".xlsx"]);
const BINARY_OFFICE_EXTENSIONS = new Set([".doc", ".ppt", ".xls"]);
const IMAGE_UPLOAD_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const BUILTIN_ADMIN_ID = "20260000";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
};
const NO_CACHE_STATIC_EXTENSIONS = new Set([".html", ".js", ".css"]);
const graphJobs = new Map();
const uploadSessions = new Map();

function now() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(user, password) {
  if (!user) return false;
  if (user.passwordHash && String(user.passwordHash).startsWith("scrypt$")) {
    const [, salt, expected] = String(user.passwordHash).split("$");
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
    return timingSafeEqualText(actual, expected);
  }
  return user.password !== undefined && String(user.password) === String(password);
}

function migratePasswordIfNeeded(user, password) {
  if (!user.passwordHash) user.passwordHash = hashPassword(password);
  delete user.password;
  user.passwordUpdatedAt = user.passwordUpdatedAt || now();
  return user;
}

function signSessionPayload(payload) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifySessionToken(token) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (!timingSafeEqualText(signature, expected)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(body));
    if (!payload.sub || Number(payload.exp || 0) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function createSessionToken(user) {
  return signSessionPayload({
    sub: user.id,
    role: user.role,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    idleTtlMs: SESSION_TTL_MS,
    jti: crypto.randomBytes(12).toString("hex")
  });
}

function cookieOptions(maxAgeMs = SESSION_TTL_MS) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}${secure}`;
}

function sessionCookie(user) {
  return `${SESSION_COOKIE}=${createSessionToken(user)}; ${cookieOptions()}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; ${cookieOptions(0)}`;
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");
      if (index > 0) cookies[part.slice(0, index)] = decodeURIComponent(part.slice(index + 1));
      return cookies;
    }, {});
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function checkDirWritable(dirPath) {
  try {
    ensureDataDir();
    const probePath = path.join(dirPath, `.ready-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probePath, "ok", "utf8");
    fs.unlinkSync(probePath);
    return true;
  } catch {
    return false;
  }
}

function checkDataDirWritable() {
  return checkDirWritable(DATA_DIR);
}

function checkRuntimeDirWritable() {
  return checkDirWritable(RUNTIME_DIR);
}

function atomicWriteJson(filePath, data) {
  ensureDataDir();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(error.code)) {
      throw error;
    }
    fs.copyFileSync(tmpPath, filePath);
    fs.unlinkSync(tmpPath);
  }
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function sampleGraph(ownerId, subject, title, global = false) {
  const templates = {
    数学: ["函数", "一次函数", "二次函数", "导数", "极限", "概率", "数列", "解析几何"],
    物理: ["力学", "牛顿定律", "运动学", "动量守恒", "能量守恒", "万有引力", "电磁学", "热学", "光学"],
    化学: ["物质结构", "化学键", "氧化还原", "化学平衡", "电化学", "有机化学", "实验探究"],
    语文: ["现代文阅读", "文言文", "古诗词", "写作", "语言运用", "名著阅读"],
    英语: ["词汇", "语法", "阅读理解", "完形填空", "写作", "听力"]
  };
  const words = templates[subject] || templates.物理;
  const root = `${subject}核心知识`;
  const nodes = [{ id: "n0", label: root, group: "root" }].concat(
    words.map((label, index) => ({ id: `n${index + 1}`, label, group: index % 3 === 0 ? "concept" : "topic" }))
  );
  const links = words.map((_, index) => ({
    source: "n0",
    target: `n${index + 1}`,
    label: index % 2 === 0 ? "包含" : "关联"
  }));
  for (let i = 1; i < words.length; i += 1) {
    if (i % 2 === 0) links.push({ source: `n${i}`, target: `n${i + 1}`, label: "支撑" });
  }
  return enhanceGraphForEducation({
    id: uid("graph"),
    ownerId,
    subject,
    title,
    sourceName: "系统示例",
    nodes,
    links,
    global,
    createdAt: now(),
    updatedAt: now()
  });
}

function createInitialDb() {
  const adminId = BUILTIN_ADMIN_ID;
  const teacherId = "20260001";
  const studentId = "20260002";

  return {
    users: [
      {
        id: adminId,
        name: "管理员",
        role: "admin",
        passwordHash: hashPassword("123456"),
        subject: "",
        className: "",
        classIds: [],
        avatar: "管",
        createdAt: now()
      },
      {
        id: teacherId,
        name: "黄豆",
        role: "teacher",
        passwordHash: hashPassword("123456"),
        subject: "机器学习",
        className: "",
        classIds: [],
        avatar: "黄",
        createdAt: now()
      },
      {
        id: studentId,
        name: "绿豆",
        role: "student",
        passwordHash: hashPassword("123456"),
        subject: "",
        className: "",
        classIds: [],
        avatar: "绿",
        createdAt: now()
      }
    ],
    knowledgeGraphs: seedInitialKnowledgeGraphs(teacherId),
    conversations: [],
    models: [],
    friendships: [],
    chatThreads: [],
    classes: [],
    homework: [],
    submissions: [],
    courseMaterials: seedInitialCourseMaterials(teacherId),
    learningProfiles: [
      createLearningProfile(adminId, "admin"),
      createLearningProfile(studentId, "student"),
      createLearningProfile(teacherId, "teacher")
    ],
    wrongNotes: [],
    learningEvents: [],
    diagnosisResults: [],
    studentMastery: [],
    misconceptionRecords: [],
    prePostAssessments: [],
    learningPathRecommendations: [],
    nodeMasterySnapshots: [],
    experimentSubmissions: [],
    learningEvidence: [],
    studentReflections: [],
    knowledgeCorrections: [],
    aiAnswerReviews: [],
    learningCycles: [],
    studentNodeAnnotations: [],
    studentEthicsSettings: [],
    studentDataDeletionRequests: [],
    agentRuns: [],
    auditLogs: [],
    friendRequests: [],
    chatInvites: [],
    agentProfiles: [],
    simulationAssets: []
  };
}

let dbStorage = null;
let embeddingProvider = null;
let backgroundQueue = null;

function getEmbeddingProvider() {
  if (!embeddingProvider) embeddingProvider = createEmbeddingProvider();
  return embeddingProvider;
}

function getDbStorage() {
  if (!dbStorage) {
    dbStorage = createStorage({
      driver: STORAGE_DRIVER,
      dataDir: DATA_DIR,
      dbPath: DB_PATH,
      sqlitePath: DATABASE_URL,
      schemaPath: STORAGE_SCHEMA_PATH,
      ensureDataDir,
      initialData: createInitialDb,
      normalizeData: ensureDbShape,
      writeJson: atomicWriteJson
    });
  }
  return dbStorage;
}

function readDb() {
  return getDbStorage().read();
}

function writeDb(db) {
  getDbStorage().write(db);
}

function dbStorageMetadata() {
  return getDbStorage().metadata();
}

function getBackgroundQueue() {
  if (!backgroundQueue) {
    backgroundQueue = new RecoverableQueue({
      storage: getDbStorage(),
      handlers: {
        ai_chat: async (job) => {
          const db = readDb();
          const actor = ensureUser(db, job.payload.actorId);
          const result = await executeAiChat(db, actor, job.payload.body || {});
          writeDb(db);
          return result;
        },
        homework_multimodal: async (job) => {
          const db = readDb();
          const result = processHomeworkMultimodal(db, job.payload || {});
          writeDb(db);
          return result;
        }
      }
    });
    backgroundQueue.start();
  }
  return backgroundQueue;
}

function createLearningProfile(userId, role = "student") {
  return {
    userId,
    role,
    level: role === "admin" ? "管理员" : role === "teacher" ? "教师" : "待诊断",
    goals: [],
    questionCount: 0,
    practiceCount: 0,
    gradedCount: 0,
    studyMinutes: 0,
    mastery: {},
    weakPoints: [],
    recentActivity: [],
    updatedAt: now()
  };
}

function ensureLearningProfile(db, userId) {
  db.learningProfiles = Array.isArray(db.learningProfiles) ? db.learningProfiles : [];
  const user = getUser(db, userId);
  let profile = db.learningProfiles.find((item) => item.userId === userId);
  if (!profile) {
    profile = createLearningProfile(userId, user?.role || "student");
    db.learningProfiles.push(profile);
  }
  profile.mastery = profile.mastery && typeof profile.mastery === "object" ? profile.mastery : {};
  profile.weakPoints = Array.isArray(profile.weakPoints) ? profile.weakPoints : [];
  profile.recentActivity = Array.isArray(profile.recentActivity) ? profile.recentActivity : [];
  profile.goals = Array.isArray(profile.goals) ? profile.goals : [];
  return profile;
}

function normalizeKeywordText(text) {
  return String(text || "")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9_+\-#/.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenizeForSearch(text) {
  const normalized = normalizeKeywordText(text);
  const tokens = normalized.match(/[\u4e00-\u9fa5]{2,10}|[a-z0-9_+\-#/.]{2,}/g) || [];
  const cn = normalized.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let index = 0; index < cn.length - 1; index += 1) tokens.push(cn.slice(index, index + 2));
  return Array.from(new Set(tokens)).slice(0, 80);
}

function tokenHash(token) {
  const hash = crypto.createHash("sha1").update(String(token)).digest();
  return hash.readUInt32BE(0);
}

function embeddingFromTokens(tokens) {
  const vector = Array(RAG_VECTOR_DIM).fill(0);
  tokens.forEach((token, index) => {
    const hash = tokenHash(token);
    const slot = hash % RAG_VECTOR_DIM;
    const sign = hash & 1 ? 1 : -1;
    const weight = Math.max(0.4, 1 - index / Math.max(12, tokens.length * 1.5));
    vector[slot] += sign * weight;
  });
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(5)));
}

function embeddingForText(text) {
  return embeddingFromTokens(tokenizeForSearch(text));
}

function cosineSimilarity(left = [], right = []) {
  if (!left.length || !right.length) return 0;
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += Number(left[index] || 0) * Number(right[index] || 0);
  return Math.max(-1, Math.min(1, sum));
}

function knowledgeChunkStorage() {
  const storage = getDbStorage();
  return typeof storage.readKnowledgeChunks === "function" ? storage : null;
}

async function embedQueryText(query) {
  const text = String(query || "").trim();
  if (!text) return null;
  const provider = getEmbeddingProvider();
  if (!provider.enabled) return null;
  try {
    const result = await provider.embedTexts([text]);
    return result.embeddings?.[0] || null;
  } catch (error) {
    console.warn(`[embedding] query fallback: ${error.message}`);
    return null;
  }
}

async function indexCourseMaterialEmbeddings(db, materialIds = []) {
  const storage = knowledgeChunkStorage();
  const provider = getEmbeddingProvider();
  if (!storage || !provider.enabled) return { provider: provider.provider, model: provider.model, indexed: 0, pending: 0 };
  const selectedIds = new Set(materialIds.filter(Boolean));
  const materialIdList = selectedIds.size ? Array.from(selectedIds) : (db.courseMaterials || []).map((material) => material.id);
  const rows = storage.readKnowledgeChunks({ materialIds: materialIdList });
  const pending = rows.filter((row) => row.embeddingProvider !== provider.provider || row.embeddingModel !== provider.model || !Array.isArray(row.embedding));
  let indexed = 0;
  for (let offset = 0; offset < pending.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const result = await provider.embedTexts(batch.map((row) => row.content));
    const updates = batch.map((row, index) => ({
      id: row.id,
      contentSha256: row.contentSha256,
      embedding: result.embeddings[index],
      provider: result.provider,
      model: result.model
    }));
    storage.updateKnowledgeChunkEmbeddings(updates);
    indexed += updates.length;
  }
  return { provider: provider.provider, model: provider.model, indexed, pending: rows.length - indexed };
}

async function tryIndexCourseMaterialEmbeddings(db, materialIds = []) {
  try {
    return await indexCourseMaterialEmbeddings(db, materialIds);
  } catch (error) {
    console.warn(`[embedding] indexing fallback: ${error.message}`);
    return { provider: "legacy-hash", model: "legacy-64", indexed: 0, pending: materialIds.length, error: error.message };
  }
}

function sourceChapterForText(text, fallback = "课程资料") {
  const match = String(text || "").match(/第\s*[一二三四五六七八九十百\d]+\s*[章节]\s*[^。\n\r]{0,24}|[一二三四五六七八九十百\d]+[.、]\s*[^。\n\r]{2,24}/);
  return match ? match[0].replace(/\s+/g, " ").trim() : fallback;
}

function chunkCourseMaterialText(text, material) {
  const clean = normalizeExtractedText(text).slice(0, PDF_LIMITS.maxExtractedTextChars);
  const chunks = [];
  if (!clean.trim()) return chunks;
  const paragraphs = clean.split(/\n{2,}|(?<=。|！|？|；)\s*/).map((item) => item.trim()).filter(Boolean);
  let buffer = "";
  let page = 1;
  let chapter = sourceChapterForText(clean, material.title || material.subject || "课程资料");
  const pushChunk = () => {
    const content = buffer.trim();
    if (!content) return;
    chapter = sourceChapterForText(content, chapter);
    const index = chunks.length;
    chunks.push({
      id: `${material.id}_chunk_${index + 1}`,
      index,
      page,
      chapter,
      text: content.slice(0, RAG_CHUNK_CHARS + RAG_CHUNK_OVERLAP),
      keywords: tokenizeForSearch(`${material.subject} ${material.title} ${chapter} ${content}`).slice(0, 36),
      embedding: embeddingForText(`${material.subject} ${material.title} ${chapter} ${content}`)
    });
    page += Math.max(1, Math.round(content.length / 1200));
    buffer = content.slice(Math.max(0, content.length - RAG_CHUNK_OVERLAP));
  };
  paragraphs.forEach((paragraph) => {
    if ((buffer + "\n" + paragraph).length > RAG_CHUNK_CHARS) pushChunk();
    buffer = [buffer, paragraph].filter(Boolean).join("\n");
  });
  pushChunk();
  return chunks.slice(0, 260);
}

function createCourseMaterial({ ownerId, subject, title, sourceName, type = "text/plain", text, global = false, classId = "" }) {
  const id = uid("mat");
  const material = {
    id,
    ownerId,
    subject: normalizeSubject(subject),
    title: String(title || sourceName || "课程资料").trim() || "课程资料",
    sourceName: String(sourceName || title || "手动录入").trim() || "手动录入",
    type,
    text: normalizeExtractedText(text).slice(0, PDF_LIMITS.maxExtractedTextChars),
    chunks: [],
    global: Boolean(global),
    classId: String(classId || ""),
    createdAt: now(),
    updatedAt: now()
  };
  material.chunks = chunkCourseMaterialText(material.text, material);
  return material;
}

function seedCourseMaterials(teacherId) {
  return [
    createCourseMaterial({
      ownerId: teacherId,
      subject: "物理",
      title: "牛顿第二定律课堂讲义",
      sourceName: "系统内置讲义",
      global: true,
      text: "第 1 章 力与运动。牛顿第二定律说明物体的加速度与合外力成正比，与质量成反比，方向与合外力方向相同，公式为 F=ma。解题时通常先选研究对象，再进行受力分析，建立坐标轴，列出合力与加速度的关系。常见误区是把速度方向当成合力方向，或者漏掉摩擦力、支持力等受力。课堂练习应让学生区分匀速、匀加速和静止三种状态。"
    }),
    createCourseMaterial({
      ownerId: teacherId,
      subject: "计算机组成原理",
      title: "Cache 映射方式与主存关系摘要",
      sourceName: "系统内置讲义",
      global: true,
      text: "第 3 章 存储系统。Cache 位于 CPU 和主存之间，用来缓解 CPU 与主存速度不匹配的问题。Cache 与主存的映射方式包括直接映射、全相联映射和组相联映射。直接映射实现简单但冲突较多，全相联映射冲突少但硬件代价高，组相联映射在冲突率和硬件复杂度之间折中。常见考点包括地址划分、命中率、替换算法、写策略以及 Cache 与主存一致性问题。"
    })
  ];
}

function machineLearningSeedText() {
  const candidates = [
    path.join(ROOT, "动手学机器学习-测试讲义.txt"),
    path.join(UPLOAD_DIR, "hands_on_ml_extract.txt")
  ];
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const text = fs.readFileSync(filePath, "utf8");
        if (normalizeExtractedText(text).length >= 800) return text;
      }
    } catch {
      // Ignore optional seed file read failures and fall back to the built-in outline.
    }
  }
  return [
    "目录",
    ...fallbackMachineLearningOutline().map((item) => item.label),
    "",
    "机器学习课程围绕数据集、监督学习、无监督学习、模型评估、优化方法、决策树、支持向量机、聚类、降维、神经网络和应用实践展开。",
    "学习时要区分训练集、验证集和测试集，理解泛化能力、过拟合、欠拟合、交叉验证、正则化和数据泄漏防控。",
    "典型算法包括 K 近邻、线性回归、逻辑回归、朴素贝叶斯、决策树、随机森林、支持向量机、K-means、PCA 和神经网络。",
    "课堂应强调算法输入输出、训练目标、关键假设、参数影响、评价指标、常见误区和可复现实验流程。"
  ].join("\n");
}

function seedInitialCourseMaterials(teacherId) {
  return [
    createCourseMaterial({
      ownerId: teacherId,
      subject: "机器学习",
      title: "《动手学机器学习》",
      sourceName: fs.existsSync(path.join(ROOT, "动手学机器学习 (张伟楠等) .pdf")) ? "动手学机器学习 (张伟楠等) .pdf" : "系统内置机器学习讲义",
      global: true,
      text: machineLearningSeedText()
    })
  ];
}

function seedInitialKnowledgeGraphs(teacherId) {
  const sourceText = machineLearningSeedText();
  const outline = extractBookOutline(sourceText, "机器学习", "动手学机器学习");
  return [
    buildOutlineGraphFromText({
      ownerId: teacherId,
      subject: "机器学习",
      title: "《动手学机器学习》知识图谱",
      sourceName: fs.existsSync(path.join(ROOT, "动手学机器学习 (张伟楠等) .pdf")) ? "动手学机器学习 (张伟楠等) .pdf" : "系统内置机器学习讲义",
      sourceText,
      extraction: {
        name: "动手学机器学习",
        method: "seeded-open-maic-course-agent",
        characters: normalizeExtractedText(sourceText).length,
        seed: true
      },
      outline: outline.length ? outline : fallbackMachineLearningOutline()
    })
  ];
}

function ensureBuiltinAdmin(db) {
  db.users = Array.isArray(db.users) ? db.users : [];
  const existing = db.users.find((user) => user.id === BUILTIN_ADMIN_ID);
  if (!existing) {
    db.users.unshift({
      id: BUILTIN_ADMIN_ID,
      name: "管理员",
      role: "admin",
      passwordHash: hashPassword("123456"),
      subject: "",
      className: "",
      classIds: [],
      avatar: "管",
      createdAt: now()
    });
    return true;
  }
  let changed = false;
  if (existing.role !== "admin") {
    existing.role = "admin";
    changed = true;
  }
  if (!existing.passwordHash && existing.password !== undefined) {
    migratePasswordIfNeeded(existing, existing.password);
    changed = true;
  }
  existing.classIds = Array.isArray(existing.classIds) ? existing.classIds : [];
  if (!existing.name) {
    existing.name = "管理员";
    changed = true;
  }
  if (!existing.avatar) {
    existing.avatar = "管";
    changed = true;
  }
  return changed;
}

function ensureDbShape(db) {
  let changed = false;
  const ensureArray = (key) => {
    if (!Array.isArray(db[key])) {
      db[key] = [];
      changed = true;
    }
  };
  [
    "knowledgeGraphs",
    "conversations",
    "models",
    "classes",
    "homework",
    "courseMaterials",
    "mlKnowledgePoints",
    "mlQuestionBank",
    "learningProfiles",
    "wrongNotes",
    "learningEvents",
    "diagnosisResults",
    "studentMastery",
    "misconceptionRecords",
    "prePostAssessments",
    "learningPathRecommendations",
    "nodeMasterySnapshots",
    "experimentSubmissions",
    "learningEvidence",
    "studentReflections",
    "knowledgeCorrections",
    "aiAnswerReviews",
    "learningCycles",
    "studentNodeAnnotations",
    "studentEthicsSettings",
    "studentDataDeletionRequests",
    "agentRuns",
    "submissions",
    "auditLogs",
    "friendships",
    "chatThreads",
    "friendRequests",
    "chatInvites",
    "agentProfiles",
    "simulationAssets"
  ].forEach(ensureArray);
  db.users = Array.isArray(db.users) ? db.users : [];
  if (ensureBuiltinAdmin(db)) changed = true;
  (db.users || []).forEach((user) => {
    if (!user.passwordHash && user.password !== undefined) {
      migratePasswordIfNeeded(user, user.password);
      changed = true;
    }
    if (!["admin", "teacher", "student"].includes(user.role)) {
      user.role = "student";
      changed = true;
    }
    user.classIds = Array.isArray(user.classIds) ? user.classIds : [];
    const before = db.learningProfiles.length;
    ensureLearningProfile(db, user.id);
    if (db.learningProfiles.length !== before) changed = true;
  });
  db.courseMaterials.forEach((material) => {
    if (!Array.isArray(material.chunks) || !material.chunks.length) {
      material.chunks = chunkCourseMaterialText(material.text || "", material);
      changed = true;
    }
    (material.chunks || []).forEach((chunk) => {
      if (!Array.isArray(chunk.embedding) || chunk.embedding.length !== RAG_VECTOR_DIM) {
        chunk.embedding = embeddingForText(`${material.subject} ${material.title} ${chunk.chapter || ""} ${chunk.text || ""}`);
        changed = true;
      }
      if (!Array.isArray(chunk.keywords) || chunk.keywords.length < 8) {
        chunk.keywords = tokenizeForSearch(`${material.subject} ${material.title} ${chunk.chapter || ""} ${chunk.text || ""}`).slice(0, 36);
        changed = true;
      }
    });
  });
  (db.homework || []).forEach((homework) => {
    if (!Array.isArray(homework.rubric) || !homework.rubric.length) {
      homework.rubric = parseRubricInput(homework.rubricText || "", homework);
      homework.rubricText = rubricToText(homework.rubric);
      changed = true;
    }
  });
  (db.chatThreads || []).forEach((thread) => {
    const memberIds = Array.isArray(thread.memberIds) ? Array.from(new Set(thread.memberIds.map(String))) : [];
    if (!Array.isArray(thread.memberIds) || memberIds.length !== thread.memberIds.length) {
      thread.memberIds = memberIds;
      changed = true;
    }
    if (!Array.isArray(thread.messages)) {
      thread.messages = [];
      changed = true;
    }
    if (thread.type === "group") {
      if (!thread.ownerId) {
        thread.ownerId = thread.memberIds[0] || "";
        changed = true;
      }
      const adminIds = Array.isArray(thread.adminIds) && thread.adminIds.length ? Array.from(new Set(thread.adminIds.map(String))) : [thread.ownerId].filter(Boolean);
      if (!Array.isArray(thread.adminIds) || adminIds.length !== thread.adminIds.length) {
        thread.adminIds = adminIds;
        changed = true;
      }
      const pendingInviteIds = Array.isArray(thread.pendingInviteIds) ? Array.from(new Set(thread.pendingInviteIds.map(String))) : [];
      if (!Array.isArray(thread.pendingInviteIds) || pendingInviteIds.length !== thread.pendingInviteIds.length) {
        thread.pendingInviteIds = pendingInviteIds;
        changed = true;
      }
    }
  });
  return changed;
}

function publicUser(user) {
  if (!user) return null;
  const {
    password,
    passwordHash,
    passwordUpdatedAt,
    failedLoginCount,
    lockUntil,
    lastLoginIp,
    ...safe
  } = user;
  return safe;
}

function generateUserId(db) {
  for (let i = 0; i < 1000; i += 1) {
    const id = String(Math.floor(10000000 + Math.random() * 90000000));
    if (!db.users.some((user) => user.id === id)) return id;
  }
  throw new Error("无法生成唯一用户 ID");
}

function normalizeDisplayName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name) throw Object.assign(new Error("用户名不能为空"), { status: 400 });
  if (name.length > 30) throw Object.assign(new Error("用户名不能超过 30 个字符"), { status: 400 });
  return name;
}

function normalizeOptionalProfileField(value, maxLength = 60) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizePasswordInput(value) {
  const password = String(value || "");
  if (password.length < 6) throw Object.assign(new Error("密码至少 6 位"), { status: 400 });
  if (password.length > 128) throw Object.assign(new Error("密码不能超过 128 位"), { status: 400 });
  return password;
}

function normalizeAccountInput(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractLoginId(account) {
  if (/^\d{8}$/.test(account)) return account;
  const match = account.match(/\b\d{8}\b/);
  return match ? match[0] : "";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        reject(Object.assign(new Error("请求体过大"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve(enforceBodyPrincipal({}, req.actor));
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        return reject(Object.assign(new Error("JSON 格式不正确"), { status: 400 }));
      }
      try {
        resolve(enforceBodyPrincipal(parsed, req.actor));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function readBinaryBody(req, limit = MAX_UPLOAD_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error(`上传文件过大，当前限制为 ${Math.round(limit / 1024 / 1024)}MB`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks, size)));
    req.on("error", reject);
  });
}

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .split(",")[0]
    .trim();
}

function recordAudit(db, actor, action, detail = {}, req = null) {
  db.auditLogs = Array.isArray(db.auditLogs) ? db.auditLogs : [];
  const entry = {
    id: uid("audit"),
    actorId: actor?.id || detail.actorId || "",
    actorRole: actor?.role || detail.actorRole || "",
    action,
    resourceType: detail.resourceType || "",
    resourceId: detail.resourceId || "",
    ip: req ? requestIp(req) : "",
    userAgent: req ? String(req.headers["user-agent"] || "").slice(0, 180) : "",
    meta: detail.meta || {},
    createdAt: now()
  };
  db.auditLogs.unshift(entry);
  db.auditLogs = db.auditLogs.slice(0, 1000);
  try {
    ensureDataDir();
    fs.appendFileSync(AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.warn("audit log write failed", error.message);
  }
  return entry;
}

function getSessionUser(req, db) {
  const cookies = parseCookies(req);
  const payload = verifySessionToken(cookies[SESSION_COOKIE]);
  if (!payload) return null;
  return getUser(db, payload.sub) || null;
}

function requireActor(req, db) {
  const user = getSessionUser(req, db);
  if (!user) throw Object.assign(new Error("登录已过期，请重新登录"), { status: 401 });
  req.actor = user;
  return user;
}

function ensureActorCanUseId(actor, id, role = "") {
  if (!id) return;
  if (actor.role === "admin") return;
  if (String(id) !== actor.id) throw Object.assign(new Error("无权使用其他用户身份操作"), { status: 403 });
  if (role && actor.role !== role) throw Object.assign(new Error(`当前账号不是${role === "teacher" ? "教师" : "学生"}身份`), { status: 403 });
}

function enforceBodyPrincipal(body, actor) {
  if (!actor || !body || typeof body !== "object" || Array.isArray(body) || actor.role === "admin") return body;
  [
    ["userId", ""],
    ["ownerId", ""],
    ["fromUserId", ""],
    ["teacherId", "teacher"],
    ["studentId", "student"]
  ].forEach(([key, role]) => {
    if (body[key] !== undefined && body[key] !== null && body[key] !== "") {
      ensureActorCanUseId(actor, body[key], role);
    }
  });
  return body;
}

function queryUserId(searchParams, actor, key = "userId", role = "") {
  const requested = searchParams.get(key);
  ensureActorCanUseId(actor, requested || actor.id, role);
  return actor.role === "admin" && requested ? requested : actor.id;
}

function requireRole(actor, roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(actor.role)) {
    throw Object.assign(new Error("当前账号无权执行该操作"), { status: 403 });
  }
}

function send(res, status, payload, headers = {}) {
  const responseHeaders = { ...SECURITY_HEADERS, ...JSON_HEADERS, ...headers };
  const hasSetCookie = Object.keys(responseHeaders).some((key) => key.toLowerCase() === "set-cookie");
  if (!hasSetCookie && res.sessionActor) {
    responseHeaders["set-cookie"] = sessionCookie(res.sessionActor);
  }
  res.writeHead(status, responseHeaders);
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  send(res, status, { ok: false, error: message });
}

function notFound(res) {
  sendError(res, 404, "资源不存在");
}

function assertRequired(payload, keys) {
  for (const key of keys) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === "") {
      throw Object.assign(new Error(`缺少字段：${key}`), { status: 400 });
    }
  }
}

function getUser(db, userId) {
  return db.users.find((user) => user.id === userId);
}

function ensureUser(db, userId) {
  const user = getUser(db, userId);
  if (!user) throw Object.assign(new Error("用户不存在"), { status: 404 });
  return user;
}

function normalizeSubject(subject) {
  return String(subject || "通用").trim() || "通用";
}

function requestText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(requestText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    for (const key of ["value", "text", "content", "sourceText"]) {
      if (value[key] !== undefined) return requestText(value[key]);
    }
    return Object.values(value).map(requestText).filter(Boolean).join("\n");
  }
  return String(value);
}

function limitText(text, maxLength = MAX_GRAPH_SOURCE_CHARS) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  const head = value.slice(0, Math.floor(maxLength * 0.72));
  const tail = value.slice(-Math.floor(maxLength * 0.28));
  return `${head}\n\n……中间超长内容已截断，保留开头和结尾用于生成图谱……\n\n${tail}`;
}

function isAiUnlimitedExtractor(extractor) {
  return String(extractor || "") === AI_UNLIMITED_EXTRACTOR;
}

function hasConfiguredUploadLimit() {
  return Number.isFinite(MAX_UPLOAD_SIZE) && MAX_UPLOAD_SIZE < Number.MAX_SAFE_INTEGER;
}

function persistGraphJobs() {
  const jobs = Array.from(graphJobs.values()).map((job) => {
    const { abort, ...safe } = job;
    return safe;
  });
  atomicWriteJson(GRAPH_JOBS_PATH, { version: 1, jobs });
}

function persistUploadSessions() {
  atomicWriteJson(UPLOAD_SESSIONS_PATH, { version: 1, sessions: Array.from(uploadSessions.values()) });
}

function loadRuntimeState() {
  ensureDataDir();
  graphJobs.clear();
  uploadSessions.clear();

  const graphState = readJsonFile(GRAPH_JOBS_PATH, { jobs: [] });
  (Array.isArray(graphState.jobs) ? graphState.jobs : []).forEach((item) => {
    if (!item?.id) return;
    const interrupted = ["queued", "running"].includes(item.status);
    graphJobs.set(item.id, {
      ...item,
      status: interrupted ? "failed" : item.status,
      stage: interrupted ? "已中断" : item.stage,
      message: interrupted ? "服务曾重启，原图谱生成任务已中断，请重新上传或重新生成。" : item.message,
      error: interrupted ? "服务重启导致任务中断" : item.error,
      cancelRequested: Boolean(item.cancelRequested),
      abort: null,
      updatedAt: interrupted ? now() : item.updatedAt
    });
  });
  if (graphJobs.size) persistGraphJobs();

  const uploadState = readJsonFile(UPLOAD_SESSIONS_PATH, { sessions: [] });
  let uploadChanged = false;
  (Array.isArray(uploadState.sessions) ? uploadState.sessions : []).forEach((item) => {
    if (!item?.id || !item.filePath || !fs.existsSync(item.filePath)) {
      uploadChanged = true;
      return;
    }
    const actualSize = fs.statSync(item.filePath).size;
    uploadSessions.set(item.id, {
      ...item,
      received: Math.min(Number(item.size || actualSize), actualSize),
      chunks: Number(item.chunks || 0),
      updatedAt: item.updatedAt || now()
    });
  });
  if (uploadChanged || uploadSessions.size) persistUploadSessions();
}

function createGraphJob(meta = {}) {
  const job = {
    id: uid("graphjob"),
    status: "queued",
    stage: "等待处理",
    progress: 3,
    message: "任务已创建",
    graphId: null,
    error: null,
    meta,
    cancelRequested: false,
    abort: null,
    createdAt: now(),
    updatedAt: now()
  };
  graphJobs.set(job.id, job);
  persistGraphJobs();
  return job;
}

function updateGraphJob(jobId, patch) {
  const job = graphJobs.get(jobId);
  if (!job) return null;
  if (job.status === "canceled" && patch.status !== "canceled") return job;
  Object.assign(job, patch, { updatedAt: now() });
  persistGraphJobs();
  return job;
}

function canceledGraphError() {
  return Object.assign(new Error("图谱生成已终止"), { canceled: true });
}

function isGraphJobCanceled(jobId) {
  const job = graphJobs.get(jobId);
  return !job || job.cancelRequested || job.status === "canceled";
}

function assertGraphJobActive(jobId) {
  if (isGraphJobCanceled(jobId)) throw canceledGraphError();
}

function cancelGraphJob(jobId) {
  const job = graphJobs.get(jobId);
  if (!job) return null;
  if (["complete", "failed", "canceled"].includes(job.status)) return job;
  job.cancelRequested = true;
  if (typeof job.abort === "function") {
    try {
      job.abort();
    } catch {}
  }
  return updateGraphJob(jobId, {
    status: "canceled",
    stage: "已终止",
    progress: Math.max(0, Number(job.progress || 0)),
    message: "已终止生成，当前表单内容已清空",
    error: null
  });
}

function publicGraphJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    graphId: job.graphId,
    error: job.error,
    meta: job.meta,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function cleanupGraphJobs() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  let changed = false;
  for (const [id, job] of graphJobs.entries()) {
    if (new Date(job.updatedAt).getTime() < cutoff) {
      graphJobs.delete(id);
      changed = true;
    }
  }
  if (changed) persistGraphJobs();
}

function sanitizeFileName(name) {
  return String(name || "upload.pdf").replace(/[\\/:*?"<>|]/g, "_").slice(0, 160);
}

function uploadExtension(name = "") {
  return path.extname(String(name || "").toLowerCase());
}

function uploadExpectedKinds(name = "", type = "") {
  const ext = uploadExtension(name);
  const mime = String(type || "").toLowerCase();
  const kinds = new Set();
  if (ext === ".pdf" || mime.includes("pdf")) kinds.add("pdf");
  if (ZIP_OFFICE_EXTENSIONS.has(ext) || /officedocument|wordprocessingml|presentationml|spreadsheetml/.test(mime)) kinds.add("office-zip");
  if (BINARY_OFFICE_EXTENSIONS.has(ext) || /msword|ms-powerpoint|ms-excel/.test(mime)) kinds.add("office-binary");
  if (TEXT_UPLOAD_EXTENSIONS.has(ext) || /^text\//.test(mime)) kinds.add("text");
  if (IMAGE_UPLOAD_EXTENSIONS.has(ext) || /^image\//.test(mime)) kinds.add("image");
  return kinds;
}

function assertSupportedUploadDeclaration(name = "", type = "") {
  const ext = uploadExtension(name);
  const mime = String(type || "").toLowerCase();
  const blockedMime = /x-msdownload|x-dosexec|octet-stream-exe|shellscript/.test(mime);
  if (blockedMime) {
    throw Object.assign(new Error("不支持上传可执行或脚本类文件"), { status: 415 });
  }
  if (ext && !SUPPORTED_UPLOAD_EXTENSIONS.has(ext)) {
    throw Object.assign(new Error(`不支持的文件格式：${ext}。请上传 PDF、Word、PPT、Excel、TXT、Markdown、CSV 或常见图片格式。`), { status: 415 });
  }
}

function isProbablyTextBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (!sample.length) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / sample.length < 0.08;
}

function sniffUploadKind(buffer) {
  if (!buffer || !buffer.length) return "empty";
  const hex8 = buffer.subarray(0, 8).toString("hex").toLowerCase();
  const ascii5 = buffer.subarray(0, 5).toString("latin1");
  const ascii4 = buffer.subarray(0, 4).toString("latin1");
  const ascii12 = buffer.subarray(0, 12).toString("latin1");
  if (ascii5 === "%PDF-") return "pdf";
  if (ascii4 === "PK\u0003\u0004" || ascii4 === "PK\u0005\u0006" || ascii4 === "PK\u0007\b") return "office-zip";
  if (hex8 === "d0cf11e0a1b11ae1") return "office-binary";
  if (hex8 === "89504e470d0a1a0a") return "image";
  if (hex8.startsWith("ffd8ff")) return "image";
  if (ascii4 === "GIF8" || (ascii4 === "RIFF" && ascii12.slice(8, 12) === "WEBP")) return "image";
  if (isProbablyTextBuffer(buffer)) return "text";
  return "unknown-binary";
}

function assertUploadContent({ name = "", type = "", buffer }) {
  assertSupportedUploadDeclaration(name, type);
  const sample = buffer || Buffer.alloc(0);
  const actual = sniffUploadKind(sample);
  if (actual === "empty") {
    throw Object.assign(new Error("上传文件为空"), { status: 400 });
  }
  const expected = uploadExpectedKinds(name, type);
  if (!expected.size) {
    if (actual === "unknown-binary") {
      throw Object.assign(new Error("未能识别上传文件类型，请使用带扩展名的 PDF、Word、PPT、Excel、TXT 或图片文件"), { status: 415 });
    }
    return;
  }
  if (expected.has(actual)) return;
  if (expected.has("text") && actual === "text") return;
  if (expected.has("image") && actual === "image") return;
  throw Object.assign(new Error("上传文件内容与声明格式不一致，请检查文件是否损坏或伪装成其他格式"), { status: 415 });
}

function assertStoredUploadSafe(session) {
  const size = fs.statSync(session.filePath).size;
  const fd = fs.openSync(session.filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, 8192));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    assertUploadContent({ name: session.fileName, type: session.fileType, buffer });
  } finally {
    fs.closeSync(fd);
  }
}

function createUploadSession({ userId, fileName, fileType, size }) {
  ensureDataDir();
  assertSupportedUploadDeclaration(fileName, fileType);
  const uploadId = uid("upload");
  const safeName = sanitizeFileName(fileName);
  const filePath = path.join(UPLOAD_DIR, `${uploadId}_${safeName}`);
  const session = {
    id: uploadId,
    userId,
    fileName: safeName,
    fileType: String(fileType || "application/octet-stream"),
    size: Number(size || 0),
    received: 0,
    chunks: 0,
    filePath,
    createdAt: now(),
    updatedAt: now()
  };
  fs.writeFileSync(filePath, Buffer.alloc(0));
  uploadSessions.set(uploadId, session);
  persistUploadSessions();
  return session;
}

function getUploadSession(uploadId) {
  const session = uploadSessions.get(uploadId);
  if (!session) throw Object.assign(new Error("上传会话不存在或已过期"), { status: 404 });
  if (!fs.existsSync(session.filePath)) {
    uploadSessions.delete(uploadId);
    persistUploadSessions();
    throw Object.assign(new Error("上传文件已丢失，请重新上传"), { status: 404 });
  }
  return session;
}

function publicUploadSession(session) {
  return {
    id: session.id,
    fileName: session.fileName,
    fileType: session.fileType,
    size: session.size,
    received: session.received,
    chunks: session.chunks,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

function cleanupUploadSession(uploadId, removeFile = true) {
  const session = uploadSessions.get(uploadId);
  if (!session) return;
  uploadSessions.delete(uploadId);
  if (removeFile) {
    try {
      fs.unlinkSync(session.filePath);
    } catch {}
  }
  persistUploadSessions();
}

function cleanupUploadSessions() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  let changed = false;
  for (const [id, session] of uploadSessions.entries()) {
    if (new Date(session.updatedAt).getTime() < cutoff || !fs.existsSync(session.filePath)) {
      uploadSessions.delete(id);
      try {
        if (session.filePath) fs.unlinkSync(session.filePath);
      } catch {}
      changed = true;
    }
  }
  if (changed) persistUploadSessions();
}

function decodeDataUrl(dataUrl) {
  const raw = String(dataUrl || "");
  const commaIndex = raw.indexOf(",");
  if (commaIndex < 0) return Buffer.alloc(0);
  return Buffer.from(raw.slice(commaIndex + 1), "base64");
}

function decodeUtf16Hex(hex) {
  const clean = String(hex || "").replace(/\s+/g, "");
  if (!clean) return "";
  if (clean.length % 4 === 0) {
    let text = "";
    for (let i = 0; i < clean.length; i += 4) {
      const code = parseInt(clean.slice(i, i + 4), 16);
      if (Number.isFinite(code) && code > 0) text += String.fromCharCode(code);
    }
    if (/[\u4e00-\u9fa5A-Za-z0-9]/.test(text)) return text;
  }
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) {
    const byte = parseInt(clean.slice(i, i + 2), 16);
    if (Number.isFinite(byte)) bytes.push(byte);
  }
  return Buffer.from(bytes).toString("utf8").replace(/\u0000/g, "");
}

function decodePdfLiteralString(value) {
  const body = String(value || "").replace(/^\(/, "").replace(/\)$/, "");
  let result = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      result += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === "n") result += "\n";
    else if (next === "r") result += "\r";
    else if (next === "t") result += "\t";
    else if (next === "b") result += "\b";
    else if (next === "f") result += "\f";
    else if (next === "(" || next === ")" || next === "\\") result += next;
    else if (/[0-7]/.test(next || "")) {
      const octal = body.slice(i + 1).match(/^[0-7]{1,3}/)?.[0] || "";
      result += String.fromCharCode(parseInt(octal, 8));
      i += octal.length;
      continue;
    }
    i += 1;
  }
  return result;
}

function parsePdfCMap(text) {
  const map = new Map();
  const bfCharBlocks = text.match(/beginbfchar[\s\S]*?endbfchar/g) || [];
  bfCharBlocks.forEach((block) => {
    const pairs = block.matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g);
    for (const pair of pairs) map.set(pair[1].toUpperCase(), decodeUtf16Hex(pair[2]));
  });

  const rangeBlocks = text.match(/beginbfrange[\s\S]*?endbfrange/g) || [];
  rangeBlocks.forEach((block) => {
    const ranges = block.matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g);
    for (const range of ranges) {
      const start = parseInt(range[1], 16);
      const end = parseInt(range[2], 16);
      const target = parseInt(range[3], 16);
      const keyWidth = range[1].length;
      for (let code = start; code <= end && code - start < 256; code += 1) {
        const key = code.toString(16).toUpperCase().padStart(keyWidth, "0");
        const value = (target + code - start).toString(16).toUpperCase().padStart(4, "0");
        map.set(key, decodeUtf16Hex(value));
      }
    }
  });
  return map;
}

function decodePdfHexString(value, cmap) {
  const clean = String(value || "").replace(/[<>\s]/g, "").toUpperCase();
  if (!clean) return "";
  if (cmap && cmap.size) {
    const keyLengths = Array.from(new Set([...cmap.keys()].map((key) => key.length))).sort((a, b) => b - a);
    let result = "";
    let index = 0;
    while (index < clean.length) {
      const keyLength = keyLengths.find((length) => cmap.has(clean.slice(index, index + length)));
      if (keyLength) {
        result += cmap.get(clean.slice(index, index + keyLength));
        index += keyLength;
      } else {
        result += decodeUtf16Hex(clean.slice(index, index + 4));
        index += 4;
      }
    }
    return result;
  }
  return decodeUtf16Hex(clean);
}

function extractPdfStrings(content, cmap) {
  const chunks = [];
  const textBlocks = content.match(/BT[\s\S]*?ET/g) || [content];
  textBlocks.forEach((block) => {
    const tj = block.matchAll(/(\((?:\\.|[^\\)])*\)|<[\dA-Fa-f\s]+>)\s*Tj/g);
    for (const match of tj) {
      chunks.push(match[1].startsWith("(") ? decodePdfLiteralString(match[1]) : decodePdfHexString(match[1], cmap));
    }

    const tjArrays = block.matchAll(/\[([\s\S]*?)\]\s*TJ/g);
    for (const arrayMatch of tjArrays) {
      const strings = arrayMatch[1].match(/\((?:\\.|[^\\)])*\)|<[\dA-Fa-f\s]+>/g) || [];
      chunks.push(strings.map((item) => item.startsWith("(") ? decodePdfLiteralString(item) : decodePdfHexString(item, cmap)).join(""));
    }
  });
  return chunks.join("\n");
}

function normalizeExtractedText(text) {
  return String(text || "")
    .replace(/\u0000/g, "")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isLikelyImageStream(dictionary) {
  return /\/Subtype\s*\/Image/.test(dictionary) || /\/Image\b/.test(dictionary) || /DCTDecode|JPXDecode|JBIG2Decode|CCITTFaxDecode/.test(dictionary);
}

function extractPdfTextFromBuffer(buffer, onProgress = () => {}) {
  if (buffer.length > PDF_LIMITS.maxFileBytes) {
    throw Object.assign(new Error(`PDF 文件过大，当前限制为 ${Math.round(PDF_LIMITS.maxFileBytes / 1024 / 1024)}MB。建议拆分章节后上传。`), { status: 413 });
  }
  const binary = buffer.toString("latin1");
  const streamRegex = /<<(?:.|\r|\n)*?>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const contentStreams = [];
  const cmap = new Map();
  const stats = {
    scannedStreams: 0,
    skippedStreams: 0,
    imageStreams: 0,
    inflatedStreams: 0,
    collectedChars: 0,
    truncated: false
  };
  let match;
  while ((match = streamRegex.exec(binary))) {
    stats.scannedStreams += 1;
    if (stats.scannedStreams > PDF_LIMITS.maxStreams) {
      stats.truncated = true;
      break;
    }
    const fullMatch = match[0];
    const dictionary = fullMatch.slice(0, fullMatch.indexOf("stream"));
    if (isLikelyImageStream(dictionary)) {
      stats.imageStreams += 1;
      continue;
    }
    let data = Buffer.from(match[1], "latin1");
    if (data.length > PDF_LIMITS.maxCompressedStreamBytes) {
      stats.skippedStreams += 1;
      continue;
    }
    if (/FlateDecode/.test(dictionary)) {
      try {
        data = zlib.inflateSync(data, { maxOutputLength: PDF_LIMITS.maxInflatedStreamBytes });
        stats.inflatedStreams += 1;
      } catch {
        try {
          data = zlib.inflateRawSync(data, { maxOutputLength: PDF_LIMITS.maxInflatedStreamBytes });
          stats.inflatedStreams += 1;
        } catch {
          stats.skippedStreams += 1;
          continue;
        }
      }
    }
    if (data.length > PDF_LIMITS.maxInflatedStreamBytes) {
      stats.skippedStreams += 1;
      continue;
    }
    const stream = data.toString("latin1");
    const parsed = parsePdfCMap(stream);
    parsed.forEach((value, key) => cmap.set(key, value));
    if (/BT|TJ|Tj/.test(stream)) {
      stats.collectedChars += stream.length;
      if (stats.collectedChars <= PDF_LIMITS.maxCollectedStreamChars) {
        contentStreams.push(stream);
      } else {
        stats.truncated = true;
      }
    }
    if (stats.scannedStreams % 80 === 0) onProgress(stats);
  }

  let text = "";
  for (const stream of contentStreams) {
    text += `\n${extractPdfStrings(stream, cmap)}`;
    if (text.length > PDF_LIMITS.maxExtractedTextChars) {
      text = text.slice(0, PDF_LIMITS.maxExtractedTextChars);
      stats.truncated = true;
      break;
    }
  }
  if (!text.trim() && buffer.length < 4 * 1024 * 1024) {
    text = extractPdfStrings(binary, cmap).slice(0, PDF_LIMITS.maxExtractedTextChars);
  }
  return { text: normalizeExtractedText(text), stats };
}

function extractUploadedBookText(file, onProgress = () => {}) {
  if (!file || !file.dataUrl) return { text: "", meta: null };
  const name = String(file.name || "上传书本");
  const type = String(file.type || "");
  const buffer = decodeDataUrl(file.dataUrl);
  return extractUploadedBookBuffer({ name, type, buffer }, onProgress);
}

function extractUploadedBookBuffer({ name = "上传书本", type = "", buffer }, onProgress = () => {}) {
  if (!buffer || !buffer.length) return { text: "", meta: { name, type, method: "empty-upload", characters: 0 } };
  assertUploadContent({ name, type, buffer: buffer.subarray(0, Math.min(buffer.length, 8192)) });
  const lowerName = name.toLowerCase();
  let text = "";
  let method = "text-reader";
  let stats = null;
  if (type.includes("pdf") || lowerName.endsWith(".pdf")) {
    method = "local-pdf-text-agent";
    const extracted = extractPdfTextFromBuffer(buffer, onProgress);
    text = extracted.text;
    stats = extracted.stats;
  } else if (isOfficeOpenXmlFile(lowerName, type)) {
    method = "office-openxml-agent";
    text = extractOfficeOpenXmlText(buffer, lowerName);
  } else if (/\.(doc|ppt)$/i.test(lowerName)) {
    method = "binary-office-text-fallback";
    text = extractBinaryOfficeText(buffer);
  } else {
    text = buffer.toString("utf8").slice(0, PDF_LIMITS.maxExtractedTextChars);
  }
  return { text, meta: { name, type, method, characters: text.length, size: buffer.length, stats } };
}

function isOfficeOpenXmlFile(lowerName, type = "") {
  return /\.(docx|pptx|xlsx)$/i.test(lowerName)
    || /officedocument|wordprocessingml|presentationml|spreadsheetml/.test(String(type || "").toLowerCase());
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlToPlainText(xml) {
  return decodeXmlEntities(String(xml || "")
    .replace(/<a:br\s*\/>|<w:br\s*\/>/g, "\n")
    .replace(/<\/w:p>|<\/a:p>|<\/row>|<\/xdr:row>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s+/g, "\n"))
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function readZipEntries(buffer) {
  const entries = [];
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 66000); offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return entries;
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  let centralOffset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const name = buffer.slice(centralOffset + 46, centralOffset + 46 + fileNameLength).toString("utf8");
    if (buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.slice(dataStart, dataStart + compressedSize);
      try {
        const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : Buffer.alloc(0);
        entries.push({ name, data });
      } catch {}
    }
    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function extractOfficeOpenXmlText(buffer, lowerName = "") {
  const entries = readZipEntries(buffer);
  const wanted = entries
    .filter((entry) => {
      const name = entry.name.replace(/\\/g, "/");
      if (lowerName.endsWith(".docx")) return /^word\/(document|header|footer|footnotes|endnotes).*\.xml$/i.test(name);
      if (lowerName.endsWith(".pptx")) return /^ppt\/(slides|notesSlides)\/.*\.xml$/i.test(name);
      if (lowerName.endsWith(".xlsx")) return /^xl\/(worksheets|sharedStrings)\/.*\.xml$/i.test(name);
      return /^(word|ppt|xl)\/.*\.xml$/i.test(name);
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return wanted
    .map((entry) => xmlToPlainText(entry.data.toString("utf8")))
    .filter(Boolean)
    .join("\n\n")
    .slice(0, PDF_LIMITS.maxExtractedTextChars);
}

function extractBinaryOfficeText(buffer) {
  const utf8 = buffer.toString("utf8");
  const utf16 = buffer.toString("utf16le");
  const pick = utf16.replace(/[^\u4e00-\u9fa5A-Za-z0-9，。！？；：、,.!?;:()（）\s-]/g, " ").length
    > utf8.replace(/[^\u4e00-\u9fa5A-Za-z0-9，。！？；：、,.!?;:()（）\s-]/g, " ").length
    ? utf16
    : utf8;
  return normalizeExtractedText(pick.replace(/[^\u4e00-\u9fa5A-Za-z0-9，。！？；：、,.!?;:()（）\s-]/g, " "))
    .slice(0, PDF_LIMITS.maxExtractedTextChars);
}

function resolvePythonCommand() {
  if (process.env.PDF_AGENT_PYTHON) return process.env.PDF_AGENT_PYTHON;
  return "python";
}

let modelCodePythonCommandCache = null;

function resolveModelCodePythonCommand() {
  const spec = resolveModelCodePythonCommands()[0];
  return spec ? formatCommandSpec(spec) : "python";
}

function splitCommandArgs(value) {
  return (String(value || "").match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => {
    if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function parseCommandSpec(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const quoted = raw.match(/^"([^"]+)"(?:\s+(.*))?$/);
  if (quoted) {
    return { command: quoted[1], args: splitCommandArgs(quoted[2] || "") };
  }
  const executablePath = raw.match(/^(.+?\.exe)(?:\s+(.*))?$/i);
  if (executablePath && (/[\\/]/.test(executablePath[1]) || fs.existsSync(executablePath[1]))) {
    return { command: executablePath[1], args: splitCommandArgs(executablePath[2] || "") };
  }
  const parts = splitCommandArgs(raw);
  const command = parts.shift();
  return command ? { command, args: parts } : null;
}

function executableExists(command) {
  if (!command) return false;
  if (/[\\/]/.test(command)) return fs.existsSync(command);
  if (process.platform !== "win32") return false;
  const extensions = String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  const pathEntries = String(process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  return pathEntries.some((entry) => extensions.some((ext) => fs.existsSync(path.join(entry, command.endsWith(ext.toLowerCase()) || command.endsWith(ext.toUpperCase()) ? command : `${command}${ext}`))));
}

function whereCommandSpecs(command, args = []) {
  if (!command || /[\\/]/.test(command) || process.platform !== "win32") return [];
  try {
    const output = execFileSync("where.exe", [command], {
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => ({ command: filePath, args: [...args] }));
  } catch {
    return [];
  }
}

function commonWindowsPythonSpecs() {
  if (process.platform !== "win32") return [];
  const username = process.env.USERNAME || "";
  const pythonVersions = ["314", "313", "312", "311", "310", "39", "38"];
  const programRoots = Array.from(new Set([
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    "C:\\Program Files",
    "D:\\Program Files"
  ].filter(Boolean)));
  const userProfiles = Array.from(new Set([
    process.env.USERPROFILE,
    username ? `C:\\Users\\${username}` : "",
    username ? `D:\\Users\\${username}` : ""
  ].filter(Boolean)));
  const rootDrives = ["C:\\", "D:\\"];
  const candidates = [
    { command: "C:\\Windows\\py.exe", args: ["-3"] },
    { command: "C:\\Windows\\py.exe", args: [] },
    ...programRoots.flatMap((root) => pythonVersions.map((version) => path.join(root, `Python${version}`, "python.exe"))),
    ...rootDrives.flatMap((root) => pythonVersions.map((version) => path.join(root, `Python${version}`, "python.exe"))),
    ...(process.env.LOCALAPPDATA ? pythonVersions.map((version) => path.join(process.env.LOCALAPPDATA, "Programs", "Python", `Python${version}`, "python.exe")) : []),
    ...userProfiles.flatMap((profile) => [
      path.join(profile, "anaconda3", "python.exe"),
      path.join(profile, "miniconda3", "python.exe"),
      ...pythonVersions.map((version) => path.join(profile, "AppData", "Local", "Programs", "Python", `Python${version}`, "python.exe"))
    ])
  ];
  return candidates.map((item) => typeof item === "string" ? { command: item, args: [] } : item)
    .filter((spec) => fs.existsSync(spec.command));
}

function expandModelCodePythonSpec(spec) {
  if (!spec) return [];
  const specs = [];
  if (/[\\/]/.test(spec.command) || executableExists(spec.command)) specs.push(spec);
  specs.push(...whereCommandSpecs(spec.command, spec.args || []));
  if (process.platform === "win32" && /^(python|python3|py)$/i.test(spec.command)) {
    specs.push(...commonWindowsPythonSpecs());
  }
  return specs.length ? specs : [spec];
}

function commandSpecKey(spec) {
  return `${String(spec?.command || "").toLowerCase()}\u0000${(spec?.args || []).join("\u0000")}`;
}

function dedupeCommandSpecs(specs) {
  const seen = new Set();
  return specs.filter((spec) => {
    const key = commandSpecKey(spec);
    if (!spec?.command || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cloneCommandSpecs(specs) {
  return specs.map((spec) => ({ command: spec.command, args: [...(spec.args || [])] }));
}

function probePythonCommandSpec(spec) {
  try {
    execFileSync(spec.command, [...(spec.args || []), "-c", "import sys; sys.exit(0)"], {
      windowsHide: true,
      timeout: 3000,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      },
      stdio: ["ignore", "pipe", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

function resolveModelCodePythonCommands() {
  if (modelCodePythonCommandCache) return cloneCommandSpecs(modelCodePythonCommandCache);
  const defaults = process.platform === "win32" ? ["python", "py -3", "python3"] : ["python3", "python"];
  const configured = [
    process.env.MODEL_CODE_PYTHON,
    process.env.PDF_AGENT_PYTHON,
    process.env.PYTHON
  ];
  const rawSpecs = dedupeCommandSpecs(configured.concat(defaults)
    .map(parseCommandSpec)
    .filter(Boolean)
    .flatMap(expandModelCodePythonSpec));
  const verifiedSpecs = rawSpecs.filter(probePythonCommandSpec);
  modelCodePythonCommandCache = verifiedSpecs.length ? cloneCommandSpecs(verifiedSpecs) : cloneCommandSpecs(rawSpecs);
  return cloneCommandSpecs(modelCodePythonCommandCache);
}

function formatCommandSpec(spec) {
  if (!spec) return "";
  return [spec.command].concat(spec.args || [])
    .map((part) => /\s/.test(part) ? `"${part}"` : part)
    .join(" ");
}

function formatModelCodeOutput({ stdout = "", stderr = "", exitCode = 0, timedOut = false, durationMs = 0, pythonCommand = "" }) {
  const sections = [];
  sections.push(`执行状态：${timedOut ? "超时终止" : exitCode === 0 ? "执行完成（退出码 0）" : `运行失败（退出码 ${exitCode}）`}`);
  if (pythonCommand) sections.push(`Python：${pythonCommand}`);
  sections.push(`耗时：${durationMs} ms`);
  const cleanStdout = String(stdout || "").trimEnd();
  const cleanStderr = String(stderr || "").trimEnd();
  if (cleanStdout) sections.push(`\n[stdout]\n${cleanStdout}`);
  if (cleanStderr) sections.push(`\n[stderr]\n${cleanStderr}`);
  if (!cleanStdout && !cleanStderr) sections.push("\n程序没有输出。请在代码中使用 print(...) 输出测试结果。");
  return sections.join("\n").slice(0, MODEL_CODE_MAX_OUTPUT_CHARS);
}

function inspectModelCodeSafety(source) {
  const code = String(source || "");
  const importPattern = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/gm;
  let match = null;
  while ((match = importPattern.exec(code))) {
    const root = String(match[1] || match[2] || "").split(".")[0];
    if (root && !MODEL_CODE_ALLOWED_IMPORTS.has(root)) {
      return { ok: false, message: "Safety block: import is not allowed: " + root + ". Allowed modules: " + Array.from(MODEL_CODE_ALLOWED_IMPORTS).join(", ") + "." };
    }
  }
  const blocked = [
    { pattern: /\b(open|eval|exec|compile|input|__import__)\s*\(/, label: "dangerous builtin" },
    { pattern: /\b(globals|locals|vars|getattr|setattr|delattr)\s*\(/, label: "runtime reflection" },
    { pattern: /\b(system|popen|spawn|fork|remove|unlink|rmdir|mkdir|rename|replace)\s*\(/, label: "system or file operation" },
    { pattern: /__(?:builtins|globals|subclasses|mro|base|code|closure|dict)__/, label: "Python internal object access" }
  ];
  const hit = blocked.find((item) => item.pattern.test(code));
  if (hit) return { ok: false, message: "Safety block: detected " + hit.label + ". The ML lab only allows pure computation teaching code." };
  return { ok: true };
}

function modelCodeExecutableSource(source) {
  return `import ast
import traceback

_source = ${JSON.stringify(String(source || ""))}
_globals = {"__name__": "__main__", "__file__": "main.py"}

try:
    _tree = ast.parse(_source, filename="main.py", mode="exec")
except SyntaxError:
    if "\\n" not in _source and _source.strip():
        print(_source.strip())
    else:
        raise
else:
    try:
        if _tree.body and isinstance(_tree.body[-1], ast.Expr):
            _last_expr = ast.Expression(_tree.body.pop().value)
            ast.fix_missing_locations(_tree)
            ast.fix_missing_locations(_last_expr)
            exec(compile(_tree, "main.py", "exec"), _globals)
            try:
                _value = eval(compile(_last_expr, "main.py", "eval"), _globals)
            except NameError:
                if len(_tree.body) == 0 and "\\n" not in _source and _source.strip().isidentifier():
                    print(_source.strip())
                else:
                    raise
            else:
                if _value is not None:
                    print(_value)
        else:
            ast.fix_missing_locations(_tree)
            exec(compile(_tree, "main.py", "exec"), _globals)
    except Exception:
        traceback.print_exc()
        raise
`;
}

function removeRuntimeTempDir(tempDir) {
  const resolvedRuntime = path.resolve(RUNTIME_DIR);
  const resolvedTarget = path.resolve(tempDir);
  if (!resolvedTarget.startsWith(resolvedRuntime)) return;
  try {
    fs.rmSync(resolvedTarget, { recursive: true, force: true });
  } catch {}
}

function runModelCodeSnippet(code) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const source = String(code || "");
    if (!source.trim()) {
      resolve({
        success: false,
        exitCode: 1,
        timedOut: false,
        durationMs: 0,
        output: "执行状态：运行失败（退出码 1）\n\n[stderr]\n代码为空，请先在画布代码编辑器中输入 Python 代码。"
      });
      return;
    }
    if (source.length > MODEL_CODE_MAX_CHARS) {
      resolve({
        success: false,
        exitCode: 1,
        timedOut: false,
        durationMs: 0,
        output: `执行状态：运行失败（退出码 1）\n\n[stderr]\n代码长度不能超过 ${MODEL_CODE_MAX_CHARS} 个字符。`
      });
      return;
    }
    const safety = inspectModelCodeSafety(source);
    if (!safety.ok) {
      const payload = { success: false, exitCode: 1, timedOut: false, durationMs: 0, stdout: "", stderr: safety.message, pythonCommand: "", securityBlocked: true };
      payload.output = formatModelCodeOutput(payload);
      resolve(payload);
      return;
    }
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(RUNTIME_DIR, "model-code-"));
    const scriptPath = path.join(tempDir, "main.py");
    fs.writeFileSync(scriptPath, modelCodeExecutableSource(source), "utf8");
    const pythonCandidates = resolveModelCodePythonCommands();
    let activeChild = null;
    let activePythonCommand = "";
    const spawnErrors = [];
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const appendLimited = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (next.length <= MODEL_CODE_MAX_OUTPUT_CHARS * 2) return next;
      return next.slice(0, MODEL_CODE_MAX_OUTPUT_CHARS * 2);
    };
    const finish = (exitCode = 1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const payload = {
        success: !timedOut && exitCode === 0,
        exitCode,
        timedOut,
        durationMs,
        stdout: stdout.slice(0, MODEL_CODE_MAX_OUTPUT_CHARS),
        stderr: stderr.slice(0, MODEL_CODE_MAX_OUTPUT_CHARS),
        pythonCommand: activePythonCommand
      };
      payload.output = formatModelCodeOutput(payload);
      removeRuntimeTempDir(tempDir);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        activeChild?.kill();
      } catch {}
      stderr = appendLimited(stderr, `\n代码执行超过 ${MODEL_CODE_TIMEOUT_MS} ms，已自动终止。`);
      finish(124);
    }, MODEL_CODE_TIMEOUT_MS);
    const startAttempt = (candidateIndex) => {
      if (settled) return;
      const spec = pythonCandidates[candidateIndex];
      if (!spec) {
        const reason = spawnErrors.length
          ? spawnErrors.join("\n")
          : "未找到可用 Python 命令。";
        stderr = appendLimited(stderr, `${reason}\n请安装 Python，或将 MODEL_CODE_PYTHON 设置为 Python 可执行文件完整路径。`);
        finish(1);
        return;
      }
      activePythonCommand = formatCommandSpec(spec);
      let child = null;
      let launchFailed = false;
      try {
        child = spawn(spec.command, [...(spec.args || []), "-u", scriptPath], {
          windowsHide: true,
          cwd: tempDir,
          env: {
            ...process.env,
            PYTHONUTF8: "1",
            PYTHONIOENCODING: "utf-8",
            MPLBACKEND: "Agg"
          },
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        spawnErrors.push(`无法启动 Python（${activePythonCommand}）：${error.message}`);
        startAttempt(candidateIndex + 1);
        return;
      }
      activeChild = child;
      child.stdout.on("data", (chunk) => {
        stdout = appendLimited(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = appendLimited(stderr, chunk);
      });
      child.on("error", (error) => {
        launchFailed = true;
        spawnErrors.push(`无法启动 Python（${activePythonCommand}）：${error.message}`);
        activeChild = null;
        startAttempt(candidateIndex + 1);
      });
      child.on("close", (code) => {
        if (launchFailed) return;
        activeChild = null;
        finish(Number.isFinite(Number(code)) ? Number(code) : 1);
      });
    };
    startAttempt(0);
  });
}

function runAdvancedPdfAgent({ filePath, maxChars, jobId, envOverrides = {}, timeoutMs = PDF_AGENT_TIMEOUT_MS }, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    if (jobId) assertGraphJobActive(jobId);
    const scriptPath = path.join(ROOT, "scripts", "pdf_text_agent.py");
    const outputPath = path.join(UPLOAD_DIR, `${uid("pdftext")}.txt`);
    const python = resolvePythonCommand();
    const child = spawn(python, [scriptPath, filePath, outputPath, String(maxChars)], {
      windowsHide: true,
      cwd: ROOT,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        ...envOverrides
      }
    });
    let stdout = "";
    let stderrBuffer = "";
    let stderrFull = "";
    let canceled = false;
    const startedAt = Date.now();
    const job = jobId ? graphJobs.get(jobId) : null;
    if (job) {
      job.abort = () => {
        canceled = true;
        child.kill();
      };
    }
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("高级 PDF/OCR 智能体解析超时，请尝试拆分 PDF、减少 OCR 页数，或设置 PDF_AGENT_OCR_MAX_PAGES 后重试"));
    }, Math.max(60 * 1000, Number(timeoutMs || PDF_AGENT_TIMEOUT_MS)));

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrFull += text;
      stderrBuffer += text;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      lines.forEach((line) => {
        if (!line.startsWith("PROGRESS ")) return;
        try {
          if (jobId) assertGraphJobActive(jobId);
          onProgress(JSON.parse(line.slice("PROGRESS ".length)));
        } catch {}
      });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (job && job.abort) job.abort = null;
      if (canceled || (jobId && isGraphJobCanceled(jobId))) {
        reject(canceledGraphError());
        return;
      }
      if (code !== 0) {
        reject(new Error(stderrFull.trim() || `高级 PDF 智能体退出码：${code}`));
        return;
      }
      try {
        const meta = JSON.parse(stdout.trim() || "{}");
        const text = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
        try {
          fs.unlinkSync(outputPath);
        } catch {}
        resolve({
          text: normalizeExtractedText(text).slice(0, maxChars),
          meta: {
            ...meta,
            method: meta.method || "advanced-python-pdf-agent",
            durationMs: Date.now() - startedAt
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function extractUploadedBookFile({ name = "上传书本", type = "", filePath, extractor = "", subject = "", sourceText = "" }, onProgress = () => {}, jobId = null) {
  const size = fs.statSync(filePath).size;
  assertStoredUploadSafe({ fileName: name, fileType: type, filePath });
  const lowerName = name.toLowerCase();
  const aiUnlimited = isAiUnlimitedExtractor(extractor);
  if (type.includes("pdf") || lowerName.endsWith(".pdf")) {
    if (aiUnlimited) {
      onProgress({
        method: AI_UNLIMITED_EXTRACTOR,
        stage: "ai-start",
        pages: 0,
        page: 0,
        characters: 0,
        message: "AI 自动图谱智能体正在分块读取 PDF 线索，优先融合文本层、目录、补充内容和文件名"
      });
      try {
        const advanced = await runAdvancedPdfAgent({
          filePath,
          maxChars: Math.min(PDF_LIMITS.maxExtractedTextChars, 160000),
          jobId,
          timeoutMs: AI_AGENT_TIMEOUT_MS,
          envOverrides: {
            PDF_AGENT_OCR_MAX_PAGES: String(process.env.AI_PDF_AGENT_OCR_MAX_PAGES || 10),
            PDF_AGENT_OCR_LEADING_PAGES: String(process.env.AI_PDF_AGENT_OCR_LEADING_PAGES || 10),
            PDF_AGENT_OCR_SCALE: String(process.env.AI_PDF_AGENT_OCR_SCALE || 1.25)
          }
        }, onProgress);
        return {
          text: advanced.text,
          meta: {
            name,
            type,
            size,
            method: AI_UNLIMITED_EXTRACTOR,
            characters: advanced.text.length,
            stats: {
              ...advanced.meta,
              extractor,
              subject,
              suppliedOutlineCharacters: String(sourceText || "").length,
              fallbackReady: advanced.text.trim().length < 20
            }
          }
        };
      } catch (error) {
        if (error.canceled) throw error;
        onProgress({
          method: AI_UNLIMITED_EXTRACTOR,
          stage: "ai-fallback",
          pages: 0,
          page: 0,
          characters: 0,
          message: `AI 自动图谱智能体未取得稳定文本，改用目录/学科/文件名融合生成：${error.message}`
        });
        return {
          text: "",
          meta: {
            name,
            type,
            size,
            method: AI_UNLIMITED_EXTRACTOR,
            characters: 0,
            stats: {
              extractor,
              subject,
              suppliedOutlineCharacters: String(sourceText || "").length,
              fallbackReady: true,
              errors: [error.message]
            }
          }
        };
      }
    }

    try {
      const advanced = await runAdvancedPdfAgent({ filePath, maxChars: PDF_LIMITS.maxExtractedTextChars, jobId }, onProgress);
      if (advanced.text.trim().length >= 20 || advanced.meta?.ocrUsed) {
        return {
          text: advanced.text,
          meta: {
            name,
            type,
            size,
            method: advanced.meta.method,
            characters: advanced.text.length,
            stats: advanced.meta
          }
        };
      }
    } catch (error) {
      if (error.canceled) throw error;
      onProgress({ message: `高级解析失败，切换轻量解析：${error.message}` });
    }

    if (size > PDF_LIMITS.maxFileBytes) {
      throw new Error("高级 PDF/OCR 智能体未能识别到可用文本，且文件过大，无法使用轻量解析兜底。请确认 PaddleOCR 环境可用，或先粘贴目录/知识点后再处理。");
    }
    const buffer = fs.readFileSync(filePath);
    return extractUploadedBookBuffer({ name, type, buffer }, onProgress);
  }
  const buffer = fs.readFileSync(filePath);
  const extracted = extractUploadedBookBuffer({ name, type, buffer }, onProgress);
  return {
    text: extracted.text,
    meta: {
      ...(extracted.meta || {}),
      name,
      type,
      size,
      characters: extracted.text.length
    }
  };
}

function isPdfUpload(name = "", type = "") {
  return String(type || "").toLowerCase().includes("pdf") || String(name || "").toLowerCase().endsWith(".pdf");
}

async function extractCourseMaterialUpload({ name = "课程资料", type = "", dataUrl = "", filePath = "" }) {
  if (filePath) {
    return extractUploadedBookFile({
      name,
      type,
      filePath,
      extractor: "advanced-python-pdf-agent",
      subject: "课程资料"
    }, () => {});
  }
  if (!dataUrl) return { text: "", meta: null };
  const buffer = decodeDataUrl(dataUrl);
  const local = extractUploadedBookBuffer({ name, type, buffer }, () => {});
  if (!isPdfUpload(name, type) || local.text.trim().length >= 80) return local;

  const tempPath = path.join(UPLOAD_DIR, `${uid("material")}_${sanitizeFileName(name || "scan.pdf")}`);
  fs.writeFileSync(tempPath, buffer);
  try {
    const advanced = await runAdvancedPdfAgent({
      filePath: tempPath,
      maxChars: PDF_LIMITS.maxExtractedTextChars,
      timeoutMs: PDF_AGENT_TIMEOUT_MS,
      envOverrides: {
        PDF_AGENT_OCR_MAX_PAGES: String(process.env.MATERIAL_PDF_OCR_MAX_PAGES || process.env.PDF_AGENT_OCR_MAX_PAGES || 80),
        PDF_AGENT_OCR_LEADING_PAGES: String(process.env.MATERIAL_PDF_OCR_LEADING_PAGES || process.env.PDF_AGENT_OCR_LEADING_PAGES || 40),
        PDF_AGENT_OCR_SCALE: String(process.env.MATERIAL_PDF_OCR_SCALE || process.env.PDF_AGENT_OCR_SCALE || 1.6)
      }
    }, () => {});
    return {
      text: advanced.text,
      meta: {
        name,
        type,
        size: buffer.length,
        method: advanced.meta.method || "advanced-python-pdf-agent",
        characters: advanced.text.length,
        stats: advanced.meta
      }
    };
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
}

function splitKnowledgeSentences(text) {
  return String(text || "")
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 6)
    .slice(0, 80);
}

function knowledgePointsForKeyword(text, keyword) {
  const sentences = splitKnowledgeSentences(text);
  const exact = sentences.filter((sentence) => sentence.includes(keyword)).slice(0, 5);
  if (exact.length) return exact.map((sentence) => sentence.slice(0, 160));
  return sentences.slice(0, 3).map((sentence) => sentence.slice(0, 160));
}

function uniqueTexts(items) {
  const seen = new Set();
  return (items || [])
    .map((item) => String(item || "").trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function extractKeywords(text, subject) {
  const source = `${subject} ${String(text || "")}`;
  const stopWords = new Set([
    "这是", "一个", "可以", "进行", "知识", "图谱", "学生", "老师", "内容", "文件", "上传", "生成", "学习", "教学", "本节", "掌握", "理解",
    "下面", "然后", "因此", "所以", "我们", "这里", "他们", "这些", "那些", "其中", "包括", "首先", "其次", "最后", "如果",
    "为了", "通过", "使用", "需要", "已经", "没有", "方法", "问题", "相关", "主要", "一般", "一种", "一些", "以及", "能够"
  ]);
  const cnWords = (source.match(/[\u4e00-\u9fa5]{2,10}/g) || []).filter((word) => !stopWords.has(word) && isUsefulGraphLabel(word));
  const enWords = Array.from(new Set((source.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []).map((word) => word.toLowerCase())));
  const rankedCn = Array.from(cnWords.reduce((map, word) => map.set(word, (map.get(word) || 0) + 1), new Map()).entries())
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .map(([word]) => word);
  const merged = rankedCn.concat(enWords.filter(isUsefulGraphLabel)).slice(0, 12);
  if (merged.length >= 5) return merged;
  const fallback = {
    数学: ["函数", "方程", "导数", "图像", "概率", "数列"],
    物理: ["运动", "力", "能量", "动量", "电场", "磁场"],
    化学: ["反应", "结构", "实验", "平衡", "电解", "有机物"],
    语文: ["阅读", "写作", "文言文", "修辞", "人物", "主题"],
    英语: ["vocabulary", "grammar", "reading", "writing", "listening"]
  };
  return Array.from(new Set(merged.concat(fallback[subject] || fallback.物理))).slice(0, 10);
}

const GENERIC_GRAPH_BAD_LABELS = new Set([
  "目录", "前言", "序言", "附录", "参考文献", "索引", "版权", "声明", "致谢", "封面", "目录页",
  "下面", "然后", "因此", "所以", "首先", "其次", "最后", "我们", "这里", "他们", "这些", "那些",
  "其中", "包括", "如果", "为了", "通过", "使用", "需要", "已经", "没有", "问题", "方法", "内容",
  "学习", "机器", "模型", "数据", "算法", "本章", "本节", "小结", "习题", "练习", "答案"
]);

const ML_TERM_PATTERNS = [
  {
    label: "训练集/验证集/测试集",
    pattern: /训练集|验证集|测试集|train(?:ing)? set|validation set|test set/i,
    points: ["训练集用于拟合模型参数，验证集用于调参和模型选择，测试集用于最终评估泛化能力。", "常见误区是把测试集用于反复调参，导致评估结果过于乐观。"]
  },
  {
    label: "监督学习",
    pattern: /监督学习|有标签|supervised/i,
    points: ["监督学习利用带标签样本学习输入到输出的映射，典型任务包括分类和回归。", "复习时要能说明损失函数、训练数据、预测目标和泛化评估之间的关系。"]
  },
  {
    label: "无监督学习",
    pattern: /无监督学习|聚类|降维|unsupervised/i,
    points: ["无监督学习不依赖人工标签，常用于发现数据结构、聚类模式或低维表示。", "需要区分聚类、降维、密度估计等任务的目标和评价方式。"]
  },
  {
    label: "特征工程",
    pattern: /特征工程|特征选择|特征提取|归一化|标准化|feature/i,
    points: ["特征工程通过选择、变换和构造特征提升模型可学性与可解释性。", "不同模型对尺度、稀疏性、异常值和类别变量的敏感程度不同。"]
  },
  {
    label: "损失函数",
    pattern: /损失函数|目标函数|代价函数|loss|objective|cost/i,
    points: ["损失函数度量预测结果与真实目标之间的差距，是优化算法更新参数的依据。", "不同任务常用不同损失，例如平方损失、交叉熵损失、合页损失。"]
  },
  {
    label: "梯度下降",
    pattern: /梯度下降|随机梯度|批量梯度|SGD|gradient/i,
    points: ["梯度下降沿损失函数下降最快方向迭代更新参数，学习率决定每一步更新幅度。", "需要关注学习率过大震荡、过小收敛慢以及局部最优/鞍点问题。"]
  },
  {
    label: "过拟合与欠拟合",
    pattern: /过拟合|欠拟合|泛化|正则化|overfit|underfit|generalization/i,
    points: ["过拟合表示模型记住训练集噪声而泛化差，欠拟合表示模型容量或训练不足。", "可通过正则化、交叉验证、早停、数据增强或调整模型复杂度改进。"]
  },
  {
    label: "交叉验证",
    pattern: /交叉验证|留出法|K\s*折|cross.?validation/i,
    points: ["交叉验证通过多次划分训练/验证数据估计模型稳定性，适合样本量有限时做模型选择。", "需要避免数据泄漏，预处理流程也应在每个训练折内独立拟合。"]
  },
  {
    label: "线性回归",
    pattern: /线性回归|最小二乘|linear regression/i,
    points: ["线性回归假设输出是输入特征的线性组合，常用平方损失和最小二乘估计参数。", "重点掌握模型形式、参数估计、残差含义和正则化扩展。"]
  },
  {
    label: "逻辑回归",
    pattern: /逻辑回归|logistic regression|sigmoid/i,
    points: ["逻辑回归用 Sigmoid 或 Softmax 把线性得分转换为类别概率，常用于分类任务。", "它名字中有回归，但解决的是分类问题，这是常见易混点。"]
  },
  {
    label: "K 近邻",
    pattern: /KNN|K\s*近邻|最近邻|nearest neighbor/i,
    points: ["K 近邻根据距离度量寻找相似样本并投票或平均，训练简单但预测开销较大。", "K 值、距离度量、特征尺度和样本分布会显著影响结果。"]
  },
  {
    label: "朴素贝叶斯",
    pattern: /朴素贝叶斯|naive bayes|贝叶斯/i,
    points: ["朴素贝叶斯基于贝叶斯公式和条件独立假设估计类别后验概率。", "适合文本分类等高维稀疏特征场景，但独立性假设可能与真实数据不一致。"]
  },
  {
    label: "决策树",
    pattern: /决策树|ID3|C4\.5|CART|信息增益|基尼/i,
    points: ["决策树通过递归划分特征空间形成可解释的判断规则。", "重点比较信息增益、增益率、基尼指数、剪枝和连续特征划分。"]
  },
  {
    label: "集成学习",
    pattern: /集成学习|随机森林|Boosting|Bagging|GBDT|AdaBoost|XGBoost/i,
    points: ["集成学习组合多个基学习器降低方差或偏差，典型方法包括 Bagging、Boosting 和随机森林。", "需要理解基学习器差异性、投票/加权和迭代纠错思想。"]
  },
  {
    label: "支持向量机",
    pattern: /支持向量机|SVM|最大间隔|核函数|kernel/i,
    points: ["支持向量机通过最大化分类间隔提升泛化能力，核函数可处理非线性可分问题。", "重点掌握支持向量、间隔、软间隔、惩罚参数和核技巧。"]
  },
  {
    label: "K-means 聚类",
    pattern: /K[-\s]?means|K均值|聚类中心|簇/i,
    points: ["K-means 通过迭代分配样本和更新簇中心最小化簇内平方误差。", "它对初始中心、K 值、异常点和特征尺度敏感。"]
  },
  {
    label: "主成分分析 PCA",
    pattern: /PCA|主成分|方差最大|降维/i,
    points: ["PCA 寻找能保留最大方差的正交方向，用于降维、去噪和可视化。", "需要区分无监督降维目标与分类目标，不能把方差大直接等同于类别可分。"]
  },
  {
    label: "神经网络",
    pattern: /神经网络|感知机|反向传播|深度学习|CNN|RNN|Transformer|neural|deep learning/i,
    points: ["神经网络通过多层非线性变换学习复杂表示，反向传播负责高效计算梯度。", "重点关注激活函数、网络层、损失函数、优化器和过拟合控制。"]
  }
];

function cleanOutlineLabel(label) {
  return String(label || "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[·•●▪□◆◇■]+/g, " ")
    .replace(/\.{2,}|…{1,}|-{3,}|_{3,}/g, " ")
    .replace(/\s*\(?第?\s*\d+\s*页\)?\s*$/i, "")
    .replace(/\s+\d{1,4}\s*$/g, "")
    .replace(/^[\s.．。:：、-]+|[\s.．。:：、-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function outlineLabelCore(label) {
  return cleanOutlineLabel(label)
    .replace(/^第\s*[一二三四五六七八九十百零〇两\d]+\s*[章节篇]\s*/g, "")
    .replace(/^\d{1,2}(?:[.．]\d{1,2}){0,3}\s*/g, "")
    .replace(/^[（(]?\d+[)）]\s*/g, "")
    .trim();
}

function isUsefulGraphLabel(label) {
  const text = cleanOutlineLabel(label);
  const core = outlineLabelCore(text);
  if (!text || !core) return false;
  if (GENERIC_GRAPH_BAD_LABELS.has(text) || GENERIC_GRAPH_BAD_LABELS.has(core)) return false;
  if (core.length < 2 && !/[A-Za-z]{2,}|K|PCA|SVM/i.test(core)) return false;
  if (core.length > 32) return false;
  if (/^\d+([.．]\d+)*$/.test(core)) return false;
  if (/^[,，.。;；:：!?！？、\s-]+$/.test(core)) return false;
  if (/^(第?\d+页|page\s*\d+|chapter\s*\d*)$/i.test(core)) return false;
  if (/版权|出版社|ISBN|作者|印刷|定价|http|www\.|公众号|扫描|下载|课后习题答案/.test(core)) return false;
  return true;
}

function looksLikeMachineLearning(subject, text) {
  const source = `${subject} ${text}`.toLowerCase();
  return /机器学习|动手学机器学习|machine learning|监督学习|无监督学习|深度学习|神经网络|决策树|支持向量机|svm|knn|pca|k-means|梯度下降|过拟合|特征工程/.test(source);
}

function fallbackMachineLearningOutline() {
  return [
    { level: 1, number: "1", label: "第1章 机器学习概述" },
    { level: 2, number: "1.1", label: "1.1 学习任务与数据集" },
    { level: 2, number: "1.2", label: "1.2 监督学习、无监督学习与强化学习" },
    { level: 2, number: "1.3", label: "1.3 训练流程与泛化能力" },
    { level: 1, number: "2", label: "第2章 数据预处理与特征工程" },
    { level: 2, number: "2.1", label: "2.1 数据清洗与缺失值处理" },
    { level: 2, number: "2.2", label: "2.2 特征缩放、编码与选择" },
    { level: 2, number: "2.3", label: "2.3 数据划分与数据泄漏防控" },
    { level: 1, number: "3", label: "第3章 监督学习基础模型" },
    { level: 2, number: "3.1", label: "3.1 K 近邻与距离度量" },
    { level: 2, number: "3.2", label: "3.2 朴素贝叶斯与概率分类" },
    { level: 2, number: "3.3", label: "3.3 线性回归与逻辑回归" },
    { level: 1, number: "4", label: "第4章 模型评估与选择" },
    { level: 2, number: "4.1", label: "4.1 损失函数与评价指标" },
    { level: 2, number: "4.2", label: "4.2 交叉验证与超参数选择" },
    { level: 2, number: "4.3", label: "4.3 偏差、方差、过拟合与欠拟合" },
    { level: 1, number: "5", label: "第5章 优化方法与正则化" },
    { level: 2, number: "5.1", label: "5.1 梯度下降与随机梯度下降" },
    { level: 2, number: "5.2", label: "5.2 学习率、收敛与局部最优" },
    { level: 2, number: "5.3", label: "5.3 L1/L2 正则化与早停" },
    { level: 1, number: "6", label: "第6章 决策树与集成学习" },
    { level: 2, number: "6.1", label: "6.1 决策树划分准则与剪枝" },
    { level: 2, number: "6.2", label: "6.2 Bagging、随机森林与 Boosting" },
    { level: 2, number: "6.3", label: "6.3 GBDT、XGBoost 与特征重要性" },
    { level: 1, number: "7", label: "第7章 支持向量机与核方法" },
    { level: 2, number: "7.1", label: "7.1 最大间隔与支持向量" },
    { level: 2, number: "7.2", label: "7.2 软间隔、惩罚参数与核函数" },
    { level: 2, number: "7.3", label: "7.3 SVM 分类与回归应用" },
    { level: 1, number: "8", label: "第8章 无监督学习与降维" },
    { level: 2, number: "8.1", label: "8.1 K-means 聚类与聚类评估" },
    { level: 2, number: "8.2", label: "8.2 高斯混合模型与 EM 算法" },
    { level: 2, number: "8.3", label: "8.3 PCA、流形学习与可视化" },
    { level: 1, number: "9", label: "第9章 神经网络与深度学习" },
    { level: 2, number: "9.1", label: "9.1 感知机、多层网络与激活函数" },
    { level: 2, number: "9.2", label: "9.2 反向传播、优化器与正则化" },
    { level: 2, number: "9.3", label: "9.3 CNN、RNN 与 Transformer 基础" },
    { level: 1, number: "10", label: "第10章 机器学习应用实践" },
    { level: 2, number: "10.1", label: "10.1 项目流程与实验设计" },
    { level: 2, number: "10.2", label: "10.2 模型部署、监控与可解释性" },
    { level: 2, number: "10.3", label: "10.3 推荐、文本与图像任务案例" }
  ];
}

function parseOutlineLine(rawLine, options = {}) {
  const allowBareChapter = Boolean(options.allowBareChapter);
  const line = cleanOutlineLabel(rawLine);
  if (!isUsefulGraphLabel(line)) return null;
  let match = line.match(/^第\s*([一二三四五六七八九十百零〇两\d]+)\s*([章节篇])\s*[:：、.\s-]*(.{2,36})$/);
  if (match) {
    const number = match[1];
    const title = cleanOutlineLabel(match[3]);
    const label = `第${number}${match[2]} ${title}`;
    return isUsefulGraphLabel(title) ? { level: 1, number, label } : null;
  }
  match = allowBareChapter ? line.match(/^([0-9]{1,2})(?:[.．]\s*|\s+)(?![0-9.．])(.{2,36})$/) : null;
  if (match && !/[。！？；;]$/.test(match[2])) {
    const title = cleanOutlineLabel(match[2]);
    if (!isUsefulGraphLabel(title)) return null;
    return { level: 1, number: match[1], label: `第${match[1]}章 ${title}` };
  }
  match = line.match(/^([0-9]{1,2}(?:[.．][0-9]{1,2}){1,3})\s*(.{2,42})$/);
  if (match) {
    const number = match[1].replace(/．/g, ".");
    const title = cleanOutlineLabel(match[2]);
    const level = Math.min(3, number.split(".").length);
    if (!isUsefulGraphLabel(title)) return null;
    return { level, number, label: `${number} ${title}` };
  }
  return null;
}

function extractBookOutline(text, subject = "", sourceName = "") {
  const source = normalizeExtractedText([text, subject, sourceName].filter(Boolean).join("\n\n"));
  const lower = source.toLowerCase();
  let markerIndex = -1;
  const markerMatch = lower.match(/(?:^|\n)\s*(目录|目\s*录|contents|table of contents)\s*(?:\n|$)/i);
  if (markerMatch) {
    markerIndex = markerMatch.index;
  }
  const inToc = markerIndex >= 0;
  const outlineWindow = inToc
    ? source.slice(markerIndex, markerIndex + 100000)
    : source.slice(0, 90000);
  const lines = outlineWindow
    .split(/\r?\n+/)
    .map((line) => cleanOutlineLabel(line))
    .filter((line) => line.length >= 3 && line.length <= 70);
  const combinedLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1] || "";
    if (/^第\s*[一二三四五六七八九十百零〇两\d]+\s*[章节篇]$/.test(line) && isUsefulGraphLabel(next)) {
      combinedLines.push(`${line} ${next}`);
      index += 1;
      continue;
    }
    if (/^\d{1,2}(?:[.．]\d{1,2}){1,3}$/.test(line) && isUsefulGraphLabel(next)) {
      combinedLines.push(`${line} ${next}`);
      index += 1;
      continue;
    }
    combinedLines.push(line);
  }
  const outline = [];
  const seen = new Set();
  for (const line of combinedLines) {
    const item = parseOutlineLine(line, { allowBareChapter: inToc });
    if (!item) continue;
    const key = `${item.level}:${item.number}:${outlineLabelCore(item.label)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    outline.push(item);
    if (outline.length >= 90) break;
  }
  const chapterCount = outline.filter((item) => item.level === 1).length;
  if (chapterCount >= 2 && outline.length >= 5) return outline;
  if (looksLikeMachineLearning(subject, `${sourceName}\n${source}`)) return fallbackMachineLearningOutline();
  return outline;
}

function textAroundLabel(text, label, fallbackStart = 0) {
  const source = String(text || "");
  if (!source) return "";
  const core = outlineLabelCore(label);
  const candidates = uniqueTexts([label, core, core.replace(/\s+/g, ""), core.split(/[、，,\s/]+/).find((part) => part.length >= 2)]);
  let index = -1;
  for (const candidate of candidates) {
    if (!candidate) continue;
    index = source.indexOf(candidate);
    if (index >= 0) break;
  }
  if (index < 0) index = Math.max(0, Math.min(source.length - 1, fallbackStart));
  return source.slice(Math.max(0, index - 1200), Math.min(source.length, index + 5200));
}

function fallbackTermsForSection(label, subject = "") {
  const text = `${subject} ${label}`;
  if (/初探|人工智能|机器学习是什么/.test(text)) return ["人工智能与机器学习", "预测与决策", "泛化能力", "归纳偏置"];
  if (/数学|向量|矩阵|梯度|凸函数/.test(text)) return ["向量", "矩阵", "梯度", "凸函数"];
  if (/K\s*近邻|KNN|最近邻/.test(text)) return ["KNN 算法原理", "分类任务", "回归任务", "距离度量与 K 值"];
  if (/线性回归/.test(text)) return ["映射形式与学习目标", "解析方法", "梯度下降", "学习率影响"];
  if (/基本思想|欠拟合|过拟合|超参数|交叉验证/.test(text)) return ["欠拟合与过拟合", "正则化约束", "参数与超参数", "数据集划分与交叉验证"];
  if (/逻辑斯谛|逻辑回归|Logistic/i.test(text)) return ["逻辑斯谛函数", "最大似然估计", "分类评价指标", "交叉熵损失"];
  if (/双线性|矩阵分解|因子分解/.test(text)) return ["矩阵分解", "隐向量表示", "因子分解机", "推荐任务"];
  if (/多层感知机|感知机|反向传播/.test(text)) return ["人工神经网络", "感知机", "隐含层与多层感知机", "反向传播"];
  if (/卷积神经网络|CNN|卷积|VGG/.test(text)) return ["卷积", "图像分类", "预训练网络", "内容表示与风格表示"];
  if (/循环神经网络|RNN|GRU|门控/.test(text)) return ["循环神经网络原理", "隐藏状态", "门控循环单元 GRU", "序列建模"];
  if (/支持向量机|SVM|核函数|最大间隔/.test(text)) return ["最大间隔", "支持向量", "SMO 求解", "核函数"];
  if (/决策树|ID3|C4\.5|CART/.test(text)) return ["决策树构造", "ID3 与 C4.5", "CART 算法", "剪枝与泛化"];
  if (/集成|随机森林|Boost|GBDT|梯度提升/.test(text)) return ["自举聚合 Bagging", "随机森林", "Boosting", "梯度提升决策树"];
  if (/k\s*均值|K-means|聚类/.test(text)) return ["k 均值原理", "聚类中心更新", "k-means++", "聚类评估"];
  if (/主成分|PCA|降维/.test(text)) return ["主成分与方差", "协方差矩阵", "特征分解", "降维可视化"];
  if (/概率图|贝叶斯|马尔可夫|朴素贝叶斯/.test(text)) return ["贝叶斯网络", "最大后验估计", "朴素贝叶斯", "马尔可夫网络"];
  if (/\bEM\b|EM 算法|高斯混合|GMM/.test(text)) return ["高斯混合模型", "E 步", "M 步", "收敛性"];
  if (/自编码|编码器|解码器/.test(text)) return ["编码器", "解码器", "重构损失", "表示学习"];
  if (/概述|任务|泛化|流程/.test(text)) return ["监督学习", "无监督学习", "训练集/验证集/测试集", "泛化能力"];
  if (/预处理|特征|数据/.test(text)) return ["数据清洗", "特征工程", "特征缩放", "数据泄漏"];
  if (/评估|选择|指标|验证/.test(text)) return ["损失函数", "交叉验证", "过拟合与欠拟合", "评价指标"];
  if (/优化|梯度|正则/.test(text)) return ["梯度下降", "学习率", "L1/L2 正则化", "早停"];
  if (/线性|回归|逻辑/.test(text)) return ["线性回归", "逻辑回归", "最小二乘", "Sigmoid 函数"];
  if (/近邻|KNN/.test(text)) return ["K 近邻", "距离度量", "K 值选择", "特征尺度"];
  if (/贝叶斯|概率/.test(text)) return ["朴素贝叶斯", "贝叶斯公式", "条件独立假设", "后验概率"];
  if (/决策树|集成|森林|Boost|GBDT/.test(text)) return ["决策树", "信息增益/基尼指数", "随机森林", "Boosting"];
  if (/支持向量|SVM|核/.test(text)) return ["支持向量机", "最大间隔", "软间隔", "核函数"];
  if (/聚类|降维|PCA|无监督/.test(text)) return ["K-means 聚类", "主成分分析 PCA", "高斯混合模型", "EM 算法"];
  if (/神经|深度|网络|CNN|RNN|Transformer/.test(text)) return ["神经网络", "反向传播", "激活函数", "CNN/RNN/Transformer"];
  if (/应用|实践|部署|解释/.test(text)) return ["项目流程", "模型部署", "可解释性", "实验复现"];
  return looksLikeMachineLearning(subject, text)
    ? ["数据集", "模型训练", "模型评估", "常见误区"]
    : [];
}

function extractTermsForSection(text, label, subject = "") {
  const sectionText = textAroundLabel(text, label);
  const matched = [];
  ML_TERM_PATTERNS.forEach((item) => {
    if (item.pattern.test(`${label}\n${sectionText}\n${subject}`)) matched.push(item.label);
  });
  const fallback = fallbackTermsForSection(label, subject);
  if (fallback.length >= 3 && /^第\s*[一二三四五六七八九十百零〇两\d]+\s*章/.test(cleanOutlineLabel(label))) {
    return uniqueTexts(fallback).filter(isUsefulGraphLabel).slice(0, 5);
  }
  const keywordTerms = extractKeywords(sectionText || label, subject).filter((item) => !outlineLabelCore(label).includes(item));
  return uniqueTexts(fallback.concat(matched, keywordTerms))
    .filter(isUsefulGraphLabel)
    .slice(0, 5);
}

function knowledgePointsForTerm(sectionText, term, parentLabel, subject = "") {
  const matched = ML_TERM_PATTERNS.find((item) => item.label === term || item.pattern.test(term));
  const extracted = knowledgePointsForKeyword(sectionText, term);
  return uniqueTexts([
    ...(matched?.points || []),
    ...extracted,
    `学习定位：「${term}」属于「${parentLabel}」，复习时要说明定义、输入输出、适用条件和典型题型。`,
    `GraphRAG 提示：回答「${term}」相关问题时，优先引用教材中对应章节，再补充模型推理和易错点。`,
    looksLikeMachineLearning(subject, `${term} ${parentLabel}`)
      ? `易错提醒：不要只记算法名称，要同时说明训练目标、关键假设、参数影响和评估方式。`
      : `易错提醒：不要只背节点名称，要结合上级章节解释它解决的问题。`
  ]).slice(0, 6);
}

function buildOutlineHierarchy(outline) {
  const chapters = [];
  let currentChapter = null;
  let currentSection = null;
  const chapterByNumber = new Map();
  outline.forEach((item) => {
    if (item.level <= 1 || !currentChapter) {
      currentChapter = { ...item, sections: [] };
      currentSection = null;
      chapters.push(currentChapter);
      if (item.number) chapterByNumber.set(String(item.number).split(".")[0], currentChapter);
      return;
    }
    const chapterKey = String(item.number || "").split(".")[0];
    const parentChapter = chapterByNumber.get(chapterKey) || currentChapter;
    if (item.level === 2 || !currentSection) {
      currentSection = { ...item, children: [] };
      parentChapter.sections.push(currentSection);
      currentChapter = parentChapter;
      return;
    }
    currentSection.children.push(item);
  });
  return chapters.slice(0, 14);
}

function addMachineLearningCrossLinks(nodes, links) {
  const findNode = (pattern) => nodes.find((node) => pattern.test(node.label));
  [
    [/训练集|验证集|测试集/, /泛化|过拟合/, "支撑泛化评估"],
    [/损失函数/, /梯度下降|优化/, "驱动参数更新"],
    [/正则化|早停/, /过拟合/, "抑制过拟合"],
    [/特征工程|特征缩放/, /K 近邻|K-means|SVM/, "影响距离与间隔"],
    [/决策树/, /随机森林|Boosting|集成/, "组成集成学习"],
    [/PCA|降维/, /可视化|聚类|K-means/, "服务结构发现"],
    [/反向传播/, /神经网络|深度学习/, "训练深层模型"]
  ].forEach(([sourcePattern, targetPattern, label]) => {
    const source = findNode(sourcePattern);
    const target = findNode(targetPattern);
    if (source && target && source.id !== target.id) links.push({ source: source.id, target: target.id, label, type: "cross-link" });
  });
}

function buildOutlineGraphFromText({ ownerId, title, subject, sourceName, sourceText, extraction, outline }) {
  const cleanSubject = normalizeSubject(subject);
  const chapters = buildOutlineHierarchy(outline);
  const rootLabel = title || `${cleanSubject}知识图谱`;
  const nodes = [makeGraphNode({
    id: "n0",
    label: rootLabel,
    group: "root",
    level: 0,
    subject: cleanSubject,
    details: `由${sourceName || "教材内容"}按“目录分支 -> 章节知识点 -> 微目标”生成。${extraction?.characters ? `已识别 ${extraction.characters} 个文本字符。` : ""}`,
    knowledgePoints: [
      `本图谱先根据目录确定「${cleanSubject}」主分支，再回到书本内容为各分支抽取知识点。`,
      "节点按章、节、知识点分级，可用于课程问答、GraphRAG 检索、学习路径规划和薄弱点归因。",
      "双击任一节点可查看知识路径、前置依赖、教学资源、考察属性和知识点详情。"
    ]
  })];
  const links = [];
  chapters.forEach((chapter, chapterIndex) => {
    const chapterId = `ch${chapterIndex + 1}`;
    const chapterText = textAroundLabel(sourceText, chapter.label, chapterIndex * 8000);
    const chapterCore = outlineLabelCore(chapter.label);
    nodes.push(makeGraphNode({
      id: chapterId,
      label: chapter.label,
      group: "chapter",
      level: 1,
      subject: cleanSubject,
      parentLabel: rootLabel,
      details: `一级分支：${chapter.label}。来源于教材目录，作为本章知识组织入口。`,
      knowledgePoints: uniqueTexts([
        ...knowledgePointsForKeyword(chapterText, chapterCore),
        ...fallbackOutlinePoints(chapter.label, rootLabel)
      ]).slice(0, 6)
    }));
    links.push({ source: "n0", target: chapterId, label: "一级章节", type: "contains" });
    if (chapterIndex > 0) links.push({ source: `ch${chapterIndex}`, target: chapterId, label: "前置依赖", type: "prerequisite" });

    const sections = chapter.sections.length
      ? chapter.sections
      : extractTermsForSection(chapterText || sourceText, chapter.label, cleanSubject).slice(0, 3).map((label, index) => ({
        level: 2,
        number: `${chapterIndex + 1}.${index + 1}`,
        label
      }));
    sections.slice(0, 8).forEach((section, sectionIndex) => {
      const sectionId = `${chapterId}s${sectionIndex + 1}`;
      const sectionText = textAroundLabel(sourceText || chapterText, section.label, chapterIndex * 8000 + sectionIndex * 1800);
      const sectionCore = outlineLabelCore(section.label);
      nodes.push(makeGraphNode({
        id: sectionId,
        label: section.label,
        group: sectionIndex % 2 === 0 ? "concept" : "topic",
        level: 2,
        subject: cleanSubject,
        parentLabel: chapter.label,
        details: `「${chapter.label}」下的二级知识分支：${section.label}。`,
        knowledgePoints: uniqueTexts([
          ...knowledgePointsForKeyword(sectionText || chapterText, sectionCore),
          `本节围绕「${sectionCore || section.label}」组织概念、方法、适用场景和常见误区。`,
          `学习时先明确它与「${chapter.label}」的关系，再通过例题或实验验证掌握情况。`
        ]).slice(0, 6)
      }));
      links.push({ source: chapterId, target: sectionId, label: "包含", type: "contains" });
      if (sectionIndex > 0) links.push({ source: `${chapterId}s${sectionIndex}`, target: sectionId, label: "前置依赖", type: "prerequisite" });

      const childLabels = uniqueTexts((section.children || []).map((item) => item.label)
        .concat(extractTermsForSection(sectionText || chapterText, section.label, cleanSubject)))
        .filter((label) => isUsefulGraphLabel(label) && outlineLabelCore(label) !== sectionCore)
        .slice(0, 5);
      childLabels.forEach((childLabel, childIndex) => {
        const childId = `${sectionId}k${childIndex + 1}`;
        nodes.push(makeGraphNode({
          id: childId,
          label: childLabel,
          group: "detail",
          level: 3,
          subject: cleanSubject,
          parentLabel: section.label,
          details: `「${chapter.label} > ${section.label}」下的三级知识点：${childLabel}。`,
          knowledgePoints: knowledgePointsForTerm(sectionText || chapterText, childLabel, section.label, cleanSubject)
        }));
        links.push({ source: sectionId, target: childId, label: "细分", type: "contains" });
      });
    });
  });
  if (looksLikeMachineLearning(cleanSubject, `${sourceName}\n${sourceText}`)) addMachineLearningCrossLinks(nodes, links);
  return enhanceGraphForEducation({
    id: uid("graph"),
    ownerId,
    subject: cleanSubject,
    title: title || `${cleanSubject}知识图谱`,
    sourceName: sourceName || "教材/讲义导入",
    extraction: {
      ...(extraction || {}),
      outlineDriven: true,
      outlineNodes: outline.length,
      outlineChapters: chapters.length,
      graphAgent: "outline-aware-education-kg-agent"
    },
    nodes,
    links,
    global: false,
    createdAt: now(),
    updatedAt: now()
  });
}

const COMPUTER_ORG_OUTLINE = [
  {
    label: "计算机系统概述",
    points: ["计算机发展历程", "系统层次结构", "硬件与软件接口", "性能指标"],
    details: "对应目录第 1 章，建立计算机系统整体视角，理解硬件、软件、层次结构、工作原理和性能评价。",
    sections: [
      {
        label: "计算机发展历程",
        points: ["理解硬件和软件的发展脉络，建立系统演进视角。"],
        children: ["计算机硬件的发展", "计算机软件的发展"]
      },
      {
        label: "计算机系统层次结构",
        points: ["计算机系统由硬件系统和软件系统共同组成。", "ISA 是软件和硬件之间的重要接口。"],
        children: ["计算机系统的组成", "计算机硬件", "计算机软件", "计算机系统的层次结构", "计算机系统的工作原理"]
      },
      {
        label: "计算机的性能指标",
        points: ["主频、时钟周期、CPI、MIPS、FLOPS、吞吐率和响应时间需要结合场景解释。"],
        children: ["计算机的主要性能指标", "几个专业术语"]
      },
      {
        label: "本章小结",
        points: ["用系统组成、层次结构和性能指标串联本章。"],
        children: ["常见问题和易混淆知识点"]
      }
    ]
  },
  {
    label: "数据的表示和运算",
    points: ["数制与编码", "定点数", "运算电路", "浮点数"],
    details: "对应目录第 2 章，解决数据如何在机器中编码、存储和参与算术逻辑运算的问题。",
    sections: [
      {
        label: "数制与编码",
        points: ["二进制、八进制、十六进制之间可按位分组转换。", "整数类型转换需要关注位宽、符号扩展和截断。"],
        children: ["进位计数制及其相互转换", "定点数的编码表示", "整数的表示", "C 语言中的整数类型及类型转换"]
      },
      {
        label: "运算方法和运算电路",
        points: ["基本运算部件、移位、加减、乘除共同构成定点运算基础。"],
        children: ["基本运算部件", "定点数的移位运算", "定点数的加减运算", "定点数的乘除运算"]
      },
      {
        label: "浮点数的表示与运算",
        points: ["阶码、尾数、规格化、舍入和溢出共同决定浮点数表示能力。"],
        children: ["浮点数的表示", "浮点数的加减运算", "C 语言中的浮点数类型", "数据的大小端和对齐存储"]
      },
      {
        label: "本章小结",
        points: ["从数制编码、定点运算、浮点运算和存储布局形成数据表示主线。"],
        children: ["常见问题和易混淆知识点"]
      }
    ]
  },
  {
    label: "存储系统",
    points: ["存储层次", "主存储器", "Cache", "虚拟存储器"],
    details: "对应目录第 3 章，围绕容量、速度、成本之间的矛盾建立多级存储层次。",
    sections: [
      {
        label: "存储器概述",
        points: ["寄存器、Cache、主存、辅存构成由快到慢、由小到大的层次。"],
        children: ["存储器的分类", "存储器的性能指标", "多级层次的存储系统"]
      },
      {
        label: "主存储器",
        points: ["SRAM、DRAM、ROM、地址译码和多模块结构是主存设计核心。"],
        children: ["SRAM 芯片和 DRAM 芯片", "只读存储器", "主存储器的基本组成", "多模块存储器"]
      },
      {
        label: "主存储器与 CPU 的连接",
        points: ["主存与 CPU 的连接要处理容量扩展、地址分配、片选和数据线连接。"],
        children: ["连接原理", "主存容量的扩展", "存储芯片的地址分配和片选", "存储器与 CPU 的连接"]
      },
      {
        label: "外部存储器",
        points: ["外存关注非易失、大容量和较慢访问速度。"],
        children: ["磁盘存储器", "固态硬盘"]
      },
      {
        label: "高速缓冲存储器",
        points: ["局部性原理、映射方式、替换算法和一致性问题影响 Cache 命中率。"],
        children: ["程序访问的局部性原理", "Cache 的基本工作原理", "Cache 和主存的映射方式", "Cache 中主存块的替换算法", "Cache 的一致性问题"]
      },
      {
        label: "虚拟存储器",
        points: ["页式、段式、段页式管理通过地址变换扩展逻辑地址空间。"],
        children: ["虚拟存储器的基本概念", "页式虚拟存储器", "段式虚拟存储器", "段页式虚拟存储器", "虚拟存储器与 Cache 的比较"]
      },
      {
        label: "本章小结",
        points: ["从存储层次、主存、Cache 和虚拟存储器串联访存路径。"],
        children: ["常见问题和易混淆知识点"]
      }
    ]
  },
  {
    label: "指令系统",
    points: ["指令格式", "寻址方式", "机器级代码", "CISC 与 RISC"],
    details: "对应目录第 4 章，说明机器指令如何描述操作、操作数位置以及处理器需要执行的动作。",
    sections: [
      {
        label: "指令系统",
        points: ["操作码、地址码、寻址特征和指令长度共同决定指令表达能力。"],
        children: ["指令集体系结构", "指令的基本格式", "定长操作码指令格式", "扩展操作码指令格式", "指令的操作类型"]
      },
      {
        label: "指令的寻址方式",
        points: ["指令寻址和数据寻址决定操作数定位与访存过程。"],
        children: ["指令寻址和数据寻址", "常见的数据寻址方式"]
      },
      {
        label: "程序的机器级代码表示",
        points: ["汇编指令、选择语句、循环语句和过程调用对应机器级执行过程。"],
        children: ["常用汇编指令介绍", "选择语句的机器级表示", "循环语句的机器级表示", "过程调用的机器级表示"]
      },
      {
        label: "CISC 和 RISC 的基本概念",
        points: ["CISC 指令复杂且类型多，RISC 强调简单指令、流水线和寄存器利用。"],
        children: ["复杂指令系统计算机（CISC）", "精简指令系统计算机（RISC）", "CISC 和 RISC 的比较"]
      },
      {
        label: "本章小结",
        points: ["把指令格式、寻址、机器级程序和体系结构风格连接到 CPU 执行。"],
        children: ["常见问题和易混淆知识点"]
      }
    ]
  },
  {
    label: "中央处理器",
    points: ["CPU 结构", "指令执行", "数据通路", "控制器", "流水线"],
    details: "对应目录第 5 章，关注 CPU 内部如何组织数据流、控制流，并高效完成指令执行。",
    sections: [
      {
        label: "CPU 的功能和基本结构",
        points: ["ALU、寄存器组、控制器、内部总线和状态寄存器构成基本 CPU。"],
        children: ["CPU 的功能", "CPU 的基本结构", "CPU 的寄存器"]
      },
      {
        label: "指令执行过程",
        points: ["取指、译码、执行、访存、写回构成典型指令周期。"],
        children: ["指令周期", "指令周期的数据流", "执行方案"]
      },
      {
        label: "数据通路的功能和基本结构",
        points: ["组合逻辑、时序逻辑、寄存器传送和多路选择器共同组织数据流。"],
        children: ["数据通路的功能", "数据通路的组成", "数据通路的基本结构", "数据通路的操作举例"]
      },
      {
        label: "控制器的功能和工作原理",
        points: ["硬布线控制速度快，微程序控制灵活，二者适合不同设计目标。"],
        children: ["控制器的结构和功能", "硬布线控制器", "微程序控制器"]
      },
      {
        label: "异常和中断机制",
        points: ["异常源于处理器执行过程，中断通常来自外设或外部事件。"],
        children: ["异常和中断的基本概念", "异常和中断的分类", "异常和中断的处理"]
      },
      {
        label: "指令流水线",
        points: ["结构冒险、数据冒险和控制冒险会影响流水线吞吐率。"],
        children: ["指令流水线的基本概念", "流水线的基本实现", "流水线的冒险与处理", "流水线的性能指标", "高级流水线技术"]
      },
      {
        label: "多处理器的基本概念",
        points: ["多处理器通过并行结构提升吞吐能力。"],
        children: ["SISD、SIMD、MIMD 的基本概念", "硬件多线程的基本概念", "多核处理器的基本概念", "共享内存多处理器的基本概念"]
      },
      {
        label: "本章小结",
        points: ["把 CPU 结构、控制、数据通路、流水线和并行处理串成执行主线。"],
        children: ["常见问题和易混淆知识点"]
      }
    ]
  },
  {
    label: "总线",
    points: ["总线概念", "总线分类", "系统总线结构", "总线仲裁"],
    details: "对应目录第 6 章，处理计算机各部件之间共享通信、仲裁、定时和性能评价。",
    sections: [
      {
        label: "总线概述",
        points: ["数据总线、地址总线、控制总线通过仲裁和定时完成共享通信。"],
        children: ["总线的基本概念", "总线的分类", "系统总线的结构", "常见的总线标准", "总线的性能指标"]
      },
      {
        label: "总线仲裁",
        points: ["总线事务和总线定时决定共享总线的访问顺序和传输节拍。"],
        children: ["总线事务", "总线定时"]
      },
      {
        label: "本章小结",
        points: ["用结构、标准、性能、仲裁和定时总结总线系统。"],
        children: ["常见问题和易混淆知识点"]
      }
    ]
  },
  {
    label: "输入/输出系统",
    points: ["I/O 系统", "外部设备", "I/O 接口", "I/O 方式"],
    details: "对应目录第 7 章，处理主机与外部设备之间的数据传送、接口编址、中断和 DMA。",
    sections: [
      {
        label: "I/O 系统基本概念",
        points: ["I/O 系统把外部设备、接口和控制方式纳入主机数据通路。"],
        children: ["输入/输出系统", "外部设备", "I/O 控制方式"]
      },
      {
        label: "I/O 接口",
        points: ["接口完成地址译码、数据缓冲、状态保存和控制命令交互。"],
        children: ["I/O 接口的功能", "I/O 接口的基本结构", "I/O 端口及其编址", "I/O 端口及其地址"]
      },
      {
        label: "I/O 方式",
        points: ["程序查询、中断和 DMA 分别代表不同 CPU 参与程度的数据传送方式。"],
        children: ["程序查询方式", "程序中断方式", "DMA 方式"]
      },
      {
        label: "本章小结",
        points: ["用外设、接口、端口编址、查询、中断和 DMA 串联 I/O 系统。"],
        children: ["常见问题和易混淆知识点"]
      }
    ]
  }
];

function looksLikeComputerOrganization(subject, text) {
  const source = `${subject} ${text}`.toLowerCase();
  return /计算机组成|组成原理|computer organization|cpu|cache|指令系统|存储系统|总线|中央处理器|输入\/输出|i\/o/.test(source);
}

const EDUCATION_COGNITIVE_LEVELS = ["记忆", "理解", "应用", "分析", "评价", "创造"];
const EDUCATION_COMPETENCIES = ["逻辑推理", "模型建构", "科学探究", "数据意识", "问题解决", "系统思维", "价值判断"];
const EDUCATION_ONTOLOGY_LAYERS = ["学科知识图谱", "认知能力图谱", "教学资源图谱", "素养与价值图谱", "学习者认知图谱"];
const EDUCATION_SEMANTIC_RELATIONS = ["contains", "prerequisite", "misconception", "cross-link", "assessment", "resource", "competency", "semantic"];
const EDUCATION_GRAPHRAG_SCHEMA = ["层级路径", "前置依赖", "下级知识点", "易混淆概念", "教学资源", "考察属性", "学生掌握状态"];

function stableNumber(value, modulo = 100) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % modulo;
}

function inferOntologyType(group, level) {
  if (level === 0 || group === "root") return "domain-root";
  if (level === 1 || group === "chapter") return "chapter";
  if (level === 2 || group === "concept" || group === "topic") return "knowledge-point";
  return "micro-objective";
}

function inferCognitiveLevel(label, level = 2) {
  const text = String(label || "");
  if (/设计|创造|综合|方案|建构|项目/.test(text)) return "创造";
  if (/评价|比较|权衡|优劣|性能指标/.test(text)) return "评价";
  if (/分析|过程|机制|原理|数据流|控制流|地址变换/.test(text)) return "分析";
  if (/应用|计算|例题|执行|操作|实验|DMA|Cache|CPU/.test(text)) return "应用";
  if (/概念|结构|功能|分类|特点/.test(text)) return "理解";
  return EDUCATION_COGNITIVE_LEVELS[Math.min(EDUCATION_COGNITIVE_LEVELS.length - 1, Math.max(0, level + 1))] || "理解";
}

function inferCompetencies(label, subject = "") {
  const text = `${subject} ${label}`;
  const result = [];
  if (/数学|函数|导数|公式|运算|数制|编码|逻辑/.test(text)) result.push("逻辑推理");
  if (/物理|实验|探究|I\/O|总线|Cache|CPU|系统|结构/.test(text)) result.push("科学探究", "模型建构");
  if (/数据|存储|地址|编码|图|表|统计/.test(text)) result.push("数据意识");
  if (/方案|应用|题|问题|执行|性能/.test(text)) result.push("问题解决");
  if (/组成|系统|层次|网络|架构|总线|计算机/.test(text)) result.push("系统思维");
  if (!result.length) result.push(EDUCATION_COMPETENCIES[stableNumber(text, EDUCATION_COMPETENCIES.length)]);
  return Array.from(new Set(result)).slice(0, 3);
}

function inferNodeResources(label, subject = "") {
  const topic = String(label || "知识点");
  return [
    { type: "micro-video", title: `${topic} 5 分钟微课`, use: "课前预习或错题后快速回看" },
    { type: "exercise", title: `${topic} 分层练习`, use: "基础题、迁移题、综合题逐级检测" },
    { type: /实验|CPU|Cache|总线|I\/O|物理|系统/.test(`${subject}${topic}`) ? "interactive-sim" : "worked-example", title: `${topic} 互动模型/例题`, use: "把抽象过程可视化，支撑应用与分析" }
  ];
}

function inferAssessment(label, level = 2) {
  const seed = stableNumber(label, 100);
  const difficulty = Math.min(0.95, Math.max(0.18, 0.25 + level * 0.13 + seed / 420));
  return {
    examFrequency: seed > 72 ? "高频" : seed > 38 ? "中频" : "低频",
    difficulty: Number(difficulty.toFixed(2)),
    discrimination: Number(Math.min(0.92, 0.35 + difficulty * 0.58).toFixed(2))
  };
}

function inferLearnerState(label, level = 2) {
  const seed = stableNumber(label, 100);
  return {
    status: "待真实诊断",
    mastery: null,
    heat: null,
    weight: Number((1 + level * 0.18 + (100 - seed) / 180).toFixed(2)),
    evidence: "暂无基于问答、课堂测验或教师确认批改的真实学习记录。"
  };
}

function relationTypeLabel(type) {
  return {
    contains: "层级包含",
    prerequisite: "前置依赖",
    misconception: "易混淆/迷思概念",
    "cross-link": "横向关联",
    assessment: "考察属性",
    resource: "教学资源",
    competency: "核心素养",
    semantic: "语义关联"
  }[type] || "语义关联";
}

function educationalNodeProfile({ label, group, level, subject, parentLabel, details }) {
  return {
    ontology: {
      domain: subject || "通用",
      type: inferOntologyType(group, level),
      parent: parentLabel || "",
      layer: level === 0 ? "学科根" : level === 1 ? "章" : level === 2 ? "节/知识点" : "考点/微目标"
    },
    cognitive: {
      bloom: inferCognitiveLevel(label, level),
      objective: `学生能够围绕「${label}」完成${inferCognitiveLevel(label, level)}层级的解释、迁移或问题解决。`
    },
    resources: inferNodeResources(label, subject),
    competencies: inferCompetencies(label, subject),
    assessment: inferAssessment(label, level),
    learnerState: inferLearnerState(label, level),
    graphRag: {
      retrievalRole: level <= 1 ? "context-anchor" : level === 2 ? "retrieval-concept" : "evidence-node",
      keywords: Array.from(new Set(String(label || "").split(/[、，,\s/]+/).filter(Boolean))).slice(0, 6),
      contextSchema: EDUCATION_GRAPHRAG_SCHEMA,
      subgraphQuery: "向上取层级路径，向下取 1-2 层子节点，同时取 prerequisite、misconception、cross-link 关系。",
      promptHint: `回答与「${label}」相关问题时，优先提取它的前置依赖、下级节点、易混淆点、典型例题和资源节点。`
    },
    navigation: {
      learningPathRole: level <= 1 ? "路径锚点" : level === 2 ? "核心学习节点" : "补救/考点节点",
      shortestPathHint: `从当前已掌握节点到「${label}」时，优先沿前置依赖和章节包含关系生成最短学习路径。`,
      weaknessTraceHint: `若「${label}」相关题目出错，沿 prerequisite 入边向前追溯低掌握度节点，定位真正薄弱点。`
    },
    misconception: /易错|混淆|问题|错误|风险/.test(`${label}${details || ""}`)
      ? `学生容易把「${label}」与相邻概念边界混淆，应先比较定义、条件和适用场景。`
      : `学习「${label}」时要避免只背名称，应同时说明条件、过程、例题和相邻关系。`
  };
}

function makeGraphNode({ id, label, group, level, knowledgePoints = [], details = "", subject = "", parentLabel = "" }) {
  const profile = educationalNodeProfile({ label, group, level, subject, parentLabel, details });
  return {
    id,
    label,
    group,
    level,
    details,
    knowledgePoints: knowledgePoints.filter(Boolean).map((point) => String(point).slice(0, 180)),
    ...profile
  };
}

function educationalLink(link, index = 0) {
  const rawLabel = String(link.label || link.relation || "关联");
  let type = String(link.type || "");
  if (!type) {
    if (/包含|章节|模块|细分/.test(rawLabel)) type = "contains";
    else if (/前置|递进|支撑|驱动|进入|服务/.test(rawLabel)) type = "prerequisite";
    else if (/易混|迷思|常见问题|易错/.test(rawLabel)) type = "misconception";
    else if (/考|高频|难度|区分度/.test(rawLabel)) type = "assessment";
    else if (/跨|关联|连接|响应|参与|缓解/.test(rawLabel)) type = "cross-link";
    else type = "semantic";
  }
  return {
    source: String(link.source),
    target: String(link.target),
    label: rawLabel,
    type,
    typeLabel: relationTypeLabel(type),
    weight: Number.isFinite(Number(link.weight)) ? Number(link.weight) : Number((0.55 + stableNumber(`${link.source}-${link.target}-${rawLabel}`, 40) / 100).toFixed(2)),
    pedagogy: link.pedagogy || (
      type === "prerequisite" ? "学习路径规划和薄弱点归因优先使用"
        : type === "misconception" ? "用于提前预警常见错误概念"
          : type === "assessment" ? "用于考频、难度和区分度分析"
            : type === "cross-link" ? "用于跨章节/跨学科迁移"
              : "用于层级上下文组织"
    )
  };
}

function isContainsEducationLink(link) {
  return String(link.type || "") === "contains" || /包含|章节|模块|细分|一级/.test(String(link.label || link.relation || ""));
}

function graphEducationStats(nodes, links) {
  const countBy = (items, getter) => items.reduce((acc, item) => {
    const key = getter(item) || "未知";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    ontology: countBy(nodes, (node) => node.ontology?.layer),
    cognitive: countBy(nodes, (node) => node.cognitive?.bloom),
    learnerState: countBy(nodes, (node) => node.learnerState?.status),
    relationTypes: countBy(links, (link) => link.type)
  };
}

function enhanceGraphForEducation(graph) {
  const nodes = graph.nodes || [];
  const nodeMap = new Map(nodes.map((node) => [String(node.id), node]));
  const parentByChild = new Map();
  (graph.links || []).forEach((link) => {
    if (isContainsEducationLink(link) && !parentByChild.has(String(link.target))) {
      parentByChild.set(String(link.target), String(link.source));
    }
  });
  const enhancedNodes = nodes.map((node, index) => {
    const id = String(node.id || `n${index}`);
    const label = String(node.label || node.name || `节点${index + 1}`);
    const level = Number.isFinite(Number(node.level)) ? Number(node.level) : index === 0 ? 0 : undefined;
    const parent = nodeMap.get(parentByChild.get(id));
    const profile = educationalNodeProfile({
      label,
      group: node.group || "topic",
      level: Number.isFinite(Number(level)) ? Number(level) : 2,
      subject: graph.subject,
      parentLabel: parent?.label || "",
      details: node.details
    });
    return {
      ...node,
      id,
      label,
      group: String(node.group || "topic"),
      level,
      details: String(node.details || ""),
      knowledgePoints: Array.isArray(node.knowledgePoints) ? node.knowledgePoints.map(String) : [],
      ontology: { ...profile.ontology, ...(node.ontology || {}) },
      cognitive: { ...profile.cognitive, ...(node.cognitive || {}) },
      resources: Array.isArray(node.resources) && node.resources.length ? node.resources : profile.resources,
      competencies: Array.isArray(node.competencies) && node.competencies.length ? node.competencies : profile.competencies,
      assessment: { ...profile.assessment, ...(node.assessment || {}) },
      learnerState: { ...profile.learnerState, ...(node.learnerState || {}) },
      graphRag: { ...profile.graphRag, ...(node.graphRag || {}) },
      navigation: { ...profile.navigation, ...(node.navigation || {}) },
      misconception: node.misconception || profile.misconception
    };
  });
  const enhancedLinks = (graph.links || []).map(educationalLink);
  const existing = new Set(enhancedLinks.map((link) => `${link.source}->${link.target}:${link.type}`));
  const childrenByParent = new Map();
  enhancedLinks.forEach((link) => {
    if (!["contains"].includes(link.type)) return;
    if (!childrenByParent.has(link.source)) childrenByParent.set(link.source, []);
    childrenByParent.get(link.source).push(link.target);
  });
  childrenByParent.forEach((children) => {
    children.forEach((target, index) => {
      if (index === 0) return;
      const source = children[index - 1];
      const key = `${source}->${target}:prerequisite`;
      if (!existing.has(key)) {
        enhancedLinks.push(educationalLink({ source, target, label: "前置依赖", type: "prerequisite" }));
        existing.add(key);
      }
    });
  });
  enhancedNodes.forEach((node) => {
    if (!/易错|常见问题|混淆|误区|小结/.test(String(node.label))) return;
    const parentId = parentByChild.get(node.id);
    if (!parentId) return;
    const key = `${parentId}->${node.id}:misconception`;
    if (!existing.has(key)) {
      enhancedLinks.push(educationalLink({ source: parentId, target: node.id, label: "易混淆/迷思概念", type: "misconception" }));
      existing.add(key);
    }
  });
  const educationStats = graphEducationStats(enhancedNodes, enhancedLinks);
  return {
    ...graph,
    nodes: enhancedNodes,
    links: enhancedLinks,
    meta: {
      ...(graph.meta || {}),
      educationModel: "Domain KG + Cognitive KG + Resource KG + Competency KG + Learner State KG",
      graphRagReady: true,
      ontologyLayers: EDUCATION_ONTOLOGY_LAYERS,
      semanticRelations: EDUCATION_SEMANTIC_RELATIONS,
      graphRag: {
        ready: true,
        localSubgraphExtraction: true,
        contextSchema: EDUCATION_GRAPHRAG_SCHEMA,
        hallucinationControl: "优先用局部子图、前置依赖、例题资源和节点证据组织大模型上下文。"
      },
      navigation: {
        shortestLearningPath: true,
        weaknessAttribution: true,
        dynamicLearnerOverlay: true
      },
      stats: educationStats,
      updatedBy: "education-kg-enricher"
    }
  };
}

function fallbackOutlinePoints(label, parentLabel = "") {
  const topic = String(label || "知识点");
  const parent = String(parentLabel || "本模块");
  const focused = [];
  if (/Cache|缓存|高速缓冲/.test(topic)) focused.push("重点区分命中率、映射方式、替换算法、写策略和一致性问题。");
  if (/CPU|处理器|控制器|数据通路|流水线/.test(topic)) focused.push("重点沿取指、译码、执行、访存、写回分析数据流和控制信号。");
  if (/存储|主存|虚拟|页式|段式|磁盘|固态/.test(topic)) focused.push("重点比较容量、速度、成本、地址变换和访存路径。");
  if (/指令|寻址|机器级|汇编|CISC|RISC/.test(topic)) focused.push("重点说明操作码、操作数位置、寻址过程和机器级执行结果。");
  if (/总线|I\/O|接口|DMA|中断|外部设备/.test(topic)) focused.push("重点关注主机与外设之间的数据传送路径、控制方式和 CPU 参与程度。");
  if (/数制|编码|定点|浮点|运算|移位|加减|乘除|整数/.test(topic)) focused.push("重点写清表示范围、符号位规则、溢出判断和运算步骤。");
  return [
    `核心定位：「${topic}」是「${parent}」中的关键节点，先明确它解决的硬件组织或机器级执行问题。`,
    `学习任务：能解释「${topic}」的定义、组成、工作流程和适用条件，并能画出简化关系图。`,
    focused[0] || `复习重点：围绕「${topic}」整理概念边界、结构关系、典型公式或执行步骤。`,
    `考查方式：常结合选择题、综合题或流程分析题，要求判断条件、比较差异并说明原因。`,
    `易错提醒：不要孤立背诵「${topic}」，要说明它与「${parent}」及相邻节点之间的数据流、控制流或层次关系。`
  ];
}

function buildComputerOrganizationGraph({ ownerId, title, subject, sourceName, sourceText, extraction }) {
  const cleanSubject = normalizeSubject(subject || "计算机组成原理");
  const rootId = "n0";
  const nodes = [makeGraphNode({
    id: rootId,
    label: "计算机组成原理",
    group: "root",
    level: 0,
    subject: cleanSubject,
    details: `由${sourceName || "教材内容"}生成。${extraction?.characters ? `已识别 ${extraction.characters} 个文本字符。` : ""}`,
    knowledgePoints: [
      "围绕数据表示、存储系统、指令系统、CPU、总线与 I/O 建立计算机硬件系统知识主线。",
      "重点关注各部件之间的数据流、控制流、地址变换和性能影响。",
      "适合用于 26 王道《计算机组成原理》教材复习、章节串联和试题定位。"
    ]
  })];
  const links = [];
  COMPUTER_ORG_OUTLINE.forEach((chapter, chapterIndex) => {
    const chapterId = `c${chapterIndex + 1}`;
    nodes.push(makeGraphNode({
      id: chapterId,
      label: chapter.label,
      group: "chapter",
      level: 1,
      subject: cleanSubject,
      parentLabel: "计算机组成原理",
      details: chapter.details,
      knowledgePoints: chapter.points
    }));
    links.push({ source: rootId, target: chapterId, label: "一级章节" });
    chapter.sections.forEach((rawSection, sectionIndex) => {
      const section = Array.isArray(rawSection)
        ? { label: rawSection[0], points: rawSection[1] || [], children: [] }
        : rawSection;
      const label = section.label;
      const points = Array.isArray(section.points) && section.points.length
        ? section.points
        : fallbackOutlinePoints(label, chapter.label);
      const sectionId = `${chapterId}s${sectionIndex + 1}`;
      nodes.push(makeGraphNode({
        id: sectionId,
        label,
        group: sectionIndex % 2 === 0 ? "concept" : "topic",
        level: 2,
        subject: cleanSubject,
        parentLabel: chapter.label,
        details: `「${chapter.label}」下的核心知识点：${label}`,
        knowledgePoints: points.length ? points : knowledgePointsForKeyword(sourceText, label)
      }));
      links.push({ source: chapterId, target: sectionId, label: "包含" });
      (section.children || []).forEach((rawChild, childIndex) => {
        const child = typeof rawChild === "string" ? { label: rawChild } : rawChild;
        const childLabel = child.label || `知识点${childIndex + 1}`;
        const childId = `${sectionId}k${childIndex + 1}`;
        const childPoints = Array.isArray(child.points) && child.points.length
          ? child.points
          : fallbackOutlinePoints(childLabel, label);
        nodes.push(makeGraphNode({
          id: childId,
          label: childLabel,
          group: "detail",
          level: 3,
          subject: cleanSubject,
          parentLabel: label,
          details: `「${chapter.label} > ${label}」下的三级知识点：${childLabel}`,
          knowledgePoints: childPoints
        }));
        links.push({ source: sectionId, target: childId, label: "细分" });
      });
    });
  });
  [
    ["c2s2", "c5s3", "支撑数据通路"],
    ["c2s3", "c5s3", "进入数据通路"],
    ["c3s5", "c5s6", "缓解访存瓶颈"],
    ["c4s1", "c5s2", "驱动执行过程"],
    ["c4s2", "c3s6", "参与地址变换"],
    ["c5s5", "c7s3", "响应外部事件"],
    ["c6s2", "c7s2", "连接 I/O 接口"],
    ["c7s3", "c3s2", "直接访问主存"],
    ["c3s1", "c5s1", "服务 CPU 访存"]
  ].forEach(([source, target, label]) => links.push({ source, target, label }));
  return enhanceGraphForEducation({
    id: uid("graph"),
    ownerId,
    subject: cleanSubject,
    title: title || "计算机组成原理知识图谱",
    sourceName: sourceName || "26王道《计算机组成原理》.pdf",
    extraction: extraction || null,
    nodes,
    links,
    global: false,
    createdAt: now(),
    updatedAt: now()
  });
}

function buildGraphFromText({ ownerId, title, subject, sourceName, sourceText, extraction }) {
  const cleanSubject = normalizeSubject(subject);
  const graphSourceText = limitText([sourceText, title, sourceName].filter(Boolean).join("\n\n"));
  if (looksLikeComputerOrganization(cleanSubject, graphSourceText)) {
    return buildComputerOrganizationGraph({ ownerId, title, subject: cleanSubject, sourceName, sourceText: graphSourceText, extraction });
  }
  const outline = extractBookOutline(graphSourceText, cleanSubject, sourceName);
  if (outline.length >= 3) {
    return buildOutlineGraphFromText({
      ownerId,
      title,
      subject: cleanSubject,
      sourceName,
      sourceText: graphSourceText,
      extraction,
      outline
    });
  }
  const keywords = extractKeywords(graphSourceText, cleanSubject);
  const nodes = [makeGraphNode({
    id: "n0",
    label: `${cleanSubject}知识主线`,
    group: "root",
    level: 0,
    subject: cleanSubject,
    knowledgePoints: splitKnowledgeSentences(graphSourceText).slice(0, 6),
    details: `由${sourceName || "输入内容"}生成。${extraction?.characters ? `已识别 ${extraction.characters} 个文本字符。` : ""}`
  })];
  const links = [];
  const groups = [];
  for (let i = 0; i < keywords.length; i += 3) groups.push(keywords.slice(i, i + 3));
  groups.forEach((group, groupIndex) => {
    const chapterId = `g${groupIndex + 1}`;
    const chapterLabel = group[0] || `模块${groupIndex + 1}`;
    nodes.push(makeGraphNode({
      id: chapterId,
      label: chapterLabel,
      group: "chapter",
      level: 1,
      subject: cleanSubject,
      parentLabel: `${cleanSubject}知识主线`,
      knowledgePoints: knowledgePointsForKeyword(graphSourceText, chapterLabel),
      details: `从书本内容中抽取的一级模块：「${chapterLabel}」。`
    }));
    links.push({ source: "n0", target: chapterId, label: "一级模块" });
    group.slice(1).forEach((keyword, sectionIndex) => {
      const nodeId = `${chapterId}s${sectionIndex + 1}`;
      nodes.push(makeGraphNode({
        id: nodeId,
        label: keyword,
        group: sectionIndex % 2 === 0 ? "concept" : "topic",
        level: 2,
        subject: cleanSubject,
        parentLabel: chapterLabel,
        knowledgePoints: knowledgePointsForKeyword(graphSourceText, keyword),
        details: `从书本内容和补充知识点中抽取的「${keyword}」相关知识。`
      }));
      links.push({ source: chapterId, target: nodeId, label: "包含" });
    });
    if (groupIndex > 0) links.push({ source: `g${groupIndex}`, target: chapterId, label: "递进" });
  });
  return enhanceGraphForEducation({
    id: uid("graph"),
    ownerId,
    subject: cleanSubject,
    title: title || `${cleanSubject}知识图谱`,
    sourceName: sourceName || "手动导入",
    extraction: extraction || null,
    nodes,
    links,
    global: false,
    createdAt: now(),
    updatedAt: now()
  });
}

function validateGraph(raw, fallback) {
  const graph = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
    throw Object.assign(new Error("图谱 JSON 需要包含 nodes 和 links 数组"), { status: 400 });
  }
  const sanitized = {
    id: uid("graph"),
    ownerId: fallback.ownerId,
    subject: normalizeSubject(graph.subject || fallback.subject),
    title: graph.title || fallback.title || "导入知识图谱",
    sourceName: fallback.sourceName || "JSON 导入",
    extraction: graph.extraction || null,
    nodes: graph.nodes.map((node, index) => ({
      id: String(node.id || `n${index}`),
      label: String(node.label || node.name || `节点${index + 1}`),
      group: String(node.group || "topic"),
      level: Number.isFinite(Number(node.level)) ? Number(node.level) : undefined,
      x: Number.isFinite(Number(node.x)) ? Number(node.x) : undefined,
      y: Number.isFinite(Number(node.y)) ? Number(node.y) : undefined,
      details: String(node.details || ""),
      knowledgePoints: Array.isArray(node.knowledgePoints) ? node.knowledgePoints.map(String) : [],
      ontology: node.ontology && typeof node.ontology === "object" ? node.ontology : undefined,
      cognitive: node.cognitive && typeof node.cognitive === "object" ? node.cognitive : undefined,
      resources: Array.isArray(node.resources) ? node.resources : undefined,
      competencies: Array.isArray(node.competencies) ? node.competencies.map(String) : undefined,
      assessment: node.assessment && typeof node.assessment === "object" ? node.assessment : undefined,
      prerequisites: Array.isArray(node.prerequisites) ? node.prerequisites.map(String).slice(0, 20) : undefined,
      learningGoal: node.learningGoal ? String(node.learningGoal).slice(0, 500) : undefined,
      misconceptions: Array.isArray(node.misconceptions) ? node.misconceptions.map(String).slice(0, 12) : undefined,
      diagnosticQuestions: Array.isArray(node.diagnosticQuestions) ? node.diagnosticQuestions.map(String).slice(0, 12) : undefined,
      remediationResources: Array.isArray(node.remediationResources) ? node.remediationResources.map(String).slice(0, 12) : undefined,
      verificationQuestions: Array.isArray(node.verificationQuestions) ? node.verificationQuestions.map(String).slice(0, 12) : undefined,
      masteryStandard: node.masteryStandard ? String(node.masteryStandard).slice(0, 500) : undefined,
      learnerState: node.learnerState && typeof node.learnerState === "object" ? node.learnerState : undefined,
      graphRag: node.graphRag && typeof node.graphRag === "object" ? node.graphRag : undefined,
      navigation: node.navigation && typeof node.navigation === "object" ? node.navigation : undefined,
      misconception: node.misconception ? String(node.misconception) : undefined
    })),
    links: graph.links.map((link) => ({
      source: String(link.source),
      target: String(link.target),
      label: String(link.label || link.relation || "关联"),
      type: link.type ? String(link.type) : undefined,
      typeLabel: link.typeLabel ? String(link.typeLabel) : undefined,
      weight: Number.isFinite(Number(link.weight)) ? Number(link.weight) : undefined,
      pedagogy: link.pedagogy ? String(link.pedagogy) : undefined
    })),
    global: false,
    createdAt: now(),
    updatedAt: now()
  };
  return enhanceGraphForEducation(sanitized);
}

function processGraphGenerationJob(jobId, payload) {
  setImmediate(async () => {
    try {
      const aiUnlimited = isAiUnlimitedExtractor(payload.extractor);
      assertGraphJobActive(jobId);
      const payloadFiles = Array.isArray(payload.files) && payload.files.length
        ? payload.files
        : (payload.file ? [payload.file] : []);
      updateGraphJob(jobId, {
        status: "running",
        stage: aiUnlimited ? "AI 识别文件" : "解析文件",
        progress: 22,
        message: payloadFiles.length
          ? (aiUnlimited ? `AI 自动图谱智能体正在汇总读取 ${payloadFiles.length} 个文件，扫描版会做有限 OCR 并融合目录线索` : `正在解析 ${payloadFiles.length} 个上传文件，扫描版 PDF 会自动尝试 OCR`)
          : "正在读取输入内容"
      });

      const extractedFiles = [];
      for (let fileIndex = 0; fileIndex < payloadFiles.length; fileIndex += 1) {
        const file = payloadFiles[fileIndex];
        assertGraphJobActive(jobId);
        updateGraphJob(jobId, {
          stage: aiUnlimited ? "AI 识别文件" : "解析文件",
          progress: Math.min(62, 22 + Math.floor((fileIndex / Math.max(1, payloadFiles.length)) * 40)),
          message: `正在解析第 ${fileIndex + 1}/${payloadFiles.length} 个文件：${file.name || payload.sourceName || "上传文件"}`
        });
        const uploadedFile = file.filePath
          ? await extractUploadedBookFile({
            ...file,
            extractor: payload.extractor,
            subject: payload.subject,
            sourceText: payload.sourceText
          }, (stats) => {
            if (isGraphJobCanceled(jobId)) return;
            const totalPages = Number(stats.pages || 0);
            const currentPage = Number(stats.page || 0);
            const isOcrStage = String(stats.stage || "").startsWith("ocr") || /OCR/i.test(String(stats.method || ""));
            const pdfPageInfo = stats.pdfPage
              ? `（PDF 第 ${stats.pdfPage}${stats.pdfPages ? `/${stats.pdfPages}` : ""} 页）`
              : "";
            const localProgress = totalPages
              ? currentPage / Math.max(1, totalPages)
              : Math.min(1, Number(stats.scannedStreams || 0) / 30);
            updateGraphJob(jobId, {
              progress: Math.min(62, 24 + Math.floor(((fileIndex + localProgress) / Math.max(1, payloadFiles.length)) * 38)),
              message: stats.message || (totalPages
                ? `${stats.method || "PDF 智能体"} 正在${isOcrStage ? "OCR" : "解析"}第 ${currentPage}/${totalPages} 页${pdfPageInfo}，已识别 ${stats.characters || 0} 字符`
                : (stats.message || `第 ${fileIndex + 1}/${payloadFiles.length} 个文件已扫描 ${stats.scannedStreams || 0} 个 PDF 内容流，跳过图片流 ${stats.imageStreams || 0} 个`))
            });
          }, jobId)
          : file.buffer?.length
            ? extractUploadedBookBuffer(file, (stats) => {
              if (isGraphJobCanceled(jobId)) return;
              updateGraphJob(jobId, {
                progress: Math.min(62, 24 + Math.floor(((fileIndex + Math.min(1, stats.scannedStreams / 30)) / Math.max(1, payloadFiles.length)) * 38)),
                message: `第 ${fileIndex + 1}/${payloadFiles.length} 个文件已扫描 ${stats.scannedStreams} 个 PDF 内容流，跳过图片流 ${stats.imageStreams} 个`
              });
            })
            : { text: "", meta: null };
        extractedFiles.push({ file, uploaded: uploadedFile });
      }

      const uploaded = extractedFiles.length
        ? {
          text: extractedFiles.map(({ file, uploaded: item }, index) => [
            `【来源文件 ${index + 1}：${file.name || item.meta?.name || payload.sourceName || "上传文件"}】`,
            item.text || ""
          ].filter(Boolean).join("\n")).join("\n\n"),
          meta: {
            name: payload.sourceName,
            fileCount: extractedFiles.length,
            files: extractedFiles.map(({ file, uploaded: item }) => ({
              name: file.name || item.meta?.name || "",
              type: file.type || "",
              characters: Number(item.meta?.characters || 0),
              pages: Number(item.meta?.pages || item.meta?.pdfPages || 0),
              agent: item.meta?.agent || item.meta?.method || ""
            })),
            characters: extractedFiles.reduce((sum, item) => sum + Number(item.uploaded.meta?.characters || item.uploaded.text?.length || 0), 0)
          }
        }
        : { text: "", meta: null };

      assertGraphJobActive(jobId);
      updateGraphJob(jobId, {
        stage: "抽取知识点",
        progress: 66,
        message: uploaded.meta
          ? (aiUnlimited && !uploaded.meta.characters
            ? "AI 自动图谱智能体已进入目录、学科和文件名融合生成"
            : `文本识别完成，识别 ${uploaded.meta.characters} 个字符`)
          : "正在根据补充内容抽取知识点",
        meta: { ...graphJobs.get(jobId).meta, extraction: uploaded.meta }
      });

      const sourceText = limitText([
        uploaded.text,
        requestText(payload.sourceText),
        aiUnlimited ? payload.subject : "",
        aiUnlimited ? payload.title : "",
        aiUnlimited ? payload.sourceName : ""
      ].filter(Boolean).join("\n\n"));
      const hasPdf = payloadFiles.some((file) => String(file.type || "").includes("pdf") || String(file.name || "").toLowerCase().endsWith(".pdf"));
      if (hasPdf && !uploaded.text.trim() && !String(payload.sourceText || "").trim() && !aiUnlimited) {
        throw new Error("PDF 文本层和 OCR 都未识别到可用于生成图谱的内容。请确认本机 PaddleOCR 可用，或在补充目录/知识点中粘贴章节信息后再生成。");
      }

      assertGraphJobActive(jobId);
      updateGraphJob(jobId, { stage: "构建图谱", progress: 82, message: "正在先识别目录分支，再抽取章节知识点和语义关系" });
      const graph = buildGraphFromText({
        ownerId: payload.userId,
        title: payload.title,
        subject: payload.subject,
        sourceName: payload.sourceName || uploaded.meta?.name,
        sourceText,
        extraction: uploaded.meta ? { ...uploaded.meta, agent: payload.extractor || "local-pdf-text-agent" } : null
      });

      assertGraphJobActive(jobId);
      updateGraphJob(jobId, { stage: "保存图谱", progress: 94, message: "正在写入当前账号图谱库" });
      const db = readDb();
      ensureUser(db, payload.userId);
      db.knowledgeGraphs.push(graph);
      writeDb(db);
      updateGraphJob(jobId, {
        status: "complete",
        stage: "生成完成",
        progress: 100,
        message: `图谱已生成：${graph.nodes.length} 个节点，${graph.links.length} 条关系`,
        graphId: graph.id,
        meta: { ...graphJobs.get(jobId).meta, extraction: graph.extraction }
      });
    } catch (error) {
      if (error.canceled || isGraphJobCanceled(jobId)) {
        updateGraphJob(jobId, {
          status: "canceled",
          stage: "已终止",
          progress: Math.max(0, Number(graphJobs.get(jobId)?.progress || 0)),
          message: "已终止生成，当前表单内容已清空",
          error: null
        });
        return;
      }
      updateGraphJob(jobId, {
        status: "failed",
        stage: "生成失败",
        progress: 100,
        message: error.message || "生成失败",
        error: error.message || "生成失败"
      });
    } finally {
      const uploadIds = Array.isArray(payload.uploadIds) ? payload.uploadIds : (payload.uploadId ? [payload.uploadId] : []);
      uploadIds.forEach((uploadId) => cleanupUploadSession(uploadId, true));
      if (!uploadIds.length) {
        const payloadFiles = Array.isArray(payload.files) && payload.files.length ? payload.files : (payload.file ? [payload.file] : []);
        payloadFiles.forEach((file) => {
          if (!file?.filePath) return;
          try {
            fs.unlinkSync(file.filePath);
          } catch {}
        });
      }
    }
  });
}

function aiAnswer({ role, mode, prompt }) {
  const text = String(prompt || "").trim();
  const topic = text || "当前知识点";
  const teacherModes = {
    explain: `围绕「${topic}」可以按“概念引入-例题拆解-错因归纳-迁移练习”展开。先用生活场景建立直觉，再把关键公式或定义写成可操作步骤，最后安排 2 道基础题和 1 道综合题检查掌握情况。`,
    questions: `根据「${topic}」生成练习：1. 写出核心概念并说明适用条件。2. 给出一个基础计算题，要求列出关键步骤。3. 设计一个开放题，让学生比较真实情境与理想模型的差异。`,
    plan: `教学方案建议：目标是让学生能解释「${topic}」并完成迁移应用。课堂前 5 分钟诊断前置知识，15 分钟讲解主干，15 分钟小组建模或题目演练，8 分钟展示反馈，最后 2 分钟布置分层作业。`
  };
  const studentModes = {
    explain: `关于「${topic}」，建议先抓住定义和适用条件，再做一道最小例题。你可以把题目拆成“已知量、要求量、相关公式、计算或论证、检查单位/结论”五步。`,
    questions: `给你三道练习：1. 用自己的话解释「${topic}」。2. 完成一道基础题并写出每一步理由。3. 找一个生活中的例子，判断它是否满足该知识点的前提。`,
    plan: `学习方向：先补齐「${topic}」的核心概念，再整理易错点。每天 20 分钟复盘笔记，20 分钟做基础题，10 分钟记录错因；连续三天后做一套综合题检测。`
  };
  const map = role === "teacher" ? teacherModes : studentModes;
  return map[mode] || map.explain;
}

function scoreMatch(answer, submission) {
  const normalize = (text) => Array.from(new Set(String(text || "").replace(/\s+/g, "").match(/[\u4e00-\u9fa5A-Za-z0-9]{1,4}/g) || []));
  const a = normalize(answer);
  const b = normalize(submission);
  if (!a.length || !b.length) return 60;
  const overlap = b.filter((item) => a.includes(item)).length;
  const score = Math.round(Math.min(100, Math.max(45, (overlap / a.length) * 100 + 20)));
  return score;
}

function normalizeRubricCriteria(criteria, fallbackText = "") {
  const rows = (Array.isArray(criteria) ? criteria : []).map((item, index) => ({
    id: item.id || `criterion_${index + 1}`,
    title: String(item.title || item.name || `评分项 ${index + 1}`).trim().slice(0, 40),
    points: Number(item.points ?? item.score ?? 0),
    expected: String(item.expected || item.description || item.text || fallbackText || "").trim().slice(0, 500)
  })).filter((item) => item.title || item.expected);
  if (!rows.length) return [];
  const explicitTotal = rows.reduce((sum, item) => sum + (Number.isFinite(item.points) && item.points > 0 ? item.points : 0), 0);
  if (explicitTotal <= 0) {
    const each = Math.floor(100 / rows.length);
    rows.forEach((item, index) => {
      item.points = index === rows.length - 1 ? 100 - each * (rows.length - 1) : each;
    });
    return rows;
  }
  rows.forEach((item) => {
    item.points = Math.max(1, Math.round((Math.max(0, item.points) / explicitTotal) * 100));
  });
  const total = rows.reduce((sum, item) => sum + item.points, 0);
  if (total !== 100 && rows.length) rows[rows.length - 1].points += 100 - total;
  return rows;
}

function parseRubricInput(input, fallback = {}) {
  if (Array.isArray(input)) return normalizeRubricCriteria(input, fallback.answer || fallback.description || fallback.title || "");
  const text = String(input || "").trim();
  if (text) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const parsed = lines.map((line, index) => {
      const match = line.match(/^(?:\d+[.、]\s*)?(.*?)(?:[:：,，]\s*)?(\d{1,3})\s*分?\s*(?:[:：,，-]\s*)?(.*)$/);
      if (match && (match[1] || match[3])) {
        return {
          id: `criterion_${index + 1}`,
          title: (match[1] || `评分项 ${index + 1}`).trim(),
          points: Number(match[2]),
          expected: (match[3] || match[1] || line).trim()
        };
      }
      return {
        id: `criterion_${index + 1}`,
        title: line.slice(0, 24),
        points: 0,
        expected: line
      };
    });
    return normalizeRubricCriteria(parsed, text);
  }
  const answer = String(fallback.answer || "").trim();
  const description = String(fallback.description || fallback.title || "").trim();
  return normalizeRubricCriteria([
    { title: "核心概念与事实", points: 35, expected: answer || description },
    { title: "解题步骤与推理", points: 35, expected: [description, answer].filter(Boolean).join(" ") },
    { title: "关键术语覆盖", points: 20, expected: answer || description },
    { title: "表达完整与规范", points: 10, expected: "结构清晰，结论明确，必要时说明依据和单位。" }
  ], answer || description);
}

function rubricToText(rubric = []) {
  return (rubric || []).map((item) => `${item.title} ${item.points}分：${item.expected}`).join("\n");
}

function evaluateCriterion(criterion, submissionText) {
  const expectedTokens = tokenizeForSearch(`${criterion.title} ${criterion.expected}`).slice(0, 30);
  const answerTokens = new Set(tokenizeForSearch(submissionText));
  const matched = expectedTokens.filter((token) => answerTokens.has(token));
  const missing = expectedTokens.filter((token) => !answerTokens.has(token)).slice(0, 6);
  const ratio = expectedTokens.length ? matched.length / expectedTokens.length : 0;
  const hasAnswer = String(submissionText || "").trim().length > 0;
  const factor = !hasAnswer ? 0 : ratio >= 0.75 ? 1 : ratio >= 0.45 ? 0.78 : ratio >= 0.2 ? 0.48 : ratio > 0 ? 0.28 : 0.12;
  const score = Math.round(Number(criterion.points || 0) * factor);
  return {
    id: criterion.id,
    title: criterion.title,
    points: criterion.points,
    score,
    matched: matched.slice(0, 6),
    missing,
    comment: score >= criterion.points * 0.8
      ? "覆盖较充分。"
      : missing.length
        ? `建议补充：${missing.join("、")}。`
        : "需要补充更明确的解释或推理过程。"
  };
}

function visibleCourseMaterials(db, userId) {
  const user = ensureUser(db, userId);
  if (user.role === "admin") return db.courseMaterials || [];
  return (db.courseMaterials || []).filter((material) => (
    material.ownerId === userId
    || (user.role === "student" && material.global)
  ));
}

function publicCourseMaterial(material) {
  return {
    id: material.id,
    ownerId: material.ownerId,
    subject: material.subject,
    title: material.title,
    sourceName: material.sourceName,
    type: material.type,
    global: Boolean(material.global),
    classId: material.classId || "",
    chunkCount: (material.chunks || []).length,
    characters: String(material.text || "").length,
    preview: String(material.text || "").slice(0, 180),
    extraction: material.extraction || null,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt
  };
}

async function searchCourseKnowledge(db, userId, query, options = {}) {
  const subject = normalizeSubject(options.subject || "");
  const queryTokens = tokenizeForSearch(query);
  const queryTokenSet = new Set(queryTokens);
  const queryVector = embeddingFromTokens(queryTokens);
  const semanticQueryVector = await embedQueryText(query);
  const queryText = String(query || "");
  const queryHead = queryText.replace(/\s+/g, "").slice(0, 16);
  const materialId = String(options.materialId || "").trim();
  const materials = visibleCourseMaterials(db, userId)
    .filter((material) => !materialId || material.id === materialId)
    .filter((material) => !subject || subject === "通用" || material.subject === subject || String(query).includes(material.subject));
  if (getEmbeddingProvider().enabled) await tryIndexCourseMaterialEmbeddings(db, materials.map((material) => material.id));
  const vectorStorage = knowledgeChunkStorage();
  const vectorRows = vectorStorage?.readKnowledgeChunks({ materialIds: materials.map((material) => material.id) }) || [];
  const vectorRowsById = new Map(vectorRows.map((row) => [row.id, row]));
  const profile = (db.learningProfiles || []).find((item) => item.userId === userId);
  const weakTopics = new Set([
    ...Object.entries(profile?.mastery || {}).filter(([, item]) => Number(item?.score) < 0.58).map(([topic]) => topic),
    ...(profile?.weakPoints || []),
    ...(db.studentMastery || []).filter((item) => item.studentId === userId && Number(item.score) < 0.58).map((item) => item.knowledgePoint)
  ].map((item) => normalizeKeywordText(item)).filter(Boolean));
  const materialHits = [];
  materials.forEach((material) => {
    const chunks = (material.chunks || []).map((chunk) => {
      const row = vectorRowsById.get(chunk.id);
      return row ? { ...chunk, ...row, text: row.content, keywords: row.metadata?.keywords || chunk.keywords || [] } : chunk;
    });
    chunks.forEach((chunk) => {
      const chunkText = chunk.text || chunk.content || "";
      const chunkTokens = chunk.keywords?.length ? chunk.keywords : tokenizeForSearch(chunkText);
      const overlap = chunkTokens.filter((token) => queryTokenSet.has(token));
      const semanticVectorScore = semanticQueryVector && chunk.embeddingProvider === getEmbeddingProvider().provider && chunk.embeddingModel === getEmbeddingProvider().model
        ? cosineSimilarity(semanticQueryVector, chunk.embedding || [])
        : null;
      const vectorScore = semanticVectorScore === null ? cosineSimilarity(queryVector, chunk.embedding || embeddingForText(chunkText)) : semanticVectorScore;
      const exactBoost = queryHead && String(chunkText).replace(/\s+/g, "").includes(queryHead) ? 5 : 0;
      const subjectBoost = subject && subject !== "通用" && material.subject === subject ? 2 : 0;
      const titleBoost = chunkTokens.some((token) => String(material.title || "").includes(token)) ? 1 : 0;
      const chapterBoost = chunkTokens.some((token) => String(chunk.chapter || "").includes(token)) ? 1 : 0;
      const masteryBoost = Array.from(weakTopics).some((topic) => normalizeKeywordText(`${chunk.chapter || ""} ${chunkText}`).includes(topic)) ? 1.8 : 0;
      const score = Number((overlap.length * 1.8 + Math.max(0, vectorScore) * (semanticVectorScore === null ? 8 : 16) + exactBoost + subjectBoost + titleBoost + chapterBoost + masteryBoost).toFixed(3));
      if (score <= 0.5 && materialHits.length > 0) return;
      materialHits.push({
        type: "material",
        score,
        scoreDetail: {
          lexical: overlap.length,
          vector: Number(vectorScore.toFixed(3)),
          embedding: semanticVectorScore !== null,
          embeddingModel: semanticVectorScore !== null ? chunk.embeddingModel : "legacy-64",
          mastery: masteryBoost,
          exact: exactBoost > 0
        },
        materialId: material.id,
        ownerId: material.ownerId,
        global: Boolean(material.global),
        classId: material.classId || "",
        chunkId: chunk.id,
        title: material.title,
        sourceName: material.sourceName,
        subject: material.subject,
        chapter: chunk.chapter || material.title,
        page: chunk.page || Math.max(1, (chunk.index || 0) + 1),
        quote: String(chunkText).slice(0, 220),
        text: chunkText
      });
    });
  });

  const graphHits = [];
  if (options.includeGraphs !== false) {
    visibleKnowledgeGraphs(db, userId)
      .filter((graph) => !subject || subject === "通用" || graph.subject === subject || String(query).includes(graph.subject))
      .forEach((graph) => {
        (graph.nodes || []).forEach((node) => {
          const nodeText = [node.label, node.details, ...(node.knowledgePoints || [])].join(" ");
          const tokens = tokenizeForSearch(nodeText);
          const overlap = tokens.filter((token) => queryTokenSet.has(token));
          const vectorScore = cosineSimilarity(queryVector, embeddingFromTokens(tokens));
          const exactBoost = String(query).includes(node.label) ? 5 : 0;
          const score = Number((overlap.length * 1.8 + Math.max(0, vectorScore) * 8 + exactBoost).toFixed(3));
          if (score <= 0.5) return;
          graphHits.push({
            type: "graph",
            score,
            scoreDetail: {
              lexical: overlap.length,
              vector: Number(vectorScore.toFixed(3)),
              exact: exactBoost > 0
            },
            graphId: graph.id,
            nodeId: node.id,
            title: graph.title,
            sourceName: graph.sourceName || graph.title,
            subject: graph.subject,
            chapter: node.ontology?.parent || node.ontology?.layer || "知识图谱",
            page: null,
            quote: nodeText.slice(0, 220),
            text: nodeText,
            nodeLabel: node.label
          });
        });
      });
  }

  const ranked = materialHits.concat(graphHits)
    .sort((a, b) => b.score - a.score)
    .reduce((items, hit) => {
      const sameSourceCount = items.filter((item) => item.sourceName === hit.sourceName).length;
      const sameChapterCount = items.filter((item) => item.sourceName === hit.sourceName && item.chapter === hit.chapter).length;
      const adjustedScore = hit.score - sameSourceCount * 0.6 - sameChapterCount * 0.8;
      items.push({ ...hit, score: Number(adjustedScore.toFixed(3)) });
      return items.sort((a, b) => b.score - a.score);
    }, []);

  return ranked.slice(0, options.limit || RAG_MAX_CONTEXT_CHUNKS);
}

function citationsFromHits(hits) {
  return verifiedCitationsFromHits(hits);
}

function publicBackgroundJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.error,
    result: job.status === "complete" ? job.result : null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt
  };
}

function knowledgeTestKeywords(text, limit = 16) {
  return Array.from(new Set(tokenizeForSearch(text)
    .map((token) => String(token || "").trim())
    .filter((token) => token.length >= 2 && !/^\d+$/.test(token))))
    .slice(0, limit);
}

const KNOWLEDGE_TEST_STOPWORDS = new Set([
  "课程", "资料", "老师", "学生", "章节", "学习", "本节", "掌握", "理解", "说明", "根据", "上传", "知识", "问题", "教材", "课本", "高中", "必修",
  "用途", "来源说明", "导入建议", "课程总览", "标准答案", "评分点", "常见错误",
  "the", "and", "for", "with", "this", "that", "from", "test", "quiz", "chapter", "section", "rag", "pdf", "md", "top_k", "score_threshold"
]);

function isMeaningfulKnowledgeTestText(text) {
  const clean = normalizeExtractedText(text || "");
  if (clean.replace(/\s+/g, "").length < 30) return false;
  return knowledgeTestKeywords(clean, 8).filter((token) => !KNOWLEDGE_TEST_STOPWORDS.has(token)).length >= 3;
}

function knowledgeTestKeywordList(text, limit = 16, subject = "") {
  const subjectText = normalizeSubject(subject || "");
  return knowledgeTestKeywords(text, limit * 2)
    .filter((token) => {
      const clean = String(token || "").trim();
      if (!clean || KNOWLEDGE_TEST_STOPWORDS.has(clean)) return false;
      if (/^[\d.．、_\-–—/]+$/.test(clean) || /^\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)+$/.test(clean) || /^[a-z]$/i.test(clean)) return false;
      if (/^[qQ]?\d+[.．、]?$/.test(clean) || /\.(md|pdf|docx?|pptx?)$/i.test(clean)) return false;
      if (subjectText && clean === subjectText) return false;
      return true;
    })
    .slice(0, limit);
}

function cleanKnowledgeTestTopicCandidate(value, subject = "") {
  let clean = String(value || "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[qQ]?\d+(?:[.．、]\s*|\s+)/, "")
    .replace(/^\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)+\s*/, "")
    .replace(/\s*典型题\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  clean = clean.replace(/[：:]\s*$/, "").trim();
  if (!clean || KNOWLEDGE_TEST_STOPWORDS.has(clean)) return "";
  if (/^[\d.．、_\-–—/]+$/.test(clean) || /^\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)+$/.test(clean)) return "";
  if (subject && clean === normalizeSubject(subject)) return "";
  if (!/[\u4e00-\u9fa5]{2,}|[A-Za-z]{2,}/.test(clean)) return "";
  return clean.slice(0, 36);
}

function knowledgeTestMaterialChunks(material, perMaterialLimit = 6) {
  const chunks = Array.isArray(material.chunks) && material.chunks.length
    ? material.chunks
    : [{ id: `${material.id}_preview`, text: material.text || material.preview || "", chapter: material.title, page: 1, index: 0 }];
  return chunks
    .map((chunk, index) => ({
      id: chunk.id || `${material.id}_chunk_${index + 1}`,
      index: Number.isFinite(Number(chunk.index)) ? Number(chunk.index) : index,
      chapter: chunk.chapter || material.title,
      page: chunk.page || Math.max(1, index + 1),
      text: String(chunk.text || "").trim()
    }))
    .filter((chunk) => isMeaningfulKnowledgeTestText(chunk.text))
    .slice(0, perMaterialLimit);
}

function knowledgeTestMaterialHits(materials, limit = 18) {
  const hits = [];
  materials.forEach((material, materialIndex) => {
    knowledgeTestMaterialChunks(material).forEach((chunk, index) => {
      const keywordCount = knowledgeTestKeywordList(`${material.subject} ${material.title} ${chunk.chapter}\n${chunk.text}`, 18, material.subject).length;
      const teachingBoost = /题库|练习|测验|quiz|keypoint|重点|误区|错因|misconception|讲义|教材|课本/i.test(`${material.title} ${material.sourceName} ${chunk.chapter}`) ? 3 : 0;
      hits.push({
        type: "material",
        score: Number((keywordCount * 1.6 + teachingBoost + Math.max(0, 5 - materialIndex * 0.4) + Math.max(0, 3 - index * 0.3)).toFixed(3)),
        materialId: material.id,
        ownerId: material.ownerId,
        global: Boolean(material.global),
        classId: material.classId || "",
        chunkId: chunk.id,
        title: material.title,
        sourceName: material.sourceName,
        subject: material.subject,
        chapter: chunk.chapter || material.title,
        page: chunk.page,
        quote: compactWorkflowText(chunk.text, 260),
        text: chunk.text
      });
    });
  });
  const byKey = new Map();
  hits
    .sort((a, b) => b.score - a.score)
    .forEach((hit) => {
      const key = `${hit.materialId}:${hit.chunkId || hit.page || hit.chapter}`;
      if (!byKey.has(key)) byKey.set(key, hit);
    });
  return Array.from(byKey.values()).slice(0, limit);
}

function knowledgeTestTopicFromHit(hit, subject = "") {
  const chapterTopic = cleanKnowledgeTestTopicCandidate(hit.chapter, subject);
  if (chapterTopic) return chapterTopic;
  const headings = Array.from(String(hit.text || "").matchAll(/^#{1,4}\s*(.+)$/gm))
    .map((match) => cleanKnowledgeTestTopicCandidate(match[1], subject))
    .filter(Boolean)
    .filter((item) => !/题库|用途|来源说明|导入建议|课程总览|目录/.test(item));
  if (headings[0]) return headings[0];
  const candidates = knowledgeTestKeywordList([hit.chapter, hit.title, hit.quote, hit.text].filter(Boolean).join("\n"), 12, subject);
  return candidates[0] || normalizeSubject(subject || hit.subject || "") || "课程知识点";
}

function selectedKnowledgeTestHits(hits, count, subject = "") {
  const total = Math.max(1, Math.min(6, Number(count || 4)));
  const selected = [];
  const usedTopics = new Set();
  hits.forEach((hit) => {
    if (selected.length >= total) return;
    const topic = knowledgeTestTopicFromHit(hit, subject);
    if (usedTopics.has(topic) && selected.length < Math.min(total, hits.length)) return;
    usedTopics.add(topic);
    selected.push({ ...hit, topic });
  });
  for (let index = 0; selected.length < total && hits.length; index += 1) {
    const hit = hits[index % hits.length];
    selected.push({ ...hit, topic: knowledgeTestTopicFromHit(hit, subject) });
  }
  return selected;
}

function knowledgeTestMasteryLevel(accuracy) {
  const score = Number(accuracy || 0);
  if (score < 40) return "未掌握";
  if (score < 60) return "薄弱";
  if (score < 75) return "基本掌握";
  if (score < 90) return "熟练掌握";
  return "精通";
}

async function buildKnowledgeTestQuestions(db, userId, { subject = "", materialId = "", count = 4, phase = "diagnostic", nodeId = "" } = {}) {
  const user = ensureUser(db, userId);
  const requestedSubject = normalizeSubject(subject || user.subject || "");
  const requestedMaterialId = String(materialId || "").trim();
  const visibleMaterials = visibleCourseMaterials(db, userId)
    .filter((material) => !requestedSubject || requestedSubject === "通用" || material.subject === requestedSubject)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  const selectedMaterial = requestedMaterialId ? visibleMaterials.find((material) => material.id === requestedMaterialId) : null;
  if (requestedMaterialId && !selectedMaterial) {
    throw Object.assign(new Error("课程资料不存在或当前账号不可见"), { status: 404 });
  }
  let materials = selectedMaterial ? [selectedMaterial] : visibleMaterials;
  if (!materials.length) {
    throw Object.assign(new Error(`当前「${requestedSubject || "该学科"}」暂无可用于出题的课程资料，请老师先上传并开放给学生检索。`), { status: 404 });
  }
  const cleanSubject = requestedSubject || materials[0]?.subject || "通用";
  // Prefer teacher-reviewed, book-grounded questions when available. The importer
  // stores a verbatim source quote and page so every generated item remains auditable.
  const curated = (db.mlQuestionBank || []).filter((item) => item.subject === cleanSubject && item.status !== "retired");
  if (curated.length && cleanSubject === "机器学习") {
    const wanted = nodeId ? curated.filter((item) => item.nodeId === nodeId) : curated;
    const pool = (wanted.length ? wanted : curated).slice().sort(() => Math.random() - 0.5).slice(0, Math.max(3, Math.min(6, Number(count || 4))));
    return {
      id: uid("quiz"), graphId: pool[0]?.graphId || "", nodeId: pool[0]?.nodeId || "", materialId: pool[0]?.materialId || requestedMaterialId,
      subject: cleanSubject, topic: pool[0]?.topic || cleanSubject, sourceNotice: "题目来自《动手学机器学习》并保留原文引用；扩展说明仅使用已核验知识点。",
      sourceMaterials: materials.slice(0, 3).map(publicCourseMaterial), phase: ["diagnostic", "remedial", "verify"].includes(String(phase)) ? String(phase) : "diagnostic",
      questions: pool.map((item, index) => ({ ...item, id: uid("question"), order: index + 1,
        version: `${String(phase).toLowerCase()}-v${index + 1}-${String(item.id || "bank").slice(-6)}`,
        knowledgePoint: item.knowledgePoint || item.topic || cleanSubject,
        difficulty: item.difficulty || (phase === "verify" ? "中高" : "中"),
        misconceptionTags: item.misconceptionTags || item.errorTags || ["概念边界混淆"],
        source: item.source || item.sourceTitle || "课程题库" })),
      citations: pool.flatMap((item) => item.citations || []).slice(0, 6), masteryRule: "按题目评分点与关键词覆盖计算；低置信或无引用内容不写入掌握度。", createdAt: now()
    };
  }
  let sourceNotice = "";
  let fallbackUsed = false;
  if (selectedMaterial && !knowledgeTestMaterialHits([selectedMaterial], 1).length) {
    const peerMaterials = visibleMaterials
      .filter((material) => material.id !== selectedMaterial.id)
      .filter((material) => !cleanSubject || cleanSubject === "通用" || material.subject === cleanSubject)
      .filter((material) => material.ownerId === selectedMaterial.ownerId || material.global || material.classId === selectedMaterial.classId)
      .filter((material) => knowledgeTestMaterialHits([material], 1).length);
    materials = [selectedMaterial, ...peerMaterials];
    fallbackUsed = peerMaterials.length > 0;
    sourceNotice = fallbackUsed
      ? `所选资料「${selectedMaterial.title}」可识别文本较少，已合并同学科可见资料出题。`
      : `所选资料「${selectedMaterial.title}」可识别文本较少。`;
  }
  const query = [
    cleanSubject,
    ...materials.slice(0, 5).map((material) => `${material.title} ${material.sourceName}`),
    ...materials.slice(0, 3).flatMap((material) => (material.chunks || []).slice(0, 2).map((chunk) => chunk.text || ""))
  ].filter(Boolean).join("\n");
  const searchedHits = (await searchCourseKnowledge(db, userId, query, {
    subject: cleanSubject,
    materialId: fallbackUsed ? "" : requestedMaterialId,
    limit: 16,
    includeGraphs: false
  })).filter((hit) => hit.type === "material" && isMeaningfulKnowledgeTestText(hit.text || hit.quote));
  const fallbackHits = knowledgeTestMaterialHits(materials, 18);
  const hitMap = new Map();
  searchedHits.concat(fallbackHits).forEach((hit) => {
    const key = `${hit.materialId}:${hit.chunkId || hit.page || hit.chapter}`;
    const existing = hitMap.get(key);
    if (!existing || Number(hit.score || 0) > Number(existing.score || 0)) hitMap.set(key, hit);
  });
  let hits = Array.from(hitMap.values())
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 12);
  if (!hits.length) {
    throw Object.assign(new Error("当前资料没有识别到足够文本，暂时无法生成知识测试。请老师上传可复制文本的 PDF/Word/PPT/TXT，或补充粘贴资料内容。"), { status: 422 });
  }
  const evidenceText = hits.length
    ? hits.map((hit) => `${hit.chapter || hit.title}：${hit.quote || hit.text || ""}`).join("\n")
    : materials.map((material) => `${material.title}：${String(material.text || "").slice(0, 260)}`).join("\n");
  const topicCandidates = knowledgeTestKeywordList([cleanSubject, evidenceText].join("\n"), 12, cleanSubject);
  const topic = String(topicCandidates[0] || cleanSubject || materials[0]?.title || "课程知识点").trim();
  const questionHits = selectedKnowledgeTestHits(hits, count, cleanSubject);
  const phaseKey = ["diagnostic", "remedial", "verify"].includes(String(phase)) ? String(phase) : "diagnostic";
  const graph = visibleKnowledgeGraphs(db, userId).find((item) => /机器学习|machine learning|动手学机器学习/i.test(`${item.subject || ""} ${item.title || ""}`)) || visibleKnowledgeGraphs(db, userId).find((item) => item.subject === cleanSubject);
  const graphNodeForTopic = (itemTopic) => {
    const nodes = graph?.nodes || [];
    return nodes.slice().sort((a, b) => String(b.label || "").length - String(a.label || "").length)
      .find((node) => String(itemTopic || "").includes(node.label) || String(node.label || "").includes(itemTopic))
      || (nodeId ? nodes.find((node) => node.id === nodeId) : null)
      || nodes.find((node) => String(node.details || "").includes(itemTopic))
      || null;
  };
  const templates = phaseKey === "remedial" ? [
    { type: "contrast", prompt: (itemTopic) => `辨析「${itemTopic}」与它的相邻概念，说明二者在目标、适用条件和结果解释上的区别，并指出一个常见误区。`, rubric: "完成概念对比，指出边界、条件和错因。" },
    { type: "steps", prompt: (itemTopic) => `请完成「${itemTopic}」关键公式或算法流程的步骤填空，并解释每一步为什么这样做。`, rubric: "步骤顺序正确，符号或输入输出说明完整。" },
    { type: "code", prompt: (itemTopic) => `阅读一段与「${itemTopic}」相关的 Python / sklearn 代码，预测运行结果，解释关键参数，并指出一处调试方向。`, rubric: "能联系参数、输入输出和运行结果定位问题。" },
    { type: "transfer", prompt: (itemTopic) => `给出一个「${itemTopic}」的变式应用场景，说明应如何选择方法、指标或数据处理方式。`, rubric: "能把知识点迁移到新场景并说明判断依据。" }
  ] : phaseKey === "verify" ? [
    { type: "contrast", prompt: (itemTopic) => `在一个新的案例中判断「${itemTopic}」是否适用，并与一个相邻概念进行辨析，说明你的依据。`, rubric: "独立迁移到新案例，边界判断准确。" },
    { type: "process", prompt: (itemTopic) => `不参考原题，重新按步骤说明「${itemTopic}」从输入到输出的完整过程。`, rubric: "过程完整，关键步骤和条件没有遗漏。" },
    { type: "transfer", prompt: (itemTopic) => `围绕「${itemTopic}」分析一个未见过的机器学习任务，并说明如何验证模型效果。`, rubric: "能选择合理方法、指标并解释验证方式。" },
    { type: "explain", prompt: (itemTopic) => `用自己的话解释「${itemTopic}」最容易被误解的地方，并给出一个反例。`, rubric: "能识别误区并用反例证明理解。" }
  ] : [
    {
      type: "choice",
      prompt: (itemTopic) => `选择题：围绕「${itemTopic}」写出你认为最正确的判断，并说明另外一个易混淆选项为什么不成立。`,
      rubric: "判断正确，并能说明概念边界和易混淆选项。"
    },
    {
      type: "judgment",
      prompt: (itemTopic) => `判断题：针对「${itemTopic}」给出一个常见说法，判断正误，并结合课程资料给出依据。`,
      rubric: "正误判断明确，依据能联系关键条件或限制。"
    },
    {
      type: "derivation",
      prompt: (itemTopic) => `公式推导：请按步骤说明「${itemTopic}」的关键公式、符号含义或计算过程，并标出最容易遗漏的一步。`,
      rubric: "公式或步骤正确，符号说明完整，能识别易错步骤。"
    },
    {
      type: "case",
      prompt: (itemTopic) => `案例分析：给出一个与「${itemTopic}」相关的机器学习场景，说明应如何分析、选择方法或评价结果。`,
      rubric: "给出具体场景，并把知识点迁移到分析过程。"
    }
  ];
  const sourceMaterials = materials
    .filter((material) => hits.some((hit) => hit.materialId === material.id))
    .map(publicCourseMaterial)
    .slice(0, 6);
  return {
    id: uid("quiz"),
    graphId: "",
    nodeId: "",
    materialId: requestedMaterialId || hits[0]?.materialId || "",
    subject: cleanSubject,
    topic,
    sourceNotice,
    sourceMaterials,
    phase: phaseKey,
    questions: questionHits.map((hit, index) => {
      const template = templates[index % templates.length];
      const itemTopic = hit.topic || knowledgeTestTopicFromHit(hit, cleanSubject);
      const sourceText = compactWorkflowText(hit.text || hit.quote || "", 760);
      const expectedKeywords = knowledgeTestKeywordList([itemTopic, hit.chapter, sourceText].join("\n"), 14, cleanSubject);
      const companionHits = [hit, ...hits.filter((item) => item.materialId !== hit.materialId || item.chunkId !== hit.chunkId)].slice(0, 3);
      const graphNode = graphNodeForTopic(itemTopic);
      return {
        id: uid("question"),
        version: `${phaseKey}-v${index + 1}-${String(hit.chunkId || hit.materialId || "source").slice(-6)}`,
        order: index + 1,
        topic: itemTopic,
        knowledgePoint: itemTopic,
        difficulty: phaseKey === "diagnostic" ? "中" : phaseKey === "remedial" ? "中低" : "中高",
        misconceptionTags: ["概念边界混淆", "条件/步骤遗漏", "迁移应用不足"].slice(0, template.type === "choice" ? 1 : 2),
        source: hit.title || hit.sourceName || "课程资料",
        graphId: graph?.id || "",
        nodeId: graphNode?.id || "",
        materialId: hit.materialId || requestedMaterialId || "",
        subject: cleanSubject,
        prompt: `${phaseKey === "diagnostic" ? "" : "【变式题】"}${template.prompt(itemTopic)}`,
        type: template.type,
        phase: phaseKey,
        rubric: template.rubric,
        referenceAnswer: sourceText || `围绕「${itemTopic}」说明定义、适用条件、关键步骤和常见误区。`,
        expectedKeywords,
        sourceTitle: hit.title || hit.sourceName || "课程资料",
        sourceChapter: hit.chapter || "",
        sourceQuote: compactWorkflowText(hit.quote || hit.text || "", 180),
        citations: citationsFromHits(companionHits).slice(0, 3)
      };
    }),
    citations: citationsFromHits(hits).slice(0, 4),
    masteryRule: "系统按每题关键词覆盖、资料依据覆盖、表达完整度和结构化程度计算准确率，再用整套题平均正确率判断掌握程度。",
    createdAt: now()
  };
}

function graphNodeLevelServer(node) {
  if (Number.isFinite(Number(node?.level))) return Number(node.level);
  if (node?.group === "root") return 0;
  if (node?.group === "chapter") return 1;
  if (node?.group === "concept" || node?.group === "topic") return 2;
  return 3;
}

function normalizeKnowledgeTestAttempts(attempts = []) {
  const items = Array.isArray(attempts) ? attempts : [];
  const byQuestion = new Map();
  items.forEach((item) => {
    const questionId = String(item?.questionId || item?.id || item?.question?.id || "").trim();
    if (!questionId) return;
    const accuracy = Math.max(0, Math.min(100, Math.round(Number(item.accuracy || 0))));
    const normalized = {
      questionId,
      order: Number(item.order || 0),
      topic: String(item.topic || "").trim(),
      accuracy,
      masteryLevel: item.masteryLevel || knowledgeTestMasteryLevel(accuracy),
      version: String(item.version || "v1"),
      difficulty: String(item.difficulty || "中"),
      misconceptionTags: Array.isArray(item.misconceptionTags) ? item.misconceptionTags.map(String) : [],
      source: String(item.source || item.sourceTitle || "课程资料"),
      durationMs: Math.max(0, Number(item.durationMs || 0)),
      answerLength: Math.max(0, Number(item.answerLength || 0)),
      matched: Array.isArray(item.matched) ? item.matched.map(String) : [],
      missing: Array.isArray(item.missing) ? item.missing.map(String) : [],
      at: item.at || now()
    };
    const existing = byQuestion.get(questionId);
    if (!existing || String(normalized.at) >= String(existing.at || "")) byQuestion.set(questionId, normalized);
  });
  return Array.from(byQuestion.values());
}

function evaluateKnowledgeTestAnswer(db, userId, question, answer, options = {}) {
  const cleanAnswer = String(answer || "").trim();
  if (!cleanAnswer) throw Object.assign(new Error("请先输入答案"), { status: 400 });
  const topic = String(question?.topic || "课程知识点").trim();
  const expectedKeywords = Array.isArray(question?.expectedKeywords) && question.expectedKeywords.length
    ? question.expectedKeywords.map(String).filter(Boolean)
    : knowledgeTestKeywordList([question?.prompt, question?.referenceAnswer].filter(Boolean).join("\n"), 14, question?.subject || options.subject || "");
  const referenceKeywords = knowledgeTestKeywordList([question?.referenceAnswer, question?.sourceQuote, question?.rubric].filter(Boolean).join("\n"), 22, question?.subject || options.subject || "");
  const answerTokens = new Set(knowledgeTestKeywords(cleanAnswer, 80));
  const matched = expectedKeywords.filter((token) => answerTokens.has(token) || cleanAnswer.includes(token));
  const referenceMatched = referenceKeywords.filter((token) => answerTokens.has(token) || cleanAnswer.includes(token));
  const missing = expectedKeywords.filter((token) => !matched.includes(token)).slice(0, 8);
  const keywordCoverage = expectedKeywords.length ? matched.length / expectedKeywords.length : 0.42;
  const referenceCoverage = referenceKeywords.length ? referenceMatched.length / Math.min(16, Math.max(6, referenceKeywords.length)) : keywordCoverage;
  const lengthScore = Math.min(1, cleanAnswer.length / 140);
  const structureScore = /(因为|所以|首先|其次|然后|最后|条件|步骤|例如|例子|适用|输入|输出|结论|定义|作用|误区|依据|推理)/.test(cleanAnswer) ? 1 : 0.35;
  const emptyPenalty = /(不知道|不会|没学|不清楚|随便|无答案)/.test(cleanAnswer) ? 22 : 0;
  let accuracy = Math.round(keywordCoverage * 58 + Math.min(1, referenceCoverage) * 22 + lengthScore * 10 + structureScore * 10 - emptyPenalty);
  if (cleanAnswer.length < 12) accuracy = Math.min(accuracy, 42);
  accuracy = Math.max(5, Math.min(100, accuracy));
  const previousAttempts = normalizeKnowledgeTestAttempts(options.attempts || []);
  const questionId = String(question?.id || options.questionId || uid("question"));
  const currentAttempt = {
    questionId,
    order: Number(question?.order || 0),
    topic,
    accuracy,
    masteryLevel: knowledgeTestMasteryLevel(accuracy),
    version: String(question?.version || options.version || "v1"),
    difficulty: String(question?.difficulty || "中"),
    misconceptionTags: Array.isArray(question?.misconceptionTags) ? question.misconceptionTags : [],
    source: String(question?.source || question?.sourceTitle || "课程资料"),
    durationMs: Math.max(0, Number(options.durationMs || 0)),
    answerLength: cleanAnswer.length,
    matched,
    missing,
    at: now()
  };
  const attemptsByQuestion = new Map(previousAttempts.map((item) => [item.questionId, item]));
  attemptsByQuestion.set(questionId, currentAttempt);
  const answeredAttempts = Array.from(attemptsByQuestion.values());
  const totalQuestions = Math.max(1, Math.max(Number(options.questionCount || options.totalQuestions || 0), answeredAttempts.length));
  const overallAccuracy = Math.round(answeredAttempts.reduce((sum, item) => sum + Number(item.accuracy || 0), 0) / answeredAttempts.length);
  const completionRate = Number((answeredAttempts.length / totalQuestions).toFixed(2));
  const masteryLevel = knowledgeTestMasteryLevel(overallAccuracy);
  const masteryScore = Number((overallAccuracy / 100).toFixed(2));
  const profile = setTopicMasteryScore(
    db,
    userId,
    topic,
    masteryScore,
    `知识测试累计：${answeredAttempts.length}/${totalQuestions} 题，平均正确率 ${overallAccuracy}%；本题 ${accuracy}%：${String(question?.prompt || topic).slice(0, 80)}`,
    masteryLevel
  );
  recordLearningActivity(db, userId, {
    kind: "practice",
    mode: "knowledge-test",
    prompt: String(question?.prompt || topic).slice(0, 120),
    topics: [topic],
    score: overallAccuracy,
    confidence: accuracy >= 70 ? "high" : "medium",
    minutes: 4
  });
  if (accuracy < 60) {
    addWrongNote(db, userId, {
      source: "知识测试",
      topic,
      question: String(question?.prompt || ""),
      answer: cleanAnswer,
      analysis: missing.length ? `缺少关键点：${missing.join("、")}` : "回答过短或结构不完整。",
      recommendation: "重新阅读课程资料后再次回答，并补充定义、条件、步骤和例子。"
    });
  }
  const mastery = profile.mastery?.[topic] || null;
  const overall = {
    answered: answeredAttempts.length,
    total: totalQuestions,
    completionRate,
    accuracy: overallAccuracy,
    masteryScore,
    phase: question?.phase || options.phase || "diagnostic",
    errorEliminated: String(question?.phase || options.phase || "") === "verify"
      ? Boolean(Number(options.previousAccuracy || 0) < 60 && accuracy >= 70)
      : null,
    masteryLevel,
    completed: answeredAttempts.length >= totalQuestions,
    attempts: answeredAttempts
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
      .map((item) => ({
        questionId: item.questionId,
        order: item.order,
        topic: item.topic,
        accuracy: item.accuracy,
        masteryLevel: item.masteryLevel,
        version: item.version,
        difficulty: item.difficulty,
        misconceptionTags: item.misconceptionTags,
        source: item.source,
        durationMs: item.durationMs,
        answerLength: item.answerLength,
        matched: item.matched,
        missing: item.missing,
        at: item.at
      }))
  };
  return {
    topic,
    accuracy,
    masteryLevel: currentAttempt.masteryLevel,
    matched: matched.slice(0, 10),
    referenceMatched: referenceMatched.slice(0, 10),
    missing,
    overall,
    mastery,
    feedback: accuracy >= 85
      ? `本题回答覆盖充分，表达清晰。累计正确率 ${overallAccuracy}%，当前判断为「${masteryLevel}」。`
      : accuracy >= 70
        ? `本题基本掌握，建议补充：${missing.slice(0, 4).join("、") || "更完整的例子和条件"}。累计正确率 ${overallAccuracy}%，当前判断为「${masteryLevel}」。`
        : `本题掌握还不稳定，需要补齐：${missing.slice(0, 5).join("、") || "定义、条件、步骤和例子"}。累计正确率 ${overallAccuracy}%，当前判断为「${masteryLevel}」。`
  };
}

function inferAlgorithmKindFromText(value) {
  const text = String(value || "").toLowerCase();
  if (/random\s*forest|bagging|\u968f\u673a\u68ee\u6797|\u96c6\u6210/.test(text)) return "randomForest";
  if (/decision\s*tree|cart|\bgini\b|\u51b3\u7b56\u6811|\u4fe1\u606f\u589e\u76ca|\u57fa\u5c3c/.test(text)) return "decisionTree";
  if (/\bsvm\b|support\s*vector|\u652f\u6301\u5411\u91cf\u673a|\u95f4\u9694\u6700\u5927\u5316|hinge|\u6838\u51fd\u6570/.test(text)) return "svm";
  if (/\bpca\b|principal\s*component|\u4e3b\u6210\u5206|\u964d\u7ef4/.test(text)) return "pca";
  if (/\bgmm\b|gaussian\s*mixture|\bem\s*\u7b97\u6cd5|\u9ad8\u65af\u6df7\u5408|\u671f\u671b\u6700\u5927\u5316/.test(text)) return "gmm";
  if (/\bmlp\b|neural\s*network|\u795e\u7ecf\u7f51\u7edc|\u591a\u5c42\u611f\u77e5\u673a|\u53cd\u5411\u4f20\u64ad|xor/.test(text)) return "mlp";
  if (/k\s*-?\s*means|\u805a\u7c7b|k\s*\u5747\u503c/.test(text)) return "kmeans";
  if (/logistic|\u903b\u8f91\u56de\u5f52|\u4e8c\u5206\u7c7b|sigmoid/.test(text)) return "logistic";
  if (/linear\s*regression|least\s*squares|\u7ebf\u6027\u56de\u5f52|\u6700\u5c0f\u4e8c\u4e58/.test(text)) return "linear";
  if (/naive\s*bayes|\u6734\u7d20\u8d1d\u53f6\u65af|\u8d1d\u53f6\u65af/.test(text)) return "bayes";
  if (/gradient|\u68af\u5ea6\u4e0b\u964d|\u4f18\u5316/.test(text)) return "gradient";
  if (/\bknn\b|k\s*nearest|nearest\s*neighbor|k\s*\u8fd1\u90bb|\u8fd1\u90bb/.test(text)) return "knn";
  return "";
}

function inferAlgorithmKind(prompt, hits = []) {
  const promptKind = inferAlgorithmKindFromText(prompt);
  if (promptKind) return promptKind;
  const hitText = hits.map((hit) => `${hit.title || ""} ${hit.chapter || ""} ${hit.quote || ""}`).join("\n");
  return inferAlgorithmKindFromText(hitText) || "knn";
}

function stdlibAlgorithmCode(kind, prompt, hits = []) {
  const sourceTitle = hits[0]?.title || "课程资料";
  const sourceChapter = hits[0]?.chapter || "检索片段";
  const sourceQuote = String(hits[0]?.quote || prompt || "").replace(/\s+/g, " ").slice(0, 180);
  const header = `# AI 生成算法：${prompt.replace(/\r?\n/g, " ").slice(0, 80)}
# 课程依据：${sourceTitle} / ${sourceChapter}
# 检索片段：${sourceQuote}
`;
  const snippets = {
    knn: `${header}
import math
from collections import Counter

train = [
    ([5.1, 3.5, 1.4, 0.2], "setosa"),
    ([4.9, 3.0, 1.4, 0.2], "setosa"),
    ([6.2, 3.4, 5.4, 2.3], "virginica"),
    ([5.9, 3.0, 5.1, 1.8], "virginica"),
    ([6.0, 2.2, 4.0, 1.0], "versicolor"),
    ([5.6, 2.9, 3.6, 1.3], "versicolor"),
]
test = [
    ([5.0, 3.4, 1.5, 0.2], "setosa"),
    ([6.1, 2.8, 4.7, 1.2], "versicolor"),
    ([6.5, 3.0, 5.5, 1.8], "virginica"),
]

def euclidean(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))

def predict(sample, k=3):
    neighbors = sorted((euclidean(sample, x), label) for x, label in train)[:k]
    return Counter(label for _, label in neighbors).most_common(1)[0][0]

k = 3
correct = sum(1 for x, y in test if predict(x, k) == y)
query = [5.7, 2.8, 4.1, 1.3]
print("算法: K近邻分类")
print("训练样本数:", len(train), "测试样本数:", len(test), "k:", k)
print("测试准确率:", round(correct / len(test), 3))
print("预测样本:", query, "=>", predict(query, k))
`,
    linear: `${header}
import random

random.seed(7)
data = []
for i in range(60):
    x1 = random.uniform(-3, 3)
    x2 = random.uniform(-2, 2)
    y = 2.8 * x1 - 1.7 * x2 + 4.2 + random.uniform(-0.18, 0.18)
    data.append((x1, x2, y))

w1 = w2 = b = 0.0
lr = 0.025
for epoch in range(700):
    g1 = g2 = gb = loss = 0.0
    for x1, x2, y in data:
        pred = w1 * x1 + w2 * x2 + b
        err = pred - y
        loss += err * err
        g1 += 2 * err * x1
        g2 += 2 * err * x2
        gb += 2 * err
    n = len(data)
    w1 -= lr * g1 / n
    w2 -= lr * g2 / n
    b -= lr * gb / n
    if epoch in (0, 100, 300, 699):
        print(f"epoch={epoch} mse={loss/n:.5f}")

mean_y = sum(y for _, _, y in data) / len(data)
ss_tot = sum((y - mean_y) ** 2 for _, _, y in data)
ss_res = sum((w1 * x1 + w2 * x2 + b - y) ** 2 for x1, x2, y in data)
print("算法: 线性回归（梯度下降）")
print("参数:", {"w1": round(w1, 3), "w2": round(w2, 3), "b": round(b, 3)})
print("R2:", round(1 - ss_res / ss_tot, 4))
print("预测 x=(1.5,-0.8):", round(w1 * 1.5 + w2 * -0.8 + b, 3))
`,
    logistic: `${header}
import math

data = [
    (0.2, 1.1, 0), (0.7, 1.4, 0), (1.0, 0.8, 0), (1.3, 1.2, 0),
    (2.1, 2.0, 1), (2.4, 2.5, 1), (2.8, 2.2, 1), (3.0, 2.9, 1),
]

def sigmoid(z):
    return 1 / (1 + math.exp(-z))

w1 = w2 = b = 0.0
lr = 0.35
for epoch in range(500):
    g1 = g2 = gb = loss = 0.0
    for x1, x2, y in data:
        p = sigmoid(w1 * x1 + w2 * x2 + b)
        err = p - y
        g1 += err * x1
        g2 += err * x2
        gb += err
        loss += -(y * math.log(p + 1e-9) + (1 - y) * math.log(1 - p + 1e-9))
    n = len(data)
    w1 -= lr * g1 / n
    w2 -= lr * g2 / n
    b -= lr * gb / n

predictions = []
for x1, x2, y in data:
    prob = sigmoid(w1 * x1 + w2 * x2 + b)
    predictions.append((prob >= 0.5) == bool(y))
print("算法: 逻辑回归二分类")
print("参数:", {"w1": round(w1, 3), "w2": round(w2, 3), "b": round(b, 3)})
print("训练准确率:", round(sum(predictions) / len(predictions), 3))
sample = (1.8, 1.7)
print("样本概率:", round(sigmoid(w1 * sample[0] + w2 * sample[1] + b), 4))
`,
    kmeans: `${header}
import math

points = [
    (1.0, 1.2), (1.2, 0.9), (0.8, 1.1),
    (4.0, 4.1), (4.2, 3.8), (3.8, 4.0),
    (7.0, 1.0), (7.3, 1.3), (6.8, 0.7),
]
centers = [(1.0, 1.0), (4.0, 4.0), (7.0, 1.0)]

def distance(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)

for epoch in range(8):
    groups = [[] for _ in centers]
    for p in points:
        idx = min(range(len(centers)), key=lambda i: distance(p, centers[i]))
        groups[idx].append(p)
    centers = [
        (sum(x for x, _ in group) / len(group), sum(y for _, y in group) / len(group))
        for group in groups
    ]

sse = sum(min(distance(p, c) ** 2 for c in centers) for p in points)
print("算法: K-Means 聚类")
print("簇中心:", [(round(x, 3), round(y, 3)) for x, y in centers])
print("簇大小:", [len(group) for group in groups])
print("SSE:", round(sse, 4))
`,
    bayes: `${header}
import math
from collections import defaultdict

data = [
    (("sunny", "hot"), "no"), (("sunny", "mild"), "no"), (("overcast", "hot"), "yes"),
    (("rain", "mild"), "yes"), (("rain", "cool"), "yes"), (("sunny", "cool"), "no"),
    (("overcast", "cool"), "yes"), (("rain", "hot"), "yes"),
]
classes = sorted(set(label for _, label in data))
feature_values = [sorted(set(x[i] for x, _ in data)) for i in range(2)]

def predict(sample):
    scores = {}
    for label in classes:
        subset = [x for x, y in data if y == label]
        prior = (len(subset) + 1) / (len(data) + len(classes))
        logp = math.log(prior)
        for i, value in enumerate(sample):
            count = sum(1 for x in subset if x[i] == value)
            prob = (count + 1) / (len(subset) + len(feature_values[i]))
            logp += math.log(prob)
        scores[label] = logp
    return max(scores, key=scores.get), scores

sample = ("rain", "cool")
label, scores = predict(sample)
print("算法: 朴素贝叶斯分类")
print("样本:", sample, "预测:", label)
print("类别对数概率:", {k: round(v, 4) for k, v in scores.items()})
`,
    gradient: `${header}
def f(x):
    return (x - 3) ** 2 + 2

def grad(x):
    return 2 * (x - 3)

x = -4.0
lr = 0.18
for step in range(35):
    x -= lr * grad(x)
    if step in (0, 1, 2, 9, 34):
        print(f"step={step + 1} x={x:.5f} f(x)={f(x):.5f}")

print("算法: 梯度下降")
print("最优点近似:", round(x, 5))
print("最小函数值:", round(f(x), 5))
`,
    decisionTree: `${header}
from collections import Counter

train = [
    ([5.1, 3.5, 1.4, 0.2], "setosa"), ([4.9, 3.0, 1.4, 0.2], "setosa"),
    ([5.0, 3.4, 1.5, 0.2], "setosa"), ([6.0, 2.2, 4.0, 1.0], "versicolor"),
    ([5.6, 2.9, 3.6, 1.3], "versicolor"), ([6.1, 2.8, 4.7, 1.2], "versicolor"),
    ([6.2, 3.4, 5.4, 2.3], "virginica"), ([5.9, 3.0, 5.1, 1.8], "virginica"),
    ([6.5, 3.0, 5.5, 1.8], "virginica"),
]
test = [
    ([5.4, 3.4, 1.7, 0.2], "setosa"),
    ([6.3, 2.5, 4.9, 1.5], "versicolor"),
    ([6.7, 3.1, 5.6, 2.4], "virginica"),
]
feature_names = ["sepal_len", "sepal_width", "petal_len", "petal_width"]

def majority(rows):
    return Counter(label for _, label in rows).most_common(1)[0][0]

def gini(rows):
    total = len(rows)
    counts = Counter(label for _, label in rows)
    return 1 - sum((count / total) ** 2 for count in counts.values())

def best_split(rows):
    base = gini(rows)
    best = None
    for feature in range(len(rows[0][0])):
        values = sorted(set(x[feature] for x, _ in rows))
        thresholds = [(a + b) / 2 for a, b in zip(values, values[1:])]
        for threshold in thresholds:
            left = [row for row in rows if row[0][feature] <= threshold]
            right = [row for row in rows if row[0][feature] > threshold]
            if not left or not right:
                continue
            score = (len(left) * gini(left) + len(right) * gini(right)) / len(rows)
            gain = base - score
            if best is None or gain > best["gain"]:
                best = {"feature": feature, "threshold": threshold, "gain": gain, "left": left, "right": right}
    return best

def build_tree(rows, depth=0, max_depth=3):
    labels = {label for _, label in rows}
    if len(labels) == 1 or depth >= max_depth:
        return {"label": majority(rows), "samples": len(rows)}
    split = best_split(rows)
    if not split or split["gain"] <= 0:
        return {"label": majority(rows), "samples": len(rows)}
    return {
        "feature": split["feature"],
        "threshold": split["threshold"],
        "gain": split["gain"],
        "left": build_tree(split["left"], depth + 1, max_depth),
        "right": build_tree(split["right"], depth + 1, max_depth),
    }

def predict(tree, sample):
    if "label" in tree:
        return tree["label"]
    branch = "left" if sample[tree["feature"]] <= tree["threshold"] else "right"
    return predict(tree[branch], sample)

tree = build_tree(train)
correct = sum(1 for x, y in test if predict(tree, x) == y)
root = f'{feature_names[tree["feature"]]} <= {tree["threshold"]:.2f}'
print("算法: 决策树分类")
print("根节点:", root, "gini_gain:", round(tree["gain"], 4))
print("测试准确率:", round(correct / len(test), 3))
print("预测样本:", test[1][0], "=>", predict(tree, test[1][0]))
`,
    randomForest: `${header}
import random
from collections import Counter

random.seed(12)
train = []
for _ in range(18):
    x1 = random.gauss(0.8, 0.35)
    x2 = random.gauss(1.0, 0.35)
    train.append(((x1, x2), "low_risk"))
for _ in range(18):
    x1 = random.gauss(2.5, 0.45)
    x2 = random.gauss(2.7, 0.45)
    train.append(((x1, x2), "high_risk"))
test = [((0.7, 1.2), "low_risk"), ((2.7, 2.4), "high_risk"), ((1.0, 0.6), "low_risk"), ((2.2, 3.0), "high_risk")]

def majority(rows):
    return Counter(label for _, label in rows).most_common(1)[0][0]

def gini(rows):
    total = len(rows)
    counts = Counter(label for _, label in rows)
    return 1 - sum((count / total) ** 2 for count in counts.values())

def best_stump(rows, feature):
    values = sorted(set(x[feature] for x, _ in rows))
    best = None
    for threshold in [(a + b) / 2 for a, b in zip(values, values[1:])]:
        left = [row for row in rows if row[0][feature] <= threshold]
        right = [row for row in rows if row[0][feature] > threshold]
        if not left or not right:
            continue
        score = (len(left) * gini(left) + len(right) * gini(right)) / len(rows)
        if best is None or score < best["score"]:
            best = {
                "feature": feature,
                "threshold": threshold,
                "left": majority(left),
                "right": majority(right),
                "score": score,
            }
    return best

forest = []
for _ in range(9):
    sample = [random.choice(train) for _ in train]
    feature = random.randrange(2)
    forest.append(best_stump(sample, feature))

def predict(sample):
    votes = []
    for tree in forest:
        votes.append(tree["left"] if sample[tree["feature"]] <= tree["threshold"] else tree["right"])
    return Counter(votes).most_common(1)[0][0], Counter(votes)

correct = 0
for x, y in test:
    label, _ = predict(x)
    correct += int(label == y)
print("算法: 随机森林分类（Bagging + 随机特征桩）")
print("树数量:", len(forest), "特征使用次数:", dict(Counter(tree["feature"] for tree in forest)))
print("测试准确率:", round(correct / len(test), 3))
sample = (2.4, 2.8)
label, votes = predict(sample)
print("预测样本:", sample, "=>", label, "votes:", dict(votes))
`,
    svm: `${header}
data = [
    ((-2.0, -1.2), -1), ((-1.5, -1.0), -1), ((-1.2, -2.0), -1), ((-2.2, -1.7), -1),
    ((1.4, 1.2), 1), ((2.0, 1.5), 1), ((1.7, 2.2), 1), ((2.4, 1.8), 1),
]
w1 = w2 = b = 0.0
lr = 0.03
c = 1.0
for epoch in range(700):
    errors = 0
    for (x1, x2), y in data:
        margin = y * (w1 * x1 + w2 * x2 + b)
        if margin < 1:
            w1 = w1 * (1 - lr) + lr * c * y * x1
            w2 = w2 * (1 - lr) + lr * c * y * x2
            b += lr * c * y
            errors += 1
        else:
            w1 *= 1 - lr
            w2 *= 1 - lr
    if epoch in (0, 50, 200, 699):
        print(f"epoch={epoch} hinge_violations={errors}")

def predict(sample):
    score = w1 * sample[0] + w2 * sample[1] + b
    return 1 if score >= 0 else -1, score

correct = sum(1 for x, y in data if predict(x)[0] == y)
sample = (1.2, 1.4)
label, score = predict(sample)
print("算法: 线性支持向量机")
print("参数:", {"w1": round(w1, 3), "w2": round(w2, 3), "b": round(b, 3)})
print("训练准确率:", round(correct / len(data), 3))
print("预测样本:", sample, "=>", label, "decision_score:", round(score, 3))
`,
    pca: `${header}
import math

points = [
    (2.5, 2.4), (0.5, 0.7), (2.2, 2.9), (1.9, 2.2), (3.1, 3.0),
    (2.3, 2.7), (2.0, 1.6), (1.0, 1.1), (1.5, 1.6), (1.1, 0.9),
]
mean_x = sum(x for x, _ in points) / len(points)
mean_y = sum(y for _, y in points) / len(points)
centered = [(x - mean_x, y - mean_y) for x, y in points]
cov_xx = sum(x * x for x, _ in centered) / (len(points) - 1)
cov_xy = sum(x * y for x, y in centered) / (len(points) - 1)
cov_yy = sum(y * y for _, y in centered) / (len(points) - 1)

v = (1.0, 0.0)
for _ in range(30):
    nx = cov_xx * v[0] + cov_xy * v[1]
    ny = cov_xy * v[0] + cov_yy * v[1]
    norm = math.sqrt(nx * nx + ny * ny)
    v = (nx / norm, ny / norm)

eigenvalue = v[0] * (cov_xx * v[0] + cov_xy * v[1]) + v[1] * (cov_xy * v[0] + cov_yy * v[1])
total_variance = cov_xx + cov_yy
projections = [x * v[0] + y * v[1] for x, y in centered]
print("算法: PCA 主成分分析")
print("均值:", (round(mean_x, 3), round(mean_y, 3)))
print("第一主成分:", (round(v[0], 4), round(v[1], 4)))
print("解释方差比:", round(eigenvalue / total_variance, 4))
print("前3个投影:", [round(value, 4) for value in projections[:3]])
`,
    gmm: `${header}
import math

data = [-2.4, -2.1, -1.8, -1.5, -1.2, 1.2, 1.5, 1.8, 2.0, 2.4, 2.7]
weights = [0.5, 0.5]
means = [-1.8, 1.8]
variances = [0.7, 0.7]

def normal_pdf(x, mean, var):
    return math.exp(-((x - mean) ** 2) / (2 * var)) / math.sqrt(2 * math.pi * var)

for epoch in range(25):
    responsibilities = []
    for x in data:
        probs = [weights[k] * normal_pdf(x, means[k], variances[k]) for k in range(2)]
        total = sum(probs)
        responsibilities.append([p / total for p in probs])
    for k in range(2):
        nk = sum(r[k] for r in responsibilities)
        means[k] = sum(r[k] * x for r, x in zip(responsibilities, data)) / nk
        variances[k] = sum(r[k] * (x - means[k]) ** 2 for r, x in zip(responsibilities, data)) / nk
        weights[k] = nk / len(data)
    if epoch in (0, 4, 24):
        log_likelihood = sum(math.log(sum(weights[k] * normal_pdf(x, means[k], variances[k]) for k in range(2))) for x in data)
        print(f"epoch={epoch + 1} log_likelihood={log_likelihood:.4f}")

sample = 1.6
probs = [weights[k] * normal_pdf(sample, means[k], variances[k]) for k in range(2)]
total = sum(probs)
print("算法: 一维高斯混合模型 EM")
print("权重:", [round(v, 3) for v in weights])
print("均值:", [round(v, 3) for v in means])
print("方差:", [round(v, 3) for v in variances])
print("样本责任度:", [round(p / total, 4) for p in probs])
`,
    mlp: `${header}
import math

data = [((0, 0), 0), ((0, 1), 1), ((1, 0), 1), ((1, 1), 0)]
weights = {
    "h1": [0.6, -0.4, 0.1],
    "h2": [-0.3, 0.7, -0.2],
    "out": [0.5, 0.5, -0.3],
}

def sigmoid(x):
    return 1 / (1 + math.exp(-x))

def forward(x):
    x1, x2 = x
    h1 = sigmoid(weights["h1"][0] * x1 + weights["h1"][1] * x2 + weights["h1"][2])
    h2 = sigmoid(weights["h2"][0] * x1 + weights["h2"][1] * x2 + weights["h2"][2])
    out = sigmoid(weights["out"][0] * h1 + weights["out"][1] * h2 + weights["out"][2])
    return h1, h2, out

lr = 0.8
for epoch in range(5000):
    loss = 0
    for x, y in data:
        h1, h2, out = forward(x)
        error = out - y
        loss += error * error
        delta_out = error * out * (1 - out)
        old_out = weights["out"][:]
        weights["out"][0] -= lr * delta_out * h1
        weights["out"][1] -= lr * delta_out * h2
        weights["out"][2] -= lr * delta_out
        delta_h1 = delta_out * old_out[0] * h1 * (1 - h1)
        delta_h2 = delta_out * old_out[1] * h2 * (1 - h2)
        weights["h1"][0] -= lr * delta_h1 * x[0]
        weights["h1"][1] -= lr * delta_h1 * x[1]
        weights["h1"][2] -= lr * delta_h1
        weights["h2"][0] -= lr * delta_h2 * x[0]
        weights["h2"][1] -= lr * delta_h2 * x[1]
        weights["h2"][2] -= lr * delta_h2
    if epoch in (0, 999, 4999):
        print(f"epoch={epoch + 1} mse={loss / len(data):.5f}")

predictions = []
for x, y in data:
    _, _, prob = forward(x)
    predictions.append((x, y, round(prob, 4), int(prob >= 0.5)))
correct = sum(1 for _, y, _, pred in predictions if pred == y)
print("算法: 多层感知机 XOR 分类")
print("训练准确率:", round(correct / len(data), 3))
print("预测:", predictions)
`
  };
  return snippets[kind] || snippets.knn;
}

function courseAlgorithmGeneration(prompt, hits) {
  const kind = inferAlgorithmKind(prompt, hits);
  return {
    title: {
      knn: "AI生成 K近邻分类算法",
      linear: "AI生成 线性回归算法",
      logistic: "AI生成 逻辑回归算法",
      kmeans: "AI生成 K-Means聚类算法",
      bayes: "AI生成 朴素贝叶斯算法",
      gradient: "AI生成 梯度下降算法",
      decisionTree: "AI生成 决策树算法",
      randomForest: "AI生成 随机森林算法",
      svm: "AI生成 支持向量机算法",
      pca: "AI生成 PCA主成分分析算法",
      gmm: "AI生成 高斯混合模型算法",
      mlp: "AI生成 多层感知机算法"
    }[kind] || "AI生成机器学习算法",
    chapter: hits[0]?.chapter || "课程资料检索生成",
    code: stdlibAlgorithmCode(kind, prompt, hits),
    sourceType: "course",
    summary: `命中 ${hits.length} 条课程资料/图谱内容，已按“${hits[0]?.title || "课程资料"}”生成可运行标准库 Python 示例。`,
    citations: citationsFromHits(hits)
  };
}

function localAlgorithmGeneration(prompt, subject, reason = "") {
  const fallbackHit = {
    type: "local",
    title: `${subject || "机器学习"}算法实验室`,
    sourceName: "系统内置标准库算法模板",
    subject: subject || "机器学习",
    chapter: "本地可运行算法模板",
    page: null,
    quote: String(prompt || "").slice(0, 180)
  };
  const generated = courseAlgorithmGeneration(prompt, [fallbackHit]);
  const reasonText = reason ? `；${reason}` : "";
  return {
    ...generated,
    chapter: generated.chapter || fallbackHit.chapter,
    sourceType: "local",
    summary: `课程资料未达到可引用命中阈值${reasonText}，已使用系统内置标准库算法模板生成，并将在返回前真实执行验证。`,
    citations: []
  };
}

function publicGenerationFallbackReason(error) {
  const message = String(error?.message || "");
  if (!message) return "OpenAI 生成不可用";
  if (/api key|Incorrect API key|401|authorization|unauthorized/i.test(message)) return "OpenAI 配置不可用";
  if (/abort|timeout|超时/i.test(message)) return "OpenAI 生成超时";
  return "OpenAI 生成不可用";
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1].trim() : raw;
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      try {
        return JSON.parse(source.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function extractPythonCode(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:python|py)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : raw).trim();
}

function isPythonRuntimeUnavailable(runResult) {
  const text = `${runResult?.stderr || ""}\n${runResult?.output || ""}`;
  return /无法启动 Python|未找到可用 Python|spawn .*ENOENT|ENOENT/i.test(text);
}

async function generateAlgorithmWithOpenAI(prompt, subject, repairContext = null, contextHits = []) {
  if (!isConfiguredSecret(OPENAI_API_KEY)) {
    throw new Error("未配置 OpenAI API Key，无法在课程资料未命中时生成算法。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const contextText = (Array.isArray(contextHits) ? contextHits : [])
      .slice(0, 5)
      .map((hit, index) => `[S${index + 1}] ${hit.title || hit.sourceName || "课程资料"} / ${hit.chapter || ""}\n${String(hit.text || hit.quote || "").slice(0, 700)}`)
      .join("\n\n");
    const messages = [
      {
        role: "system",
        content: [
          "你是机器学习课程的算法代码生成器。",
          "必须精准理解用户要的算法类型、输入输出和评估指标。",
          "只输出 JSON，不要输出 Markdown。",
          "JSON 字段为 title、chapter、code、summary。",
          "code 必须是可直接运行的 Python 代码，只使用 Python 标准库，不依赖 numpy、sklearn、pandas、matplotlib。",
          "代码必须包含小型内置数据、训练或计算过程，并使用 print 输出真实指标、预测结果、误差或中间过程。",
          "不要只打印“运行成功”，不要伪造结果，不要省略可复现实验数据。"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `学科：${subject || "机器学习"}`,
          `算法需求：${prompt}`,
          contextText ? `可参考的课程资料片段：\n${contextText}` : ""
        ].filter(Boolean).join("\n\n")
      }
    ];
    if (repairContext) {
      messages.push({
        role: "user",
        content: [
          "上一次生成的代码在真实执行时失败，请根据报错修复后重新输出同样 JSON 结构。",
          `退出码：${repairContext.exitCode}`,
          `stdout：${String(repairContext.stdout || "").slice(0, 1200)}`,
          `stderr：${String(repairContext.stderr || "").slice(0, 1800)}`,
          "只返回修复后的 JSON。"
        ].join("\n")
      });
    }
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.15,
        max_tokens: 2500
      }),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI 接口返回 ${response.status}：${text.slice(0, 240)}`);
    }
    const data = JSON.parse(text);
    const content = data.choices?.[0]?.message?.content || data.output?.text || "";
    const parsed = extractJsonObject(content);
    const code = extractPythonCode(parsed?.code || content);
    if (!code) throw new Error("OpenAI 没有返回可执行 Python 代码。");
    return {
      title: parsed?.title || "OpenAI 生成机器学习算法",
      chapter: parsed?.chapter || "OpenAI 大模型生成",
      code,
      sourceType: "openai",
      summary: parsed?.summary || (contextHits?.length ? "已结合课程资料上下文调用 OpenAI 生成标准库 Python 算法代码。" : "已调用 OpenAI 生成标准库 Python 算法代码。"),
      citations: citationsFromHits(contextHits || []).slice(0, 5)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function verifyGeneratedAlgorithm(generated, prompt, subject) {
  const firstRun = await runModelCodeSnippet(generated.code);
  if (firstRun.success && String(firstRun.stdout || "").trim()) {
    return {
      ...generated,
      summary: `${generated.summary || "已生成算法代码"}（已在服务器真实执行验证，退出码 ${firstRun.exitCode}。）`,
      verifiedRun: {
        success: true,
        exitCode: firstRun.exitCode,
        durationMs: firstRun.durationMs,
        pythonCommand: firstRun.pythonCommand || "",
        stdout: firstRun.stdout.slice(0, 2000),
        stderr: firstRun.stderr.slice(0, 1000),
        output: firstRun.output
      }
    };
  }
  if (isPythonRuntimeUnavailable(firstRun)) {
    return {
      ...generated,
      summary: `${generated.summary || "已生成算法代码"}（服务器暂未找到可用 Python，已返回代码；配置 MODEL_CODE_PYTHON 后可真实运行验证。）`,
      verifiedRun: {
        success: false,
        exitCode: firstRun.exitCode,
        durationMs: firstRun.durationMs,
        pythonCommand: firstRun.pythonCommand || "",
        stdout: firstRun.stdout?.slice(0, 2000) || "",
        stderr: firstRun.stderr?.slice(0, 1000) || "",
        output: firstRun.output
      }
    };
  }
  if (generated.sourceType !== "openai") {
    throw new Error(`生成的课程算法未通过真实执行验证：${firstRun.stderr || firstRun.output || "没有输出"}`);
  }
  const repaired = await generateAlgorithmWithOpenAI(prompt, subject, firstRun);
  const secondRun = await runModelCodeSnippet(repaired.code);
  if (!secondRun.success || !String(secondRun.stdout || "").trim()) {
    throw new Error(`OpenAI 生成的算法未通过真实执行验证：${secondRun.stderr || secondRun.output || "没有输出"}`);
  }
  return {
    ...repaired,
    summary: `${repaired.summary || "已生成算法代码"}（已在服务器真实执行验证，退出码 ${secondRun.exitCode}。）`,
    verifiedRun: {
      success: true,
      exitCode: secondRun.exitCode,
      durationMs: secondRun.durationMs,
      pythonCommand: secondRun.pythonCommand || "",
      stdout: secondRun.stdout.slice(0, 2000),
      stderr: secondRun.stderr.slice(0, 1000),
      output: secondRun.output
    }
  };
}

function compactModelCodeRun(run, attempt = 0, label = "") {
  return { attempt, label, success: Boolean(run?.success), exitCode: Number.isFinite(Number(run?.exitCode)) ? Number(run.exitCode) : 1, timedOut: Boolean(run?.timedOut), durationMs: Number.isFinite(Number(run?.durationMs)) ? Number(run.durationMs) : 0, pythonCommand: run?.pythonCommand || "", stdout: String(run?.stdout || "").slice(0, 2000), stderr: String(run?.stderr || "").slice(0, 1000), output: String(run?.output || "").slice(0, MODEL_CODE_MAX_OUTPUT_CHARS), securityBlocked: Boolean(run?.securityBlocked) };
}

function verifiedRunFromResult(run) {
  return { success: Boolean(run?.success), exitCode: Number.isFinite(Number(run?.exitCode)) ? Number(run.exitCode) : 1, durationMs: Number.isFinite(Number(run?.durationMs)) ? Number(run.durationMs) : 0, pythonCommand: run?.pythonCommand || "", stdout: String(run?.stdout || "").slice(0, 2000), stderr: String(run?.stderr || "").slice(0, 1000), output: String(run?.output || "").slice(0, MODEL_CODE_MAX_OUTPUT_CHARS), securityBlocked: Boolean(run?.securityBlocked) };
}

async function runModelCodeWithAutoRepair({ code, prompt, subject, contextHits = [] }) {
  let currentCode = String(code || "");
  const repairHistory = [];
  for (let attempt = 0; attempt <= MODEL_CODE_REPAIR_MAX_ATTEMPTS; attempt += 1) {
    const run = await runModelCodeSnippet(currentCode);
    repairHistory.push(compactModelCodeRun(run, attempt, attempt === 0 ? "manual-run" : "auto-repair-run"));
    if (run.success) return { ...run, repairedCode: attempt > 0 ? currentCode : "", repairAttempts: attempt, repairHistory, repairAvailable: true };
    if (run.securityBlocked || isPythonRuntimeUnavailable(run) || attempt >= MODEL_CODE_REPAIR_MAX_ATTEMPTS || !isConfiguredSecret(OPENAI_API_KEY)) return { ...run, repairedCode: attempt > 0 ? currentCode : "", repairAttempts: attempt, repairHistory, repairAvailable: isConfiguredSecret(OPENAI_API_KEY) && !run.securityBlocked && !isPythonRuntimeUnavailable(run) };
    const repaired = await generateAlgorithmWithOpenAI(String(prompt || "Repair and improve this machine learning lab code"), subject, { ...run, originalCode: currentCode }, contextHits);
    currentCode = String(repaired.code || currentCode);
  }
  const last = repairHistory[repairHistory.length - 1] || {};
  return { success: false, exitCode: last.exitCode || 1, timedOut: Boolean(last.timedOut), durationMs: Number(last.durationMs || 0), stdout: last.stdout || "", stderr: last.stderr || "Auto repair did not produce runnable code.", output: last.output || "Auto repair did not produce runnable code.", repairedCode: currentCode, repairAttempts: Math.max(0, repairHistory.length - 1), repairHistory, repairAvailable: isConfiguredSecret(OPENAI_API_KEY) };
}

function simpleAlgorithmExplanation(prompt, generated = {}, hits = [], options = {}) {
  return { agentName: "ML Lab Code Agent", codeMode: options.codeMode || "teaching", difficulty: options.difficulty || "standard", goal: "Generate a runnable Python teaching lab for: " + String(prompt || generated.title || "machine learning").slice(0, 100), steps: ["Search course materials", "Generate complete Python code", "Run it on the server", "Save prompt, code, explanation, and run result"], metrics: ["exitCode", "stdout", "durationMs"], tunables: ["codeMode", "difficulty", "algorithm parameters"], courseBasis: hits.slice(0, 3).map((hit) => ({ title: hit.title || hit.sourceName || "course material", chapter: hit.chapter || "", quote: String(hit.quote || "").slice(0, 160) })) };
}

function buildModelCodeWorkflow({ hits = [], generated = {}, run = null, repairHistory = [] }) {
  const finalRun = run || generated.verifiedRun || repairHistory[repairHistory.length - 1] || null;
  const repairs = Math.max(0, Number(generated.repairAttempts || 0));
  return [
    { key: "course_search", label: "Course search tool", status: hits.length ? "done" : "fallback", detail: hits.length ? "Matched " + hits.length + " course/graph snippets" : "Used built-in template or model fallback" },
    { key: "code_generation", label: "Code generation tool", status: "done", detail: generated.sourceType === "openai" ? "Generated Python code with model" : generated.sourceType === "course" ? "Generated from course context and stdlib template" : "Used local template or manual code" },
    { key: "python_runner", label: "Python sandbox runner", status: finalRun?.success ? "done" : finalRun ? "failed" : "pending", detail: finalRun ? "Exit " + finalRun.exitCode + ", " + (finalRun.durationMs || 0) + " ms" : "Waiting to run" },
    { key: "error_repair", label: "Error repair tool", status: repairs > 0 ? "done" : finalRun?.success ? "skipped" : "pending", detail: repairs > 0 ? "Auto repaired " + repairs + " time(s)" : "No repair needed or waiting for failure" },
    { key: "experiment_record", label: "Experiment record tool", status: "ready", detail: "Save prompt, course basis, code, run result, and explanation" }
  ];
}

function buildExperimentRecord({ userId, subject, prompt, codeMode, difficulty, generated = {}, hits = [] }) {
  return { agentName: "ML Lab Code Agent", userId, subject, prompt: String(prompt || "").slice(0, 1200), codeMode: codeMode || "teaching", difficulty: difficulty || "standard", sourceType: generated.sourceType || "", title: generated.title || "", chapter: generated.chapter || "", citations: Array.isArray(generated.citations) ? generated.citations.slice(0, 8) : citationsFromHits(hits).slice(0, 8), explanation: generated.explanation || null, verifiedRun: generated.verifiedRun || null, repairAttempts: Number(generated.repairAttempts || 0), repairHistory: Array.isArray(generated.repairHistory) ? generated.repairHistory.slice(0, 4) : [], workflow: buildModelCodeWorkflow({ hits, generated }), createdAt: now() };
}

function sanitizeExperimentRecord(value) {
  if (!value || typeof value !== "object") return null;
  const workshop = value.workshop && typeof value.workshop === "object" ? value.workshop : null;
  return { agentName: String(value.agentName || "ML Lab Code Agent").slice(0, 80), userId: String(value.userId || "").slice(0, 80), subject: normalizeSubject(value.subject || "machine learning"), prompt: String(value.prompt || "").slice(0, 1200), codeMode: String(value.codeMode || "teaching").slice(0, 40), difficulty: String(value.difficulty || "standard").slice(0, 40), sourceType: String(value.sourceType || "").slice(0, 40), title: String(value.title || "").slice(0, 160), chapter: String(value.chapter || "").slice(0, 160), citations: Array.isArray(value.citations) ? value.citations.slice(0, 8) : [], explanation: value.explanation && typeof value.explanation === "object" ? value.explanation : null, verifiedRun: value.verifiedRun && typeof value.verifiedRun === "object" ? verifiedRunFromResult(value.verifiedRun) : null, repairAttempts: Math.max(0, Math.min(3, Number(value.repairAttempts || 0))), repairHistory: Array.isArray(value.repairHistory) ? value.repairHistory.slice(0, 4) : [], workflow: Array.isArray(value.workflow) ? value.workflow.slice(0, 8) : [], workshop: workshop ? { experimentKey: String(workshop.experimentKey || "").slice(0, 60), title: String(workshop.title || "").slice(0, 160), ability: String(workshop.ability || "").slice(0, 240), dataset: String(workshop.dataset || "").slice(0, 240), nodes: Array.isArray(workshop.nodes) ? workshop.nodes.slice(0, 8).map((item) => String(item).slice(0, 80)) : [], steps: Array.isArray(workshop.steps) ? workshop.steps.slice(0, 8).map((item) => String(item).slice(0, 160)) : [], findings: String(workshop.findings || "").slice(0, 1200), mismatch: String(workshop.mismatch || "").slice(0, 1200), improvement: String(workshop.improvement || "").slice(0, 1200), evidenceFiles: Array.isArray(workshop.evidenceFiles) ? workshop.evidenceFiles.slice(0, 8).map((file) => ({ name: String(file?.name || "").slice(0, 160), type: String(file?.type || "").slice(0, 80), size: Math.max(0, Math.min(2 * 1024 * 1024, Number(file?.size || 0))) })) : [], conclusionCheck: workshop.conclusionCheck && typeof workshop.conclusionCheck === "object" ? { ok: Boolean(workshop.conclusionCheck.ok), title: String(workshop.conclusionCheck.title || "").slice(0, 160), detail: String(workshop.conclusionCheck.detail || "").slice(0, 500), evidence: String(workshop.conclusionCheck.evidence || "").slice(0, 300) } : null, runResult: String(workshop.runResult || "").slice(0, 10000) } : null, createdAt: value.createdAt || now(), updatedAt: value.updatedAt || "" };
}

function isAcademicMisuse(prompt) {
  return /直接.*(写|生成|完成).*(作业|论文|实验报告|考试|答案)|代写|替我写|帮我作弊|考试.*答案|不要解释.*只给答案/.test(String(prompt || ""));
}

const AI_MODE_META = {
  qa: {
    label: "问答模式",
    strategy: "课程 RAG 问答",
    structure: "结论、依据、补充推理、下一步"
  },
  explain: {
    label: "讲解模式",
    strategy: "分层讲解",
    structure: "定义、通俗解释、资料依据、例子、误区、练习"
  },
  guided: {
    label: "引导模式",
    strategy: "苏格拉底式引导",
    structure: "关键提示、追问、前置知识、下一步作答"
  },
  practice: {
    label: "练习模式",
    strategy: "自适应练习",
    structure: "知识点、分层题目、答案解析、错因提醒"
  },
  grade: {
    label: "批改模式",
    strategy: "错因诊断",
    structure: "总体评价、正确点、错误点、修改建议、复习建议"
  },
  plan: {
    label: "规划模式",
    strategy: "学习路径规划",
    structure: "目标、优先级、每日任务、练习安排、检测方式"
  }
};

const ML_DIAGNOSIS_WORKFLOW_INFO = {
  name: "机器学习知识点问答与学习诊断助手_升级版_多RAG_朴素贝叶斯诊断_0_6_0",
  version: "0.6.0",
  source: "dify/ml_learning_diagnosis/ml_learning_diagnosis_assistant_upgraded_0_6_0.yml"
};
const NATIVE_STUDENT_ASSISTANT_INFO = {
  name: "学生画像驱动课程问答助手",
  version: "1.0.0",
  source: "server.js"
};
const ML_AI_WORKFLOW_CONTRACTS = {
  knowledge_qa: { label: "机器学习知识问答", input: ["问题", "当前知识点", "课程资料"], output: ["分层讲解", "引用资料", "关联节点"] },
  misconception_classification: { label: "错因分类", input: ["学生答案", "标准答案", "解题过程", "节点信息"], output: ["对错", "错因标签", "错误证据", "掌握度", "补救任务", "复测标记"] },
  personalized_path: { label: "个性化路径生成", input: ["掌握度", "错因", "前置依赖", "可用时间"], output: ["任务序列", "资源", "练习", "预计时长"] },
  reflection_evaluation: { label: "反思引导与评价", input: ["学生反思", "学习记录"], output: ["反思质量反馈", "待改进点", "迁移建议"] }
};

function mlWorkflowType(value = "", mode = "") {
  const key = String(value || "").trim().toLowerCase();
  if (["knowledge_qa", "qa", "concept", "derivation", "code", "explain", "guided"].includes(key)) return key === "knowledge_qa" ? key : "knowledge_qa";
  if (["misconception_classification", "diagnosis", "grade", "grading"].includes(key)) return "misconception_classification";
  if (["personalized_path", "review", "plan", "class_analysis", "remedial_plan"].includes(key)) return "personalized_path";
  if (["reflection_evaluation", "reflection"].includes(key)) return "reflection_evaluation";
  return mode === "grade" ? "misconception_classification" : mode === "plan" ? "personalized_path" : "knowledge_qa";
}

function graphNodeIdForWorkflow(label = "") {
  return String(label || "").trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
}

const ML_DIAGNOSIS_WORKFLOW_STEP_TITLES = [
  "开始",
  "输入清洗与任务识别_代码节点",
  "课程知识库检索_RAG",
  "错因知识库检索_RAG",
  "RAG片段去重与证据整理_代码节点",
  "朴素贝叶斯知识点分类_代码节点",
  "掌握度评分_代码节点",
  "LLM标准解释节点",
  "条件分支_问答或诊断",
  "LLM诊断反馈节点",
  "输出结构化JSON_代码节点",
  "项目数据库同步_HTTP节点",
  "结束"
];

const TEACHER_WORKFLOW_INFO = {
  name: DIFY_TEACHER_WORKFLOW_NAME,
  version: "1.0.0",
  source: "DIFY_TEACHER_WORKFLOW_API_KEY"
};

const TEACHER_WORKFLOW_STEP_TITLES = [
  "开始",
  "输入清洗与教师任务识别",
  "项目资料/图谱/班级/作业上下文整理",
  "条件分支_备课/出题/批改/学情",
  "备课分支",
  "出题分支",
  "批改分支",
  "学情分析分支",
  "引用与可靠性检查",
  "输出结构化JSON",
  "结束"
];

const TEACHER_WORKFLOW_TASK_META = {
  lesson_plan: {
    label: "备课",
    mode: "plan",
    strategy: "教师教学工作流：备课",
    structure: "教学目标、重难点、课堂流程、板书/讲义、检测方式"
  },
  quiz_generation: {
    label: "出题",
    mode: "practice",
    strategy: "教师教学工作流：出题",
    structure: "分层题目、标准答案、评分点、错因标签、讲评建议"
  },
  grading: {
    label: "批改",
    mode: "grade",
    strategy: "教师教学工作流：批改建议",
    structure: "rubric分项、建议分、错因、修改建议、后续练习"
  },
  class_analysis: {
    label: "学情分析",
    mode: "plan",
    strategy: "教师教学工作流：学情分析",
    structure: "班级薄弱点、学生分层、补救路径、检测安排"
  },
  remedial_plan: {
    label: "补救方案",
    mode: "plan",
    strategy: "教师教学工作流：分层补救",
    structure: "薄弱点归因、分组任务、补救练习、复测标准"
  }
};

const ML_DIAGNOSIS_TOPIC_KEYWORDS = {
  "机器学习基础": ["机器学习", "监督学习", "无监督学习", "强化学习", "泛化", "归纳偏置", "训练集", "测试集"],
  "数学基础": ["向量", "矩阵", "梯度", "凸函数", "范数", "内积", "协方差", "优化"],
  KNN: ["KNN", "K近邻", "最近邻", "距离", "投票", "回归平均", "标准化", "K值"],
  "线性回归": ["线性回归", "平方损失", "均方误差", "MSE", "正规方程", "梯度下降", "学习率"],
  "过拟合与泛化": ["过拟合", "欠拟合", "泛化", "正则化", "L1", "L2", "验证集", "交叉验证", "数据泄漏"],
  "逻辑回归": ["逻辑回归", "逻辑斯谛", "Sigmoid", "二分类", "交叉熵", "最大似然", "精确率", "召回率", "F1"],
  "矩阵分解与推荐": ["矩阵分解", "推荐", "隐因子", "用户向量", "物品向量", "评分预测", "冷启动"],
  "神经网络": ["神经网络", "感知机", "多层感知机", "隐藏层", "激活函数", "反向传播", "ReLU", "Dropout"],
  "卷积神经网络": ["CNN", "卷积", "卷积核", "特征图", "池化", "padding", "stride", "权值共享"],
  "循环神经网络": ["RNN", "GRU", "LSTM", "序列", "隐藏状态", "时间步", "门控", "梯度消失"],
  "支持向量机": ["SVM", "支持向量机", "支持向量", "最大间隔", "软间隔", "核函数", "C", "gamma"],
  "决策树": ["决策树", "ID3", "C4.5", "CART", "信息增益", "增益率", "基尼", "剪枝"],
  "集成学习": ["集成学习", "Bagging", "随机森林", "Boosting", "AdaBoost", "GBDT", "残差", "负梯度"],
  "KMeans聚类": ["KMeans", "K均值", "聚类", "簇", "簇中心", "SSE", "肘部法", "轮廓系数", "KMeans++"],
  "PCA降维": ["PCA", "主成分", "降维", "方差", "协方差", "特征值", "特征向量", "解释方差率"],
  "朴素贝叶斯": ["朴素贝叶斯", "贝叶斯", "先验", "似然", "后验", "条件独立", "拉普拉斯平滑", "文本分类"],
  "EM与GMM": ["EM", "GMM", "高斯混合", "隐变量", "E步", "M步", "似然", "软聚类"],
  "自编码器": ["自编码器", "编码器", "解码器", "隐表示", "重构误差", "异常检测"]
};

function aiModeAlias(mode) {
  const raw = String(mode || "").trim().toLowerCase();
  const aliases = {
    rag: "qa",
    answer: "qa",
    question: "qa",
    questions: "practice",
    quiz: "practice",
    socratic: "guided",
    hint: "guided",
    guide: "guided",
    guided_tutoring: "guided",
    "study-plan": "plan",
    "teacher-plan": "plan",
    lesson_plan: "plan",
    "lesson-plan": "plan",
    class_analysis: "plan",
    "class-analysis": "plan",
    remedial_plan: "plan",
    "remedial-plan": "plan",
    quiz_generation: "practice",
    "quiz-generation": "practice",
    correction: "grade",
    grading: "grade",
    qa: "qa",
    explain: "explain",
    guided: "guided",
    practice: "practice",
    grade: "grade",
    plan: "plan"
  };
  return aliases[raw] || null;
}

function detectTeachingIntent(prompt, requestedMode, role = "student") {
  const text = String(prompt || "");
  let mode = aiModeAlias(requestedMode);
  if (!mode || String(requestedMode || "").trim().toLowerCase() === "auto") {
    if (/批改|评分|看看.*答案|哪里错|错因|修改建议|改作业|检查代码|实验报告反馈/.test(text)) mode = "grade";
    else if (/苏格拉底|追问|引导|提示模式|只给.*提示|分步提示|不要直接给答案|先问我|一步步/.test(text)) mode = "guided";
    else if (/出题|生成.*题|练习|测验|选择题|填空题|简答题|计算题|编程题|错题|类似题|同类题/.test(text)) mode = "practice";
    else if (/复习|学习路径|复习路径|学习计划|规划|薄弱点|掌握度|推荐顺序|每日|每周|考试|教案|教学设计|课堂设计|授课方案/.test(text)) mode = "plan";
    else if (/讲解|解释|是什么|为什么|原理|通俗|推导|举例|对比|区别/.test(text)) mode = "explain";
    else mode = "qa";
  }
  const teacherDesign = role === "teacher" && /教学设计|教案|课堂设计|授课方案|教学目标|重难点|课堂流程|评分标准/.test(text);
  const strategy = teacherDesign
    ? "教师助手：教学设计生成"
    : AI_MODE_META[mode]?.strategy || "课程 RAG 问答";
  const intent = teacherDesign ? "teacher-design" : mode;
  return {
    mode,
    label: AI_MODE_META[mode]?.label || "问答模式",
    intent,
    strategy,
    answerStructure: AI_MODE_META[mode]?.structure || AI_MODE_META.qa.structure
  };
}

function inferQuestionTopics(text, subject = "") {
  return extractKeywords(text, subject).slice(0, 6);
}

function linkEndpointId(value) {
  if (value && typeof value === "object") return String(value.id || value.key || value.label || "");
  return String(value || "");
}

function relationBucket(label = "") {
  const text = String(label || "");
  if (/前置|依赖|先修|基础/.test(text)) return "prerequisite";
  if (/混淆|误区|迷思|区别|对比/.test(text)) return "misconception";
  if (/考|题|测|评分|难度/.test(text)) return "assessment";
  if (/资源|视频|讲义|实验|资料/.test(text)) return "resource";
  if (/复习|路径|推荐/.test(text)) return "review";
  return "related";
}

function graphNodeText(node) {
  return [
    node.label,
    node.details,
    node.summary,
    node.description,
    node.ontology?.layer,
    node.ontology?.parent,
    ...(node.knowledgePoints || []),
    ...(node.misconceptions || [])
  ].filter(Boolean).join(" ");
}

function findGraphContext(db, userId, subject, prompt, topics = [], hits = []) {
  const queryText = [prompt, subject, ...topics].filter(Boolean).join(" ");
  const queryTokens = new Set(tokenizeForSearch(queryText));
  const graphHitNodeIds = new Set(hits.filter((hit) => hit.type === "graph").map((hit) => `${hit.graphId}:${hit.nodeId}`));
  const graphs = visibleKnowledgeGraphs(db, userId).filter((graph) => (
    !subject || subject === "通用" || graph.subject === subject || String(prompt).includes(graph.subject)
  ));
  const candidates = [];
  graphs.forEach((graph) => {
    (graph.nodes || []).forEach((node) => {
      const nodeText = graphNodeText(node);
      const tokens = tokenizeForSearch(nodeText);
      const overlap = tokens.filter((token) => queryTokens.has(token)).length;
      const exact = String(prompt).includes(node.label) ? 8 : 0;
      const hitBoost = graphHitNodeIds.has(`${graph.id}:${node.id}`) ? 6 : 0;
      const score = overlap * 2 + exact + hitBoost;
      if (score > 0) candidates.push({ graph, node, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) {
    return {
      focusNode: null,
      relatedNodes: topics.slice(0, 6).map((topic) => ({ label: topic })),
      prerequisiteNodes: [],
      misconceptionNodes: [],
      path: [],
      graphTitle: "",
      graphId: ""
    };
  }
  const nodeMap = new Map((best.graph.nodes || []).map((node) => [String(node.id), node]));
  const related = [];
  const prerequisite = [];
  const misconception = [];
  (best.graph.links || []).forEach((link) => {
    const source = linkEndpointId(link.source);
    const target = linkEndpointId(link.target);
    const touches = source === String(best.node.id) || target === String(best.node.id);
    if (!touches) return;
    const otherId = source === String(best.node.id) ? target : source;
    const other = nodeMap.get(otherId);
    if (!other) return;
    const item = {
      id: other.id,
      label: other.label,
      relation: link.label || "关联",
      direction: target === String(best.node.id) ? "incoming" : "outgoing"
    };
    const bucket = relationBucket(link.label);
    if (bucket === "prerequisite" || (target === String(best.node.id) && /包含|细分|支撑/.test(String(link.label || "")))) prerequisite.push(item);
    else if (bucket === "misconception") misconception.push(item);
    else related.push(item);
  });
  const parentLabel = best.node.ontology?.parent || "";
  const path = [best.graph.subject, parentLabel, best.node.label].filter(Boolean);
  return {
    graphId: best.graph.id,
    graphTitle: best.graph.title,
    focusNode: {
      id: best.node.id,
      label: best.node.label,
      details: best.node.details || best.node.summary || "",
      layer: best.node.ontology?.layer || best.node.group || "知识点"
    },
    relatedNodes: related.concat(candidates.slice(1, 7).map((item) => ({
      id: item.node.id,
      label: item.node.label,
      relation: "相邻知识点"
    }))).slice(0, 8),
    prerequisiteNodes: prerequisite.slice(0, 6),
    misconceptionNodes: misconception.concat((best.node.misconceptions || []).map((label) => ({ label, relation: "常见误区" }))).slice(0, 6),
    path
  };
}

function normalizedTopicKey(topic) {
  return String(topic || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（）()《》「」'"]/g, "");
}

function mlTermPatternForTopic(topic) {
  const text = String(topic || "");
  if (!text.trim()) return null;
  return ML_TERM_PATTERNS.find((item) => (
    item.label === text
    || item.label.includes(text)
    || text.includes(item.label)
    || item.pattern.test(text)
  )) || null;
}

function topicDirectHit(text, topic) {
  const source = String(text || "");
  const label = String(topic || "").trim();
  if (!source.trim() || !label) return false;
  if (textContainsKeyword(source, label)) return true;
  const term = mlTermPatternForTopic(label);
  return term ? term.pattern.test(source) : false;
}

function normalizeTopicProbability(value, fallback = 0.45) {
  const normalized = normalizeLearningScore(value);
  return normalized === null ? fallback : normalized;
}

function buildTopicLocalization({ prompt = "", knowledgePoint = "", graphContext = {}, agent = {}, workflowResult = {} }) {
  const evidenceText = [
    prompt,
    knowledgePoint,
    graphContext?.focusNode?.label,
    ...(Array.isArray(agent.topics) ? agent.topics : []),
    workflowResult.topic_label || workflowResult.topicLabel || ""
  ].filter(Boolean).join("\n");
  const candidateMap = new Map();
  const addCandidate = (topic, score, source, evidence = "") => {
    const label = String(topic || "").trim();
    if (!label) return;
    const key = normalizedTopicKey(label);
    if (!key) return;
    const direct = topicDirectHit(prompt, label) || topicDirectHit(knowledgePoint, label);
    let adjusted = Number(score || 0);
    if (direct) adjusted = Math.max(adjusted + 0.22, 0.92);
    if (!direct && source === "图谱焦点") adjusted = Math.min(adjusted, 0.58);
    adjusted = Math.max(0.05, Math.min(1, adjusted));
    const existing = candidateMap.get(key);
    const item = {
      topic: label,
      probability: Number(adjusted.toFixed(4)),
      source,
      evidence: evidence || (direct ? "学生问题或手动上下文直接命中该知识点" : "由工作流、图谱或检索证据推断"),
      direct
    };
    if (!existing || item.probability > existing.probability) candidateMap.set(key, item);
  };

  if (knowledgePoint) addCandidate(knowledgePoint, 0.82, "手动上下文", "学生或页面上下文已指定知识点");
  const workflowTopic = workflowResult.topic_label || workflowResult.topicLabel || "";
  if (workflowTopic) addCandidate(workflowTopic, normalizeTopicProbability(workflowResult.topic_probability ?? workflowResult.topicProbability, agent.confidence === "dify" ? 0.68 : 0.54), "Dify 工作流", "工作流结构化输出的 topic_label");
  const workflowCandidates = Array.isArray(workflowResult.top_topic_candidates || workflowResult.topTopicCandidates)
    ? (workflowResult.top_topic_candidates || workflowResult.topTopicCandidates)
    : [];
  workflowCandidates.forEach((item, index) => {
    const topic = typeof item === "string" ? item : item.topic || item.label || item.name || "";
    const probability = typeof item === "string" ? Math.max(0.42, 0.58 - index * 0.06) : normalizeTopicProbability(item.probability ?? item.score, Math.max(0.42, 0.62 - index * 0.07));
    addCandidate(topic, probability, "Dify 候选", "工作流返回的候选知识点");
  });
  (Array.isArray(agent.topics) ? agent.topics : []).forEach((topic, index) => {
    addCandidate(topic, Math.max(0.32, 0.54 - index * 0.04), "智能体候选", "智能体综合检索与回答生成得到");
  });
  if (graphContext?.focusNode?.label) {
    addCandidate(graphContext.focusNode.label, 0.52, "图谱焦点", graphContext.graphTitle ? `命中图谱「${graphContext.graphTitle}」节点` : "命中知识图谱节点");
  }
  ML_TERM_PATTERNS.forEach((item) => {
    if (item.pattern.test(evidenceText)) addCandidate(item.label, 0.88, "问题文本命中", `问题文本命中「${item.label}」别名或关键词`);
  });

  const candidates = Array.from(candidateMap.values())
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5);
  const best = candidates[0] || {
    topic: knowledgePoint || workflowTopic || "待确认知识点",
    probability: 0.35,
    source: "待确认",
    evidence: "没有足够的题面、上下文或图谱证据",
    direct: false
  };
  const second = candidates[1];
  const margin = second ? best.probability - second.probability : best.probability;
  const needsConfirmation = best.probability < 0.62 || (!best.direct && second && margin < 0.12);
  const confidenceLabel = best.probability >= 0.82
    ? "高"
    : best.probability >= 0.62 ? "中" : "低";
  return {
    selectedTopic: best.topic,
    confidence: best.probability,
    confidenceLabel,
    needsConfirmation,
    candidates,
    basis: best.evidence,
    policy: needsConfirmation ? "低置信度或候选接近，仅记录为待确认，不更新掌握度。" : "定位证据充足，本轮可写入学习画像。",
    corrected: false
  };
}

function profileMasterySummary(profile) {
  const entries = Object.entries(profile.mastery || {})
    .filter(([, item]) => Array.isArray(item?.evidence) && item.evidence.length > 0)
    .map(([topic, item]) => ({ topic, score: Number(item.score || 0), status: item.status || "待诊断", evidenceCount: item.evidence.length }))
    .sort((a, b) => a.score - b.score);
  return {
    weak: entries.filter((item) => item.score < 0.58).slice(0, 6),
    strong: entries.filter((item) => item.score >= 0.75).slice(-6).reverse(),
    count: entries.length,
    average: entries.length ? Number((entries.reduce((sum, item) => sum + item.score, 0) / entries.length).toFixed(2)) : null
  };
}

function updateTopicMastery(db, userId, topics, delta, evidence) {
  const profile = ensureLearningProfile(db, userId);
  topics.filter(Boolean).slice(0, 8).forEach((topic) => {
    const current = profile.mastery[topic] || { score: 0.52, status: "待诊断", evidence: [] };
    profile.mastery[topic] = applyWeightedMasteryEvidence(current, {
      score: Number(current.score || 0.52) + Number(delta || 0),
      weight: 0.15,
      source: "learning_activity",
      text: evidence,
      at: now()
    });
  });
  const weakSet = new Set(profile.weakPoints || []);
  Object.entries(profile.mastery || {}).forEach(([topic, item]) => {
    if (Number(item.score || 0) < 0.58) weakSet.add(topic);
    else weakSet.delete(topic);
  });
  profile.weakPoints = Array.from(weakSet).slice(0, 12);
  profile.updatedAt = now();
  return profile;
}

function appendLearningEvidence(db, item = {}) {
  db.learningEvidence = Array.isArray(db.learningEvidence) ? db.learningEvidence : [];
  const evidence = { id: uid("evidence"), studentId: String(item.studentId || ""), evidenceType: String(item.evidenceType || "learning_event").slice(0, 80), relatedNodeIds: Array.isArray(item.relatedNodeIds) ? item.relatedNodeIds.map(String).slice(0, 20) : [], relatedMisconceptionId: String(item.relatedMisconceptionId || ""), eventId: String(item.eventId || ""), summary: String(item.summary || "").slice(0, 1200), teacherVerified: Boolean(item.teacherVerified), createdAt: now() };
  if (!evidence.studentId) return null;
  db.learningEvidence.unshift(evidence); db.learningEvidence = db.learningEvidence.slice(0, 6000);
  return evidence;
}

function appendNodeMasterySnapshot(db, studentId, nodeId, masteryScore, source, eventId = "") {
  if (!nodeId || masteryScore === null || masteryScore === undefined) return null;
  db.nodeMasterySnapshots = Array.isArray(db.nodeMasterySnapshots) ? db.nodeMasterySnapshots : [];
  const snapshot = { id: uid("mastery_snap"), studentId, nodeId: String(nodeId), masteryScore: normalizeLearningScore(masteryScore), source: String(source || "learning_activity").slice(0, 100), eventId: String(eventId || ""), recordedAt: now() };
  db.nodeMasterySnapshots.unshift(snapshot); db.nodeMasterySnapshots = db.nodeMasterySnapshots.slice(0, 10000);
  return snapshot;
}

function upsertMisconceptionRecord(db, item = {}) {
  db.misconceptionRecords = Array.isArray(db.misconceptionRecords) ? db.misconceptionRecords : [];
  const studentId = String(item.studentId || ""); const type = String(item.misconceptionType || "待归类错因").slice(0, 180); const nodeId = String(item.nodeId || "");
  if (!studentId) return null;
  const record = db.misconceptionRecords.find((row) => row.studentId === studentId && row.nodeId === nodeId && row.misconceptionType === type && row.status !== "eliminated");
  const history = { at: now(), action: String(item.action || "diagnosed").slice(0, 80), detail: String(item.detail || "").slice(0, 600), evidenceId: String(item.evidenceId || "") };
  if (record) { record.lastSeen = now(); record.evidenceId = history.evidenceId || record.evidenceId; record.status = item.status || record.status || "active"; record.interventionHistory = [...(record.interventionHistory || []), history].slice(-20); return record; }
  const next = { id: uid("misconception"), studentId, nodeId, misconceptionType: type, evidenceId: history.evidenceId, firstSeen: now(), lastSeen: now(), status: item.status || "active", interventionHistory: [history] };
  db.misconceptionRecords.unshift(next); db.misconceptionRecords = db.misconceptionRecords.slice(0, 5000); return next;
}

function createPrePostAssessment(db, item = {}) {
  db.prePostAssessments = Array.isArray(db.prePostAssessments) ? db.prePostAssessments : [];
  const assessment = { id: uid("assessment"), studentId: String(item.studentId || ""), cycleId: String(item.cycleId || ""), assessmentType: String(item.assessmentType || "diagnostic").slice(0, 60), score: normalizeLearningScore(item.score), nodeScores: item.nodeScores && typeof item.nodeScores === "object" ? item.nodeScores : {}, completedAt: item.completedAt || now() };
  db.prePostAssessments.unshift(assessment); db.prePostAssessments = db.prePostAssessments.slice(0, 5000); return assessment;
}

function createLearningPathRecommendation(db, item = {}) {
  db.learningPathRecommendations = Array.isArray(db.learningPathRecommendations) ? db.learningPathRecommendations : [];
  const path = { id: uid("path"), studentId: String(item.studentId || ""), targetNodes: Array.isArray(item.targetNodes) ? item.targetNodes.map(String).slice(0, 20) : [], reason: String(item.reason || "").slice(0, 1000), tasks: Array.isArray(item.tasks) ? item.tasks.slice(0, 12) : [], estimatedMinutes: Math.max(0, Math.min(1440, Number(item.estimatedMinutes || 0))), status: String(item.status || "recommended").slice(0, 40), createdAt: now(), updatedAt: now() };
  db.learningPathRecommendations.unshift(path); db.learningPathRecommendations = db.learningPathRecommendations.slice(0, 3000); return path;
}

function createExperimentSubmissionRecord(db, item = {}) {
  db.experimentSubmissions = Array.isArray(db.experimentSubmissions) ? db.experimentSubmissions : [];
  const submission = { id: uid("experiment_submission"), studentId: String(item.studentId || ""), experimentId: String(item.experimentId || ""), artifacts: Array.isArray(item.artifacts) ? item.artifacts.slice(0, 12) : [], resultSummary: String(item.resultSummary || "").slice(0, 1500), aiFeedback: String(item.aiFeedback || "").slice(0, 1500), reflection: item.reflection && typeof item.reflection === "object" ? item.reflection : {}, modelId: String(item.modelId || ""), submittedAt: now() };
  db.experimentSubmissions.unshift(submission); db.experimentSubmissions = db.experimentSubmissions.slice(0, 3000); return submission;
}

function recordLearningActivity(db, userId, activity) {
  const profile = ensureLearningProfile(db, userId);
  profile.questionCount = Number(profile.questionCount || 0) + (activity.kind === "question" ? 1 : 0);
  profile.practiceCount = Number(profile.practiceCount || 0) + (activity.kind === "practice" ? 1 : 0);
  profile.studyMinutes = Number(profile.studyMinutes || 0) + Number(activity.minutes || 3);
  profile.recentActivity = Array.isArray(profile.recentActivity) ? profile.recentActivity : [];
  profile.recentActivity.unshift({ ...activity, at: now() });
  profile.recentActivity = profile.recentActivity.slice(0, 30);
  profile.updatedAt = now();
  return profile;
}

function addWrongNote(db, userId, note) {
  db.wrongNotes = Array.isArray(db.wrongNotes) ? db.wrongNotes : [];
  const wrongNote = {
    id: uid("wrong"),
    userId,
    source: note.source || "智能体反馈",
    topic: note.topic || "待归类",
    question: note.question || "",
    answer: note.answer || "",
    analysis: note.analysis || "",
    recommendation: note.recommendation || "",
    createdAt: now()
  };
  db.wrongNotes.unshift(wrongNote);
  db.wrongNotes = db.wrongNotes.slice(0, 500);
  const misconception = upsertMisconceptionRecord(db, { studentId: userId, nodeId: note.nodeId || "", misconceptionType: note.misconceptionType || wrongNote.analysis || wrongNote.topic, action: "diagnosed", detail: wrongNote.analysis, status: "active" });
  wrongNote.misconceptionId = misconception?.id || "";
  return wrongNote;
}

function formatCitations(citations) {
  if (!citations.length) return "暂无课程资料引用。";
  const shown = citations.slice(0, 2);
  const lines = shown.map((citation) => {
    const location = citation.page ? `${citation.chapter || "课程片段"}，第 ${citation.page} 页` : (citation.chapter || "知识图谱节点");
    const source = String(citation.sourceName || citation.title || "课程资料").replace(/\s+/g, " ").slice(0, 28);
    const compactLocation = String(location || "").replace(/\s+/g, " ").slice(0, 36);
    return `[${citation.id}] ${source} · ${compactLocation}`;
  });
  if (citations.length > shown.length) lines.push(`还有 ${citations.length - shown.length} 条引用，已放在右侧“引用来源”栏。`);
  return lines.join("\n");
}

function answerDepthLabel(depth) {
  return {
    brief: "简洁解释",
    layered: "分层讲解",
    full: "完整解析",
    exam: "考试版"
  }[String(depth || "layered")] || "分层讲解";
}

function citationEvidenceLines(hits, max = 3) {
  return hits.slice(0, max).map((hit, index) => `依据 [S${index + 1}]：${String(hit.text || hit.quote || "").replace(/\s+/g, " ").slice(0, 150)}`);
}

function masteryItemsForTopics(profile, topics) {
  return topics.slice(0, 8).map((topic) => {
    const item = profile.mastery?.[topic] || {};
    return {
      topic,
      score: item.score === undefined ? null : Number(item.score),
      status: item.status || "待诊断"
    };
  });
}

function buildRecommendedExercises(mode, topics, graphContext) {
  const topic = topics[0] || graphContext?.focusNode?.label || "当前知识点";
  if (mode === "practice") {
    return [
      `基础题：用一句话解释「${topic}」并列出适用条件。`,
      `提高题：比较「${topic}」和一个相邻知识点的区别。`,
      `迁移题：设计一个需要应用「${topic}」解决的小题并写出评分点。`
    ];
  }
  if (mode === "grade") {
    return [
      `复盘题：重新写出「${topic}」的定义、条件和解题步骤。`,
      "错因题：把本次错误归类为概念、条件、步骤或表达问题。",
      "同类题：换一组条件再完成一次，并标出每一步依据。"
    ];
  }
  if (mode === "plan") {
    return [
      `今天：整理「${topic}」的定义和前置知识。`,
      "明天：完成 3 道基础题和 1 道迁移题。",
      "复盘：24 小时后重做错题并更新掌握度。"
    ];
  }
  if (mode === "guided") {
    return [
      `先回答：你认为「${topic}」最关键的条件是什么？`,
      "再写出第一步依据，不要直接跳到结论。",
      "如果卡住，只补充你不确定的那一步。"
    ];
  }
  return [
    `复述「${topic}」的定义并举一个例子。`,
    `列出「${topic}」的一个易错点。`,
    "做 1 道基础题检验是否真正理解。"
  ];
}

function buildAgentActions(mode, topics) {
  const topic = topics[0] || "当前知识点";
  const common = [
    { type: "simplify", label: "讲得更简单", mode: "explain", prompt: `请把「${topic}」讲得更简单，并用生活类比说明。` },
    { type: "example", label: "举个例子", mode: "explain", prompt: `请围绕「${topic}」举一个完整例子，并说明每一步对应的知识点。` },
    { type: "sources", label: "显示来源", mode, prompt: "" }
  ];
  const byMode = {
    qa: [{ type: "hint", label: "只给提示", mode: "guided", prompt: `围绕「${topic}」只给我下一步提示，不要直接给完整答案。` }],
    explain: [{ type: "quiz", label: "给我一道题", mode: "practice", prompt: `请根据「${topic}」生成 1 道基础题、1 道提高题，并附答案解析。` }],
    guided: [{ type: "full", label: "完整解析", mode: "explain", prompt: `请把「${topic}」按完整解析模式讲清楚。` }],
    practice: [{ type: "grade", label: "批改我的答案", mode: "grade", prompt: `请按批改模式检查我对「${topic}」的答案。` }],
    grade: [{ type: "quiz", label: "生成同类题", mode: "practice", prompt: `请根据本次错因，为「${topic}」生成 2 道同类题并附解析。` }],
    plan: [{ type: "quiz", label: "生成阶段测验", mode: "practice", prompt: `请根据「${topic}」生成一组阶段测验题并附答案解析。` }]
  };
  return common.concat(byMode[mode] || []).concat([
    { type: "wrong-note", label: "加入错题本", mode, prompt: "" },
    { type: "mastered", label: "标记已掌握", mode, prompt: "" }
  ]);
}

function metacognitivePromptsForTopic(topic = "当前知识点", mode = "qa") {
  const label = String(topic || "当前知识点").trim() || "当前知识点";
  const common = [
    `你为什么会这样理解「${label}」？请写出依据，而不是只写结论。`,
    `你能不能举一个反例或边界场景，检验自己是否真的理解「${label}」？`,
    "你现在最不确定的一步是什么？下一次准备怎么验证？",
    "这次你使用 AI 是为了获得提示、核对证据，还是直接替代思考？"
  ];
  if (mode === "grade") {
    return [
      `你这次错误更像是概念误解、条件遗漏、步骤跳跃，还是表达不完整？`,
      ...common.slice(0, 3)
    ];
  }
  if (mode === "practice") {
    return [
      `作答前，你准备先用哪个知识点或公式？为什么？`,
      ...common.slice(0, 3)
    ];
  }
  if (mode === "guided") {
    return [
      `在看下一条提示前，你能先说出自己已经确定的部分吗？`,
      ...common.slice(0, 3)
    ];
  }
  return common;
}

function buildGraphProfileRecommendations({ topics = [], graphContext = {}, profile = {}, mastery = [] }) {
  const focus = graphContext?.focusNode;
  const topic = topics[0] || focus?.label || "当前知识点";
  const weakTopics = mastery.filter((item) => item.score === null || item.score < 0.58).map((item) => item.topic).slice(0, 4);
  const prerequisites = (graphContext?.prerequisiteNodes || []).map((node) => node.label).filter(Boolean).slice(0, 4);
  const related = (graphContext?.relatedNodes || []).map((node) => node.label).filter(Boolean).slice(0, 4);
  const profileEvidence = profile.mastery?.[topic]?.evidence || [];
  const nextPath = [
    prerequisites.length ? `先补前置：${prerequisites.join("、")}` : "",
    `聚焦节点：${focus?.label || topic}`,
    weakTopics.length ? `修正薄弱：${weakTopics.join("、")}` : "完成一次变式测试",
    "写结构化反思并进入学习档案"
  ].filter(Boolean);
  return {
    title: "GraphRAG + 学习画像推荐路径",
    topic,
    graphNode: focus ? {
      graphId: graphContext.graphId || "",
      graphTitle: graphContext.graphTitle || "",
      nodeId: focus.id || "",
      label: focus.label || topic,
      path: graphContext.path || []
    } : null,
    weakTopics,
    prerequisites,
    related,
    nextPath,
    evidenceIndex: {
      profileEvidenceCount: Array.isArray(profileEvidence) ? profileEvidence.length : 0,
      graphEvidence: focus ? "知识图谱节点作为证据索引" : "未命中图谱节点",
      ragEvidence: "引用来源与图谱节点共同约束 AI 回答"
    },
    rationale: focus
      ? "AI 回答绑定课程资料和图谱节点，本轮行为回写画像，画像再反向影响复习路径。"
      : "当前没有稳定图谱焦点，建议先用知识点纠错或图谱定位确认节点后再更新画像。"
  };
}

function buildLearningPanel({ citations, topics, graphContext, profile, mode, strategy, answerDepth }) {
  const mastery = masteryItemsForTopics(profile, topics);
  const prerequisites = (graphContext?.prerequisiteNodes || []).map((node) => ({
    label: node.label,
    relation: node.relation || "前置依赖"
  }));
  const related = [
    ...(graphContext?.focusNode ? [{ label: graphContext.focusNode.label, relation: "当前焦点" }] : []),
    ...(graphContext?.relatedNodes || []).map((node) => ({ label: node.label, relation: node.relation || "相关知识点" })),
    ...topics.map((topic) => ({ label: topic, relation: "自动识别" }))
  ].filter((item, index, array) => item.label && array.findIndex((other) => other.label === item.label) === index).slice(0, 10);
  const misconceptions = (graphContext?.misconceptionNodes || []).map((node) => ({
    label: node.label,
    relation: node.relation || "易混淆"
  }));
  const weak = mastery.filter((item) => item.score === null || item.score < 0.58).slice(0, 4);
  const suggestions = [
    citations.length ? "本轮回答已优先依据课程资料，可在引用来源中追溯。" : "当前缺少明确资料引用，建议先上传教材、课件或讲义。",
    prerequisites.length ? `先复习前置知识：${prerequisites.slice(0, 3).map((item) => item.label).join("、")}。` : "如果理解困难，先补充定义、条件和典型例题。",
    weak.length ? `需要重点观察：${weak.map((item) => item.topic).join("、")}。` : "当前知识点暂无明显低掌握记录。"
  ];
  return {
    mode,
    strategy,
    answerDepth: answerDepthLabel(answerDepth),
    citations: citations.slice(0, 5),
    relatedKnowledgePoints: related,
    prerequisites,
    misconceptions,
    recommendedExercises: buildRecommendedExercises(mode, topics, graphContext),
    metacognitivePrompts: metacognitivePromptsForTopic(topics[0] || graphContext?.focusNode?.label || "当前知识点", mode),
    profileDrivenPath: buildGraphProfileRecommendations({ topics, graphContext, profile, mastery }),
    mastery,
    suggestions,
    graphFocus: graphContext?.focusNode ? {
      graphId: graphContext.graphId,
      graphTitle: graphContext.graphTitle,
      nodeId: graphContext.focusNode.id,
      label: graphContext.focusNode.label,
      path: graphContext.path || []
    } : null
  };
}

function mistakeKnowledgeBoost(hit) {
  const text = `${hit.title || ""} ${hit.sourceName || ""} ${hit.chapter || ""} ${hit.quote || ""}`;
  return /错因|误区|易混淆|评分|标准答案|题库|rubric|quiz|misconception|mistake/i.test(text) ? 1.2 : 0;
}

function ragHitKey(hit) {
  if (hit.materialId || hit.chunkId) return `material:${hit.materialId || ""}:${hit.chunkId || hit.page || hit.chapter || ""}`;
  if (hit.graphId || hit.nodeId) return `graph:${hit.graphId || ""}:${hit.nodeId || hit.chapter || ""}`;
  return `${hit.type || "hit"}:${hit.sourceName || hit.title || ""}:${hit.chapter || ""}:${String(hit.quote || "").slice(0, 80)}`;
}

function graphWorkflowHitsFromSelection(db, userId, options = {}) {
  const graphId = String(options.graphId || options.graph_id || "").trim();
  const nodeId = String(options.nodeId || options.node_id || "").trim();
  const knowledgePoint = String(options.knowledgePoint || options.knowledge_point || "").trim();
  if (!graphId && !nodeId && !knowledgePoint) return [];
  const subject = normalizeSubject(options.subject || "");
  const graph = visibleKnowledgeGraphs(db, userId)
    .filter((item) => !subject || subject === "通用" || item.subject === subject)
    .find((item) => (graphId ? item.id === graphId : true));
  if (!graph) return [];
  const node = (graph.nodes || []).find((item) => (nodeId ? item.id === nodeId : false))
    || (graph.nodes || []).find((item) => knowledgePoint && String(item.label || "") === knowledgePoint)
    || (graph.nodes || []).find((item) => knowledgePoint && graphNodeText(item).includes(knowledgePoint));
  if (!node) return [];
  const nodeMap = new Map((graph.nodes || []).map((item) => [String(item.id), item]));
  const relations = (graph.links || [])
    .filter((link) => linkEndpointId(link.source) === String(node.id) || linkEndpointId(link.target) === String(node.id))
    .slice(0, 12)
    .map((link) => {
      const sourceId = linkEndpointId(link.source);
      const targetId = linkEndpointId(link.target);
      const source = nodeMap.get(sourceId)?.label || sourceId;
      const target = nodeMap.get(targetId)?.label || targetId;
      return `${source} -> ${target}: ${link.label || link.type || "related"}`;
    });
  const neighbors = relations
    .flatMap((line) => line.split(/->|:/).map((part) => part.trim()))
    .filter(Boolean)
    .filter((label) => label !== String(node.label || ""))
    .slice(0, 12);
  const path = [graph.subject, node.ontology?.parent, node.ontology?.layer, node.label].filter(Boolean);
  const text = [
    `Graph: ${graph.title || ""}`,
    `Subject: ${graph.subject || ""}`,
    `Path: ${path.join(" / ")}`,
    `Focus: ${node.label || ""}`,
    node.details || node.summary || node.description || "",
    ...(node.knowledgePoints || []),
    node.misconception ? `Misconception: ${node.misconception}` : "",
    node.graphRag?.promptHint ? `GraphRAG: ${node.graphRag.promptHint}` : "",
    relations.length ? `Relations:\n${relations.join("\n")}` : "",
    neighbors.length ? `Neighbor nodes: ${Array.from(new Set(neighbors)).join(", ")}` : ""
  ].filter(Boolean).join("\n");
  return [{
    type: "graph",
    score: 999,
    scoreDetail: { explicitGraphSelection: true },
    graphId: graph.id,
    nodeId: node.id,
    title: graph.title,
    sourceName: graph.sourceName || graph.title,
    subject: graph.subject,
    chapter: path.join(" / ") || "GraphRAG",
    page: null,
    quote: text.replace(/\s+/g, " ").slice(0, 220),
    text,
    nodeLabel: node.label,
    ragChannel: "graph-focus"
  }];
}

function graphDatabaseHitsForWorkflow(db, userId, options = {}) {
  const subject = normalizeSubject(options.subject || "");
  const query = [
    options.question || options.query || options.prompt || "",
    options.knowledgePoint || options.knowledge_point || "",
    options.chapter || ""
  ].filter(Boolean).join("\n");
  const graphId = String(options.graphId || options.graph_id || "").trim();
  const nodeId = String(options.nodeId || options.node_id || "").trim();
  const knowledgePoint = String(options.knowledgePoint || options.knowledge_point || "").trim();
  const explicitHits = userId ? graphWorkflowHitsFromSelection(db, userId, { ...options, subject, graphId, nodeId, knowledgePoint }) : [];
  const queryTokens = tokenizeForSearch(query || knowledgePoint || subject);
  const queryTokenSet = new Set(queryTokens);
  const queryVector = embeddingFromTokens(queryTokens);
  const graphs = userId
    ? visibleKnowledgeGraphs(db, userId)
    : (db.knowledgeGraphs || []).filter((graph) => graph.global);
  const hits = [];
  graphs
    .filter((graph) => (!subject || subject === "通用" || graph.subject === subject || String(query).includes(graph.subject)))
    .filter((graph) => (graphId ? graph.id === graphId : true))
    .forEach((graph) => {
      const nodeMap = new Map((graph.nodes || []).map((node) => [String(node.id), node]));
      (graph.nodes || []).forEach((node) => {
        if (nodeId && node.id !== nodeId) return;
        const nodeText = graphNodeText(node);
        const tokens = tokenizeForSearch(nodeText);
        const overlap = tokens.filter((token) => queryTokenSet.has(token));
        const vectorScore = cosineSimilarity(queryVector, embeddingFromTokens(tokens));
        const exactBoost = knowledgePoint && String(node.label || "").includes(knowledgePoint) ? 6 : 0;
        const score = Number((overlap.length * 1.8 + Math.max(0, vectorScore) * 8 + exactBoost).toFixed(3));
        if (!nodeId && !knowledgePoint && score <= 0.5) return;
        const relations = (graph.links || [])
          .filter((link) => linkEndpointId(link.source) === String(node.id) || linkEndpointId(link.target) === String(node.id))
          .slice(0, 10)
          .map((link) => {
            const sourceId = linkEndpointId(link.source);
            const targetId = linkEndpointId(link.target);
            const source = nodeMap.get(sourceId)?.label || sourceId;
            const target = nodeMap.get(targetId)?.label || targetId;
            return `${source} -> ${target}: ${link.label || link.type || "related"}`;
          });
        const text = [
          `Graph: ${graph.title || ""}`,
          `Subject: ${graph.subject || ""}`,
          `Focus: ${node.label || ""}`,
          nodeText,
          relations.length ? `Relations:\n${relations.join("\n")}` : ""
        ].filter(Boolean).join("\n");
        hits.push({
          type: "graph",
          score: nodeId || exactBoost ? score + 100 : score,
          graphId: graph.id,
          nodeId: node.id,
          title: graph.title,
          sourceName: graph.sourceName || graph.title,
          subject: graph.subject,
          chapter: node.ontology?.parent || node.ontology?.layer || "知识图谱",
          quote: text.replace(/\s+/g, " ").slice(0, 220),
          text,
          nodeLabel: node.label,
          relations,
          ragChannel: nodeId || exactBoost ? "graph-db-focus" : "graph-db"
        });
      });
    });
  return mergeWorkflowRagHits(explicitHits.concat(hits), [], Number(options.limit || 8));
}

function mergeWorkflowRagHits(courseHits = [], mistakeHits = [], limit = RAG_MAX_CONTEXT_CHUNKS) {
  const byKey = new Map();
  const addHit = (hit, channel, boost = 0) => {
    if (!hit) return;
    const key = ragHitKey(hit);
    const candidate = {
      ...hit,
      ragChannel: hit.ragChannel || channel,
      workflowBoost: Number(boost.toFixed(3)),
      score: Number((Number(hit.score || 0) + boost).toFixed(3))
    };
    const existing = byKey.get(key);
    if (!existing || candidate.score > existing.score) {
      byKey.set(key, candidate);
    } else if (existing.ragChannel && existing.ragChannel !== channel) {
      existing.ragChannel = "multi";
    }
  };
  courseHits.forEach((hit) => addHit(hit, "course", 0));
  mistakeHits.forEach((hit) => addHit(hit, "mistake", mistakeKnowledgeBoost(hit)));
  return Array.from(byKey.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function buildMlDiagnosisQueries({ prompt, chapter = "", knowledgePoint = "", mode = "qa" }) {
  const cleanPrompt = String(prompt || "").trim();
  const target = [chapter, knowledgePoint].filter(Boolean).join(" ");
  const courseQuery = [cleanPrompt, target].filter(Boolean).join("\n");
  const mistakeQuery = [
    "常见误区 易混淆 评分标准 错因标签 标准答案 题库",
    mode === "grade" ? "学生答案 批改 诊断 缺漏点" : "知识问答 追问 练习 掌握度",
    cleanPrompt,
    target
  ].filter(Boolean).join("\n");
  return { courseQuery, mistakeQuery };
}

async function searchMlDiagnosisWorkflowKnowledge(db, userId, options = {}) {
  const limit = options.limit || RAG_MAX_CONTEXT_CHUNKS;
  const { courseQuery, mistakeQuery } = buildMlDiagnosisQueries(options);
  const searchLimit = Math.max(limit, 8);
  const selectedGraphHits = graphWorkflowHitsFromSelection(db, userId, options);
  const courseHits = selectedGraphHits.concat((await searchCourseKnowledge(db, userId, courseQuery, {
    subject: options.subject,
    limit: searchLimit
  })).map((hit) => ({ ...hit, ragChannel: "course" })));
  const mistakeHits = (await searchCourseKnowledge(db, userId, mistakeQuery, {
    subject: options.subject,
    limit: searchLimit
  })).map((hit) => ({ ...hit, ragChannel: "mistake" }));
  return {
    courseQuery,
    mistakeQuery,
    selectedGraphHits,
    courseHits,
    mistakeHits,
    hits: mergeWorkflowRagHits(courseHits, mistakeHits, limit)
  };
}

function buildMlDiagnosisWorkflowTrace({ retrieval = {}, citations = [], mode = "qa", topics = [], hasStudentAnswer = false }) {
  const hits = Array.isArray(retrieval.hits) ? retrieval.hits : [];
  const materialHits = hits.filter((hit) => hit.type === "material");
  const graphHits = hits.filter((hit) => hit.type === "graph");
  const publicMaterialHits = materialHits.filter((hit) => hit.global);
  const topicText = topics.length ? topics.slice(0, 3).join("、") : "待定位";
  const modeText = hasStudentAnswer || mode === "grade" ? "学习诊断模式" : "知识问答模式";
  const courseCount = retrieval.courseHits?.length || 0;
  const mistakeCount = retrieval.mistakeHits?.length || 0;
  return {
    ...ML_DIAGNOSIS_WORKFLOW_INFO,
    mode: modeText,
    retrievedCount: hits.length,
    citationCount: citations.length,
    steps: [
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[0]}：接收问题、上下文、学习目标和可选学生答案`,
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[1]}：识别为${modeText}，抽取候选关键词`,
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[2]}：检索教师端课程资料，命中 ${courseCount} 条候选`,
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[3]}：检索错因/题库/评分标准，命中 ${mistakeCount} 条候选`,
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[4]}：合并去重后保留 ${hits.length} 条证据，其中教师公开资料 ${publicMaterialHits.length} 条、图谱节点 ${graphHits.length} 条`,
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[5]}：定位知识点 ${topicText}`,
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[6]}：根据本轮证据更新学习画像和掌握度`,
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[7]}：生成标准解释、练习、批改或学习路径`,
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[8]}：${hasStudentAnswer || mode === "grade" ? "进入诊断反馈分支" : "进入知识问答分支"}`,
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[9]}：${hasStudentAnswer || mode === "grade" ? "输出错因、缺漏点和改进建议" : "问答模式下保留追问建议"}`,
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[10]}：返回答案、引用、知识点、掌握度和后续问题`,
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[11]}：同步会话、错题本和学习画像到项目数据库`,
      `${ML_DIAGNOSIS_WORKFLOW_STEP_TITLES[12]}：完成本轮 AI 助教响应`
    ]
  };
}

const ML_DIAGNOSIS_FORMULA_TERMS = ["目标", "损失", "函数", "最小化", "最大化", "MSE", "SSE", "交叉熵", "似然", "间隔", "方差", "概率"];
const ML_DIAGNOSIS_PROCESS_TERMS = ["步骤", "流程", "初始化", "训练", "预测", "更新", "迭代", "分配", "反向传播", "梯度下降", "投票", "平均", "近邻"];
const ML_DIAGNOSIS_SCENARIO_TERMS = ["适合", "场景", "优点", "缺点", "局限", "用于", "当", "如果", "不适合"];
const ML_DIAGNOSIS_METRIC_TERMS = ["准确率", "精确率", "召回率", "F1", "AUC", "MSE", "RMSE", "MAE", "轮廓系数", "SSE"];
const ML_DIAGNOSIS_PREPROCESS_TERMS = ["标准化", "归一化", "缺失值", "类别不平衡", "数据泄漏", "尺度", "量纲"];

function compactWorkflowText(value, limit = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function textContainsKeyword(text, keyword) {
  const source = String(text || "").toLowerCase();
  const sourceCompact = source.replace(/\s+/g, "");
  const target = String(keyword || "").toLowerCase();
  const targetCompact = target.replace(/\s+/g, "");
  if (!targetCompact) return false;
  return source.includes(target) || sourceCompact.includes(targetCompact);
}

function keywordHitCount(text, keyword) {
  const source = String(text || "").toLowerCase();
  const target = String(keyword || "").toLowerCase();
  if (!target) return 0;
  let count = 0;
  let index = source.indexOf(target);
  while (index >= 0) {
    count += 1;
    index = source.indexOf(target, index + target.length);
  }
  if (!count && textContainsKeyword(source, target)) return 1;
  return count;
}

function mlDiagnosisSoftmax(scores) {
  const values = Object.values(scores);
  const top = Math.max(...values);
  const expScores = Object.fromEntries(Object.entries(scores).map(([topic, score]) => [topic, Math.exp(score - top)]));
  const total = Object.values(expScores).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(Object.entries(expScores).map(([topic, value]) => [topic, value / total]));
}

function classifyMlDiagnosisTopic({ question = "", studentAnswer = "", evidenceSummary = "", knowledgePoint = "" }) {
  const queryText = [question, knowledgePoint].filter(Boolean).join("\n");
  const answerText = String(studentAnswer || "");
  const evidenceText = String(evidenceSummary || "").slice(0, 1800);
  const scores = {};
  const primaryScores = {};
  const evidenceScores = {};
  Object.entries(ML_DIAGNOSIS_TOPIC_KEYWORDS).forEach(([topic, keywords]) => {
    let primaryScore = 0;
    let evidenceScore = 0;
    keywords.forEach((keyword) => {
      primaryScore += keywordHitCount(queryText, keyword) * 6;
      primaryScore += keywordHitCount(answerText, keyword) * 4;
      evidenceScore += Math.min(keywordHitCount(evidenceText, keyword), 3) * 0.25;
    });
    if (textContainsKeyword(queryText, topic)) primaryScore += 18;
    if (textContainsKeyword(answerText, topic)) primaryScore += 10;
    if (textContainsKeyword(evidenceText, topic)) evidenceScore += 0.5;
    primaryScores[topic] = primaryScore;
    evidenceScores[topic] = evidenceScore;
  });
  if (knowledgePoint && Object.prototype.hasOwnProperty.call(primaryScores, knowledgePoint)) {
    primaryScores[knowledgePoint] += 7;
  } else if (knowledgePoint) {
    primaryScores[knowledgePoint] = 7;
    evidenceScores[knowledgePoint] = 0;
  }
  const maxPrimaryScore = Math.max(...Object.values(primaryScores));
  Object.keys(primaryScores).forEach((topic) => {
    scores[topic] = maxPrimaryScore > 0
      ? primaryScores[topic] + Math.min(evidenceScores[topic] || 0, 1)
      : evidenceScores[topic] || 0;
  });
  const bestScore = Math.max(...Object.values(scores));
  if (!Number.isFinite(bestScore) || bestScore <= 0) {
    return {
      topic_label: knowledgePoint || "机器学习基础",
      topic_probability: 0.35,
      top_topic_candidates: [
        { topic: knowledgePoint || "机器学习基础", probability: 0.35 }
      ]
    };
  }
  const probabilities = mlDiagnosisSoftmax(scores);
  const ranked = Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([topic, probability]) => ({ topic, probability: Number(probability.toFixed(4)) }));
  return {
    topic_label: ranked[0]?.topic || knowledgePoint || "机器学习基础",
    topic_probability: ranked[0]?.probability || 0.35,
    top_topic_candidates: ranked
  };
}

function mlDiagnosisHasAny(text, terms) {
  return terms.some((term) => textContainsKeyword(text, term));
}

function mlDiagnosisCoverage(answer, topic) {
  const keywords = ML_DIAGNOSIS_TOPIC_KEYWORDS[topic] || [];
  const matched = keywords.filter((keyword) => textContainsKeyword(answer, keyword));
  return { matched, coverage: matched.length / Math.max(keywords.length, 1) };
}

function mlDiagnosisMasteryLevel(score) {
  if (score <= 0) return "未诊断";
  if (score < 45) return "薄弱";
  if (score < 65) return "基本理解";
  if (score < 85) return "较好掌握";
  return "熟练掌握";
}

function assessMlDiagnosisMastery({ question = "", studentAnswer = "", topicLabel = "机器学习基础", targetLevel = "考试复习" }) {
  const answer = String(studentAnswer || "").trim();
  if (!answer) {
    return {
      mastery_score: 0,
      mastery_level: "未诊断",
      error_tags: [],
      missing_points: ["未提供学生自我理解，当前仅生成标准解释。"],
      positive_points: [],
      project_sync_suggestion: "未提供 student_answer，建议不写入错题本，仅保存问答记录。"
    };
  }
  const { matched, coverage } = mlDiagnosisCoverage(answer, topicLabel);
  const dimensions = {
    "公式/目标函数": mlDiagnosisHasAny(answer, ML_DIAGNOSIS_FORMULA_TERMS),
    "算法流程": mlDiagnosisHasAny(answer, ML_DIAGNOSIS_PROCESS_TERMS),
    "适用场景": mlDiagnosisHasAny(answer, ML_DIAGNOSIS_SCENARIO_TERMS),
    "评价指标": mlDiagnosisHasAny(answer, ML_DIAGNOSIS_METRIC_TERMS)
  };
  if (["KNN", "KMeans聚类", "PCA降维", "支持向量机"].includes(topicLabel)) {
    dimensions["数据预处理"] = mlDiagnosisHasAny(answer, ML_DIAGNOSIS_PREPROCESS_TERMS);
  }

  let score = 28 + Math.min(answer.length / 10, 22) + coverage * 26;
  score += Object.values(dimensions).filter(Boolean).length * 6;

  const errors = [];
  const combined = `${question}\n${answer}`;
  if (topicLabel === "KMeans聚类" && textContainsKeyword(answer, "分类") && !textContainsKeyword(answer, "无监督")) {
    errors.push("概念混淆", "任务类型错误");
  }
  if (topicLabel === "KNN" && textContainsKeyword(answer, "聚类") && !textContainsKeyword(answer, "监督")) errors.push("概念混淆");
  if (topicLabel === "逻辑回归" && textContainsKeyword(answer, "连续") && !textContainsKeyword(answer, "分类")) errors.push("任务类型错误");
  if (topicLabel === "PCA降维" && textContainsKeyword(answer, "标签") && !textContainsKeyword(answer, "无监督")) errors.push("任务类型错误");
  if (topicLabel !== "KNN" && !dimensions["公式/目标函数"]) errors.push("公式目标缺失");
  if (!dimensions["算法流程"] && ["考试复习", "代码实践", "原理推导"].includes(targetLevel)) errors.push("算法流程缺失");
  if (!dimensions["评价指标"] && ["考试复习", "代码实践"].includes(targetLevel)) errors.push("评价指标误用");
  if (textContainsKeyword(combined, "测试集") && textContainsKeyword(combined, "调参")) errors.push("数据泄漏");
  if (["KNN", "KMeans聚类", "PCA降维", "支持向量机"].includes(topicLabel) && !dimensions["数据预处理"]) errors.push("数据预处理缺失");

  const error_tags = Array.from(new Set(errors));
  const evidenceLines = answer
    .split(/\r?\n|[。；;！？!?]/)
    .map((line) => line.trim())
    .filter(Boolean);
  const error_evidence = evidenceLines.find((line) => error_tags.some((tag) => {
    if (/概念|任务类型/.test(tag)) return /分类|聚类|监督|无监督|连续/.test(line);
    if (/公式|目标/.test(tag)) return /损失|梯度|函数|正则|交叉熵/.test(line);
    if (/流程|步骤/.test(tag)) return /训练|预测|更新|迭代|测试/.test(line);
    if (/数据|指标/.test(tag)) return /测试集|训练集|调参|准确率|召回率|F1/.test(line);
    return false;
  })) || evidenceLines[0] || "学生未提供可定位的具体句子或代码行。";
  score -= error_tags.length * 6;
  const mastery_score = Math.max(0, Math.min(100, Math.round(score)));
  const missing_points = Object.entries(dimensions)
    .filter(([, ok]) => !ok)
    .map(([name]) => `缺少${name}说明`);
  if (coverage < 0.35) missing_points.push("关键词覆盖不足");
  if (!missing_points.length) missing_points.push("可继续补充公式推导或代码实现细节");

  const positive_points = [];
  if (matched.length) positive_points.push(`已覆盖关键词：${matched.slice(0, 8).join("、")}`);
  Object.entries(dimensions).forEach(([name, ok]) => {
    if (ok) positive_points.push(`已提到${name}`);
  });

  let project_sync_suggestion = "建议写入 conversations，并根据错因标签生成 wrongNotes。";
  if (mastery_score >= 85) project_sync_suggestion = "建议更新 learningProfiles 为较高掌握度，可不加入错题本。";
  else if (error_tags.length) project_sync_suggestion = "建议写入 wrongNotes，并在学习画像中降低对应知识点掌握度。";

  return {
    mastery_score,
    mastery_level: mlDiagnosisMasteryLevel(mastery_score),
    error_tags,
    error_evidence,
    missing_points,
    positive_points,
    project_sync_suggestion
  };
}

function mlDiagnosisNextQuestions(topic, missingPoints = []) {
  const label = topic || "该知识点";
  const questions = [
    `请用一句话说明${label}的任务类型和输入输出。`,
    `${label}的核心目标函数或预测流程是什么？`
  ];
  if (missingPoints.some((item) => textContainsKeyword(item, "评价指标"))) {
    questions.push(`评价${label}时应选择哪些指标，为什么？`);
  } else {
    questions.push(`${label}在什么场景下不适合使用？`);
  }
  return questions.slice(0, 3);
}

function mlDiagnosisEvidenceItems(hits = [], citations = []) {
  return hits.slice(0, 6).map((hit, index) => {
    const citation = citations[index] || {};
    return {
      id: citation.id || `S${index + 1}`,
      type: hit.type || citation.type || "material",
      title: hit.title || citation.title || citation.sourceName || "课程资料",
      sourceName: hit.sourceName || citation.sourceName || "",
      chapter: hit.chapter || citation.chapter || "",
      page: hit.page || citation.page || "",
      quote: compactWorkflowText(hit.quote || hit.text || citation.quote || "", 260),
      score: hit.score,
      global: Boolean(hit.global || citation.global),
      ragChannel: hit.ragChannel || citation.ragChannel || ""
    };
  });
}

function buildMlDiagnosisStandardAnswer({ prompt = "", topicLabel = "", hits = [], citations = [], hasEvidence = false }) {
  const sourceRefs = citations.length ? citations.slice(0, 3).map((citation) => `[${citation.id}]`).join("、") : "";
  const evidencePrefix = hasEvidence
    ? `以下解释优先依据课程知识库证据 ${sourceRefs}。`
    : "知识库依据不足，以下为课程通用解释。";
  if (topicLabel === "KNN") {
    return [
      `1. 核心结论：KNN（K 近邻）是一种基于实例的监督学习方法，可用于分类和回归。它不显式训练参数模型，而是把训练样本保存下来，在预测时根据“相似样本给出相似结果”的思想做判断。${evidencePrefix}`,
      "2. 原理或流程：对一个待预测样本，先计算它与训练集中样本的距离；再选出距离最近的 K 个邻居；分类任务通常用多数投票得到类别，回归任务通常对邻居标签取平均或加权平均。",
      "3. 公式/目标函数或关键机制：核心机制包括距离度量、K 值选择、邻居投票/平均以及特征尺度处理。常用欧氏距离、曼哈顿距离等；不同特征量纲差异较大时，需要标准化或归一化，否则距离会被大尺度特征主导。",
      "4. 评价指标与适用场景：分类可看准确率、精确率、召回率、F1 等；回归可看 MSE、MAE 等。KNN 适合样本规模不大、局部相似性明显、决策边界较复杂的问题，但预测阶段计算开销较大，对噪声、无关特征和特征尺度较敏感。",
      "5. 一句易错提醒：KNN 不是 KMeans 聚类；K 不是越小越好，也不是越大越好，需要结合验证集、距离度量和数据预处理一起选择。"
    ].join("\n");
  }
  const evidenceLines = mlDiagnosisEvidenceItems(hits, citations)
    .slice(0, 3)
    .map((item) => `${item.id}：${item.quote}`)
    .filter((line) => line.replace(/^[^：]+：/, "").trim());
  const evidenceText = evidenceLines.length ? `可参考证据：${evidenceLines.join("；")}` : `问题原文：${compactWorkflowText(prompt, 120)}`;
  return [
    `1. 核心结论：本题定位到「${topicLabel || "机器学习基础"}」。${evidencePrefix}`,
    `2. 原理或流程：先明确该知识点的输入、处理步骤和输出，再把定义、关键条件和例题对应起来。${evidenceText}`,
    "3. 公式/目标函数或关键机制：复习时应写清楚核心机制、优化目标或预测流程，避免只背名称。",
    "4. 评价指标与适用场景：结合任务类型选择指标；分类关注准确率、精确率、召回率、F1，回归关注 MSE、MAE，聚类关注轮廓系数、SSE 等。",
    "5. 一句易错提醒：不要把相邻算法的任务类型、训练目标、预测流程和评价指标混用。"
  ].join("\n");
}

function buildMlDiagnosisFeedback({ diagnosisMode = "知识问答模式", studentAnswer = "", topicLabel = "", mastery = {} }) {
  if (!String(studentAnswer || "").trim() && diagnosisMode === "知识问答模式") {
    return "未提供学生自我理解，当前为知识问答模式，暂不进行掌握度扣分诊断。";
  }
  const positives = mastery.positive_points?.length ? `已掌握：${mastery.positive_points.join("；")}。` : "";
  const missing = mastery.missing_points?.length ? `需要补齐：${mastery.missing_points.join("；")}。` : "";
  const errors = mastery.error_tags?.length ? `错因标签：${mastery.error_tags.join("、")}。` : "";
  return [
    `本轮对「${topicLabel || "该知识点"}」的诊断结果为${mastery.mastery_level || "未诊断"}，得分 ${mastery.mastery_score ?? 0}。`,
    positives,
    errors,
    missing,
    "建议按“任务类型 -> 预测流程/目标函数 -> 评价指标 -> 适用场景与局限”的顺序重写一次答案。"
  ].filter(Boolean).join("\n");
}

function buildMlDiagnosisFinalAnswer({ topic, mastery, standardAnswer, diagnosisFeedback, ragEvidence = [] }) {
  const nextQuestions = mlDiagnosisNextQuestions(topic.topic_label, mastery.missing_points);
  const structuredResult = {
    workflow_type: "misconception_classification",
    knowledge_point: topic.topic_label,
    graph_node_id: graphNodeIdForWorkflow(topic.topic_label),
    is_correct: Number(mastery.mastery_score || 0) >= 75,
    misconception_tags: mastery.error_tags || [],
    misconception_level: Number(mastery.mastery_score || 0) < 45 ? "high" : Number(mastery.mastery_score || 0) < 70 ? "medium" : "low",
    evidence: (mastery.error_evidence || [])[0] || diagnosisFeedback || "",
    recommended_actions: mlDiagnosisNextQuestions(topic.topic_label, mastery.missing_points).slice(0, 3),
    need_reassessment: Number(mastery.mastery_score || 0) < 75,
    topic_label: topic.topic_label,
    topic_probability: topic.topic_probability,
    top_topic_candidates: topic.top_topic_candidates,
    mastery_score: mastery.mastery_score,
    mastery_level: mastery.mastery_level,
    error_tags: mastery.error_tags,
    error_evidence: mastery.error_evidence,
    missing_points: mastery.missing_points,
    rag_evidence: ragEvidence,
    standard_answer: standardAnswer,
    diagnosis_feedback: diagnosisFeedback,
    next_questions: nextQuestions,
    project_sync_suggestion: mastery.project_sync_suggestion
  };
  const finalAnswer = [
    `## 知识点定位\n${topic.topic_label}（置信度 ${topic.topic_probability}）`,
    `## 掌握度\n${mastery.mastery_level}，得分 ${mastery.mastery_score}`,
    `## 标准解释\n${standardAnswer}`,
    `## 诊断反馈\n${diagnosisFeedback}`,
    `## 追问题\n${nextQuestions.map((question, index) => `${index + 1}. ${question}`).join("\n")}`
  ].join("\n\n");
  return { finalAnswer, structuredResult };
}

function buildMlDiagnosisWorkflowAnswer({ user, mode, prompt, hits = [], citations = [], chapter = "", knowledgePoint = "", studentAnswer = "" }) {
  const hasEvidence = hits.length > 0 && hits[0].score > 0;
  const evidenceSummary = [chapter, knowledgePoint, ...hits.slice(0, 6).map((hit) => hit.text || hit.quote || "")].join("\n");
  const hasStudentAnswer = Boolean(String(studentAnswer || "").trim());
  const diagnosisMode = hasStudentAnswer ? "学习诊断模式" : "知识问答模式";
  const topic = classifyMlDiagnosisTopic({
    question: prompt,
    studentAnswer,
    evidenceSummary,
    knowledgePoint
  });
  const mastery = assessMlDiagnosisMastery({
    question: prompt,
    studentAnswer,
    topicLabel: topic.topic_label,
    targetLevel: "考试复习"
  });
  const ragEvidence = mlDiagnosisEvidenceItems(hits, citations);
  const standardAnswer = buildMlDiagnosisStandardAnswer({
    prompt,
    topicLabel: topic.topic_label,
    hits,
    citations,
    hasEvidence
  });
  const diagnosisFeedback = buildMlDiagnosisFeedback({
    diagnosisMode,
    studentAnswer,
    topicLabel: topic.topic_label,
    mastery
  });
  const { finalAnswer, structuredResult } = buildMlDiagnosisFinalAnswer({
    topic,
    mastery,
    standardAnswer,
    diagnosisFeedback,
    ragEvidence
  });
  const relatedTopics = Array.from(new Set([
    topic.topic_label,
    ...topic.top_topic_candidates.map((item) => item.topic),
    knowledgePoint
  ].filter(Boolean))).slice(0, 8);
  return {
    content: finalAnswer,
    confidence: hasEvidence ? "high" : "low",
    topics: relatedTopics,
    workflowResult: {
      ...structuredResult,
      diagnosis_mode: diagnosisMode,
      final_answer: finalAnswer,
      workflow: ML_DIAGNOSIS_WORKFLOW_INFO,
      student_id: user?.id || "",
      question: prompt,
      student_answer: studentAnswer
    }
  };
}

function normalizeMisconceptionClassification(result = {}, context = {}) {
  const score = Number(result.mastery_score ?? result.masteryScore ?? context.masteryScore ?? 0);
  const tags = Array.isArray(result.misconception_tags) ? result.misconception_tags : Array.isArray(result.error_tags) ? result.error_tags : [];
  const topic = String(result.knowledge_point || result.topic_label || context.knowledgePoint || "机器学习知识点");
  return { workflow_type: "misconception_classification", knowledge_point: topic, graph_node_id: String(result.graph_node_id || context.nodeId || graphNodeIdForWorkflow(topic)), is_correct: result.is_correct !== undefined ? Boolean(result.is_correct) : score >= 75, misconception_tags: tags.map(String).slice(0, 12), misconception_level: String(result.misconception_level || (score < 45 ? "high" : score < 70 ? "medium" : "low")), evidence: String(result.evidence || result.error_evidence?.[0] || result.diagnosis_feedback || "").slice(0, 1200), mastery_score: Math.max(0, Math.min(100, Number.isFinite(score) ? Math.round(score) : 0)), recommended_actions: (Array.isArray(result.recommended_actions) ? result.recommended_actions : Array.isArray(result.next_questions) ? result.next_questions : []).map(String).slice(0, 5), need_reassessment: result.need_reassessment !== undefined ? Boolean(result.need_reassessment) : score < 75 };
}

function answerFromEvidence({ user, mode, prompt, hits, citations, profile, teaching, answerDepth, chapter, knowledgePoint, studentAnswer = "" }) {
  if (user.role === "student") {
    return buildMlDiagnosisWorkflowAnswer({ user, mode, prompt, hits, citations, chapter, knowledgePoint, studentAnswer });
  }
  const hasEvidence = hits.length > 0 && hits[0].score > 0;
  const topics = Array.from(new Set([
    knowledgePoint,
    ...inferQuestionTopics([prompt, chapter, knowledgePoint, ...hits.map((hit) => hit.text)].join("\n"), hits[0]?.subject || user.subject || "")
  ].filter(Boolean))).slice(0, 8);
  const mastery = profileMasterySummary(profile);
  const levelHint = profile.level === "基础" || mastery.average < 0.58
    ? "我会先用通俗语言解释，再补充正式定义。"
    : "你已有一定基础，我会同时给出原理、边界条件和迁移应用。";
  const effectiveMode = mode || teaching?.mode || "qa";
  const depthHint = `回答深度：${answerDepthLabel(answerDepth)}。`;
  if (!hasEvidence) {
    if (effectiveMode === "guided") {
      return {
        content: [
          "课程资料中没有检索到足够明确的依据，下面内容仅作为引导性学习建议。",
          "",
          `【引导追问：${prompt}】`,
          "1. 你认为这个问题最核心的概念是什么？请先用一句话说出你的理解。",
          "2. 这个概念成立需要哪些前提条件？如果条件变化，结论是否还成立？",
          "3. 你能举一个教材、课堂或生活中的例子来验证它吗？",
          "4. 如果你卡住了，请补充题干、你的第一步思路或你不确定的地方，我会继续给分步提示。",
          "",
          "【可靠性说明】当前没有课程资料引用，建议上传教材/讲义后再进行可追溯回答。"
        ].join("\n"),
        confidence: "low",
        topics
      };
    }
    if (effectiveMode === "practice") {
      const topic = topics[0] || prompt;
      return {
        content: [
          "课程资料中没有检索到足够明确的依据，下面练习为模型根据题意生成，建议教师复核。",
          "",
          `【围绕「${topic}」的练习】`,
          `1. 基础题：请解释「${topic}」的定义、适用条件和一个典型例子。`,
          "参考要点：定义准确；能说明条件；例子与概念对应。",
          "",
          `2. 提高题：比较「${topic}」与一个相邻概念的区别，并说明容易混淆的地方。`,
          "参考要点：边界清楚；能指出误区；能用反例说明。",
          "",
          `3. 综合题：设计一个需要应用「${topic}」解决的小题，并写出评分标准。`,
          "参考要点：题干完整；步骤可检查；评分点覆盖概念、过程和结论。",
          "",
          "【可靠性说明】当前没有课程资料引用，上传资料后可按章节和页码生成更准确练习。"
        ].join("\n"),
        confidence: "low",
        topics
      };
    }
    if (effectiveMode === "grade") {
      const topic = topics[0] || prompt;
      return {
        content: [
          "课程资料中没有检索到足够明确的参考答案，因此以下批改只能作为学习反馈，不能直接作为最终评分。",
          "",
          `【批改反馈：${topic}】`,
          "1. 总体评价：请先确认你的答案是否写出了定义、条件、步骤和结论。",
          "2. 可能正确点：如果你已经写出核心概念和应用场景，这部分可以保留。",
          "3. 需要检查点：是否缺少关键条件、前置知识、推导依据或例题对应关系。",
          "4. 修改建议：把答案改成“结论 + 依据 + 步骤 + 易错点”的结构。",
          "5. 建议复习：上传标准答案或对应章节后，我可以按课程资料逐项评分。",
          "",
          "【可靠性说明】当前没有课程资料引用，建议补充标准答案或课程资料。"
        ].join("\n"),
        confidence: "low",
        topics
      };
    }
    if (effectiveMode === "plan" && teaching?.intent === "teacher-design") {
      const topic = topics[0] || prompt;
      return {
        content: [
          "课程资料中没有检索到足够明确的依据，下面教学设计为通用框架，建议上传对应章节后再细化。",
          "",
          `【45 分钟教学设计：${topic}】`,
          `教学目标：学生能够解释「${topic}」的定义、条件、应用场景和常见误区。`,
          "重难点：概念边界、前置知识、典型题型和迁移应用。",
          "教学流程：",
          "1. 5 分钟：前测提问，诊断学生已有认知。",
          "2. 10 分钟：概念讲解，建立定义、条件和例子。",
          "3. 12 分钟：例题拆解，强调每一步依据。",
          "4. 10 分钟：分层练习，基础题到迁移题逐步推进。",
          "5. 6 分钟：错因归纳，比较易混淆概念。",
          "6. 2 分钟：布置课后复习任务。",
          "课堂提问：这个概念的前置知识是什么？哪些条件变化会导致结论失效？",
          "课后作业：1 道基础题、1 道综合题、1 条错因反思。",
          "",
          "【可靠性说明】当前没有课程资料引用，教师应结合教材章节复核。"
        ].join("\n"),
        confidence: "low",
        topics
      };
    }
    if (effectiveMode === "plan") {
      const weak = mastery.weak.map((item) => item.topic).concat(profile.weakPoints || []).filter(Boolean);
      return {
        content: [
          "课程资料中没有检索到足够明确的依据，下面路径为通用复习建议。",
          "",
          "【复习路径】",
          `当前画像：${profile.level || "基础"}；已记录薄弱点：${weak.slice(0, 5).join("、") || "暂未形成明确薄弱点"}。`,
          `1. 第 1 步：先整理「${topics[0] || prompt}」的定义、条件和例题。`,
          "2. 第 2 步：列出前置知识，找出最不熟的一项先补。",
          "3. 第 3 步：完成 3 道基础题，要求写出每一步依据。",
          "4. 第 4 步：完成 1 道迁移题，并记录错因。",
          "5. 第 5 步：24 小时后再做同类题，更新掌握度。",
          "",
          "【可靠性说明】当前没有课程资料引用，上传课程资料后可生成带章节依据的路径。"
        ].join("\n"),
        confidence: "low",
        topics
      };
    }
    if (effectiveMode === "explain") {
      const topic = topics[0] || prompt;
      return {
        content: [
          "课程资料中没有检索到足够明确的依据，下面讲解只作为模型推理，不能当作教材结论。",
          "",
          `【概念讲解：${topic}】`,
          "1. 简明定义：请先补充教材或课件后，我可以给出基于资料的准确定义。",
          "2. 通俗解释：先把概念放到具体场景中理解，再回到正式定义。",
          "3. 例子：用一个小例子验证这个概念的适用条件。",
          "4. 常见误区：不要只记结论，要说明边界条件和前置知识。",
          "5. 推荐练习：写出一个例子，再说明它为什么符合这个概念。",
          "",
          "【可靠性说明】当前没有课程资料引用，建议上传对应章节。"
        ].join("\n"),
        confidence: "low",
        topics
      };
    }
    return {
      content: [
        "课程资料中没有检索到足够明确的依据，因此我不能把下面内容当作资料结论。",
        "",
        `【不确定说明】当前问题是：「${prompt}」。建议先上传教材、课件或讲义，或指定章节/页码后再问。`,
        "【可作为模型推理的学习建议】先明确相关概念的定义、适用条件、典型例题和易混淆点；如果是题目，请补充题干、已知量和你的解题步骤。"
      ].join("\n"),
      confidence: "low",
      topics
    };
  }

  const evidenceLines = citationEvidenceLines(hits);
  if (effectiveMode === "guided") {
    return {
      content: [
        `${levelHint}`,
        depthHint,
        "【苏格拉底式引导】我先不直接给最终答案，先按三步帮你判断：",
        `1. 先看资料依据：${evidenceLines[0] || "当前片段不足"}`,
        `2. 你先回答：这里最关键的概念或条件是什么？`,
        `3. 如果是题目，请你先写出第一步公式/定义/判断依据，我再根据你的回答继续提示。`,
        "",
        "【可能误区】不要只背结论，要说明前提条件、适用范围和与相邻知识点的区别。",
        "",
        `【引用来源】\n${formatCitations(citations)}`
      ].join("\n"),
      confidence: "medium",
      topics
    };
  }
  if (effectiveMode === "practice") {
    const topic = topics[0] || prompt;
    return {
      content: [
        `根据课程资料为「${topic}」生成自适应练习：`,
        "",
        `1. 基础选择题：${topic} 的核心定义或作用是什么？`,
        "A. 只记名称即可  B. 说明定义、条件和作用  C. 与相邻概念无关  D. 不需要例题",
        "答案：B。解析：资料要求同时把定义、条件、作用和相邻关系说清楚。",
        "",
        `2. 提高题：结合资料 [S1]，说明「${topic}」在本章知识结构中的作用。`,
        "答案要点：写出概念定位、前置知识、适用场景和常见误区。",
        "",
        `3. 综合题：设计一个能考查「${topic}」的课堂问题，并说明评分标准。`,
        "参考：看学生是否能引用资料依据、解释过程，并识别易混淆点。",
        "",
        `【引用来源】\n${formatCitations(citations)}`
      ].join("\n"),
      confidence: "high",
      topics
    };
  }
  if (effectiveMode === "grade") {
    const topic = topics[0] || prompt;
    return {
      content: [
        `【批改反馈：${topic}】`,
        "1. 总体评价：你的答案需要和课程资料中的定义、条件、步骤逐项对应。",
        `2. 资料依据：${evidenceLines[0] || "当前片段不足"}。`,
        "3. 正确的地方：如果答案已经覆盖核心定义和适用场景，可以作为保留部分。",
        "4. 需要补充的地方：检查是否遗漏前置条件、推导过程、关键术语或结论边界。",
        "5. 修改建议：按“概念定位 -> 关键条件 -> 分步依据 -> 最终结论 -> 易错提醒”重写。",
        "6. 建议复习知识点：先复盘相关定义，再做 1 道同类题检验。",
        "",
        `【引用来源】\n${formatCitations(citations)}`
      ].join("\n"),
      confidence: "high",
      topics
    };
  }
  if (effectiveMode === "plan" && teaching?.intent === "teacher-design") {
    const topic = topics[0] || prompt;
    return {
      content: [
        `【45 分钟教学设计：${topic}】`,
        `教学目标：学生能依据课程资料解释「${topic}」的概念、条件和应用。`,
        "重难点：概念边界、典型题型、易混淆点和迁移应用。",
        "教学流程：5 分钟前测；12 分钟概念讲解；12 分钟例题拆解；10 分钟分层练习；4 分钟错因归纳；2 分钟布置复习任务。",
        "课堂提问：这个概念的前置知识是什么？如果条件变化，结论是否仍成立？",
        "课后作业：1 道基础题、1 道迁移题、1 个错因反思。",
        "",
        `【引用来源】\n${formatCitations(citations)}`
      ].join("\n"),
      confidence: "high",
      topics
    };
  }
  if (effectiveMode === "plan") {
    const weak = mastery.weak.map((item) => item.topic).concat(profile.weakPoints || []).filter(Boolean);
    return {
      content: [
        "【个性化学习路径】",
        `当前画像：${profile.level || "基础"}；薄弱点：${weak.slice(0, 5).join("、") || "暂未形成明确薄弱点"}。`,
        "1. 先复习资料中最直接相关的定义和例题。",
        `2. 按顺序学习：${topics.slice(0, 5).join(" → ") || "概念 → 例题 → 练习 → 错题复盘"}。`,
        "3. 每个知识点完成 2 道基础题和 1 道迁移题。",
        "4. 做错后把错因归类到“概念不清、条件漏看、步骤错误、计算错误”。",
        "5. 复习 24 小时后再做一次同类题，更新掌握度。",
        "",
        `【引用来源】\n${formatCitations(citations)}`
      ].join("\n"),
      confidence: "high",
      topics
    };
  }
  if (effectiveMode === "explain") {
    const topic = topics[0] || prompt;
    return {
      content: [
        `${levelHint}`,
        depthHint,
        `【概念讲解：${topic}】`,
        `1. 简明定义：${String(hits[0].text || hits[0].quote).replace(/\s+/g, " ").slice(0, 180)}。`,
        hits[1] ? `2. 通俗解释：可以结合资料 [S2] 把它理解为：${String(hits[1].text || hits[1].quote).replace(/\s+/g, " ").slice(0, 140)}。` : "2. 通俗解释：先把概念放进具体例题或实验场景中理解。",
        `3. 课程资料依据：${evidenceLines[0] || "当前片段不足"}。`,
        `4. 例子：围绕「${topic}」写一个小例子，并说明条件如何对应到定义。`,
        "5. 常见误区：只记结论而不说明适用条件，或者把相邻概念混为一谈。",
        `6. 推荐练习：用自己的话复述「${topic}」，再做 1 道基础题。`,
        "",
        `【引用来源】\n${formatCitations(citations)}`
      ].join("\n"),
      confidence: "high",
      topics
    };
  }
  return {
    content: [
      `${levelHint}`,
      depthHint,
      "【课程资料依据】",
      ...evidenceLines,
      "",
      "【回答】",
      `围绕「${prompt}」，课程资料支持的核心结论是：${String(hits[0].text || hits[0].quote).slice(0, 180)}。`,
      hits[1] ? `进一步看，${String(hits[1].text || hits[1].quote).slice(0, 150)}。` : "",
      "",
      "【模型推理/补充】",
      "基于以上资料，可以按“定义/条件/步骤/例题/易错点”五个角度复习。若这是解题问题，请先列出题干条件，再把相关公式或规则与条件逐一对应。",
      "",
      `【引用来源】\n${formatCitations(citations)}`
    ].filter(Boolean).join("\n"),
    confidence: hasEvidence ? "high" : "low",
    topics
  };
}

function studentProfileModelContext(profile = {}) {
  const summary = profileMasterySummary(profile);
  return {
    level: profile.level || "未建档",
    weak_topics: summary.weak.slice(0, 5).map((item) => ({ topic: item.topic, score: item.score, status: item.status })),
    strong_topics: summary.strong.slice(0, 3).map((item) => ({ topic: item.topic, score: item.score, status: item.status })),
    explicit_weak_points: (profile.weakPoints || []).slice(0, 5),
    question_count: Number(profile.questionCount || 0),
    practice_count: Number(profile.practiceCount || 0),
    recent_activity: (profile.recentActivity || []).slice(0, 4).map((item) => ({
      kind: item.kind || "",
      mode: item.mode || "",
      topics: (item.topics || []).slice(0, 3),
      at: item.at || ""
    }))
  };
}

function openAiMessageText(data = {}) {
  const content = data.choices?.[0]?.message?.content || data.output?.text || data.output_text || "";
  if (Array.isArray(content)) {
    return content.map((item) => typeof item === "string" ? item : (item?.text || item?.content || "")).join("\n").trim();
  }
  return String(content || "").trim();
}

async function callStudentModel({ user, mode, prompt, subject, chapter, knowledgePoint, answerDepth, studentAnswer, hits, citations, profile }) {
  if (!isConfiguredSecret(OPENAI_API_KEY)) {
    throw Object.assign(new Error("学生端直连模型未配置：请在 .env 设置有效的 OPENAI_API_KEY。"), { status: 503 });
  }
  const evidence = hits.slice(0, RAG_MAX_CONTEXT_CHUNKS).map((hit, index) => [
    `[S${index + 1}] ${hit.title || hit.sourceName || "课程资料"}${hit.chapter ? ` / ${hit.chapter}` : ""}`,
    String(hit.text || hit.quote || "").replace(/\s+/g, " ").slice(0, 750)
  ].join("\n")).join("\n\n");
  const profileContext = studentProfileModelContext(profile);
  const requestId = uid("native_ai_req");
  const messages = [
    {
      role: "system",
      content: [
        "你是机器学习课程的学生端问答助手。",
        "回答必须优先依据给定的课程证据；证据不足时必须明确说明，并只给出一般性学习建议。",
        "学生画像只能用于决定讲解深度、补充顺序和练习难度，不能把历史掌握度当作本轮答题结论，也不能透露无关个人信息。",
        "学生没有提供自我理解时，mastery_score 必须为 null，mastery_level 必须为“未诊断”。",
        "学生提供自我理解或处于批改模式时，才评估本轮回答并给出 0 到 100 的 mastery_score、错误标签和缺漏点；没有充分证据时应保守表达。",
        "不要直接代做考试或作业；此类请求应改为提示解题思路和自检步骤。",
        "只输出 JSON，不要 Markdown 围栏。字段：answer、topic_label、mastery_score、mastery_level、error_tags、missing_points、next_questions。",
        "answer 用中文，依次包含“直接回答”“依据与例子”“易错提醒”“下一步自检问题”。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `学科：${subject || "机器学习"}`,
        `任务模式：${mode}`,
        `回答深度：${answerDepthLabel(answerDepth)}`,
        chapter ? `章节：${chapter}` : "",
        knowledgePoint ? `指定知识点：${knowledgePoint}` : "",
        `学生问题：${prompt}`,
        studentAnswer ? `学生自我理解：${studentAnswer}` : "",
        `学生画像摘要：${JSON.stringify(profileContext)}`,
        `课程证据：\n${evidence || "未检索到可引用的课程证据。"}`
      ].filter(Boolean).join("\n\n")
    }
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 1800
      }),
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`模型接口返回 ${response.status}：${raw.slice(0, 240)}`);
    const content = openAiMessageText(JSON.parse(raw));
    const structured = extractJsonObject(content) || {};
    const answer = String(structured.answer || structured.final_answer || content).trim();
    if (!answer) throw new Error("模型没有返回学生端回答。");
    const rawScore = structured.mastery_score;
    const numericScore = rawScore === null || rawScore === undefined || rawScore === "" ? null : Number(rawScore);
    const masteryScore = Number.isFinite(numericScore) && (studentAnswer || mode === "grade")
      ? Math.max(0, Math.min(100, Math.round(numericScore)))
      : null;
    const list = (value) => Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 8) : [];
    const topic = String(structured.topic_label || knowledgePoint || inferQuestionTopics([prompt, chapter, ...hits.map((hit) => hit.text)].join("\n"), subject)[0] || "当前知识点").trim();
    return {
      content: answer,
      confidence: hits.length ? "high" : "medium",
      topics: Array.from(new Set([topic, ...inferQuestionTopics(`${prompt}\n${studentAnswer}`, subject)])).slice(0, 8),
      workflowSource: "native-openai-compatible",
      workflowResult: {
        source: "native-openai-compatible",
        request_id: requestId,
        model: OPENAI_MODEL,
        topic_label: topic,
        mastery_score: masteryScore,
        mastery_level: masteryScore === null ? "未诊断" : String(structured.mastery_level || "待复核"),
        error_tags: list(structured.error_tags),
        missing_points: list(structured.missing_points),
        next_questions: list(structured.next_questions),
        rag_evidence: citations.slice(0, RAG_MAX_CONTEXT_CHUNKS),
        diagnosis_mode: studentAnswer || mode === "grade" ? "学习诊断模式" : "知识问答模式"
      }
    };
  } catch (error) {
    const detail = error?.name === "AbortError" ? `模型请求超时：${OPENAI_TIMEOUT_MS}ms。` : `学生端直连模型调用失败：${error.message || error}`;
    throw Object.assign(new Error(detail), { status: error?.status || 502 });
  } finally {
    clearTimeout(timer);
  }
}

function buildNativeStudentAnswerTrace({ retrieval = {}, citations = [], mode = "qa", topics = [], hasStudentAnswer = false }) {
  return {
    ...NATIVE_STUDENT_ASSISTANT_INFO,
    mode,
    retrievedCount: retrieval.hits?.length || 0,
    citationCount: citations.length,
    steps: [
      "接收学生问题和当前学习任务",
      `检索课程资料 ${retrieval.courseHits?.length || 0} 条、错因资料 ${retrieval.mistakeHits?.length || 0} 条`,
      "读取学生掌握度、薄弱点和近期学习活动",
      "将课程证据和学生画像传给后端直连模型",
      hasStudentAnswer ? "解析本轮自我理解，生成诊断字段" : "生成分层讲解与自检问题，不更新本轮诊断分数",
      `返回回答、引用和关联知识点：${topics.slice(0, 4).join("、") || "待定位"}`
    ]
  };
}

function isConfiguredSecret(value, placeholders = []) {
  const text = String(value || "").trim();
  if (!text) return false;
  const blocked = new Set([
    "app-xxx",
    "replace-with-your-openai-api-key",
    "replace-me",
    "change-me",
    "replace-me-with-long-random-token",
    "replace-with-dify-callback-token",
    ...placeholders
  ]);
  return !blocked.has(text);
}

function isDifyStudentWorkflowConfigured() {
  return Boolean(DIFY_BASE_URL && isConfiguredSecret(DIFY_STUDENT_WORKFLOW_API_KEY));
}

function isDifyTeacherWorkflowConfigured() {
  return Boolean(DIFY_BASE_URL && isConfiguredSecret(DIFY_TEACHER_WORKFLOW_API_KEY));
}

function isDifyWorkflowConfigured(role = "student") {
  if (role === "teacher") return isDifyTeacherWorkflowConfigured();
  if (role === "student") return isDifyStudentWorkflowConfigured();
  return isDifyStudentWorkflowConfigured() || isDifyTeacherWorkflowConfigured();
}

function isDifyCallbackTokenConfigured() {
  return isConfiguredSecret(DIFY_CALLBACK_TOKEN);
}

function difyTargetLevel(answerDepth = "") {
  return {
    brief: "入门理解",
    layered: "考试复习",
    full: "原理推导",
    exam: "考试复习"
  }[String(answerDepth || "layered")] || "考试复习";
}

function difyDiagnosisDepth(answerDepth = "") {
  return {
    brief: "简洁",
    layered: "标准",
    full: "深度",
    exam: "深度"
  }[String(answerDepth || "layered")] || "标准";
}

function difyWorkflowUrl() {
  return `${DIFY_BASE_URL}/workflows/run`;
}

function compactDifyErrorDetail(error) {
  const parts = [
    error?.message,
    error?.cause?.message,
    error?.cause?.code,
    error?.cause?.errno,
    error?.cause?.address ? `${error.cause.address}${error.cause.port ? `:${error.cause.port}` : ""}` : ""
  ].filter(Boolean);
  return Array.from(new Set(parts.map((item) => String(item).trim()).filter(Boolean))).join("；");
}

function formatDifyNetworkError(error, authHintName) {
  const targetUrl = difyWorkflowUrl();
  const baseHint = `请确认 Dify 服务已启动，${authHintName} 已配置为已发布工作流 App 的 API Key，并检查 .env 中 DIFY_BASE_URL=${DIFY_BASE_URL} 是否能从当前 Node 服务访问。`;
  if (error?.name === "AbortError") {
    return `Dify 工作流请求超时：${DIFY_WORKFLOW_TIMEOUT_MS}ms 内未收到响应。目标地址：${targetUrl}。${baseHint}`;
  }
  const detail = compactDifyErrorDetail(error) || "网络请求失败";
  const connectionCodes = ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"];
  const looksLikeNetworkFailure = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|connect|network/i.test(detail);
  const codeHint = connectionCodes.find((code) => detail.includes(code));
  const reason = codeHint === "ECONNREFUSED"
    ? "Dify 端口拒绝连接，通常表示 Dify 未启动、端口不对，或服务没有监听该地址"
    : codeHint === "ENOTFOUND" || codeHint === "EAI_AGAIN"
      ? "无法解析 Dify 地址，通常是容器/宿主机地址写法不适用"
      : codeHint === "ETIMEDOUT" || codeHint === "UND_ERR_CONNECT_TIMEOUT"
        ? "连接 Dify 超时，可能是服务无响应或网络不可达"
        : looksLikeNetworkFailure
          ? "无法连接到 Dify 工作流接口"
          : "Dify 工作流请求失败";
  return `${reason}。目标地址：${targetUrl}。原始错误：${detail}。${baseHint}`;
}

async function postDifyWorkflow({ apiKey, inputs, user, authHintName = "DIFY_WORKFLOW_API_KEY" }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIFY_WORKFLOW_TIMEOUT_MS);
  try {
    const response = await fetch(difyWorkflowUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        inputs,
        response_mode: "blocking",
        user: `${DIFY_WORKFLOW_USER_PREFIX}-${user.id}`
      }),
      signal: controller.signal
    });
    const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => "") }));
    if (!response.ok) {
      const authHint = response.status === 401 ? `，请检查 ${authHintName} 是否属于已发布的 Dify 工作流 App` : "";
      throw Object.assign(new Error(`Dify 工作流调用失败：HTTP ${response.status}${authHint}`), {
        status: response.status,
        details: payload
      });
    }
    return payload;
  } catch (error) {
    if (error?.status) throw error;
    throw Object.assign(new Error(formatDifyNetworkError(error, authHintName)), {
      status: 502,
      cause: error
    });
  } finally {
    clearTimeout(timeout);
  }
}

function difyProjectDocsFromHits(hits = [], sourceType = "项目教师端课程资料", limit = 8) {
  return hits.slice(0, limit).map((hit, index) => ({
    id: `P${index + 1}`,
    content: compactWorkflowText(hit.text || hit.quote || "", 700),
    title: hit.title || hit.sourceName || sourceType,
    source_type: hit.source_type || hit.sourceType || (hit.type === "graph" ? "project_knowledge_graph" : sourceType),
    type: hit.type || "",
    score: Number((Number(hit.score || 0) + (hit.global ? 2 : 0)).toFixed(4)),
    subject: hit.subject || "",
    chapter: hit.chapter || "",
    page: hit.page || "",
    materialId: hit.materialId || "",
    graphId: hit.graphId || "",
    nodeId: hit.nodeId || "",
    nodeLabel: hit.nodeLabel || "",
    sourceName: hit.sourceName || "",
    global: Boolean(hit.global),
    ragChannel: hit.ragChannel || ""
  })).filter((item) => item.content);
}

function buildDifyProjectMasteryContext(db, userId, profile, subject = "机器学习") {
  const summary = profileMasterySummary(profile);
  const wrongNotes = (db.wrongNotes || [])
    .filter((item) => item.userId === userId)
    .slice(0, 12)
    .map((item) => ({
      topic: item.topic,
      question: compactWorkflowText(item.question, 180),
      analysis: compactWorkflowText(item.analysis, 180),
      recommendation: compactWorkflowText(item.recommendation, 180),
      createdAt: item.createdAt
    }));
  return {
    student_id: userId,
    subject,
    level: profile.level || "",
    weak_points: profile.weakPoints || [],
    question_count: Number(profile.questionCount || 0),
    practice_count: Number(profile.practiceCount || 0),
    summary,
    mastery: profile.mastery || {},
    wrong_notes: wrongNotes,
    recent_activity: (profile.recentActivity || []).slice(0, 10)
  };
}

function roleLabel(role = "") {
  return {
    admin: "管理员",
    teacher: "教师",
    student: "学生"
  }[String(role || "").trim()] || "用户";
}

function buildDifyAssistantContext({ user, mode, teaching, subject, chapter, knowledgePoint, answerDepth, hasStudentAnswer }) {
  const meta = AI_MODE_META[mode] || AI_MODE_META.qa;
  const teacherInstructions = {
    qa: "面向教师答疑，优先给出课程资料依据、课堂可讲法、可追问点和可引用来源。",
    explain: "面向教师讲解设计，输出可用于课堂的概念切入、板书结构、例题和易错提醒。",
    guided: "面向教师课堂互动，设计逐步追问、学生可能回答和教师追问策略。",
    practice: "面向教师出题，生成分层题目、标准答案、评分点、错因标签和讲评建议。",
    grade: "面向教师批改，基于粘贴的学生答案给出评分建议、错因、修改建议和后续练习。",
    plan: "面向教师备课或学情分析，输出教学目标、重难点、课堂流程、分层补救和检测方式。"
  };
  const studentInstructions = {
    qa: "面向学生答疑，先给核心结论，再给资料依据、例子、易错点和下一步练习。",
    explain: "面向学生讲解，按定义、直觉、步骤、例子、误区组织，不直接代做作业。",
    guided: "面向学生提示，只给下一步线索和追问，保留思考空间。",
    practice: "面向学生练习，按基础、提高、迁移分层出题，并附答案解析。",
    grade: "面向学生诊断，基于学生自我理解指出已掌握、错因、缺漏点和修正路径。",
    plan: "面向学生规划，结合学习画像给出复习优先级、每日任务和检查方式。"
  };
  const roleInstructions = user.role === "teacher" ? teacherInstructions : studentInstructions;
  return {
    request_user_id: user.id,
    request_user_role: user.role,
    request_user_name: user.name || "",
    role_label: roleLabel(user.role),
    assistant_task: mode,
    assistant_task_label: meta.label,
    assistant_strategy: teaching?.strategy || meta.strategy,
    answer_structure: meta.structure,
    task_instruction: roleInstructions[mode] || roleInstructions.qa,
    subject,
    chapter,
    knowledge_point: knowledgePoint,
    answer_depth: answerDepth,
    target_level: difyTargetLevel(answerDepth),
    diagnosis_depth: difyDiagnosisDepth(answerDepth),
    has_student_answer: Boolean(hasStudentAnswer),
    metacognitive_prompts: metacognitivePromptsForTopic(knowledgePoint || subject || "当前知识点", mode),
    metacognitive_instruction: "回答后必须引导学生解释依据、检验反例、标记不确定点，并反思是否过度依赖 AI。"
  };
}

function buildDifyClassContext(db, user, body = {}, subject = "通用") {
  const requestedClassId = String(body.classId || body.class_id || "").trim();
  const subjectText = normalizeSubject(subject || "");
  if (user.role === "teacher" || user.role === "admin") {
    const ownedClasses = (db.classes || [])
      .filter((klass) => user.role === "admin" || klass.teacherId === user.id)
      .filter((klass) => !requestedClassId || klass.id === requestedClassId || klass.inviteCode === requestedClassId)
      .filter((klass) => !subjectText || subjectText === "通用" || !klass.subject || klass.subject === subjectText)
      .slice(0, 6);
    return {
      role: user.role,
      request_user_id: user.id,
      requested_class_id: requestedClassId,
      class_count: ownedClasses.length,
      classes: ownedClasses.map((klass) => {
        const studentIds = Array.isArray(klass.studentIds) ? klass.studentIds : [];
        const studentProfiles = studentIds
          .map((studentId) => {
            const student = getUser(db, studentId);
            const profile = ensureLearningProfile(db, studentId);
            const summary = profileMasterySummary(profile);
            return {
              id: studentId,
              name: student?.name || "",
              level: profile.level || "",
              weak_points: (summary.weak || []).slice(0, 3).map((item) => ({ topic: item.topic, score: item.score })),
              average_mastery: summary.average
            };
          })
          .slice(0, 12);
        const classHomework = (db.homework || [])
          .filter((item) => item.classId === klass.id)
          .slice(0, 8)
          .map((item) => {
            const submissions = (db.submissions || []).filter((submission) => submission.homeworkId === item.id);
            const reviewed = submissions.filter((submission) => ["graded", "review_pending"].includes(submission.status)).length;
            return {
              id: item.id,
              title: item.title,
              subject: item.subject || klass.subject || "",
              submission_count: submissions.length,
              reviewed_count: reviewed,
              created_at: item.createdAt
            };
          });
        return {
          id: klass.id,
          name: klass.name,
          subject: klass.subject || "",
          student_count: studentIds.length,
          students: studentProfiles,
          recent_homework: classHomework
        };
      })
    };
  }
  const joinedClasses = (db.classes || [])
    .filter((klass) => (klass.studentIds || []).includes(user.id))
    .filter((klass) => !requestedClassId || klass.id === requestedClassId || klass.inviteCode === requestedClassId)
    .filter((klass) => !subjectText || subjectText === "通用" || !klass.subject || klass.subject === subjectText)
    .slice(0, 6);
  const ownSubmissions = (db.submissions || [])
    .filter((submission) => submission.studentId === user.id)
    .slice(0, 10);
  return {
    role: "student",
    student_id: user.id,
    requested_class_id: requestedClassId,
    classes: joinedClasses.map((klass) => ({
      id: klass.id,
      name: klass.name,
      subject: klass.subject || "",
      teacher_id: klass.teacherId,
      teacher_name: getUser(db, klass.teacherId)?.name || "",
      homework: (db.homework || [])
        .filter((item) => item.classId === klass.id)
        .slice(0, 8)
        .map((item) => ({
          id: item.id,
          title: item.title,
          submitted: ownSubmissions.some((submission) => submission.homeworkId === item.id),
          created_at: item.createdAt
        }))
    }))
  };
}

function teacherWorkflowTaskAlias(value = "", prompt = "", requestedMode = "") {
  const raw = String(value || "").trim().toLowerCase();
  const aliases = {
    "teacher-plan": "lesson_plan",
    lesson: "lesson_plan",
    lesson_plan: "lesson_plan",
    "lesson-plan": "lesson_plan",
    plan: "lesson_plan",
    quiz: "quiz_generation",
    questions: "quiz_generation",
    practice: "quiz_generation",
    quiz_generation: "quiz_generation",
    "quiz-generation": "quiz_generation",
    grade: "grading",
    grading: "grading",
    correction: "grading",
    "class-analysis": "class_analysis",
    class_analysis: "class_analysis",
    analysis: "class_analysis",
    remedy: "remedial_plan",
    remedial: "remedial_plan",
    remedial_plan: "remedial_plan",
    "remedial-plan": "remedial_plan"
  };
  if (aliases[raw]) return aliases[raw];
  const mode = String(requestedMode || "").trim().toLowerCase();
  if (aliases[mode]) return aliases[mode];
  const text = String(prompt || "");
  if (/学情|班级|薄弱|掌握度|分层补救|补救|补差/.test(text)) return "class_analysis";
  if (/批改|评分|rubric|错因|提交|答案/.test(text)) return "grading";
  if (/出题|生成.*题|测验|练习|作业|题库|选择题|填空题|简答题|计算题|编程题/.test(text)) return "quiz_generation";
  if (/补救|补差|复测|分层任务/.test(text)) return "remedial_plan";
  return "lesson_plan";
}

function teacherWorkflowMeta(taskType) {
  return TEACHER_WORKFLOW_TASK_META[taskType] || TEACHER_WORKFLOW_TASK_META.lesson_plan;
}

function normalizeIdList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  const parsed = arrayFromJsonish(value);
  if (parsed.length) return parsed.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function arrayItemsFromJsonish(value) {
  const parsed = parseJsonish(value, value);
  if (Array.isArray(parsed)) return parsed.filter((item) => item !== null && item !== undefined && item !== "");
  if (parsed && typeof parsed === "object") return [parsed];
  return arrayFromJsonish(parsed);
}

function selectedMaterialHitsForWorkflow(db, userId, materialIds = [], subject = "", limit = 8) {
  const idSet = new Set(normalizeIdList(materialIds));
  if (!idSet.size) return [];
  const subjectText = normalizeSubject(subject || "");
  const hits = [];
  visibleCourseMaterials(db, userId)
    .filter((material) => idSet.has(String(material.id)))
    .filter((material) => !subjectText || subjectText === "通用" || !material.subject || material.subject === subjectText)
    .forEach((material) => {
      const chunks = Array.isArray(material.chunks) && material.chunks.length
        ? material.chunks.slice(0, 4)
        : [{ id: `${material.id}_preview`, text: material.text || material.preview || "", chapter: material.title, page: 1, index: 0 }];
      chunks.forEach((chunk, index) => {
        hits.push({
          type: "material",
          score: Number((30 - hits.length * 0.4).toFixed(3)),
          materialId: material.id,
          ownerId: material.ownerId,
          global: Boolean(material.global),
          classId: material.classId || "",
          chunkId: chunk.id,
          title: material.title,
          sourceName: material.sourceName,
          subject: material.subject,
          chapter: chunk.chapter || material.title,
          page: chunk.page || Math.max(1, Number(chunk.index ?? index) + 1),
          quote: String(chunk.text || "").slice(0, 220),
          text: chunk.text || material.text || "",
          ragChannel: "selected_material"
        });
      });
    });
  return hits.filter((hit) => hit.text || hit.quote).slice(0, limit);
}

function buildTeacherSubmissionContext(db, teacher, body = {}) {
  const submissionId = String(body.studentSubmissionId || body.student_submission_id || body.submissionId || "").trim();
  const requestedHomeworkId = String(body.homeworkId || body.homework_id || "").trim();
  const requestedStudentId = String(body.studentId || body.student_id || "").trim();
  let submission = submissionId ? (db.submissions || []).find((item) => item.id === submissionId) : null;
  let homework = null;
  if (submission) {
    homework = (db.homework || []).find((item) => item.id === submission.homeworkId);
    if (!homework || (teacher.role !== "admin" && homework.teacherId !== teacher.id)) {
      submission = null;
      homework = null;
    }
  }
  if (!homework && requestedHomeworkId) {
    homework = (db.homework || []).find((item) => item.id === requestedHomeworkId && (teacher.role === "admin" || item.teacherId === teacher.id)) || null;
  }
  const studentId = submission?.studentId || requestedStudentId;
  const student = studentId ? getUser(db, studentId) : null;
  const rubric = normalizeRubricCriteria(body.rubric || homework?.rubric || [], homework?.answer || homework?.description || "");
  return {
    homework_id: homework?.id || requestedHomeworkId,
    homework_title: homework?.title || "",
    homework_description: compactWorkflowText(homework?.description || "", 500),
    homework_answer: compactWorkflowText(homework?.answer || "", 500),
    student_submission_id: submission?.id || submissionId,
    student_id: student?.id || "",
    student_name: student?.name || "",
    submission_text: compactWorkflowText(submission?.text || body.studentAnswer || body.student_answer || "", 900),
    submission_status: submission?.status || "",
    rubric,
    teacher_review_required: true
  };
}

function buildTeacherWorkflowTrace({ retrieval = {}, citations = [], taskType = "lesson_plan", topics = [] }) {
  const hits = Array.isArray(retrieval.hits) ? retrieval.hits : [];
  const taskMeta = teacherWorkflowMeta(taskType);
  return {
    ...TEACHER_WORKFLOW_INFO,
    mode: taskMeta.label,
    task_type: taskType,
    retrievedCount: hits.length,
    citationCount: citations.length,
    steps: [
      `${TEACHER_WORKFLOW_STEP_TITLES[0]}：接收教师任务、课程范围、班级/资料/图谱选择`,
      `${TEACHER_WORKFLOW_STEP_TITLES[1]}：识别为${taskMeta.label}任务`,
      `${TEACHER_WORKFLOW_STEP_TITLES[2]}：检索项目资料 ${retrieval.courseHits?.length || 0} 条、错因/题库 ${retrieval.mistakeHits?.length || 0} 条`,
      `${TEACHER_WORKFLOW_STEP_TITLES[3]}：进入${taskMeta.label}分支`,
      `${TEACHER_WORKFLOW_STEP_TITLES[9]}：检查引用、可靠性和教师复核要求`,
      `${TEACHER_WORKFLOW_STEP_TITLES[10]}：返回 final_answer、结构化产物、引用和后续动作`,
      `${TEACHER_WORKFLOW_STEP_TITLES[11]}：完成教师教学工作流响应`
    ],
    focusTopics: topics.slice(0, 6)
  };
}

function normalizeTeacherWorkflowOutputs(raw = {}, fallbackTaskType = "lesson_plan") {
  const normalized = normalizeDifyOutputs(raw);
  const structured = normalized.structuredResult || {};
  const nested = parseJsonish(structured.structured_result, structured.structured_result || {});
  const structuredResult = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : {};
  const taskType = String(
    structured.task_type
    || structured.task
    || structuredResult.task_type
    || fallbackTaskType
  ).trim() || fallbackTaskType;
  const citations = arrayItemsFromJsonish(structured.citations || structuredResult.citations);
  const warnings = arrayItemsFromJsonish(structured.warnings || structuredResult.warnings);
  const followUpActions = arrayItemsFromJsonish(
    structured.follow_up_actions
    || structured.next_actions
    || structuredResult.follow_up_actions
    || structuredResult.next_actions
  );
  const finalAnswer = String(
    normalized.finalAnswer
    || structured.final_answer
    || structuredResult.final_answer
    || ""
  ).trim();
  return {
    ...normalized,
    finalAnswer,
    structuredResult: {
      ...structured,
      final_answer: finalAnswer,
      task_type: taskType,
      structured_result: structuredResult,
      teaching_objectives: arrayItemsFromJsonish(structured.teaching_objectives || structuredResult.teaching_objectives),
      key_difficult_points: arrayItemsFromJsonish(structured.key_difficult_points || structuredResult.key_difficult_points),
      lesson_steps: arrayItemsFromJsonish(structured.lesson_steps || structuredResult.lesson_steps),
      questions: arrayItemsFromJsonish(structured.questions || structuredResult.questions),
      rubric: arrayItemsFromJsonish(structured.rubric || structuredResult.rubric),
      citations,
      warnings,
      follow_up_actions: followUpActions,
      teacher_review_required: structured.teacher_review_required !== undefined
        ? Boolean(structured.teacher_review_required)
        : structuredResult.teacher_review_required !== undefined
          ? Boolean(structuredResult.teacher_review_required)
          : true
    }
  };
}

function normalizeDifyOutputs(raw = {}) {
  const data = raw.data && typeof raw.data === "object" ? raw.data : raw;
  const outputs = data.outputs && typeof data.outputs === "object" ? data.outputs : {};
  const callbackPayload = parseJsonish(outputs.callback_payload, {});
  const callbackStructured = callbackPayload && typeof callbackPayload === "object"
    ? parseJsonish(callbackPayload.structured_result, callbackPayload.structured_result || {})
    : {};
  const structured = {
    ...(parseJsonish(outputs.structured_json, {}) || {}),
    ...(parseJsonish(outputs.structured_result, {}) || {}),
    ...(callbackStructured && typeof callbackStructured === "object" ? callbackStructured : {})
  };
  const ragEvidence = parseJsonish(outputs.rag_evidence, structured.rag_evidence || []);
  const topicLabel = String(outputs.topic_label || structured.topic_label || "").trim();
  const masteryScore = Number(outputs.mastery_score ?? structured.mastery_score ?? 0);
  const masteryLevel = String(outputs.mastery_level || structured.mastery_level || "未诊断");
  const errorTags = arrayFromJsonish(outputs.error_tags || structured.error_tags);
  const finalAnswer = String(
    outputs.final_answer
    || callbackPayload.final_answer
    || structured.final_answer
    || outputs.answer
    || data.answer
    || raw.answer
    || ""
  ).trim();
  return {
    finalAnswer,
    structuredResult: {
      ...structured,
      topic_label: topicLabel || structured.topic_label || "",
      diagnosis_mode: outputs.diagnosis_mode || structured.diagnosis_mode || "",
      mastery_level: masteryLevel,
      mastery_score: Number.isFinite(masteryScore) ? masteryScore : 0,
      error_tags: errorTags,
      rag_evidence: Array.isArray(ragEvidence) ? ragEvidence : arrayFromJsonish(ragEvidence),
      final_answer: finalAnswer
    },
    rawStatus: data.status || raw.status || "",
    workflowRunId: raw.workflow_run_id || data.workflow_run_id || data.id || "",
    taskId: raw.task_id || data.task_id || ""
  };
}

async function callStudentWorkflow({ db, user, body, mode, subject, chapter, knowledgePoint, answerDepth, studentAnswer, retrieval, profile }) {
  const requestId = uid("dify_req");
  const workflowStudentId = user.role === "student" ? user.id : "";
  const projectCourseDocs = difyProjectDocsFromHits(retrieval?.courseHits?.length ? retrieval.courseHits : retrieval?.hits || [], "项目教师端课程资料", 10);
  const projectMistakeDocs = difyProjectDocsFromHits(retrieval?.mistakeHits || [], "项目错因/题库/评分标准", 8);
  const projectGraphDocs = difyProjectDocsFromHits(graphDatabaseHitsForWorkflow(db, user.id, {
    question: String(body.prompt || "").trim(),
    subject,
    chapter,
    knowledgePoint,
    graphId: String(body.graphId || body.graph_id || ""),
    nodeId: String(body.nodeId || body.node_id || ""),
    limit: 8
  }), "project_knowledge_graph", 8);
  const projectMasteryContext = {
    ...buildDifyProjectMasteryContext(db, user.id, profile, subject),
    student_id: workflowStudentId,
    request_user_id: user.id,
    request_user_role: user.role
  };
  const assistantRoleContext = buildDifyAssistantContext({
    user,
    mode,
    teaching: detectTeachingIntent(String(body.prompt || ""), body.mode || mode, user.role),
    subject,
    chapter,
    knowledgePoint,
    answerDepth,
    hasStudentAnswer: Boolean(studentAnswer)
  });
  const projectClassContext = buildDifyClassContext(db, user, body, subject);
  const inputs = {
    question: String(body.prompt || "").trim(),
    student_answer: studentAnswer,
    target_level: difyTargetLevel(answerDepth),
    diagnosis_depth: difyDiagnosisDepth(answerDepth),
    assistant_task: mode,
    assistant_task_label: AI_MODE_META[mode]?.label || AI_MODE_META.qa.label,
    assistant_role_context: JSON.stringify(assistantRoleContext),
    student_id: workflowStudentId,
    class_id: workflowStudentId ? String(body.classId || body.class_id || user.classIds?.[0] || "") : String(body.classId || body.class_id || ""),
    conversation_id: String(body.conversationId || body.conversation_id || ""),
    request_id: requestId,
    sync_mode: "api-return",
    request_user_id: user.id,
    request_user_role: user.role,
    subject,
    chapter,
    knowledge_point: knowledgePoint,
    graph_id: String(body.graphId || body.graph_id || ""),
    node_id: String(body.nodeId || body.node_id || ""),
    graph_context_url: DIFY_GRAPH_CONTEXT_URL,
    graph_context_token: DIFY_CALLBACK_TOKEN,
    callback_url: DIFY_CALLBACK_URL,
    project_graph_context: JSON.stringify(projectGraphDocs),
    project_rag_context: JSON.stringify(projectCourseDocs),
    project_misconception_context: JSON.stringify(projectMistakeDocs),
    project_mastery_context: JSON.stringify(projectMasteryContext),
    project_class_context: JSON.stringify(projectClassContext)
  };
  const payload = await postDifyWorkflow({
    apiKey: DIFY_STUDENT_WORKFLOW_API_KEY,
    inputs,
    user,
    authHintName: "DIFY_STUDENT_WORKFLOW_API_KEY 或 DIFY_WORKFLOW_API_KEY"
  });
  const normalized = normalizeDifyOutputs(payload);
  if (normalized.rawStatus && !["succeeded", "success"].includes(String(normalized.rawStatus).toLowerCase())) {
    throw Object.assign(new Error(`Dify 工作流状态异常：${normalized.rawStatus}`), { details: payload });
  }
  if (!normalized.finalAnswer) {
    throw Object.assign(new Error("Dify 工作流未返回 final_answer"), { details: payload });
  }
  const topicLabel = normalized.structuredResult.topic_label || knowledgePoint || "机器学习诊断";
  return {
    content: normalized.finalAnswer,
    confidence: "dify",
    topics: Array.from(new Set([
      topicLabel,
      ...(Array.isArray(normalized.structuredResult.top_topic_candidates)
        ? normalized.structuredResult.top_topic_candidates.map((item) => item.topic || item)
        : []),
      knowledgePoint
    ].filter(Boolean))).slice(0, 8),
    workflowResult: {
      ...normalized.structuredResult,
      workflow: ML_DIAGNOSIS_WORKFLOW_INFO,
      workflow_run_id: normalized.workflowRunId,
      task_id: normalized.taskId,
      request_id: requestId,
      student_id: workflowStudentId,
      request_user_id: user.id,
      request_user_role: user.role,
      question: inputs.question,
      student_answer: studentAnswer,
      source: "dify-api",
      assistant_task: inputs.assistant_task,
      assistant_task_label: inputs.assistant_task_label,
      assistant_role_context: assistantRoleContext
    },
    workflowSource: "dify-api"
  };
}

function callDifyDiagnosisWorkflow(options) {
  return callStudentWorkflow(options);
}

function buildTeacherWorkflowInputs({ db, user, body, taskType, mode, subject, chapter, knowledgePoint, answerDepth, retrieval, profile }) {
  const requestId = uid("dify_teacher_req");
  const taskMeta = teacherWorkflowMeta(taskType);
  const selectedMaterialIds = normalizeIdList(body.selectedMaterialIds || body.selected_material_ids || body.materialIds || body.materialId || body.material_id);
  const selectedGraphId = String(body.selectedGraphId || body.selected_graph_id || body.graphId || body.graph_id || "").trim();
  const selectedNodeId = String(body.selectedNodeId || body.selected_node_id || body.nodeId || body.node_id || "").trim();
  const projectCourseDocs = difyProjectDocsFromHits(retrieval?.courseHits?.length ? retrieval.courseHits : retrieval?.hits || [], "项目教师端课程资料", 12);
  const projectMistakeDocs = difyProjectDocsFromHits(retrieval?.mistakeHits || [], "项目错因/题库/评分标准", 10);
  const projectGraphDocs = difyProjectDocsFromHits(graphDatabaseHitsForWorkflow(db, user.id, {
    question: String(body.prompt || "").trim(),
    subject,
    chapter,
    knowledgePoint,
    graphId: selectedGraphId,
    nodeId: selectedNodeId,
    limit: 8
  }), "project_knowledge_graph", 8);
  const projectClassContext = buildDifyClassContext(db, user, body, subject);
  const profileContext = {
    ...buildDifyProjectMasteryContext(db, user.id, profile, subject),
    student_id: "",
    profile_owner_id: user.id,
    teacher_id: user.id,
    request_user_id: user.id,
    request_user_role: user.role,
    note: "教师端画像仅用于教师任务上下文，不自动写入学生学习画像。"
  };
  const submissionContext = buildTeacherSubmissionContext(db, user, body);
  const explicitStudentId = taskType === "grading" ? submissionContext.student_id : "";
  const assistantRoleContext = {
    request_user_id: user.id,
    request_user_role: user.role,
    request_user_name: user.name || "",
    role_label: roleLabel(user.role),
    assistant_task: taskType,
    assistant_task_label: taskMeta.label,
    assistant_strategy: taskMeta.strategy,
    answer_structure: taskMeta.structure,
    task_instruction: "面向教师输出可复用教学产物，必须保留资料引用、可靠性说明和教师复核要求。",
    subject,
    chapter,
    knowledge_point: knowledgePoint,
    answer_depth: answerDepth,
    teacher_review_required: true
  };
  const inputs = {
    question: String(body.prompt || "").trim(),
    task: taskType,
    task_type: taskType,
    teacher_id: user.id,
    request_user_id: user.id,
    request_user_role: user.role,
    subject,
    chapter,
    knowledge_point: knowledgePoint,
    class_id: String(body.classId || body.class_id || "").trim(),
    selected_material_ids: selectedMaterialIds,
    selected_material_ids_json: JSON.stringify(selectedMaterialIds),
    selected_graph_id: selectedGraphId,
    selected_node_id: selectedNodeId,
    graph_id: selectedGraphId,
    node_id: selectedNodeId,
    homework_id: submissionContext.homework_id || String(body.homeworkId || body.homework_id || "").trim(),
    student_submission_id: submissionContext.student_submission_id,
    student_id: explicitStudentId,
    rubric: submissionContext.rubric,
    rubric_json: JSON.stringify(submissionContext.rubric || []),
    output_format: String(body.outputFormat || body.output_format || "json"),
    answer_depth: answerDepth,
    assistant_task: taskType,
    assistant_task_label: taskMeta.label,
    assistant_role_context: JSON.stringify(assistantRoleContext),
    teacher_review_required: true,
    conversation_id: String(body.conversationId || body.conversation_id || ""),
    request_id: requestId,
    sync_mode: "teacher-api-return",
    graph_context_url: DIFY_GRAPH_CONTEXT_URL,
    graph_context_token: DIFY_CALLBACK_TOKEN,
    callback_url: "",
    diagnosis_callback_url: DIFY_CALLBACK_URL,
    project_graph_context: JSON.stringify(projectGraphDocs),
    project_rag_context: JSON.stringify(projectCourseDocs),
    project_misconception_context: JSON.stringify(projectMistakeDocs),
    project_mastery_context: JSON.stringify(profileContext),
    project_class_context: JSON.stringify(projectClassContext),
    grading_context: JSON.stringify(submissionContext)
  };
  return {
    requestId,
    inputs,
    assistantRoleContext,
    projectCourseDocs,
    projectMistakeDocs,
    projectClassContext,
    submissionContext
  };
}

async function callTeacherWorkflow({ db, user, body, taskType, mode, subject, chapter, knowledgePoint, answerDepth, retrieval, profile }) {
  const built = buildTeacherWorkflowInputs({ db, user, body, taskType, mode, subject, chapter, knowledgePoint, answerDepth, retrieval, profile });
  const payload = await postDifyWorkflow({
    apiKey: DIFY_TEACHER_WORKFLOW_API_KEY,
    inputs: built.inputs,
    user,
    authHintName: "DIFY_TEACHER_WORKFLOW_API_KEY"
  });
  const normalized = normalizeTeacherWorkflowOutputs(payload, taskType);
  if (normalized.rawStatus && !["succeeded", "success"].includes(String(normalized.rawStatus).toLowerCase())) {
    throw Object.assign(new Error(`教师 Dify 工作流状态异常：${normalized.rawStatus}`), { details: payload });
  }
  if (!normalized.finalAnswer) {
    throw Object.assign(new Error("教师 Dify 工作流未返回 final_answer"), { details: payload });
  }
  const topics = Array.from(new Set([
    knowledgePoint,
    normalized.structuredResult.topic_label,
    normalized.structuredResult.task_type,
    ...(Array.isArray(normalized.structuredResult.top_topic_candidates)
      ? normalized.structuredResult.top_topic_candidates.map((item) => item.topic || item)
      : [])
  ].filter(Boolean))).slice(0, 8);
  return {
    content: normalized.finalAnswer,
    confidence: "dify",
    topics,
    outputCitations: normalized.structuredResult.citations || [],
    workflowResult: {
      ...normalized.structuredResult,
      workflow: TEACHER_WORKFLOW_INFO,
      workflow_run_id: normalized.workflowRunId,
      task_id: normalized.taskId,
      request_id: built.requestId,
      request_user_id: user.id,
      request_user_role: user.role,
      question: built.inputs.question,
      source: "teacher-dify-api",
      assistant_task: taskType,
      assistant_task_label: teacherWorkflowMeta(taskType).label,
      assistant_role_context: built.assistantRoleContext,
      project_class_context: built.projectClassContext,
      grading_context: built.submissionContext
    },
    workflowSource: "teacher-dify-api"
  };
}

async function buildStudentDiagnosisAnswer(db, user, body) {
  const prompt = String(body.prompt || "").trim();
  const teaching = detectTeachingIntent(prompt, body.mode || "auto", user.role);
  const mode = teaching.mode;
  const subject = normalizeSubject(body.subject || user.subject || "");
  const chapter = String(body.chapter || "").trim();
  const knowledgePoint = String(body.knowledgePoint || "").trim();
  const answerDepth = String(body.answerDepth || "layered");
  const studentAnswer = String(body.studentAnswer || body.student_answer || "").trim();
  const hasStudentAnswer = Boolean(studentAnswer);
  const profile = ensureLearningProfile(db, user.id);
  const retrieval = await searchMlDiagnosisWorkflowKnowledge(db, user.id, {
    prompt,
    chapter,
    knowledgePoint,
    subject,
    mode,
    graphId: body.graphId || body.graph_id,
    nodeId: body.nodeId || body.node_id,
    limit: RAG_MAX_CONTEXT_CHUNKS
  });
  const retrievalQuery = retrieval.courseQuery;
  const hits = retrieval.hits;
  const citations = citationsFromHits(hits);
  const agent = await callStudentModel({
    user,
    mode,
    prompt,
    subject,
    chapter,
    knowledgePoint,
    answerDepth,
    studentAnswer,
    hits,
    citations,
    profile
  });
  const graphContext = findGraphContext(db, user.id, subject, retrievalQuery, agent.topics, hits);
  const workflowResult = agent.workflowResult || {};
  const topicLocalization = buildTopicLocalization({ prompt, knowledgePoint, graphContext, agent, workflowResult });
  const topics = Array.from(new Set([
    topicLocalization.selectedTopic,
    knowledgePoint,
    ...(agent.topics || []),
    graphContext.focusNode?.label
  ].filter(Boolean))).slice(0, 8);
  const masteryTopics = topicLocalization.needsConfirmation ? [] : topics;
  const evidenceDelta = ["high", "dify"].includes(agent.confidence) ? 0.04 : agent.confidence === "medium" ? 0.02 : -0.02;
  let updatedProfile = profile;
  if (masteryTopics.length) {
    updatedProfile = updateTopicMastery(db, user.id, masteryTopics, evidenceDelta, `智能体对话：${prompt.slice(0, 60)}`);
  }
  recordLearningActivity(db, user.id, {
    kind: mode === "practice" ? "practice" : "question",
    mode,
    prompt: prompt.slice(0, 120),
    topics,
    confidence: agent.confidence,
    topicLocalization,
    minutes: mode === "plan" ? 6 : 3
  });
  const enrichedWorkflowResult = {
    ...workflowResult,
    topic_label: topicLocalization.selectedTopic || workflowResult.topic_label || topics[0] || knowledgePoint,
    topic_probability: topicLocalization.confidence,
    top_topic_candidates: topicLocalization.candidates,
    topic_localization: topicLocalization,
    mastery_update_skipped: topicLocalization.needsConfirmation
  };
  const workflowRequestId = String(workflowResult.request_id || workflowResult.requestId || "").trim();
  const rawWorkflowScore = workflowResult.mastery_score ?? workflowResult.masteryScore;
  const workflowScore = rawWorkflowScore === null || rawWorkflowScore === undefined || rawWorkflowScore === "" ? NaN : Number(rawWorkflowScore);
  const workflowType = mlWorkflowType(body.workflowType || body.workflow_type, mode);
  const structuredDiagnosis = normalizeMisconceptionClassification(workflowResult, { knowledgePoint: topicLocalization.selectedTopic || topics[0] || knowledgePoint, nodeId: String(body.nodeId || body.node_id || graphContext.focusNode?.id || ""), masteryScore: workflowScore });
  Object.assign(enrichedWorkflowResult, workflowType === "misconception_classification" ? structuredDiagnosis : { workflow_type: workflowType });
  const acceptedWorkflowScore = topicLocalization.needsConfirmation ? null : (Number.isFinite(workflowScore) ? workflowScore : null);
  const learningEvent = recordLearningEvent(db, {
    studentId: user.id,
    classId: String(body.classId || body.class_id || user.classIds?.[0] || ""),
    eventType: topicLocalization.needsConfirmation ? "ai_topic_pending" : (hasStudentAnswer || mode === "grade" ? "ai_diagnosis" : "ai_question"),
    source: agent.workflowSource || "native-openai-compatible",
    subject,
    knowledgePoint: topicLocalization.selectedTopic || topics[0] || knowledgePoint,
    graphId: String(body.graphId || body.graph_id || graphContext.graphId || ""),
    nodeId: String(body.nodeId || body.node_id || graphContext.focusNode?.id || ""),
    score: acceptedWorkflowScore,
    payload: {
      requestId: workflowRequestId,
      mode,
      prompt,
      studentAnswer,
      topics,
      topicLocalization,
      masteryUpdated: Boolean(masteryTopics.length),
      confidence: agent.confidence,
      workflowRunId: workflowResult.workflow_run_id || "",
      taskId: workflowResult.task_id || ""
    },
    evidenceType: workflowType,
    evidenceSummary: workflowType === "misconception_classification" ? structuredDiagnosis.evidence : `AI ${workflowType}：${prompt.slice(0, 80)}`,
    idempotencyKey: workflowRequestId ? `ai:${workflowRequestId}` : ""
  });
  if (hasStudentAnswer && (Number.isFinite(workflowScore) || workflowResult.mastery_level || workflowResult.masteryLevel)) {
    recordDiagnosisResult(db, {
      studentId: user.id,
      eventId: learningEvent?.id || "",
      topic: topicLocalization.selectedTopic || workflowResult.topic_label || topics[0] || knowledgePoint,
      masteryScore: acceptedWorkflowScore,
      masteryLevel: topicLocalization.needsConfirmation ? "待确认" : (workflowResult.mastery_level || workflowResult.masteryLevel || ""),
      errorTags: Array.isArray(workflowResult.error_tags) ? workflowResult.error_tags : [],
      missingPoints: Array.isArray(workflowResult.missing_points) ? workflowResult.missing_points : [],
      evidence: Array.isArray(workflowResult.rag_evidence) ? workflowResult.rag_evidence : [],
      finalAnswer: agent.content || "",
      modelOrWorkflow: agent.workflowSource || "native-openai-compatible",
      idempotencyKey: workflowRequestId ? `ai-diagnosis:${workflowRequestId}` : ""
    });
  }
  if (masteryTopics.length) {
    syncStudentMasteryFromProfile(db, user.id, masteryTopics, {
      subject,
      graphId: String(body.graphId || body.graph_id || graphContext.graphId || ""),
      nodeId: String(body.nodeId || body.node_id || graphContext.focusNode?.id || ""),
      lastEventId: learningEvent?.id || ""
    });
  }
  if (mode === "grade" && topics[0]) {
    addWrongNote(db, user.id, {
      source: "批改反馈",
      topic: topics[0],
      question: prompt,
      analysis: "本轮触发批改/错因诊断，建议记录错误类型并生成同类题。",
      recommendation: "按修改建议重写答案，再完成 1 道同类题。"
    });
  }
  const learningPanel = buildLearningPanel({
    citations,
    topics,
    graphContext,
    profile: updatedProfile,
    mode,
    strategy: teaching.strategy,
    answerDepth
  });
  learningPanel.topicLocalization = topicLocalization;
  const workflow = buildNativeStudentAnswerTrace({ retrieval, citations, mode, topics, hasStudentAnswer });
  return {
    ...agent,
    citations,
    mode,
    label: teaching.label,
    intent: teaching.intent,
    strategy: "后端直连模型的学生画像 RAG 问答",
    answerDepth,
    knowledgePoints: topics,
    graphContext,
    actions: buildAgentActions(mode, topics),
    learningPanel,
    workflow,
    workflowResult: enrichedWorkflowResult,
    workflowContract: ML_AI_WORKFLOW_CONTRACTS[workflowType] || ML_AI_WORKFLOW_CONTRACTS.knowledge_qa,
    retrieved: hits.map((hit) => ({ type: hit.type, title: hit.title, score: hit.score, subject: hit.subject, chapter: hit.chapter, scoreDetail: hit.scoreDetail, ragChannel: hit.ragChannel || "" })),
    tools: [
      "intent_router",
      "student_profile_context",
      "openai_compatible_chat_completion",
      "course_rag_retrieval",
      "mistake_rag_retrieval",
      "evidence_merge",
      mode === "practice" ? "generate_quiz" : "",
      mode === "grade" ? "grade_answer" : "",
      mode === "plan" ? "create_study_plan" : "",
      "structured_json_output",
      "update_mastery"
    ].filter(Boolean)
  };
}

async function buildTeacherWorkflowAnswer(db, user, body) {
  const prompt = String(body.prompt || "").trim();
  const taskType = teacherWorkflowTaskAlias(body.teacherTask || body.task || body.task_type || body.workflowTask, prompt, body.mode);
  const taskMeta = teacherWorkflowMeta(taskType);
  const mode = taskMeta.mode;
  const subject = normalizeSubject(body.subject || user.subject || "");
  const chapter = String(body.chapter || "").trim();
  const knowledgePoint = String(body.knowledgePoint || "").trim();
  const answerDepth = String(body.answerDepth || "layered");
  const profile = ensureLearningProfile(db, user.id);
  const selectedMaterialHits = selectedMaterialHitsForWorkflow(db, user.id, body.selectedMaterialIds || body.selected_material_ids || body.materialIds || body.materialId || body.material_id, subject, 8);
  const retrieval = await searchMlDiagnosisWorkflowKnowledge(db, user.id, {
    prompt,
    chapter,
    knowledgePoint,
    subject,
    mode,
    graphId: body.selectedGraphId || body.selected_graph_id || body.graphId || body.graph_id,
    nodeId: body.selectedNodeId || body.selected_node_id || body.nodeId || body.node_id,
    limit: RAG_MAX_CONTEXT_CHUNKS
  });
  retrieval.courseHits = selectedMaterialHits.concat(retrieval.courseHits || []);
  retrieval.hits = mergeWorkflowRagHits(retrieval.courseHits, retrieval.mistakeHits || [], RAG_MAX_CONTEXT_CHUNKS);
  const retrievalQuery = retrieval.courseQuery;
  const hits = retrieval.hits;
  const citations = citationsFromHits(hits);
  if (!isDifyTeacherWorkflowConfigured()) {
    throw Object.assign(new Error("教师 Dify 工作流未配置：请先在 .env 设置有效的 DIFY_TEACHER_WORKFLOW_API_KEY，并在 Dify 中发布教师教学工作流。"), { status: 503 });
  }
  let agent;
  try {
    agent = await callTeacherWorkflow({ db, user, body, taskType, mode, subject, chapter, knowledgePoint, answerDepth, retrieval, profile });
  } catch (error) {
    throw Object.assign(new Error(`教师 Dify 工作流调用失败：${error.message || error}`), { status: 502 });
  }
  const graphContext = findGraphContext(db, user.id, subject, retrievalQuery, agent.topics, hits);
  const topics = Array.from(new Set([
    knowledgePoint,
    graphContext.focusNode?.label,
    ...(agent.topics || [])
  ].filter(Boolean))).slice(0, 8);
  const learningPanel = buildLearningPanel({
    citations,
    topics,
    graphContext,
    profile,
    mode,
    strategy: taskMeta.strategy,
    answerDepth
  });
  const workflow = buildTeacherWorkflowTrace({ retrieval, citations, taskType, topics });
  const outputCitations = Array.isArray(agent.outputCitations) && agent.outputCitations.length
    ? agent.outputCitations.map((citation, index) => ({
      id: citation.id || `T${index + 1}`,
      type: citation.type || "teacher-workflow",
      title: citation.title || citation.sourceName || "教师工作流引用",
      sourceName: citation.sourceName || citation.title || "教师工作流引用",
      subject: citation.subject || subject,
      chapter: citation.chapter || "",
      page: citation.page || "",
      quote: citation.quote || citation.content || citation.text || ""
    }))
    : [];
  const checkedOutputCitations = verifyExternalCitations(outputCitations, hits);
  return {
    ...agent,
    citations: checkedOutputCitations.length ? checkedOutputCitations : citations,
    mode,
    label: taskMeta.label,
    intent: taskType,
    strategy: taskMeta.strategy,
    answerDepth,
    knowledgePoints: topics,
    graphContext,
    actions: buildAgentActions(mode, topics),
    learningPanel,
    workflow,
    workflowResult: {
      ...agent.workflowResult,
      workflow,
      task_type: taskType,
      teacher_review_required: agent.workflowResult?.teacher_review_required !== false
    },
    retrieved: hits.map((hit) => ({ type: hit.type, title: hit.title, score: hit.score, subject: hit.subject, chapter: hit.chapter, scoreDetail: hit.scoreDetail, ragChannel: hit.ragChannel || "" })),
    tools: [
      "teacher_task_router",
      "teacher_dify_workflow_api",
      "teacher_input_schema",
      "course_rag_retrieval",
      "graph_context_retrieval",
      "class_context_builder",
      taskType === "quiz_generation" ? "generate_quiz" : "",
      taskType === "grading" ? "grading_rubric" : "",
      taskType === "class_analysis" ? "class_learning_analysis" : "",
      "structured_json_output",
      "teacher_review_required"
    ].filter(Boolean)
  };
}

async function buildEducationalAgentAnswer(db, user, body) {
  const route = routeEducationalRequest({
    prompt: body.prompt,
    requestedMode: body.mode,
    role: user.role,
    hasStudentAnswer: Boolean(body.studentAnswer || body.student_answer)
  });
  if (route.decision !== "allow") {
    return {
      content: route.message,
      citations: [],
      confidence: route.decision === "blocked" ? "blocked" : "low",
      mode: "qa",
      intent: route.intent || route.reason,
      strategy: "教育意图与安全路由",
      knowledgePoints: [],
      graphContext: null,
      learningPanel: { citations: [], nextPath: [], topicLocalization: { needsConfirmation: true } },
      workflow: { mode: "route_only", decision: route.decision, reason: route.reason, steps: ["教育意图与安全路由已拦截或请求澄清"] },
      workflowResult: { route },
      actions: [],
      retrieved: [],
      tools: ["education_intent_safety_router"]
    };
  }
  if (user.role === "teacher" || user.role === "admin") return buildTeacherWorkflowAnswer(db, user, body);
  return buildStudentDiagnosisAnswer(db, user, body);
}

function assertActorOwnsUser(actor, userId) {
  if (actor.role !== "admin" && actor.id !== String(userId || "")) {
    throw Object.assign(new Error("不能代表其他账号发起此请求"), { status: 403 });
  }
}

async function executeAiChat(db, actor, body) {
  const user = ensureUser(db, body.userId);
  let conv = body.conversationId ? db.conversations.find((item) => item.id === body.conversationId && item.userId === user.id) : null;
  if (!conv) {
    conv = { id: uid("conv"), userId: user.id, role: user.role, title: String(body.prompt).slice(0, 24) || "新的对话", mode: body.mode || "explain", messages: [], createdAt: now(), updatedAt: now() };
    db.conversations.unshift(conv);
  }
  const userMessage = { id: uid("msg"), role: "user", content: String(body.prompt), createdAt: now() };
  const agentAnswer = await buildEducationalAgentAnswer(db, user, body);
  const assistantMessage = {
    id: uid("msg"), role: "assistant", content: agentAnswer.content, citations: agentAnswer.citations,
    confidence: agentAnswer.confidence, mode: agentAnswer.mode, intent: agentAnswer.intent, strategy: agentAnswer.strategy,
    knowledgePoints: agentAnswer.knowledgePoints, graphContext: agentAnswer.graphContext, learningPanel: agentAnswer.learningPanel,
    workflow: agentAnswer.workflow, workflowResult: agentAnswer.workflowResult, actions: agentAnswer.actions, retrieved: agentAnswer.retrieved, createdAt: now()
  };
  conv.mode = agentAnswer.mode || body.mode || conv.mode;
  conv.messages.push(userMessage, assistantMessage);
  conv.updatedAt = now();
  if (conv.title === "新的对话") conv.title = String(body.prompt).slice(0, 24);
  db.agentRuns = Array.isArray(db.agentRuns) ? db.agentRuns : [];
  db.agentRuns.unshift({
    id: uid("run"), userId: user.id, conversationId: conv.id, mode: conv.mode, prompt: String(body.prompt).slice(0, 240),
    confidence: agentAnswer.confidence, citations: agentAnswer.citations, retrieved: agentAnswer.retrieved, intent: agentAnswer.intent,
    strategy: agentAnswer.strategy, knowledgePoints: agentAnswer.knowledgePoints, graphFocus: agentAnswer.learningPanel?.graphFocus || null,
    tools: agentAnswer.tools || [], workflow: agentAnswer.workflow, workflowResult: agentAnswer.workflowResult,
    steps: agentAnswer.workflow?.steps || ML_DIAGNOSIS_WORKFLOW_STEP_TITLES, createdAt: now()
  });
  db.agentRuns = db.agentRuns.slice(0, 200);
  recordAudit(db, actor, "ai.chat", { resourceType: "conversation", resourceId: conv.id, meta: { mode: conv.mode, confidence: agentAnswer.confidence } });
  return { conversation: conv, messages: [userMessage, assistantMessage] };
}

function processHomeworkMultimodal(db, payload = {}) {
  const submission = (db.submissions || []).find((item) => item.id === payload.submissionId);
  if (!submission) throw Object.assign(new Error("作业提交不存在"), { status: 404 });
  const attachments = Array.isArray(submission.attachments) ? submission.attachments : [];
  const documents = attachments.slice(0, 12).map((attachment) => {
    const type = String(attachment?.type || "").toLowerCase();
    const name = String(attachment?.name || "附件");
    if (type.startsWith("image/")) {
      return { name, type, modality: "image", status: "vision_required", text: "", message: "图片作业已入队；配置视觉 OCR/多模态模型后可提取手写内容。" };
    }
    try {
      const extracted = extractUploadedBookText(attachment);
      return { name, type, modality: type.includes("pdf") ? "pdf" : "document", status: extracted.text ? "extracted" : "no_text", text: String(extracted.text || "").slice(0, 6000), meta: extracted.meta || null };
    } catch (error) {
      return { name, type, modality: "document", status: "failed", text: "", message: String(error.message || error).slice(0, 500) };
    }
  });
  const extractedText = documents.filter((item) => item.status === "extracted").map((item) => item.text).join("\n\n").slice(0, 12000);
  submission.multimodalUnderstanding = {
    status: documents.some((item) => item.status === "vision_required") ? "partial" : "complete",
    documents,
    extractedText,
    processedAt: now(),
    pendingVisionCount: documents.filter((item) => item.status === "vision_required").length
  };
  submission.updatedAt = now();
  return { submissionId: submission.id, understanding: submission.multimodalUnderstanding };
}

function learningAnalytics(db, userId) {
  const profile = ensureLearningProfile(db, userId);
  const summary = profileMasterySummary(profile);
  const wrongNotes = (db.wrongNotes || []).filter((item) => item.userId === userId).slice(0, 10);
  const recommendations = [];
  if (summary.weak[0]) {
    recommendations.push(`优先复习「${summary.weak[0].topic}」，这条建议来自你的掌握度记录。`);
  }
  if (wrongNotes[0]) {
    recommendations.push(`最近错题记录包含「${wrongNotes[0].topic}」，建议先回看对应答案和解析。`);
  }
  return {
    profile,
    summary,
    wrongNotes,
    recommendations
  };
}

function scorePercentNumber(value) {
  const normalized = normalizeLearningScore(value);
  return normalized === null ? null : Math.round(normalized * 100);
}

function scorePercentText(value, fallback = "未记录") {
  const score = scorePercentNumber(value);
  return score === null ? fallback : `${score}%`;
}

function eventTimeValue(item) {
  return new Date(item?.occurredAt || item?.createdAt || item?.updatedAt || item?.submittedAt || item?.gradedAt || 0).getTime() || 0;
}

function sortNewest(items = []) {
  return items.slice().sort((a, b) => eventTimeValue(b) - eventTimeValue(a));
}

function classNamesForUser(db, user) {
  const ids = new Set(Array.isArray(user.classIds) ? user.classIds : []);
  (db.classes || []).forEach((klass) => {
    if ((klass.studentIds || []).includes(user.id)) ids.add(klass.id);
  });
  return Array.from(ids).map((id) => (db.classes || []).find((klass) => klass.id === id)?.name).filter(Boolean);
}

function inferPortfolioSubject(db, userId, events = []) {
  const profile = ensureLearningProfile(db, userId);
  const user = getUser(db, userId) || {};
  const subjectCounts = new Map();
  const add = (subject, weight = 1) => {
    const label = normalizeSubject(subject || "");
    if (!label || label === "通用") return;
    subjectCounts.set(label, (subjectCounts.get(label) || 0) + weight);
  };
  events.forEach((event) => add(event.subject, 2));
  Object.keys(profile.mastery || {}).forEach((topic) => {
    if (/KNN|K\s*近邻|逻辑回归|支持向量机|SVM|机器学习|监督学习|特征工程/i.test(topic)) add("机器学习", 3);
  });
  (db.courseMaterials || []).filter((item) => item.ownerId === userId || item.global).forEach((item) => add(item.subject, 0.5));
  add(user.subject || user.className, 1);
  const ranked = Array.from(subjectCounts.entries()).sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] || user.subject || "机器学习";
}

function portfolioGoalsForSubject(subject) {
  if (/机器学习|machine learning|ML/i.test(subject)) {
    return ["理解 KNN、逻辑回归、支持向量机等核心算法", "能解释算法适用条件、关键参数和常见误区", "能用测验、代码实验和反思证明学习改进"];
  }
  return [`理解${subject || "本课程"}核心概念`, "能用资料引用和练习结果解释学习过程", "能形成错因修正、作品证据和个人反思"];
}

function portfolioStage(evidence = {}) {
  const stages = [
    { key: "pretest", label: "前测诊断", done: evidence.knowledgeTests > 0 || evidence.masteryChanges > 0 },
    { key: "goals", label: "学习目标设定", done: evidence.learningCycles > 0 || evidence.nodeAnnotations > 0 },
    { key: "aiGraph", label: "AI + 知识图谱学习", done: evidence.aiDialogues > 0 && evidence.nodeAnnotations > 0 },
    { key: "practice", label: "节点练习/作业", done: evidence.knowledgeTests > 1 || evidence.learningOutputs > 0 },
    { key: "fix", label: "错因修正", done: evidence.wrongNotes > 0 },
    { key: "posttest", label: "后测与反思", done: evidence.knowledgeTests >= 2 && evidence.reflections > 0 }
  ];
  const active = stages.find((stage) => !stage.done) || stages[stages.length - 1];
  return {
    label: stages.map((stage) => stage.label).join(" → "),
    activeKey: active.key,
    activeLabel: active.label,
    stages,
    progress: Math.round(stages.filter((stage) => stage.done).length / stages.length * 100)
  };
}

function buildMasteryComparison(events = [], mastery = []) {
  const groups = new Map();
  events
    .filter((event) => event.knowledgePoint && event.score !== null && event.score !== undefined)
    .sort((a, b) => eventTimeValue(a) - eventTimeValue(b))
    .forEach((event) => {
      const key = event.knowledgePoint;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    });
  mastery.forEach((item) => {
    const key = item.knowledgePoint;
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      knowledgePoint: key,
      subject: item.subject,
      score: item.score,
      eventType: "student_mastery_snapshot",
      source: "studentMastery",
      occurredAt: item.updatedAt,
      createdAt: item.updatedAt
    });
  });
  return Array.from(groups.entries()).map(([topic, rows]) => {
    const sorted = rows.sort((a, b) => eventTimeValue(a) - eventTimeValue(b));
    const first = sorted.find((item) => item.score !== null && item.score !== undefined);
    const last = sorted.slice().reverse().find((item) => item.score !== null && item.score !== undefined);
    const start = normalizeLearningScore(first?.score);
    const current = normalizeLearningScore(last?.score);
    const change = start !== null && current !== null ? Number((current - start).toFixed(4)) : null;
    return {
      topic,
      subject: last?.subject || first?.subject || "",
      start,
      current,
      change,
      startText: scorePercentText(start),
      currentText: scorePercentText(current),
      changeText: change === null ? "未计算" : `${change >= 0 ? "+" : ""}${Math.round(change * 100)}%`,
      evidenceCount: sorted.length,
      firstAt: first?.occurredAt || first?.createdAt || "",
      lastAt: last?.occurredAt || last?.createdAt || ""
    };
  }).sort((a, b) => Math.abs(b.change || 0) - Math.abs(a.change || 0)).slice(0, 24);
}

const DEFAULT_LEARNING_CYCLE_REQUIREMENTS = {
  aiDialogues: 3,
  knowledgeTests: 2,
  reflections: 1,
  learningOutputs: 1,
  wrongFixes: 1
};

const LEARNING_CYCLE_TEMPLATES = [
  {
    key: "knn_intro",
    name: "KNN 入门周期",
    title: "机器学习 KNN 入门学习周期",
    subject: "机器学习",
    startLabel: "第 1 周",
    endLabel: "第 2 周",
    goals: ["理解 KNN 核心思想", "掌握距离度量与 K 值选择", "能用测试和错因订正解释 KNN 的适用边界"],
    focusNodes: ["KNN", "距离度量", "K 值选择", "特征缩放", "分类边界"],
    recommendedTestNodes: ["KNN", "距离度量", "K 值选择"],
    weeklyPlan: [
      { week: "第 1 周", title: "前测与概念建构", tasks: ["完成 KNN 前测", "阅读 KNN 图谱节点", "先写自己的 KNN 理解再让 AI 诊断"] },
      { week: "第 2 周", title: "变式测试与反思", tasks: ["完成距离度量测试", "订正 K 值选择误区", "写一次结构化反思并形成学习卡片"] }
    ],
    evidenceRequirements: { aiDialogues: 3, knowledgeTests: 2, reflections: 1, learningOutputs: 1, wrongFixes: 1 }
  },
  {
    key: "logistic_regression",
    name: "逻辑回归专题周期",
    title: "机器学习逻辑回归专题学习周期",
    subject: "机器学习",
    startLabel: "第 1 周",
    endLabel: "第 3 周",
    goals: ["理解逻辑回归基本思想", "说明 sigmoid、损失函数和决策边界", "能比较逻辑回归与 KNN 的适用场景"],
    focusNodes: ["逻辑回归", "Sigmoid 函数", "损失函数", "决策边界", "分类评估"],
    recommendedTestNodes: ["逻辑回归", "损失函数", "分类评估"],
    weeklyPlan: [
      { week: "第 1 周", title: "前测与函数理解", tasks: ["完成逻辑回归前测", "标注 Sigmoid 节点", "向 AI 提交原始理解"] },
      { week: "第 2 周", title: "损失函数与训练", tasks: ["完成损失函数测试", "整理常见误区", "用自己的话解释参数更新"] },
      { week: "第 3 周", title: "后测与迁移", tasks: ["完成同知识点后测", "比较 KNN 与逻辑回归", "提交一份小实验或笔记"] }
    ],
    evidenceRequirements: { aiDialogues: 3, knowledgeTests: 2, reflections: 1, learningOutputs: 1, wrongFixes: 1 }
  },
  {
    key: "svm_compare",
    name: "SVM 对比学习周期",
    title: "机器学习 SVM 对比学习周期",
    subject: "机器学习",
    startLabel: "第 1 周",
    endLabel: "第 3 周",
    goals: ["理解支持向量机的间隔思想", "比较 SVM、KNN 与逻辑回归的差异", "能识别核函数和超参数相关误区"],
    focusNodes: ["支持向量机", "最大间隔", "核函数", "KNN", "逻辑回归"],
    recommendedTestNodes: ["支持向量机", "最大间隔", "核函数"],
    weeklyPlan: [
      { week: "第 1 周", title: "概念定位", tasks: ["完成 SVM 前测", "阅读最大间隔节点", "纠正 KNN/SVM 混淆点"] },
      { week: "第 2 周", title: "对比学习", tasks: ["完成核函数测试", "用表格比较三类算法", "让 AI 检查比较依据"] },
      { week: "第 3 周", title: "后测与反思", tasks: ["完成后测", "提交错因图谱或学习卡片", "写一次 AI 使用边界反思"] }
    ],
    evidenceRequirements: { aiDialogues: 3, knowledgeTests: 2, reflections: 1, learningOutputs: 1, wrongFixes: 1 }
  },
  {
    key: "ml_review",
    name: "机器学习综合复习周期",
    title: "机器学习核心算法综合复习周期",
    subject: "机器学习",
    startLabel: "第 1 周",
    endLabel: "第 4 周",
    goals: ["串联 KNN、逻辑回归、SVM 等核心算法", "用图谱路径定位薄弱点", "形成前后测对比、错因修正和学习产出"],
    focusNodes: ["KNN", "逻辑回归", "支持向量机", "特征缩放", "模型评估"],
    recommendedTestNodes: ["KNN", "逻辑回归", "支持向量机", "模型评估"],
    weeklyPlan: [
      { week: "第 1 周", title: "前测诊断", tasks: ["完成综合前测", "选出 3 个薄弱节点", "设置本轮证据要求"] },
      { week: "第 2 周", title: "图谱路径学习", tasks: ["按图谱路径复习 KNN 与逻辑回归", "完成一次 AI 诊断", "保存学习卡片"] },
      { week: "第 3 周", title: "错因修正", tasks: ["完成阶段测", "订正错因标签", "上传笔记或代码实验"] },
      { week: "第 4 周", title: "后测与档案", tasks: ["完成后测", "写周期总结反思", "生成匿名申报证据包"] }
    ],
    evidenceRequirements: { aiDialogues: 4, knowledgeTests: 3, reflections: 2, learningOutputs: 1, wrongFixes: 2 }
  }
];

const LEARNING_CYCLE_TASK_STATUS_LABELS = {
  not_started: "未开始",
  in_progress: "进行中",
  submitted: "已提交",
  archived: "已入档",
  needs_reflection: "需反思",
  done: "已完成"
};

function normalizeStringItems(value, max = 12) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, max);
  }
  return String(value || "")
    .split(/[\n,，;；、]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeWeeklyPlanItems(value, max = 8) {
  const raw = Array.isArray(value) ? value : String(value || "")
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return raw.slice(0, max).map((item, index) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return {
        week: String(item.week || item.label || `第 ${index + 1} 周`).trim().slice(0, 40),
        title: String(item.title || item.name || "").trim().slice(0, 80),
        tasks: normalizeStringItems(item.tasks || item.task || "", 8)
      };
    }
    const text = String(item || "").trim();
    const parts = text.split(/[:：]/);
    return {
      week: parts.length > 1 ? parts[0].trim().slice(0, 40) : `第 ${index + 1} 周`,
      title: parts.length > 1 ? parts[1].trim().slice(0, 80) : text.slice(0, 80),
      tasks: parts.length > 2 ? normalizeStringItems(parts.slice(2).join("："), 8) : []
    };
  }).filter((item) => item.week || item.title || item.tasks.length);
}

function learningCycleTemplateLibrary() {
  return LEARNING_CYCLE_TEMPLATES.map((template) => JSON.parse(JSON.stringify(template)));
}

function findLearningCycleTemplate(templateKey = "") {
  return learningCycleTemplateLibrary().find((template) => template.key === String(templateKey || "").trim()) || null;
}

function learningCycleDefaultsForSubject(subject = "机器学习") {
  const isMachineLearning = /机器学习|machine learning|ML|KNN|逻辑回归/i.test(subject || "");
  const defaultTemplate = LEARNING_CYCLE_TEMPLATES[0];
  return {
    title: isMachineLearning ? "机器学习 KNN 与逻辑回归专题学习" : `${subject || "课程"}专题学习周期`,
    subject: subject || "机器学习",
    startLabel: isMachineLearning ? defaultTemplate.startLabel : "第 1 周",
    endLabel: isMachineLearning ? "第 4 周" : "第 4 周",
    goals: isMachineLearning
      ? ["掌握 KNN 原理、距离度量与 K 值选择", "理解逻辑回归基本思想与适用场景", "能用测试、错因订正、反思和学习产出证明理解变化"]
      : [`掌握${subject || "本课程"}核心概念`, "能用 AI 诊断和图谱路径修正误区", "形成可导出的学习证据档案"],
    focusNodes: isMachineLearning ? ["KNN", "距离度量", "K 值选择", "逻辑回归", "损失函数"] : [],
    weeklyPlan: isMachineLearning ? LEARNING_CYCLE_TEMPLATES[3].weeklyPlan : [],
    recommendedTestNodes: isMachineLearning ? ["KNN", "距离度量", "K 值选择", "逻辑回归"] : [],
    evidenceRequirements: { ...DEFAULT_LEARNING_CYCLE_REQUIREMENTS }
  };
}

function normalizeLearningCycleRecord(cycle = {}, userId = "", subject = "") {
  const template = findLearningCycleTemplate(cycle.templateKey);
  const defaults = {
    ...learningCycleDefaultsForSubject(cycle.subject || subject),
    ...(template || {})
  };
  const requirements = {
    ...DEFAULT_LEARNING_CYCLE_REQUIREMENTS,
    ...(defaults.evidenceRequirements && typeof defaults.evidenceRequirements === "object" ? defaults.evidenceRequirements : {}),
    ...(cycle.evidenceRequirements && typeof cycle.evidenceRequirements === "object" ? cycle.evidenceRequirements : {})
  };
  Object.keys(requirements).forEach((key) => {
    requirements[key] = Math.max(0, Math.min(99, Number(requirements[key] || 0)));
  });
  return {
    id: cycle.id || uid("cycle"),
    studentId: cycle.studentId || userId,
    title: String(cycle.title || defaults.title).trim().slice(0, 120),
    subject: normalizeSubject(cycle.subject || defaults.subject || subject || ""),
    startLabel: String(cycle.startLabel || defaults.startLabel).trim().slice(0, 40),
    endLabel: String(cycle.endLabel || defaults.endLabel).trim().slice(0, 40),
    startDate: String(cycle.startDate || "").trim().slice(0, 30),
    endDate: String(cycle.endDate || "").trim().slice(0, 30),
    goals: normalizeStringItems(cycle.goals && cycle.goals.length ? cycle.goals : defaults.goals, 8),
    templateKey: String(cycle.templateKey || template?.key || "").trim().slice(0, 80),
    focusNodes: normalizeStringItems(cycle.focusNodes && cycle.focusNodes.length ? cycle.focusNodes : defaults.focusNodes, 12),
    weeklyPlan: normalizeWeeklyPlanItems(cycle.weeklyPlan && cycle.weeklyPlan.length ? cycle.weeklyPlan : defaults.weeklyPlan, 8),
    recommendedTestNodes: normalizeStringItems(cycle.recommendedTestNodes && cycle.recommendedTestNodes.length ? cycle.recommendedTestNodes : defaults.recommendedTestNodes, 12),
    viewMode: ["stage", "week"].includes(cycle.viewMode) ? cycle.viewMode : "stage",
    evidenceRequirements: requirements,
    status: ["draft", "active", "completed", "archived"].includes(cycle.status) ? cycle.status : "active",
    manualTaskStatus: cycle.manualTaskStatus && typeof cycle.manualTaskStatus === "object" ? cycle.manualTaskStatus : {},
    createdAt: cycle.createdAt || now(),
    updatedAt: cycle.updatedAt || cycle.createdAt || now()
  };
}

function activeLearningCycle(db, userId, subject = "") {
  db.learningCycles = Array.isArray(db.learningCycles) ? db.learningCycles : [];
  const cycles = sortNewest(db.learningCycles.filter((item) => item.studentId === userId && item.status !== "archived"));
  const selected = cycles.find((item) => item.status === "active") || cycles[0];
  if (selected) return normalizeLearningCycleRecord(selected, userId, subject);
  const defaults = learningCycleDefaultsForSubject(subject);
  return normalizeLearningCycleRecord({
    ...defaults,
    id: `virtual_cycle_${userId}`,
    studentId: userId,
    virtual: true
  }, userId, subject);
}

function buildLearningCycleTaskProgress(cycle = {}, evidenceCounts = {}) {
  const requirements = {
    ...DEFAULT_LEARNING_CYCLE_REQUIREMENTS,
    ...(cycle.evidenceRequirements || {})
  };
  const knowledgeTests = Number(evidenceCounts.knowledgeTests || 0);
  const wrongFixes = Number(evidenceCounts.wrongNotes || 0) + Number(evidenceCounts.corrections || 0);
  const learningOutputs = Number(evidenceCounts.learningOutputs || 0);
  const aiTarget = Math.max(1, Number(requirements.aiDialogues || 1));
  const practiceTarget = Math.max(1, Number(requirements.knowledgeTests || 1)) + (Number(requirements.learningOutputs || 0) > 0 ? 1 : 0);
  const reflectionTarget = Math.max(1, Number(requirements.reflections || 1));
  const hasSavedCyclePlan = !String(cycle.id || "").startsWith("virtual_cycle_")
    && (cycle.goals || []).length >= 2
    && ((cycle.focusNodes || []).length || (cycle.recommendedTestNodes || []).length);
  const values = {
    pretest: Math.min(knowledgeTests, 1),
    goals: hasSavedCyclePlan ? 1 : 0,
    aiGraph: Math.min(Number(evidenceCounts.aiDialogues || 0), aiTarget) + Math.min(1, Number(evidenceCounts.nodeAnnotations || 0) + Number(evidenceCounts.learningCards || 0)),
    practice: knowledgeTests + Math.min(1, learningOutputs),
    wrongFix: wrongFixes,
    postReflection: Math.min(1, Math.max(0, knowledgeTests - 1)) + Math.min(Number(evidenceCounts.reflections || 0), reflectionTarget)
  };
  const defs = [
    {
      key: "pretest",
      label: "前测诊断",
      shortLabel: "前测",
      target: 1,
      value: values.pretest,
      page: "graph",
      evidenceType: "前测证据",
      evidence: "知识点掌握度、典型误区和原始理解会进入学习档案",
      nextAction: "生成前测题并独立作答",
      evidenceChecklist: ["前测分数", "薄弱知识点", "原始理解", "典型误区"]
    },
    {
      key: "goals",
      label: "学习目标设定",
      shortLabel: "目标",
      target: 1,
      value: values.goals,
      page: "home",
      evidenceType: "目标证据",
      evidence: "保存本周期要解决的 2-3 个具体难点和验证节点",
      nextAction: "设置本轮学习周期、目标和重点节点",
      evidenceChecklist: ["周期主题", "2-3 个难点", "目标节点", "证据要求"]
    },
    {
      key: "aiGraph",
      label: "AI + 知识图谱学习",
      shortLabel: "AI+图谱",
      target: aiTarget + 1,
      value: values.aiGraph,
      page: "ai",
      evidenceType: "AI 与图谱证据",
      evidence: "带着原始答案向 AI 追问，保留引用资料和图谱节点路径",
      nextAction: "先写自己的理解，再让 AI 诊断并打开图谱焦点",
      evidenceChecklist: ["AI 对话次数", "引用资料", "图谱路径", "AI 审辩记录"]
    },
    {
      key: "practice",
      label: "节点练习/作业",
      shortLabel: "练习",
      target: practiceTarget,
      value: values.practice,
      page: "graph",
      evidenceType: "练习验证证据",
      evidence: "知识测试、作业提交、代码实验或节点产出会写入学习画像",
      nextAction: "完成一次同知识点变式测试或提交学习产出",
      evidenceChecklist: ["正确率", "提交记录", "模型实验", "节点学习卡片"]
    },
    {
      key: "wrongFix",
      label: "错因修正",
      shortLabel: "修正",
      target: Math.max(1, Number(requirements.wrongFixes || 1)),
      value: values.wrongFix,
      page: "portfolio",
      evidenceType: "错因修正证据",
      evidence: "记录错题、误区、修正解释和二次验证方式",
      nextAction: "补充错因、修正后理解和验证题",
      evidenceChecklist: ["错题", "误区标签", "修正解释", "二次验证"]
    },
    {
      key: "postReflection",
      label: "后测与反思",
      shortLabel: "后测反思",
      target: reflectionTarget + 1,
      value: values.postReflection,
      page: "portfolio",
      evidenceType: "后测反思证据",
      evidence: "后测掌握度变化、学习策略变化和 AI 使用反思共同入档",
      nextAction: "完成后测，并填写结构化反思卡",
      evidenceChecklist: ["后测掌握度", "学习策略变化", "AI 使用反思", "下一步验证计划"]
    }
  ];
  const manual = cycle.manualTaskStatus && typeof cycle.manualTaskStatus === "object" ? cycle.manualTaskStatus : {};
  const tasks = defs.map((task) => {
    const target = Math.max(1, Number(task.target || 1));
    const value = Math.max(0, Number(task.value || 0));
    const manualStatus = manual[task.key] || {};
    const evidenceDone = value >= target;
    const manualStatusKey = LEARNING_CYCLE_TASK_STATUS_LABELS[manualStatus.status] ? manualStatus.status : "";
    let statusKey = manualStatusKey || (value > 0 ? "in_progress" : "not_started");
    if (evidenceDone) statusKey = "archived";
    if (manualStatus.done || manualStatusKey === "done") statusKey = "done";
    if (manualStatusKey === "submitted" && !evidenceDone) statusKey = "submitted";
    if (manualStatusKey === "needs_reflection") statusKey = "needs_reflection";
    if (["aiGraph", "practice", "wrongFix"].includes(task.key) && evidenceDone && Number(evidenceCounts.reflections || 0) < reflectionTarget) {
      statusKey = "needs_reflection";
    }
    const done = Boolean(["archived", "done"].includes(statusKey));
    const gapValue = Math.max(0, target - value);
    return {
      ...task,
      target,
      value,
      done,
      manualDone: Boolean(manualStatus.done),
      statusKey,
      statusLabel: LEARNING_CYCLE_TASK_STATUS_LABELS[statusKey] || "进行中",
      note: manualStatus.note || "",
      gap: gapValue ? `还差 ${gapValue} ${task.evidenceType.includes("对话") ? "次" : task.evidenceType.includes("反思") ? "份" : task.evidenceType.includes("产出") ? "个" : "次"}` : "证据已形成",
      progress: Math.round(Math.min(1, value / target) * 100),
      statusText: done ? "已入档" : `${LEARNING_CYCLE_TASK_STATUS_LABELS[statusKey] || "进行中"} · ${value}/${target}`
    };
  });
  const current = tasks.find((task) => !task.done) || tasks[tasks.length - 1];
  const completedRatio = tasks.reduce((sum, task) => sum + Math.min(1, Number(task.value || 0) / Math.max(1, Number(task.target || 1))), 0) / Math.max(1, tasks.length);
  const stages = tasks.slice(0, 6).map((task) => ({
    key: task.key,
    label: task.shortLabel,
    done: task.done,
    statusKey: task.statusKey
  }));
  const evidenceGaps = tasks
    .filter((task) => !task.done)
    .map((task) => ({
      key: task.key,
      label: task.label,
      evidenceType: task.evidenceType,
      gap: task.gap,
      nextAction: task.nextAction,
      page: task.page,
      statusKey: task.statusKey,
      statusLabel: task.statusLabel
    }));
  return {
    tasks,
    evidenceGaps,
    nextTask: tasks.find((task) => !task.done) || null,
    currentStage: {
      label: stages.map((stage) => stage.label).join(" → "),
      activeKey: current.key,
      activeLabel: current.shortLabel || current.label,
      stages,
      progress: Math.round(completedRatio * 100)
    },
    requiredEvidenceText: [
      "1 个学习目标设定",
      `至少 ${requirements.aiDialogues} 次 AI 对话`,
      `${requirements.knowledgeTests} 次测试`,
      `${requirements.wrongFixes} 条错因修正`,
      `${requirements.reflections} 份反思`,
      `${requirements.learningOutputs} 个学习产出`
    ].join("、")
  };
}

function buildLearningCycleView(db, userId, subject = "", evidenceCounts = {}) {
  const cycle = activeLearningCycle(db, userId, subject);
  const progress = buildLearningCycleTaskProgress(cycle, evidenceCounts);
  return {
    ...cycle,
    virtual: String(cycle.id || "").startsWith("virtual_cycle_"),
    rangeText: [cycle.startLabel, cycle.endLabel].filter(Boolean).join(" 到 "),
    templateLibrary: learningCycleTemplateLibrary(),
    evidenceCounts,
    evidenceLoop: ["学习目标", "前测诊断", "图谱路径", "AI 对话", "知识测试", "错因修正", "反思", "后测", "学习档案"],
    ...progress
  };
}

function buildLearningCycleCompletionReport({ cycle = {}, comparison = [], wrongNotes = [], reflections = [], citations = [], counts = {}, ethicsSettings = {} }) {
  const progress = Number(cycle.currentStage?.progress || 0);
  const ready = progress >= 100;
  const improvedTopics = comparison.filter((item) => Number(item.change || 0) > 0);
  const weakTopics = comparison.filter((item) => Number(item.current || 0) < 0.58);
  const reflectionSamples = reflections.slice(0, 5).map((item) => ({
    time: item.createdAt,
    topic: item.knowledgePoint || item.contextTitle || "学习反思",
    text: reportCompactText([item.originalUnderstanding, item.aiDiscovery, item.aiAgreement, item.strategyChange, item.aiLimitation, item.nextPlan, item.antiOverreliance].filter(Boolean).join("；"), 220)
  }));
  return {
    ready,
    statusText: ready ? "已生成周期完成报告" : `周期进度 ${progress}%，完成后自动生成报告`,
    title: `${cycle.title || "学习周期"}完成报告`,
    generatedAt: ready ? now() : "",
    summary: ready
      ? `本周期完成 ${Number(counts.aiDialogues || 0)} 次 AI 对话、${Number(counts.knowledgeTests || 0)} 次测试、${Number(counts.reflections || 0)} 份反思和 ${Number(counts.learningOutputs || 0)} 个学习产出。`
      : "完成前测、AI 学习、知识测试、错因修正、反思、后测和学习产出后，系统会自动生成周期总结。",
    prePostComparison: comparison.slice(0, 8).map((item) => ({
      topic: item.topic,
      startText: item.startText,
      currentText: item.currentText,
      changeText: item.changeText
    })),
    masteryChange: {
      improvedTopics: improvedTopics.length,
      weakTopics: weakTopics.length,
      highlights: improvedTopics.slice(0, 5).map((item) => `${item.topic} ${item.changeText}`)
    },
    misconceptionChange: {
      wrongNotes: wrongNotes.length,
      corrections: Number(counts.corrections || 0),
      summary: wrongNotes.length ? `已形成 ${wrongNotes.length} 条错因记录，可用于展示从误解到修正后理解的轨迹。` : "暂无错因记录，建议完成一次错因订正。"
    },
    reflectionSamples,
    aiUseStatement: ethicsSettings.aiUseDisclosure
      ? "AI 用于诊断、引用、追问和学习建议；学生保留原始作答、最终判断和反思记录。"
      : "建议开启 AI 使用声明，明确 AI 辅助内容与学生原创内容边界。",
    citationSummary: {
      count: citations.length,
      sources: citations.slice(0, 8).map((item) => item.sourceName || item.title || item.id).filter(Boolean)
    },
    anonymousPackage: ready
      ? "可生成匿名申报包：隐藏学生姓名、ID 和敏感对话，仅保留过程证据、统计摘要、引用来源和反思摘录。"
      : "周期完成后可一键生成匿名申报包。"
  };
}

function suggestLearningCycleFromProfile(db, userId, body = {}) {
  const portfolio = buildStudentPortfolio(db, userId);
  const currentCycle = portfolio.learningCycle || {};
  const requestedTemplate = findLearningCycleTemplate(body.templateKey) || null;
  const weakByMastery = (portfolio.masteryComparison || [])
    .filter((item) => Number(item.current || 0) < 0.68)
    .map((item) => item.topic);
  const weakByAnnotation = (portfolio.nodeAnnotations || [])
    .filter((item) => ["weak", "uncertain", "learning"].includes(item.status))
    .map((item) => item.nodeLabel || item.knowledgePoint)
    .filter(Boolean);
  const focusNodes = Array.from(new Set([
    ...normalizeStringItems(body.focusNodes || "", 8),
    ...weakByMastery,
    ...weakByAnnotation,
    ...(requestedTemplate?.focusNodes || currentCycle.focusNodes || []),
    "KNN",
    "逻辑回归"
  ].filter(Boolean))).slice(0, 6);
  const primary = focusNodes[0] || "KNN";
  const secondary = focusNodes[1] || "逻辑回归";
  const suggestion = {
    templateKey: requestedTemplate?.key || currentCycle.templateKey || "ml_review",
    title: `${currentCycle.subject || portfolio.summary?.subject || "机器学习"} ${primary} 与 ${secondary} 学习周期`,
    subject: currentCycle.subject || portfolio.summary?.subject || requestedTemplate?.subject || "机器学习",
    startLabel: body.startLabel || "第 1 周",
    endLabel: body.endLabel || "第 4 周",
    goals: [
      `补齐 ${primary} 的核心概念、适用条件和常见误区`,
      `围绕 ${focusNodes.slice(0, 4).join("、")} 完成图谱路径学习和测试诊断`,
      "用前后测、错因订正、结构化反思和学习产出证明理解变化"
    ],
    focusNodes,
    recommendedTestNodes: focusNodes.slice(0, 4),
    weeklyPlan: [
      { week: "第 1 周", title: "前测诊断", tasks: [`完成 ${primary} 前测`, "标注薄弱图谱节点", "设置证据要求"] },
      { week: "第 2 周", title: "AI 学习与图谱路径", tasks: ["先作答再求助", `围绕 ${primary} 向 AI 追问`, "把 AI 回答转成学习卡片"] },
      { week: "第 3 周", title: "知识测试与错因修正", tasks: [`完成 ${secondary} 或相关节点测试`, "订正错因标签", "补充我的理解"] },
      { week: "第 4 周", title: "后测与学习档案", tasks: ["完成同知识点后测", "写周期总结反思", "生成匿名申报证据包"] }
    ],
    evidenceRequirements: {
      aiDialogues: Math.max(3, Number(currentCycle.evidenceRequirements?.aiDialogues || 0)),
      knowledgeTests: Math.max(2, Number(currentCycle.evidenceRequirements?.knowledgeTests || 0)),
      reflections: Math.max(1, Number(currentCycle.evidenceRequirements?.reflections || 0)),
      learningOutputs: Math.max(1, Number(currentCycle.evidenceRequirements?.learningOutputs || 0)),
      wrongFixes: Math.max(1, Number(currentCycle.evidenceRequirements?.wrongFixes || 0))
    },
    rationale: [
      weakByMastery.length ? `根据掌握度低于 68% 的知识点推荐：${weakByMastery.slice(0, 4).join("、")}` : "当前掌握度数据不足，优先使用机器学习核心节点模板。",
      weakByAnnotation.length ? `结合学生图谱标注：${weakByAnnotation.slice(0, 4).join("、")}` : "建议在图谱中标注薄弱/不确定节点，以便后续生成更精准周期。",
      "证据要求覆盖 AI 对话、测试、错因修正、反思和学习产出，可直接进入学习档案。"
    ],
    generatedAt: now()
  };
  return normalizeLearningCycleRecord(suggestion, userId, suggestion.subject);
}

function upsertStudentLearningCycle(db, userId, body = {}) {
  db.learningCycles = Array.isArray(db.learningCycles) ? db.learningCycles : [];
  const template = findLearningCycleTemplate(body.templateKey);
  const subject = normalizeSubject(body.subject || template?.subject || "");
  let cycle = body.id
    ? db.learningCycles.find((item) => item.id === String(body.id) && item.studentId === userId)
    : db.learningCycles.find((item) => item.studentId === userId && item.status === "active");
  if (!cycle) {
    cycle = normalizeLearningCycleRecord({ ...(template || {}), studentId: userId, subject, createdAt: now() }, userId, subject);
    db.learningCycles.unshift(cycle);
  }
  const source = template && body.applyTemplate ? { ...template } : {};
  const next = normalizeLearningCycleRecord({
    ...source,
    ...cycle,
    title: body.title !== undefined ? body.title : source.title || cycle.title,
    subject: body.subject !== undefined ? body.subject : source.subject || cycle.subject,
    startLabel: body.startLabel !== undefined ? body.startLabel : source.startLabel || cycle.startLabel,
    endLabel: body.endLabel !== undefined ? body.endLabel : source.endLabel || cycle.endLabel,
    startDate: body.startDate !== undefined ? body.startDate : cycle.startDate,
    endDate: body.endDate !== undefined ? body.endDate : cycle.endDate,
    goals: body.goals !== undefined ? body.goals : source.goals || cycle.goals,
    templateKey: body.templateKey !== undefined ? body.templateKey : source.key || cycle.templateKey,
    focusNodes: body.focusNodes !== undefined ? body.focusNodes : source.focusNodes || cycle.focusNodes,
    weeklyPlan: body.weeklyPlan !== undefined ? body.weeklyPlan : source.weeklyPlan || cycle.weeklyPlan,
    recommendedTestNodes: body.recommendedTestNodes !== undefined ? body.recommendedTestNodes : source.recommendedTestNodes || cycle.recommendedTestNodes,
    viewMode: body.viewMode !== undefined ? body.viewMode : cycle.viewMode,
    evidenceRequirements: body.evidenceRequirements !== undefined ? body.evidenceRequirements : source.evidenceRequirements || cycle.evidenceRequirements,
    status: body.status !== undefined ? body.status : cycle.status,
    manualTaskStatus: cycle.manualTaskStatus,
    updatedAt: now()
  }, userId, subject || cycle.subject);
  Object.assign(cycle, next);
  recordLearningEvent(db, {
    studentId: userId,
    eventType: "learning_cycle_update",
    source: "learning-cycle",
    subject: cycle.subject,
    knowledgePoint: cycle.title,
    payload: {
      title: cycle.title,
      range: [cycle.startLabel, cycle.endLabel].filter(Boolean).join(" 到 "),
      goals: cycle.goals,
      templateKey: cycle.templateKey,
      focusNodes: cycle.focusNodes,
      weeklyPlan: cycle.weeklyPlan,
      recommendedTestNodes: cycle.recommendedTestNodes,
      evidenceRequirements: cycle.evidenceRequirements
    }
  });
  return cycle;
}

function updateLearningCycleTask(db, userId, body = {}) {
  const cycle = upsertStudentLearningCycle(db, userId, { id: body.cycleId, subject: body.subject });
  const key = String(body.taskKey || body.key || "").trim();
  if (!key) throw Object.assign(new Error("请提供任务标识"), { status: 400 });
  cycle.manualTaskStatus = cycle.manualTaskStatus && typeof cycle.manualTaskStatus === "object" ? cycle.manualTaskStatus : {};
  const status = LEARNING_CYCLE_TASK_STATUS_LABELS[body.status] ? body.status : "";
  cycle.manualTaskStatus[key] = {
    done: body.done === true || body.done === "true" || body.done === "1" || status === "done",
    status: status || (body.done === true || body.done === "true" || body.done === "1" ? "done" : "not_started"),
    note: String(body.note || "").trim().slice(0, 300),
    updatedAt: now()
  };
  cycle.updatedAt = now();
  recordLearningEvent(db, {
    studentId: userId,
    eventType: "learning_cycle_task",
    source: "learning-cycle",
    subject: cycle.subject,
    knowledgePoint: cycle.title,
    payload: { taskKey: key, ...cycle.manualTaskStatus[key] }
  });
  return cycle;
}

function nodeAnnotationScore(status = "") {
  return {
    mastered: 0.86,
    uncertain: 0.55,
    weak: 0.32,
    learning: 0.62,
    not_started: 0.18
  }[status] ?? null;
}

function nodeAnnotationStatusLabel(status = "") {
  return {
    mastered: "已掌握",
    uncertain: "不确定",
    weak: "易错/薄弱",
    learning: "正在学习",
    not_started: "未开始"
  }[status] || "正在学习";
}

function createStudentNodeAnnotation(db, userId, body = {}) {
  db.studentNodeAnnotations = Array.isArray(db.studentNodeAnnotations) ? db.studentNodeAnnotations : [];
  const graphId = String(body.graphId || "").trim();
  const nodeId = String(body.nodeId || "").trim();
  const nodeLabel = String(body.nodeLabel || body.knowledgePoint || "").trim().slice(0, 120);
  if (!graphId || !nodeId || !nodeLabel) throw Object.assign(new Error("请先选择知识图谱节点"), { status: 400 });
  const status = ["mastered", "uncertain", "weak", "learning", "not_started"].includes(body.status) ? body.status : "learning";
  let annotation = db.studentNodeAnnotations.find((item) => item.studentId === userId && item.graphId === graphId && item.nodeId === nodeId);
  if (!annotation) {
    annotation = {
      id: uid("nodeann"),
      studentId: userId,
      graphId,
      nodeId,
      createdAt: now()
    };
    db.studentNodeAnnotations.unshift(annotation);
  }
  Object.assign(annotation, {
    subject: String(body.subject || "").trim().slice(0, 80),
    graphTitle: String(body.graphTitle || "").trim().slice(0, 120),
    nodeLabel,
    favorite: body.favorite === true || body.favorite === "true" || body.favorite === "1",
    status,
    statusLabel: nodeAnnotationStatusLabel(status),
    explanation: String(body.explanation || "").trim().slice(0, 1200),
    evidenceType: String(body.evidenceType || "note").trim().slice(0, 40),
    evidenceTitle: String(body.evidenceTitle || "").trim().slice(0, 120),
    evidenceUrl: String(body.evidenceUrl || "").trim().slice(0, 300),
    fromAiAnswer: body.fromAiAnswer === true || body.fromAiAnswer === "true" || body.fromAiAnswer === "1",
    updatedAt: now()
  });
  db.studentNodeAnnotations = db.studentNodeAnnotations.slice(0, 2000);
  const score = nodeAnnotationScore(status);
  const learningEvent = recordLearningEvent(db, {
    studentId: userId,
    eventType: "graph_node_annotation",
    source: "student-graph-construction",
    subject: annotation.subject,
    knowledgePoint: nodeLabel,
    graphId,
    nodeId,
    score,
    payload: {
      status,
      favorite: annotation.favorite,
      explanation: annotation.explanation,
      evidenceType: annotation.evidenceType,
      evidenceTitle: annotation.evidenceTitle,
      fromAiAnswer: annotation.fromAiAnswer
    }
  });
  if (score !== null) {
    setTopicMasteryScore(db, userId, nodeLabel, score, `学生图谱标注：${annotation.statusLabel}`);
    syncStudentMasteryFromProfile(db, userId, [nodeLabel], {
      subject: annotation.subject,
      graphId,
      nodeId,
      lastEventId: learningEvent.id
    });
  }
  return { annotation, learningEvent };
}

function defaultStudentEthicsSettings(userId) {
  return {
    studentId: userId,
    aiUseDisclosure: true,
    citationRequired: true,
    uncertaintyNotice: true,
    dataConsent: true,
    anonymousExportDefault: true,
    requireOriginalAnswerFirst: true,
    allowTeacherPrivateConversationAccess: false,
    aiFinalAnswerBlocked: true,
    updatedAt: ""
  };
}

function getStudentEthicsSettings(db, userId) {
  db.studentEthicsSettings = Array.isArray(db.studentEthicsSettings) ? db.studentEthicsSettings : [];
  return {
    ...defaultStudentEthicsSettings(userId),
    ...(db.studentEthicsSettings.find((item) => item.studentId === userId) || {})
  };
}

function updateStudentEthicsSettings(db, userId, body = {}) {
  db.studentEthicsSettings = Array.isArray(db.studentEthicsSettings) ? db.studentEthicsSettings : [];
  let settings = db.studentEthicsSettings.find((item) => item.studentId === userId);
  if (!settings) {
    settings = defaultStudentEthicsSettings(userId);
    db.studentEthicsSettings.unshift(settings);
  }
  [
    "aiUseDisclosure",
    "citationRequired",
    "uncertaintyNotice",
    "dataConsent",
    "anonymousExportDefault",
    "requireOriginalAnswerFirst",
    "allowTeacherPrivateConversationAccess",
    "aiFinalAnswerBlocked"
  ].forEach((key) => {
    if (body[key] !== undefined) settings[key] = body[key] === true || body[key] === "true" || body[key] === "1";
  });
  settings.updatedAt = now();
  recordLearningEvent(db, {
    studentId: userId,
    eventType: "ethics_settings_update",
    source: "ethics-settings",
    subject: "",
    knowledgePoint: "AI 使用规范与学术诚信",
    payload: settings
  });
  return settings;
}

function requestStudentDataDeletion(db, userId, body = {}) {
  db.studentDataDeletionRequests = Array.isArray(db.studentDataDeletionRequests) ? db.studentDataDeletionRequests : [];
  const scopes = normalizeStringItems(body.scopes || body.scope || "learningEvents,studentReflections,aiAnswerReviews,studentNodeAnnotations", 12);
  const request = {
    id: uid("delreq"),
    studentId: userId,
    scopes,
    reason: String(body.reason || "").trim().slice(0, 300),
    status: "requested",
    createdAt: now()
  };
  db.studentDataDeletionRequests.unshift(request);
  recordLearningEvent(db, {
    studentId: userId,
    eventType: "data_deletion_request",
    source: "privacy-center",
    knowledgePoint: "个人学习数据管理",
    payload: { scopes, reason: request.reason }
  });
  return request;
}

function buildPortfolioTimeline({ events = [], reflections = [], wrongNotes = [], submissions = [], conversations = [], agentRuns = [], aiReviews = [], nodeAnnotations = [] }) {
  const items = [];
  events.forEach((event) => {
    items.push({
      id: event.id,
      type: reportEventLabel(event.eventType),
      rawType: event.eventType,
      time: event.occurredAt || event.createdAt,
      title: event.knowledgePoint || reportEventLabel(event.eventType),
      summary: reportCompactText(event.payload?.prompt || event.payload?.question || event.payload?.answer || event.payload?.evidence || event.payload?.analysis || event.source || "", 160),
      score: scorePercentText(event.score, ""),
      source: event.source || ""
    });
  });
  reflections.forEach((item) => {
    items.push({
      id: item.id,
      type: "结构化反思",
      rawType: "structured_reflection",
      time: item.createdAt,
      title: item.knowledgePoint || item.contextTitle || "学习反思",
      summary: reportCompactText([item.originalUnderstanding, item.aiDiscovery, item.aiAgreement, item.strategyChange, item.aiLimitation, item.nextPlan, item.antiOverreliance].filter(Boolean).join("；"), 180),
      score: "",
      source: item.contextType || "reflection"
    });
  });
  wrongNotes.forEach((note) => {
    items.push({
      id: note.id,
      type: "错因修正",
      rawType: "wrong_note",
      time: note.createdAt,
      title: note.topic || "错题",
      summary: reportCompactText(note.analysis || note.recommendation || note.question || "", 160),
      score: "",
      source: note.source || "wrong-note"
    });
  });
  submissions.forEach((submission) => {
    items.push({
      id: submission.id,
      type: "作品/作业",
      rawType: "homework_submission",
      time: submission.submittedAt || submission.createdAt,
      title: submission.title || submission.homeworkTitle || "作业提交",
      summary: reportCompactText(submission.content || submission.answer || submission.feedback?.comment || "", 160),
      score: scorePercentText(submission.score, ""),
      source: reportStatusLabel(submission.status)
    });
  });
  conversations.slice(0, 12).forEach((conv) => {
    const latestUserMessage = [...(conv.messages || [])].reverse().find((message) => message.role === "user");
    if (!latestUserMessage) return;
    items.push({
      id: conv.id,
      type: "AI 对话",
      rawType: "ai_conversation",
      time: conv.updatedAt || latestUserMessage.createdAt,
      title: conv.title || "AI 对话",
      summary: reportCompactText(latestUserMessage.content || "", 150),
      score: "",
      source: conv.mode || ""
    });
  });
  agentRuns.slice(0, 12).forEach((run) => {
    items.push({
      id: run.id,
      type: "AI 工作流",
      rawType: "agent_run",
      time: run.createdAt,
      title: (run.knowledgePoints || [])[0] || run.intent || "AI 工作流",
      summary: reportCompactText(run.prompt || run.strategy || "", 150),
      score: "",
      source: run.confidence || ""
    });
  });
  aiReviews.forEach((review) => {
    items.push({
      id: review.id,
      type: "AI 审辩记录",
      rawType: "ai_answer_review",
      time: review.createdAt,
      title: review.topic || review.reviewType || "AI 可信度评价",
      summary: reportCompactText([review.reviewType, review.comment, review.finalJudgment, review.studentAction].filter(Boolean).join("；"), 160),
      score: review.trustScore === null || review.trustScore === undefined ? "" : `${Math.round(Number(review.trustScore || 0) * 100)}%`,
      source: review.accepted ? "采纳" : "待修正"
    });
  });
  nodeAnnotations.forEach((annotation) => {
    items.push({
      id: annotation.id,
      type: annotation.fromAiAnswer ? "AI 回答学习卡片" : "图谱节点标注",
      rawType: "graph_node_annotation",
      time: annotation.updatedAt || annotation.createdAt,
      title: annotation.nodeLabel || "图谱节点",
      summary: reportCompactText([annotation.statusLabel, annotation.explanation, annotation.evidenceTitle].filter(Boolean).join("；"), 180),
      score: scorePercentText(nodeAnnotationScore(annotation.status), ""),
      source: annotation.favorite ? "已收藏" : annotation.evidenceType || "node"
    });
  });
  return sortNewest(items).slice(0, 120);
}

function buildInnovationSummary(subject = "课程", evidence = {}) {
  const counts = evidence.counts || {};
  const cycle = evidence.cycle || {};
  const comparison = evidence.comparison || [];
  const citationCount = Number(evidence.citationCount || 0);
  const nodeAnnotationCount = Number(counts.nodeAnnotations || 0);
  const learningOutputCount = Number(counts.learningOutputs || (Number(counts.homeworkOutputs || 0) + Number(counts.modelExperiments || 0) + nodeAnnotationCount));
  const loopEvidence = [
    `${Number(counts.aiDialogues || 0)} 次 AI 对话`,
    `${Number(counts.knowledgeTests || 0)} 次知识测试`,
    `${Number(counts.wrongNotes || 0) + Number(counts.corrections || 0)} 条错因/纠错`,
    `${Number(counts.reflections || 0)} 份结构化反思`
  ];
  const points = [
    {
      key: "evidence_loop",
      title: "证据驱动的 AI 自主学习闭环",
      summary: "学生不是简单问 AI，而是在系统中完成“诊断-学习-测试-修正-反思-再诊断”的完整周期，每一步都形成可追踪证据。",
      evidence: loopEvidence,
      evaluationValue: "对应学习过程记录、学习成效证据和个人反思，能证明一个完整实施周期真实发生。"
    },
    {
      key: "graph_path",
      title: "知识图谱驱动的个性化学习路径",
      summary: "系统把课程资料、知识点关系、常见误区和学生掌握度结合起来，围绕具体知识节点推荐学习路径，而不是泛泛聊天。",
      evidence: [
        `${citationCount} 条课程/图谱引用`,
        `${nodeAnnotationCount} 条学生节点标注`,
        `${(cycle.tasks || []).filter((task) => task.done).length}/${(cycle.tasks || []).length || 7} 个周期任务完成`
      ],
      evaluationValue: "把知识结构、学习画像和路径推荐连成闭环，突出学生在具体知识节点上的成长。"
    },
    {
      key: "metacognition",
      title: "AI 诊断与学生反思结合的元认知培养",
      summary: "AI 不只给答案，还帮助学生发现误区、表达不确定性、制定下一步学习计划，推动学生从“获得答案”转向“管理自己的学习”。",
      evidence: [
        `${Number(counts.reflections || 0)} 份反思`,
        `${Number(counts.aiWorkflowRuns || 0)} 次 AI 诊断/工作流`,
        `${comparison.filter((item) => Number(item.change || 0) > 0).length} 个知识点出现掌握度提升`
      ],
      evaluationValue: "反思字段直接记录原理解、AI 发现、策略变化、不确定点和下一步计划，体现元认知发展。"
    },
    {
      key: "critical_ai",
      title: "学生参与校验 AI 的批判性学习机制",
      summary: "学生可以纠正 AI 的知识点定位、标注回答是否可靠、查看引用来源，体现 Beyond AI：不是依赖 AI，而是学会审慎使用 AI。",
      evidence: [
        `${Number(counts.corrections || 0)} 条知识点纠正`,
        `${Number(counts.aiReviews || 0)} 条 AI 审辩记录`,
        `${citationCount} 条可追溯引用`
      ],
      evaluationValue: "把 AI 的不确定性、引用和学生校验显式纳入学习档案，回应规范性和可信度评审。"
    },
    {
      key: "auto_portfolio",
      title: "自动生成学习证据档案",
      summary: "系统自动把 AI 对话、测试结果、错题、图谱节点、反思、作业和成果组织成学习档案，直接支持学习评价和案例申报。",
      evidence: [
        `${Number(counts.aiDialogues || 0) + Number(counts.knowledgeTests || 0) + Number(counts.reflections || 0) + learningOutputCount} 条核心证据`,
        `${learningOutputCount} 个学习产出/节点证据`,
        "支持 HTML/PDF/CSV/JSON 与匿名导出"
      ],
      evaluationValue: "减少人工整理申报材料的成本，让学习过程、成效变化和个人反思自动形成证据包。"
    }
  ];
  return {
    title: "证据驱动的 AI 学习闭环",
    thesis: "不是让 AI 直接替学生学习，而是让 AI 在诊断、路径推荐、证据记录和反思引导中支持学生形成可持续的自主学习能力。",
    loop: ["前测诊断", "学习目标设定", "AI + 知识图谱学习", "节点练习/作业", "错因修正", "后测与反思"],
    positioning: "创新点不表述为“用了大模型、知识图谱或 Dify”，而表述为 AI 环境下学生自主学习能力、元认知和证据化评价方式的改变。",
    points,
    differentiators: points.map((point) => point.title),
    subject
  };
}

function averageNormalizedScore(values = []) {
  const normalized = values.map(normalizeLearningScore).filter((value) => value !== null);
  if (!normalized.length) return null;
  return Number((normalized.reduce((sum, value) => sum + value, 0) / normalized.length).toFixed(4));
}

function effectPercentText(value, empty = "待形成") {
  const normalized = normalizeLearningScore(value);
  return normalized === null ? empty : scorePercentText(normalized);
}

function learningGainText(start, current) {
  if (start === null || current === null) return "待形成";
  const gain = Number((current - start).toFixed(4));
  return `${gain >= 0 ? "+" : ""}${Math.round(gain * 100)}%`;
}

function buildLearningEffectPanel({ comparison = [], events = [], wrongNotes = [], corrections = [], aiReviews = [], works = [], reflections = [], cycle = {} }) {
  const comparable = comparison.filter((item) => item.start !== null && item.current !== null);
  const startAverage = averageNormalizedScore(comparable.map((item) => item.start));
  const currentAverage = averageNormalizedScore(comparable.map((item) => item.current));
  const knowledgeTestEvents = events
    .filter((event) => event.eventType === "knowledge_test_evaluate" && event.score !== null && event.score !== undefined)
    .sort((a, b) => eventTimeValue(a) - eventTimeValue(b));
  const firstPracticeScore = normalizeLearningScore(knowledgeTestEvents[0]?.score);
  const latestPracticeScore = normalizeLearningScore(knowledgeTestEvents[knowledgeTestEvents.length - 1]?.score);
  const durationEvents = events
    .filter((event) => Number.isFinite(Number(event.durationSeconds)) && Number(event.durationSeconds) > 0)
    .sort((a, b) => eventTimeValue(a) - eventTimeValue(b));
  const firstDuration = durationEvents[0]?.durationSeconds ? Math.round(Number(durationEvents[0].durationSeconds) / 60) : null;
  const latestDuration = durationEvents[durationEvents.length - 1]?.durationSeconds ? Math.round(Number(durationEvents[durationEvents.length - 1].durationSeconds) / 60) : null;
  const strategyEvidence = reflections.filter((item) => item.originalUnderstanding && item.aiDiscovery && item.strategyChange);
  const auditEvidence = aiReviews.filter((item) => /question|error|citation|partial|challenge|质疑|错误|引用|部分/.test(String(item.reviewType || item.comment || item.studentAction || "")));
  const reviewTypeCounts = aiReviews.reduce((acc, item) => {
    const key = item.reviewType || "未分类";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const resolvedMisconceptions = corrections.length;
  const unresolvedMisconceptions = Math.max(0, wrongNotes.length - corrections.length);
  const gain = startAverage !== null && currentAverage !== null ? Number((currentAverage - startAverage).toFixed(4)) : null;
  const metrics = [
    {
      key: "mastery",
      label: "知识点掌握度",
      before: effectPercentText(startAverage),
      after: effectPercentText(currentAverage),
      change: learningGainText(startAverage, currentAverage),
      evidence: `${comparable.length} 个知识点有前后记录`,
      source: "前测/后测、AI 诊断、作业批改与掌握度快照"
    },
    {
      key: "accuracy",
      label: "正确率",
      before: effectPercentText(firstPracticeScore),
      after: effectPercentText(latestPracticeScore),
      change: learningGainText(firstPracticeScore, latestPracticeScore),
      evidence: `${knowledgeTestEvents.length} 次知识测试或练习验证`,
      source: "知识测试提交记录"
    },
    {
      key: "misconception",
      label: "错因数量",
      before: `${wrongNotes.length} 条记录`,
      after: `${resolvedMisconceptions} 条已修正`,
      change: unresolvedMisconceptions ? `仍有 ${unresolvedMisconceptions} 条待验证` : "已形成修正闭环",
      evidence: `${wrongNotes.length} 条错因，${corrections.length} 条纠正`,
      source: "错题本、知识点纠正、结构化反思"
    },
    {
      key: "efficiency",
      label: "学习效率",
      before: firstDuration === null ? "待记录" : `${firstDuration} 分钟`,
      after: latestDuration === null ? "待记录" : `${latestDuration} 分钟`,
      change: firstDuration !== null && latestDuration !== null ? `${latestDuration <= firstDuration ? "减少" : "增加"} ${Math.abs(latestDuration - firstDuration)} 分钟` : "需要带时长的任务记录",
      evidence: `${durationEvents.length} 条带时长学习事件`,
      source: "测验、作业或学习事件 durationSeconds"
    },
    {
      key: "strategy",
      label: "学习策略",
      before: "直接问答/等待解释",
      after: `${strategyEvidence.length} 次先写原理解再让 AI 诊断`,
      change: auditEvidence.length ? `${auditEvidence.length} 次质疑/核验 AI` : "审辩记录待补充",
      evidence: `${reflections.length} 份反思，${aiReviews.length} 条 AI 审辩`,
      source: "结构化反思、AI 审辩表单"
    },
    {
      key: "output",
      label: "作品产出",
      before: "周期开始前待归档",
      after: `${works.length} 个作品/实验/学习卡片`,
      change: works.length ? "已有可展示产出" : "建议提交代码实验、学习笔记或项目报告",
      evidence: works.slice(0, 4).map((item) => item.title).filter(Boolean).join("；") || "暂无作品证据",
      source: "作业、模型实验、图谱节点卡片"
    }
  ];
  return {
    title: "前后对比学习成效",
    learningGain: gain,
    learningGainText: gain === null ? "待形成" : `${gain >= 0 ? "+" : ""}${Math.round(gain * 100)}%`,
    summary: gain === null
      ? "完成前测、后测和反思后自动计算学习增益。"
      : `本周期平均掌握度从 ${effectPercentText(startAverage)} 到 ${effectPercentText(currentAverage)}，学习增益 ${gain >= 0 ? "+" : ""}${Math.round(gain * 100)}%。`,
    metrics,
    reviewTypeCounts,
    evidenceSources: [
      "前测/后测掌握度记录",
      "练习与作业正确率",
      "错题和知识点纠正",
      "结构化反思",
      "AI 审辩记录",
      "代码实验、学习笔记和项目报告"
    ],
    cycleTitle: cycle.title || ""
  };
}

function buildDeclarationApplicationSections(portfolio = {}) {
  const cycle = portfolio.learningCycle || {};
  const effect = portfolio.effectPanel || {};
  const showcase = portfolio.showcase || {};
  const graphPath = portfolio.graphRagProfileCoupling?.recommendedPath || [];
  const reflectionSamples = portfolio.reflectionExcerpts || [];
  return [
    {
      key: "problem",
      title: "学习问题",
      summary: showcase.background || `${portfolio.summary?.student?.name || "学生"} 在 ${portfolio.summary?.subject || "本课程"} 中需要把薄弱知识点、错因和学习策略变化变成可验证证据。`,
      evidence: [
        `${cycle.focusNodes?.length || 0} 个重点节点`,
        `${cycle.evidenceCounts?.wrongNotes || 0} 条错因记录`,
        `${portfolio.masteryComparison?.length || 0} 个掌握度对比点`
      ]
    },
    {
      key: "intervention",
      title: "AI介入方案",
      summary: showcase.intervention || "通过 GraphRAG 引用、知识图谱路径、AI 诊断、审辩记录和结构化反思支持学生自主学习。",
      evidence: [
        `${cycle.evidenceCounts?.aiDialogues || 0} 次 AI 对话`,
        `${portfolio.graphRagProfileCoupling?.ragCitationCount || 0} 条 RAG/图谱引用`,
        `${portfolio.aiReviews?.length || 0} 条 AI 审辩`
      ]
    },
    {
      key: "cycle",
      title: "完整学习周期",
      summary: `${cycle.title || "学习周期"}：${cycle.rangeText || "第 1 周 到 第 4 周"}；${cycle.requiredEvidenceText || "前测、目标、AI 学习、练习、修正、后测反思"}`,
      evidence: (cycle.tasks || []).map((task) => `${task.label}：${task.statusText || task.statusLabel}`).slice(0, 6)
    },
    {
      key: "effect",
      title: "成效数据",
      summary: effect.summary || "系统按前后测、正确率、错因修正、效率、学习策略和作品产出自动汇总成效。",
      evidence: (effect.metrics || []).slice(0, 6).map((metric) => `${metric.label}：${metric.before} -> ${metric.after}（${metric.change}）`)
    },
    {
      key: "reflection",
      title: "个人反思",
      summary: reflectionSamples[0]?.text || "学生记录原始理解、AI 发现、是否采纳、策略变化、下一步验证和避免过度依赖 AI 的做法。",
      evidence: reflectionSamples.slice(0, 5).map((item) => `${item.topic}：${item.text}`)
    },
    {
      key: "transfer",
      title: "推广价值",
      summary: showcase.transfer || "同一证据链可迁移到其他课程和小组协作场景，用统一模板记录学习周期、成效和规范使用 AI。",
      evidence: [
        `${portfolio.collaboration?.chatThreads || 0} 个协作会话`,
        `${portfolio.works?.length || 0} 个作品证据`,
        graphPath[0] ? `示例路径：${graphPath.slice(0, 3).map((item) => item.topic).join(" -> ")}` : "路径待生成"
      ]
    },
    {
      key: "ethics",
      title: "伦理规范",
      summary: [portfolio.ethics?.aiStatement, portfolio.ethics?.citationPolicy, portfolio.ethics?.privacyPolicy].filter(Boolean).join(" "),
      evidence: [
        portfolio.ethics?.settings?.anonymousExportDefault ? "默认匿名导出" : "可手动匿名导出",
        portfolio.ethics?.settings?.citationRequired ? "要求引用来源" : "建议开启引用来源",
        portfolio.ethics?.settings?.requireOriginalAnswerFirst ? "先作答再求助" : "建议开启先作答再求助"
      ]
    }
  ];
}

function buildVideoScriptOutline(portfolio = {}) {
  const cycle = portfolio.learningCycle || {};
  const effect = portfolio.effectPanel || {};
  return [
    { time: "0:00-0:25", shot: "学生端学习周期驾驶舱", narration: `说明学习问题和本周期主题：${cycle.title || "完整学习周期"}`, evidence: cycle.focusNodes?.slice(0, 4).join("、") || "学习目标" },
    { time: "0:25-1:05", shot: "前测诊断与目标设定", narration: "展示前测掌握度、典型误区、学生原始理解和 2-3 个学习目标。", evidence: cycle.tasks?.slice(0, 2).map((task) => task.statusText).join("；") || "" },
    { time: "1:05-1:55", shot: "AI 三栏学习工作台", narration: "展示知识图谱路径、AI 诊断回答、引用来源、学生审辩和最终判断。", evidence: `${cycle.evidenceCounts?.aiDialogues || 0} 次 AI 对话，${cycle.evidenceCounts?.aiReviews || 0} 条审辩` },
    { time: "1:55-2:35", shot: "节点练习/作业与错因修正", narration: "展示练习正确率、错题、误区修正解释和二次验证。", evidence: `${cycle.evidenceCounts?.knowledgeTests || 0} 次测试，${cycle.evidenceCounts?.wrongNotes || 0} 条错因` },
    { time: "2:35-3:15", shot: "前后对比成效面板", narration: `展示学习增益、正确率变化、策略变化和作品产出。${effect.learningGainText ? `学习增益 ${effect.learningGainText}` : ""}`, evidence: effect.summary || "" },
    { time: "3:15-3:45", shot: "个人反思与伦理规范", narration: "展示学生如何判断 AI、如何避免过度依赖、如何保留引用和匿名导出。", evidence: `${portfolio.reflections?.length || 0} 份反思，${portfolio.aiReviews?.length || 0} 条审辩` },
    { time: "3:45-4:30", shot: "学习周期申报页与导出", narration: "打开固定七段申报页，导出匿名证据包、申报表素材和视频脚本。", evidence: "学习问题 -> AI介入方案 -> 完整学习周期 -> 成效数据 -> 个人反思 -> 推广价值 -> 伦理规范" }
  ];
}

function buildDeclarationEvidencePack({ portfolio, events = [], citations = [], aiReviews = [] }) {
  const comparison = portfolio.masteryComparison || [];
  const counts = portfolio.learningCycle?.evidenceCounts || {};
  const masteryChart = comparison.slice(0, 8).map((item) => ({
    topic: item.topic,
    start: item.start,
    current: item.current,
    change: item.change,
    startText: item.startText,
    currentText: item.currentText,
    changeText: item.changeText
  }));
  const eventTypeCounts = {};
  events.forEach((event) => {
    const label = reportEventLabel(event.eventType);
    eventTypeCounts[label] = (eventTypeCounts[label] || 0) + 1;
  });
  const citationSources = {};
  citations.forEach((citation) => {
    const key = citation.sourceName || citation.title || citation.id || "未知来源";
    citationSources[key] = (citationSources[key] || 0) + 1;
  });
  return {
    title: "个人学习档案自动生成申报证据包",
    ready: Boolean((portfolio.timeline || []).length || comparison.length || (portfolio.reflections || []).length),
    processTimeline: (portfolio.timeline || []).slice(0, 20),
    masteryChart,
    eventTypeCounts,
    evidenceCounts: counts,
    cycleTasks: (portfolio.learningCycle?.tasks || []).map((task) => ({
      key: task.key,
      label: task.label,
      statusText: task.statusText,
      statusLabel: task.statusLabel,
      done: task.done,
      evidenceType: task.evidenceType,
      evidence: task.evidence
    })),
    cycleCompletionReport: portfolio.learningCycle?.completionReport || {},
    cycleRequirements: portfolio.learningCycle?.evidenceRequirements || {},
    innovationPoints: (portfolio.innovation?.points || []).map((point) => ({
      title: point.title,
      summary: point.summary,
      evidence: point.evidence,
      evaluationValue: point.evaluationValue
    })),
    aiDialogueSummary: (portfolio.aiSupportRecords || []).slice(0, 8).map((item) => ({
      topic: item.topic,
      prompt: item.prompt,
      citations: item.citations,
      confidence: item.confidence
    })),
    reflectionSamples: (portfolio.reflectionExcerpts || []).slice(0, 5),
    correctionRecords: (portfolio.corrections || []).slice(0, 8),
    aiReviewRecords: aiReviews.slice(0, 8),
    applicationSections: buildDeclarationApplicationSections(portfolio),
    videoScriptOutline: buildVideoScriptOutline(portfolio),
    effectPanel: portfolio.effectPanel || {},
    citationSources: Object.entries(citationSources).map(([source, count]) => ({ source, count })).slice(0, 12),
    anonymization: "可导出匿名版，隐藏学生姓名、ID 和真实班级，仅保留过程证据与统计摘要。",
    exportMaterials: ["学习过程时间线", "前后测对比图", "错因修正记录", "AI 对话与引用摘要", "学生反思摘录", "匿名化学习档案", "申报表素材 JSON/HTML/PDF", "3-5 分钟视频脚本提纲"]
  };
}

function buildStudentPortfolio(db, userId, options = {}) {
  const user = ensureUser(db, userId);
  const anonymous = Boolean(options.anonymous);
  const events = sortNewest((db.learningEvents || []).filter((event) => event.studentId === userId));
  const diagnoses = sortNewest((db.diagnosisResults || []).filter((item) => item.studentId === userId));
  const mastery = sortNewest((db.studentMastery || []).filter((item) => item.studentId === userId));
  const reflections = sortNewest((db.studentReflections || []).filter((item) => item.studentId === userId));
  const corrections = sortNewest((db.knowledgeCorrections || []).filter((item) => item.studentId === userId));
  const aiReviews = sortNewest((db.aiAnswerReviews || []).filter((item) => item.studentId === userId));
  const nodeAnnotations = sortNewest((db.studentNodeAnnotations || []).filter((item) => item.studentId === userId));
  const ethicsSettings = getStudentEthicsSettings(db, userId);
  const wrongNotes = sortNewest((db.wrongNotes || []).filter((item) => item.userId === userId));
  const conversations = sortNewest((db.conversations || []).filter((item) => item.userId === userId));
  const submissions = sortNewest((db.submissions || []).filter((item) => item.studentId === userId).map((submission) => {
    const homework = (db.homework || []).find((item) => item.id === submission.homeworkId);
    return { ...submission, title: homework?.title || submission.title || "作业提交", homeworkTitle: homework?.title || "" };
  }));
  const agentRuns = sortNewest((db.agentRuns || []).filter((item) => item.userId === userId));
  const models = sortNewest((db.models || []).filter((item) => item.ownerId === userId));
  const subject = inferPortfolioSubject(db, userId, events);
  const comparison = buildMasteryComparison(events, mastery);
  const evidenceCounts = {
    aiDialogues: conversations.length,
    aiWorkflowRuns: agentRuns.length,
    knowledgeTests: events.filter((event) => event.eventType === "knowledge_test_evaluate").length,
    masteryChanges: comparison.filter((item) => item.change !== null && item.change !== 0).length,
    wrongNotes: wrongNotes.length,
    reflections: reflections.length,
    homeworkOutputs: submissions.length,
    modelExperiments: models.length,
    corrections: corrections.length,
    aiReviews: aiReviews.length,
    nodeAnnotations: nodeAnnotations.length,
    learningCycles: (db.learningCycles || []).filter((item) => item.studentId === userId && item.status !== "archived").length,
    learningCards: nodeAnnotations.filter((item) => item.fromAiAnswer).length,
    learningOutputs: submissions.length + models.length + nodeAnnotations.length
  };
  const cycleView = buildLearningCycleView(db, userId, subject, evidenceCounts);
  const stage = cycleView.currentStage || portfolioStage(evidenceCounts);
  const timeline = buildPortfolioTimeline({ events, reflections, wrongNotes, submissions, conversations, agentRuns, aiReviews, nodeAnnotations });
  const latestDiagnosis = diagnoses[0] || null;
  const aiSupportRecords = agentRuns.slice(0, 10).map((run) => ({
    id: run.id,
    time: run.createdAt,
    topic: (run.knowledgePoints || [])[0] || run.intent || "待定位",
    prompt: reportCompactText(run.prompt || "", 140),
    help: run.strategy || "课程资料 + 图谱 + 诊断工作流",
    citations: Array.isArray(run.citations) ? run.citations.slice(0, 5).map((item) => item.sourceName || item.title || item.id).filter(Boolean) : [],
    adopted: "已归档到学习事件，可在反思卡中记录是否采纳。",
    confidence: run.workflowResult?.topic_localization?.confidenceLabel || run.confidence || ""
  }));
  const allCitations = agentRuns.flatMap((run) => Array.isArray(run.citations) ? run.citations : []);
  const works = submissions.slice(0, 10).map((submission) => ({
    id: submission.id,
    type: "作业/项目",
    title: submission.title || "作业提交",
    time: submission.submittedAt || submission.createdAt,
    status: reportStatusLabel(submission.status),
    score: scorePercentText(submission.score, "未评分"),
    summary: reportCompactText(submission.content || submission.answer || submission.feedback?.comment || "", 160)
  })).concat(models.slice(0, 8).map((model) => ({
    id: model.id,
    type: "代码实验",
    title: model.name || "模型实验",
    time: model.updatedAt || model.createdAt,
    status: model.mode || "实验记录",
    score: "",
    summary: reportCompactText(model.notes || model.experiment?.summary || "", 160)
  }))).concat(nodeAnnotations.slice(0, 12).map((annotation) => ({
    id: annotation.id,
    type: annotation.fromAiAnswer ? "AI 学习卡片" : "图谱标注",
    title: annotation.nodeLabel || annotation.evidenceTitle || "节点证据",
    time: annotation.updatedAt || annotation.createdAt,
    status: [annotation.statusLabel, annotation.favorite ? "已收藏" : ""].filter(Boolean).join(" · "),
    score: scorePercentText(nodeAnnotationScore(annotation.status), ""),
    summary: reportCompactText(annotation.explanation || annotation.evidenceTitle || "学生主动建构的节点证据", 160)
  })));
  const teacherEvaluations = submissions.filter((submission) => submission.feedback?.comment || submission.feedback?.teacherComment || submission.feedback?.rubricResults).slice(0, 8).map((submission) => ({
    time: submission.feedback?.gradedAt || submission.gradedAt || submission.updatedAt || submission.createdAt,
    teacher: submission.feedback?.teacherName || "任课教师",
    comment: reportCompactText(submission.feedback?.teacherComment || submission.feedback?.comment || submission.feedback?.summary || "教师已完成学习成果确认。", 220),
    summary: submission.title || "作业/项目评价"
  }));
  const misconceptionTrajectory = wrongNotes.slice(0, 12).map((note) => {
    const relatedDiagnosis = diagnoses.find((item) => item.topic === note.topic || (item.missingPoints || []).some((point) => String(point).includes(note.topic)));
    const topicCorrections = corrections.filter((item) => item.fromTopic === note.topic || item.correctedTopic === note.topic);
    const topicTests = events.filter((event) => event.knowledgePoint === note.topic || event.topic === note.topic);
    const resolved = topicCorrections.length > 0 || topicTests.some((event) => Number(event.payload?.accuracy || event.accuracy || 0) >= 0.8);
    return {
      topic: note.topic || "待归类",
      before: reportCompactText(note.question || relatedDiagnosis?.finalAnswer || "原始理解存在缺口", 120),
      issue: reportCompactText(note.analysis || (relatedDiagnosis?.missingPoints || []).join("；") || "等待补充错因", 140),
      after: reportCompactText(note.recommendation || "完成同类题、重写解释并在反思中记录修正策略。", 140),
      time: note.createdAt,
      firstFound: note.source || "章节前测",
      intervention: note.recommendation || "概念对比微课 + 3 道变式题 + 节点实验",
      retestResult: resolved ? "由错误改为正确" : "尚未完成验证性复测",
      currentStatus: resolved ? "已消除" : "待干预",
      transfer: resolved ? "可迁移到不平衡分类等新场景。" : "完成变式题后，再用新场景验证迁移。"
    };
  });
  const userChatThreads = (db.chatThreads || []).filter((thread) => (thread.memberIds || []).includes(userId));
  const collaborationMessages = userChatThreads.flatMap((thread) => (thread.messages || []).map((message) => ({ ...message, threadTitle: thread.title || thread.name || "小组讨论" })));
  const collaboration = {
    classes: classNamesForUser(db, user),
    chatThreads: userChatThreads.length,
    messages: collaborationMessages.filter((msg) => msg.senderId === userId).length,
    contributionHint: "可用于小组共学任务、共享图谱、成员贡献和共识总结。",
    groupSpace: {
      title: "小组共学最小闭环",
      graphCoBuild: `${nodeAnnotations.length} 条本人图谱标注/学习卡片，可作为小组共建知识图谱的贡献记录。`,
      questionPool: wrongNotes.slice(0, 6).map((note) => note.topic || note.question || "待归类问题"),
      roles: [
        { role: "提问者", evidence: conversations.length ? `${conversations.length} 次学习对话` : "待通过问题池补充" },
        { role: "验证者", evidence: aiReviews.length ? `${aiReviews.length} 条 AI 审辩` : "待补充引用核验" },
        { role: "总结者", evidence: reflections.length ? `${reflections.length} 份结构化反思` : "待补充小组总结" },
        { role: "代码实验者", evidence: models.length ? `${models.length} 个模型实验` : "可由模型实验室补充" }
      ],
      aiDiscussionSummary: collaborationMessages.length
        ? reportCompactText(collaborationMessages.slice(-8).map((msg) => msg.content || msg.text || "").join("；"), 220)
        : "暂无小组讨论消息，可在班级或站内消息中围绕问题池开展轻量协作。",
      peerReview: submissions.length ? `${submissions.length} 次作业/项目提交可用于同伴互评。` : "可在作业提交后加入同伴互评与贡献记录。",
      timeline: collaborationMessages.slice(-8).map((msg) => ({
        time: msg.createdAt || msg.time || "",
        title: msg.threadTitle || "小组讨论",
        summary: reportCompactText(msg.content || msg.text || "", 120)
      }))
    }
  };
  const reflectionExcerpts = reflections.slice(0, 5).map((item) => ({
    time: item.createdAt,
    topic: item.knowledgePoint || item.contextTitle || "学习反思",
    text: reportCompactText(item.strategyChange || item.aiAgreement || item.aiDiscovery || item.aiLimitation || item.nextPlan || item.originalUnderstanding || "", 180)
  }));
  const summary = {
    student: anonymous ? { id: "S001", name: "匿名学生", classes: classNamesForUser(db, user).map((_, index) => `班级${index + 1}`) } : { id: user.id, name: user.name, classes: classNamesForUser(db, user) },
    subject,
    generatedAt: now(),
    latestActivity: timeline[0]?.time || "",
    averageMastery: mastery.length
      ? Number((mastery.reduce((sum, item) => sum + Number(normalizeLearningScore(item.score) || 0), 0) / mastery.length).toFixed(4))
      : null,
    latestDiagnosis: latestDiagnosis ? {
      topic: latestDiagnosis.topic,
      score: latestDiagnosis.masteryScore,
      level: latestDiagnosis.masteryLevel,
      time: latestDiagnosis.createdAt
    } : null
  };
  const innovation = buildInnovationSummary(subject, {
    counts: evidenceCounts,
    cycle: cycleView,
    comparison,
    citationCount: allCitations.length
  });
  const pathSource = comparison.length
    ? comparison
    : (cycleView.focusNodes || []).map((topic) => ({
      topic,
      current: null,
      currentText: "未诊断",
      changeText: "待形成"
    }));
  const recommendedPath = pathSource.slice(0, 6).map((item, index) => {
    const current = item.current === null || item.current === undefined ? null : Number(item.current);
    const weak = current === null || current < 0.58;
    const previous = (cycleView.focusNodes || [])[Math.max(0, index - 1)] || "本章基础概念";
    const next = (cycleView.focusNodes || [])[index + 1] || (cycleView.recommendedTestNodes || [])[0] || "同知识点变式题";
    return {
      topic: item.topic,
      current,
      action: weak ? "先补前置并完成同类题" : "做变式后测并写反思",
      why: weak
        ? `当前掌握度${item.currentText || "未诊断"}，应优先补齐该节点再进入后续任务。`
        : `该节点已有学习证据，适合作为后测或迁移任务的验证点。`,
      misconceptionRelation: wrongNotes.some((note) => {
        const noteTopic = String(note.topic || "").trim();
        const pathTopic = String(item.topic || "").trim();
        return Boolean(noteTopic && pathTopic && (noteTopic.includes(pathTopic) || pathTopic.includes(noteTopic)));
      })
        ? "错题本中已有相关误区，学习时需要对照修正解释。"
        : "暂无显式错题，可通过前测或 AI 诊断确认是否存在隐性误区。",
      prerequisites: [previous].filter(Boolean),
      verification: weak ? "完成一道同知识点变式题，并写下修正后的解释。" : "完成一次后测题或小型代码/笔记产出。",
      fallback: `仍未掌握时，回到「${previous}」或补学「${next}」。`,
      evidenceSource: item.evidenceCount ? `${item.evidenceCount} 条掌握度证据` : "学习周期目标与图谱节点"
    };
  });
  const graphRagProfileCoupling = {
    title: "GraphRAG + 学习画像双向驱动",
    description: "AI 回答绑定课程资料和知识图谱；学习行为回写学生画像；画像反过来影响路径推荐；图谱节点成为学习证据索引。",
    graphEvidenceCount: allCitations.filter((item) => item.type === "graph" || item.graphId || item.nodeId).length,
    ragCitationCount: allCitations.length,
    profileEvidenceCount: mastery.reduce((sum, item) => sum + Number(item.evidenceCount || 0), 0) + nodeAnnotations.length,
    weakDrivenTopics: comparison.filter((item) => Number(item.current || 0) < 0.58).slice(0, 6).map((item) => item.topic),
    recommendedPath
  };
  const cycleCompletionReport = buildLearningCycleCompletionReport({
    cycle: cycleView,
    comparison,
    wrongNotes,
    reflections,
    citations: allCitations,
    counts: evidenceCounts,
    ethicsSettings
  });
  const effectPanel = buildLearningEffectPanel({
    comparison,
    events,
    wrongNotes,
    corrections,
    aiReviews,
    works,
    reflections,
    cycle: cycleView
  });
  const portfolio = {
    summary,
    learningCycle: {
      ...cycleView,
      subject: cycleView.subject || subject,
      goals: cycleView.goals?.length ? cycleView.goals : portfolioGoalsForSubject(subject),
      currentStage: stage,
      evidenceCounts,
      evidenceLoop: innovation.loop,
      completionReport: cycleCompletionReport
    },
    innovation,
    graphRagProfileCoupling,
    effectPanel,
    timeline,
    masteryComparison: comparison,
    aiSupportRecords,
    works,
    misconceptionTrajectory,
    reflections,
    reflectionExcerpts,
    corrections,
    aiReviews,
    nodeAnnotations,
    teacherEvaluations,
    collaboration,
    ethics: {
      settings: ethicsSettings,
      aiStatement: ethicsSettings.aiUseDisclosure
        ? "对话、诊断、资料引用和学习建议由 AI 辅助生成；最终答案、反思与作品提交由学生确认。"
        : "学生尚未开启 AI 使用声明展示，建议在参赛材料中显式说明 AI 辅助边界。",
      citationPolicy: ethicsSettings.citationRequired
        ? "AI 回答必须展示引用来源；没有引用或低置信度时仅作为待确认学习事件。"
        : "当前允许不强制引用，建议比赛演示时开启引用来源记录。",
      privacyPolicy: ethicsSettings.dataConsent
        ? "导出时可匿名化学生姓名、ID 和班级；教师端默认以统计和证据摘要为主。"
        : "学生尚未授权将个人学习数据用于档案展示，只保留本地个人可见记录。",
      integrityMode: ethicsSettings.requireOriginalAnswerFirst
        ? "推荐先作答再求助，诊断时要求保留学生原始理解，AI 生成内容不直接作为最终答案。"
        : "当前未强制先作答再求助，建议在正式实施周期中启用。"
    },
    showcase: {
      background: `${summary.student.name} 在 ${subject} 学习中围绕核心概念、错因修正和反思形成证据链。`,
      intervention: "知识图谱、GraphRAG 引用、AI 诊断、知识测试、错题修正、结构化反思和学习档案导出。",
      period: "4 周学习周期，可用于小样本深描或班级推广。",
      effect: {
        prePostTopics: comparison.length,
        masteryImproved: comparison.filter((item) => Number(item.change || 0) > 0).length,
        wrongNotes: wrongNotes.length,
        reflections: reflections.length,
        evidenceEvents: events.length,
        learningGain: effectPanel.learningGain,
        learningGainText: effectPanel.learningGainText
      },
      reflectionExcerpts,
      transfer: "同一证据链可迁移到其他课程：前测、AI 学习、图谱节点、测试、错因、反思、后测、导出。",
      norms: "保留引用、不确定性提示、学生授权、匿名导出和知识点定位纠错。"
    },
    exports: ["html", "pdf", "csv", "json", "application", "script"]
  };
  portfolio.declarationEvidencePack = buildDeclarationEvidencePack({ portfolio, events, citations: allCitations, aiReviews });
  return portfolio;
}

function studentPortfolioJson(portfolio) {
  return JSON.stringify(portfolio, null, 2);
}

function studentPortfolioCsv(portfolio) {
  const rows = [
    ["section", "time", "type", "topic", "score", "summary"],
    ...portfolio.timeline.map((item) => ["timeline", reportDate(item.time), item.type, item.title, item.score, item.summary]),
    ...portfolio.masteryComparison.map((item) => ["mastery", reportDate(item.lastAt), "前后测对比", item.topic, item.currentText, `起始 ${item.startText}，变化 ${item.changeText}`]),
    ...portfolio.reflections.map((item) => ["reflection", reportDate(item.createdAt), "结构化反思", item.knowledgePoint || item.contextTitle || "", "", [item.originalUnderstanding, item.aiDiscovery, item.aiAgreement, item.strategyChange, item.aiLimitation, item.nextPlan, item.antiOverreliance].filter(Boolean).join("；")]),
    ...(portfolio.aiReviews || []).map((item) => ["ai_review", reportDate(item.createdAt), item.reviewType, item.topic || "", item.trustScore === null || item.trustScore === undefined ? "" : `${Math.round(Number(item.trustScore || 0) * 100)}%`, item.comment || item.studentAction || ""]),
    ...((portfolio.innovation?.points || []).map((item) => ["innovation", reportDate(portfolio.summary.generatedAt), "教育创新点", item.title, "", [item.summary, ...(item.evidence || []), item.evaluationValue].filter(Boolean).join("；")])),
    ...((portfolio.declarationEvidencePack?.exportMaterials || []).map((item) => ["evidence_pack", reportDate(portfolio.summary.generatedAt), "申报材料", item, "", portfolio.declarationEvidencePack?.anonymization || ""]))
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function studentPortfolioHtml(portfolio, options = {}) {
  const printScript = options.print ? `<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),300));</script>` : "";
  const stats = portfolio.learningCycle.evidenceCounts;
  const statRows = [
    ["AI 对话", stats.aiDialogues],
    ["知识测试", stats.knowledgeTests],
    ["掌握变化", stats.masteryChanges],
    ["错题", stats.wrongNotes],
    ["反思", stats.reflections],
    ["作品/实验", stats.learningOutputs || (stats.homeworkOutputs + stats.modelExperiments)]
  ];
  const tableRows = (rows, columns) => rows.length
    ? rows.map((row) => `<tr>${columns.map((column) => `<td>${reportHtmlEscape(row[column] ?? "")}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${columns.length}">暂无记录</td></tr>`;
  const innovationRows = (portfolio.innovation?.points || []).map((point, index) => ({
    序号: index + 1,
    创新点: point.title,
    教育价值: point.summary,
    证据指标: (point.evidence || []).join("；"),
    申报对应: point.evaluationValue || ""
  }));
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>学生学习证据档案</title>
  <style>
    body{font-family:"Microsoft YaHei",Arial,sans-serif;margin:0;color:#172033;background:#f6f8fb;}
    main{max-width:1080px;margin:0 auto;padding:34px;}
    section{background:#fff;border:1px solid #dfe7f1;border-radius:8px;padding:22px;margin:0 0 18px;}
    h1,h2,h3,p{margin:0;} h1{font-size:30px;} h2{font-size:20px;margin-bottom:12px;} p{line-height:1.7;color:#536476;}
    .hero{display:grid;grid-template-columns:1.4fr .8fr;gap:18px;align-items:start;}
    .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px;}
    .stat{border:1px solid #edf2f7;border-radius:8px;padding:12px;background:#f8fafc;} .stat strong{display:block;font-size:24px;}
    table{width:100%;border-collapse:collapse;font-size:14px;} th,td{border-bottom:1px solid #edf2f7;text-align:left;vertical-align:top;padding:10px;} th{color:#536476;background:#f8fafc;}
    .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;} .chips span{border:1px solid #dfe7f1;border-radius:999px;padding:7px 10px;background:#f8fafc;}
    @media print{body{background:#fff;} main{padding:0;} section{break-inside:avoid;box-shadow:none;}}
  </style>
</head>
<body>
<main>
  <section class="hero">
    <div>
      <h1>${reportHtmlEscape(portfolio.summary.student.name)}学习证据档案</h1>
      <p>${reportHtmlEscape(portfolio.learningCycle.title)} · 当前阶段：${reportHtmlEscape(portfolio.learningCycle.currentStage.activeLabel)} · 生成时间：${reportDate(portfolio.summary.generatedAt)}</p>
      <div class="chips">${portfolio.learningCycle.goals.map((goal) => `<span>${reportHtmlEscape(goal)}</span>`).join("")}</div>
    </div>
    <div class="stats">${statRows.map(([label, value]) => `<div class="stat"><strong>${reportHtmlEscape(value)}</strong><span>${reportHtmlEscape(label)}</span></div>`).join("")}</div>
  </section>
  <section><h2>${reportHtmlEscape(portfolio.innovation?.title || "证据驱动的 AI 学习闭环")}</h2><p>${reportHtmlEscape(portfolio.innovation?.thesis || "")}</p><p>${reportHtmlEscape(portfolio.innovation?.positioning || "")}</p><div class="chips">${(portfolio.innovation?.loop || []).map((item) => `<span>${reportHtmlEscape(item)}</span>`).join("")}</div></section>
  <section><h2>五个教育创新点</h2><table><thead><tr><th>序号</th><th>创新点</th><th>教育价值</th><th>证据指标</th><th>申报对应</th></tr></thead><tbody>${tableRows(innovationRows, ["序号", "创新点", "教育价值", "证据指标", "申报对应"])}</tbody></table></section>
  <section><h2>GraphRAG + 学习画像</h2><p>${reportHtmlEscape(portfolio.graphRagProfileCoupling?.description || "")}</p><div class="stats"><div class="stat"><strong>${reportHtmlEscape(portfolio.graphRagProfileCoupling?.ragCitationCount || 0)}</strong><span>RAG 引用</span></div><div class="stat"><strong>${reportHtmlEscape(portfolio.graphRagProfileCoupling?.graphEvidenceCount || 0)}</strong><span>图谱证据</span></div><div class="stat"><strong>${reportHtmlEscape(portfolio.graphRagProfileCoupling?.profileEvidenceCount || 0)}</strong><span>画像证据</span></div></div></section>
  <section><h2>学习时间线</h2><table><thead><tr><th>时间</th><th>类型</th><th>主题</th><th>分数</th><th>摘要</th></tr></thead><tbody>${tableRows(portfolio.timeline.slice(0, 60).map((item) => ({ 时间: reportDate(item.time), 类型: item.type, 主题: item.title, 分数: item.score, 摘要: item.summary })), ["时间", "类型", "主题", "分数", "摘要"])}</tbody></table></section>
  <section><h2>前测/后测与掌握度变化</h2><table><thead><tr><th>知识点</th><th>起始</th><th>当前</th><th>变化</th><th>证据数</th></tr></thead><tbody>${tableRows(portfolio.masteryComparison.map((item) => ({ 知识点: item.topic, 起始: item.startText, 当前: item.currentText, 变化: item.changeText, 证据数: item.evidenceCount })), ["知识点", "起始", "当前", "变化", "证据数"])}</tbody></table></section>
  <section><h2>AI 支持记录</h2><table><thead><tr><th>时间</th><th>知识点</th><th>帮助方式</th><th>引用</th><th>采纳</th></tr></thead><tbody>${tableRows(portfolio.aiSupportRecords.map((item) => ({ 时间: reportDate(item.time), 知识点: item.topic, 帮助方式: item.help, 引用: item.citations.join("、"), 采纳: item.adopted })), ["时间", "知识点", "帮助方式", "引用", "采纳"])}</tbody></table></section>
  <section><h2>AI 审辩记录</h2><table><thead><tr><th>时间</th><th>知识点</th><th>类型</th><th>可信度</th><th>说明</th></tr></thead><tbody>${tableRows((portfolio.aiReviews || []).map((item) => ({ 时间: reportDate(item.createdAt), 知识点: item.topic, 类型: item.reviewType, 可信度: item.trustScore === null || item.trustScore === undefined ? "" : `${Math.round(Number(item.trustScore || 0) * 100)}%`, 说明: item.comment || item.studentAction || "" })), ["时间", "知识点", "类型", "可信度", "说明"])}</tbody></table></section>
  <section><h2>作品证据</h2><table><thead><tr><th>时间</th><th>类型</th><th>标题</th><th>状态</th><th>摘要</th></tr></thead><tbody>${tableRows(portfolio.works.map((item) => ({ 时间: reportDate(item.time), 类型: item.type, 标题: item.title, 状态: [item.status, item.score].filter(Boolean).join(" · "), 摘要: item.summary })), ["时间", "类型", "标题", "状态", "摘要"])}</tbody></table></section>
  <section><h2>错因变化与个人反思</h2><table><thead><tr><th>时间</th><th>主题</th><th>原理解/发现/判断/策略/计划</th></tr></thead><tbody>${tableRows(portfolio.reflections.map((item) => ({ 时间: reportDate(item.createdAt), 主题: item.knowledgePoint || item.contextTitle || "学习反思", "原理解/发现/判断/策略/计划": [item.originalUnderstanding, item.aiDiscovery, item.aiAgreement, item.strategyChange, item.aiLimitation, item.nextPlan, item.antiOverreliance].filter(Boolean).join("；") })), ["时间", "主题", "原理解/发现/判断/策略/计划"])}</tbody></table></section>
  <section><h2>申报证据包</h2><p>${reportHtmlEscape(portfolio.declarationEvidencePack?.anonymization || "")}</p><div class="chips">${(portfolio.declarationEvidencePack?.exportMaterials || []).map((item) => `<span>${reportHtmlEscape(item)}</span>`).join("")}</div></section>
  <section><h2>规范机制</h2><p>${reportHtmlEscape(portfolio.ethics.aiStatement)}</p><p>${reportHtmlEscape(portfolio.ethics.citationPolicy)}</p><p>${reportHtmlEscape(portfolio.ethics.privacyPolicy)}</p></section>
</main>${printScript}</body></html>`;
}

function studentPortfolioApplicationJson(portfolio) {
  return JSON.stringify({
    title: `${portfolio.learningCycle?.title || "学习周期"}申报表素材`,
    generatedAt: portfolio.summary?.generatedAt || now(),
    student: portfolio.summary?.student,
    subject: portfolio.summary?.subject,
    sections: portfolio.declarationEvidencePack?.applicationSections || buildDeclarationApplicationSections(portfolio),
    effectPanel: portfolio.effectPanel,
    evidencePack: portfolio.declarationEvidencePack,
    exports: portfolio.exports
  }, null, 2);
}

function studentPortfolioVideoScript(portfolio) {
  const outline = portfolio.declarationEvidencePack?.videoScriptOutline || buildVideoScriptOutline(portfolio);
  const lines = [
    `# 3-5 分钟展示视频脚本提纲`,
    "",
    `案例：${portfolio.learningCycle?.title || "AI 支持的完整学习周期"}`,
    `学生：${portfolio.summary?.student?.name || "匿名学生"} · 学科：${portfolio.summary?.subject || ""}`,
    "",
    ...outline.flatMap((item, index) => [
      `## ${index + 1}. ${item.time} ${item.shot}`,
      `旁白：${item.narration}`,
      `证据：${item.evidence || "待补充"}`,
      ""
    ])
  ];
  return lines.join("\n");
}

function buildStudentPortfolioExportPayload(db, userId, format = "json", options = {}) {
  const portfolio = buildStudentPortfolio(db, userId, options);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const normalizedFormat = ["json", "csv", "html", "pdf", "application", "script"].includes(String(format).toLowerCase()) ? String(format).toLowerCase() : "json";
  const anonymized = options.anonymous ? "-anonymous" : "";
  if (normalizedFormat === "csv") return { format: "csv", fileName: `student-portfolio${anonymized}-${stamp}.csv`, mime: "text/csv;charset=utf-8", content: studentPortfolioCsv(portfolio), portfolio };
  if (normalizedFormat === "application") return { format: "application", fileName: `application-material${anonymized}-${stamp}.json`, mime: "application/json;charset=utf-8", content: studentPortfolioApplicationJson(portfolio), portfolio };
  if (normalizedFormat === "script") return { format: "script", fileName: `video-script${anonymized}-${stamp}.md`, mime: "text/markdown;charset=utf-8", content: studentPortfolioVideoScript(portfolio), portfolio };
  if (normalizedFormat === "html" || normalizedFormat === "pdf") {
    return {
      format: normalizedFormat,
      fileName: normalizedFormat === "pdf" ? `student-portfolio${anonymized}-${stamp}-print.html` : `student-portfolio${anonymized}-${stamp}.html`,
      mime: "text/html;charset=utf-8",
      content: studentPortfolioHtml(portfolio, { print: normalizedFormat === "pdf" }),
      portfolio
    };
  }
  return { format: "json", fileName: `student-portfolio${anonymized}-${stamp}.json`, mime: "application/json;charset=utf-8", content: studentPortfolioJson(portfolio), portfolio };
}

function createStudentReflection(db, userId, body = {}) {
  db.studentReflections = Array.isArray(db.studentReflections) ? db.studentReflections : [];
  const reflection = {
    id: uid("refl"),
    studentId: userId,
    subject: String(body.subject || "").slice(0, 80),
    knowledgePoint: String(body.knowledgePoint || body.topic || "").slice(0, 120),
    contextType: String(body.contextType || "learning").slice(0, 60),
    contextId: String(body.contextId || "").slice(0, 120),
    contextTitle: String(body.contextTitle || body.title || "").slice(0, 160),
    originalUnderstanding: String(body.originalUnderstanding || "").slice(0, 1200),
    aiDiscovery: String(body.aiDiscovery || "").slice(0, 1200),
    aiAgreement: String(body.aiAgreement || "").slice(0, 800),
    strategyChange: String(body.strategyChange || body.changes || "").slice(0, 1200),
    uncertainty: String(body.uncertainty || "").slice(0, 1200),
    aiLimitation: String(body.aiLimitation || "").slice(0, 1000),
    nextPlan: String(body.nextPlan || "").slice(0, 1200),
    antiOverreliance: String(body.antiOverreliance || "").slice(0, 1000),
    aiUseBoundary: String(body.aiUseBoundary || "AI 用于提示、引用和诊断；最终理解、作答和反思由学生确认。").slice(0, 800),
    createdAt: now()
  };
  db.studentReflections.unshift(reflection);
  db.studentReflections = db.studentReflections.slice(0, 1200);
  const learningEvent = recordLearningEvent(db, {
    studentId: userId,
    eventType: "structured_reflection",
    source: "reflection-card",
    subject: reflection.subject,
    knowledgePoint: reflection.knowledgePoint,
    payload: {
      reflectionId: reflection.id,
      contextType: reflection.contextType,
      contextId: reflection.contextId,
      originalUnderstanding: reflection.originalUnderstanding,
      aiDiscovery: reflection.aiDiscovery,
      strategyChange: reflection.strategyChange,
      uncertainty: reflection.uncertainty,
      nextPlan: reflection.nextPlan
    },
    idempotencyKey: `reflection:${reflection.id}`
  });
  appendLearningEvidence(db, { studentId: userId, evidenceType: "reflection", relatedNodeIds: body.nodeId ? [body.nodeId] : [], eventId: learningEvent?.id || "", summary: reflection.strategyChange || reflection.nextPlan || reflection.originalUnderstanding });
  return { reflection, learningEvent };
}

function applyKnowledgeCorrection(db, userId, body = {}) {
  db.knowledgeCorrections = Array.isArray(db.knowledgeCorrections) ? db.knowledgeCorrections : [];
  const correctedTopic = String(body.correctedTopic || body.topic || "").trim().slice(0, 120);
  if (!correctedTopic) throw Object.assign(new Error("请填写纠正后的知识点"), { status: 400 });
  const eventId = String(body.eventId || "").trim();
  const diagnosisId = String(body.diagnosisId || "").trim();
  const messageId = String(body.messageId || "").trim();
  const event = eventId ? (db.learningEvents || []).find((item) => item.id === eventId && item.studentId === userId) : null;
  const diagnosis = diagnosisId
    ? (db.diagnosisResults || []).find((item) => item.id === diagnosisId && item.studentId === userId)
    : eventId ? (db.diagnosisResults || []).find((item) => item.eventId === eventId && item.studentId === userId) : null;
  const fromTopic = String(body.fromTopic || event?.knowledgePoint || diagnosis?.topic || "").trim();
  const correction = {
    id: uid("corr"),
    studentId: userId,
    eventId,
    diagnosisId: diagnosis?.id || diagnosisId,
    messageId,
    fromTopic,
    correctedTopic,
    confidence: normalizeLearningScore(body.confidence) ?? null,
    reason: String(body.reason || "").slice(0, 800),
    candidates: Array.isArray(body.candidates) ? body.candidates.slice(0, 8) : [],
    createdAt: now()
  };
  db.knowledgeCorrections.unshift(correction);
  db.knowledgeCorrections = db.knowledgeCorrections.slice(0, 1000);
  if (event) {
    event.knowledgePoint = correctedTopic;
    event.payload = compactLearningPayload({
      ...(event.payload || {}),
      correctedTopic,
      previousTopic: fromTopic,
      correctionId: correction.id,
      topicLocalization: {
        ...(event.payload?.topicLocalization || {}),
        selectedTopic: correctedTopic,
        corrected: true,
        needsConfirmation: false,
        policy: "学生已手动纠正知识点，学习事件已重新归档。"
      }
    });
  }
  if (diagnosis) {
    diagnosis.topic = correctedTopic;
    diagnosis.correctedTopic = correctedTopic;
    diagnosis.previousTopic = fromTopic;
  }
  const learningEvent = recordLearningEvent(db, {
    studentId: userId,
    eventType: "knowledge_point_corrected",
    source: "student-correction",
    subject: String(body.subject || event?.subject || "").trim(),
    knowledgePoint: correctedTopic,
    graphId: String(event?.graphId || body.graphId || "").trim(),
    nodeId: String(event?.nodeId || body.nodeId || "").trim(),
    payload: {
      correctionId: correction.id,
      eventId,
      diagnosisId: correction.diagnosisId,
      messageId,
      fromTopic,
      correctedTopic,
      reason: correction.reason,
      candidates: correction.candidates
    },
    idempotencyKey: `knowledge-correction:${correction.id}`
  });
  syncStudentMasteryFromProfile(db, userId, [correctedTopic], {
    subject: String(body.subject || event?.subject || "").trim(),
    graphId: String(event?.graphId || body.graphId || "").trim(),
    nodeId: String(event?.nodeId || body.nodeId || "").trim(),
    lastEventId: learningEvent?.id || ""
  });
  return { correction, learningEvent, event, diagnosis };
}

function createAiAnswerReview(db, userId, body = {}) {
  db.aiAnswerReviews = Array.isArray(db.aiAnswerReviews) ? db.aiAnswerReviews : [];
  const reviewType = String(body.reviewType || body.type || "trust_review").trim().slice(0, 80);
  const topic = String(body.topic || body.knowledgePoint || "").trim().slice(0, 120);
  const trustScore = normalizeLearningScore(body.trustScore);
  const accepted = ["accepted", "partial_accept"].includes(reviewType) || body.accepted === true || body.accepted === "1";
  const issueTags = Array.isArray(body.issueTags) ? body.issueTags.map(String).filter(Boolean).slice(0, 12) : [];
  if (reviewType && !issueTags.includes(reviewType)) issueTags.unshift(reviewType);
  const review = {
    id: uid("airev"),
    studentId: userId,
    conversationId: String(body.conversationId || "").slice(0, 120),
    messageId: String(body.messageId || "").slice(0, 120),
    topic,
    reviewType,
    trustScore,
    accepted,
    issueTags: issueTags.slice(0, 12),
    comment: String(body.comment || "").slice(0, 1200),
    studentAction: String(body.studentAction || "").slice(0, 800),
    finalJudgment: String(body.finalJudgment || body.studentAction || "").slice(0, 1000),
    citationIssue: String(body.citationIssue || "").slice(0, 800),
    verificationNeed: String(body.verificationNeed || "").slice(0, 800),
    createdAt: now()
  };
  db.aiAnswerReviews.unshift(review);
  db.aiAnswerReviews = db.aiAnswerReviews.slice(0, 1200);
  const learningEvent = recordLearningEvent(db, {
    studentId: userId,
    eventType: "ai_answer_review",
    source: "student-ai-review",
    knowledgePoint: review.topic,
    score: review.trustScore,
    payload: {
      reviewId: review.id,
      conversationId: review.conversationId,
      messageId: review.messageId,
      reviewType: review.reviewType,
      accepted: review.accepted,
      issueTags: review.issueTags,
      comment: review.comment,
      studentAction: review.studentAction,
      finalJudgment: review.finalJudgment,
      citationIssue: review.citationIssue,
      verificationNeed: review.verificationNeed
    },
    idempotencyKey: `ai-answer-review:${review.id}`
  });
  return { review, learningEvent };
}

function requestBearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isDifyCallbackAuthorized(req) {
  const expected = String(DIFY_CALLBACK_TOKEN || "").trim();
  if (!isDifyCallbackTokenConfigured()) return false;
  return timingSafeEqualText(requestBearerToken(req), expected);
}

function parseJsonish(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function arrayFromJsonish(value) {
  const parsed = parseJsonish(value, value);
  if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  return String(parsed || "")
    .split(/[、,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function masteryStatusFromScore(score) {
  if (score < 0.35) return "未掌握";
  if (score < 0.58) return "模糊";
  if (score < 0.78) return "基本掌握";
  return "精通";
}

function setTopicMasteryScore(db, userId, topic, score, evidence, status = "") {
  const profile = ensureLearningProfile(db, userId);
  const current = profile.mastery[topic] || { score: 0.52, status: "待诊断", evidence: [] };
  const next = applyWeightedMasteryEvidence(current, {
    score: normalizeLearningScore(score),
    weight: 0.55,
    source: "structured_diagnosis",
    text: evidence,
    at: now()
  });
  if (status) next.status = status;
  profile.mastery[topic] = next;
  const normalized = next.score;
  const weakSet = new Set(profile.weakPoints || []);
  if (normalized < 0.58) weakSet.add(topic);
  else weakSet.delete(topic);
  profile.weakPoints = Array.from(weakSet).slice(0, 12);
  profile.updatedAt = now();
  return profile;
}

function normalizeLearningScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  if (score > 1 && score <= 100) return Number((score / 100).toFixed(4));
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

function compactLearningPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const copy = { ...payload };
  ["prompt", "question", "answer", "studentAnswer", "finalAnswer"].forEach((key) => {
    if (copy[key] !== undefined) copy[key] = String(copy[key] || "").slice(0, 1200);
  });
  return copy;
}

function recordLearningEvent(db, event = {}) {
  db.learningEvents = Array.isArray(db.learningEvents) ? db.learningEvents : [];
  const idempotencyKey = String(event.idempotencyKey || "").trim();
  if (idempotencyKey) {
    const existing = db.learningEvents.find((item) => item.idempotencyKey === idempotencyKey);
    if (existing) return existing;
  }
  const studentId = String(event.studentId || event.userId || "").trim();
  if (!studentId) return null;
  const item = {
    id: event.id || uid("learn"),
    studentId,
    classId: String(event.classId || "").trim(),
    teacherId: String(event.teacherId || "").trim(),
    subject: String(event.subject || "").trim(),
    eventType: String(event.eventType || "unknown").trim(),
    source: String(event.source || "").trim(),
    knowledgePoint: String(event.knowledgePoint || event.topic || "").trim(),
    graphId: String(event.graphId || "").trim(),
    nodeId: String(event.nodeId || "").trim(),
    homeworkId: String(event.homeworkId || "").trim(),
    submissionId: String(event.submissionId || "").trim(),
    score: normalizeLearningScore(event.score),
    durationSeconds: Number.isFinite(Number(event.durationSeconds)) ? Math.max(0, Math.round(Number(event.durationSeconds))) : null,
    payload: compactLearningPayload(event.payload || {}),
    idempotencyKey,
    occurredAt: event.occurredAt || now(),
    createdAt: now()
  };
  db.learningEvents.unshift(item);
  db.learningEvents = db.learningEvents.slice(0, 5000);
  appendLearningEvidence(db, {
    studentId,
    evidenceType: event.evidenceType || event.eventType || "learning_event",
    relatedNodeIds: event.nodeId ? [event.nodeId] : [],
    relatedMisconceptionId: event.misconceptionId || "",
    eventId: item.id,
    summary: event.evidenceSummary || `${item.eventType}${item.knowledgePoint ? `：${item.knowledgePoint}` : ""}`
  });
  return item;
}

function recordDiagnosisResult(db, result = {}) {
  db.diagnosisResults = Array.isArray(db.diagnosisResults) ? db.diagnosisResults : [];
  const idempotencyKey = String(result.idempotencyKey || "").trim();
  if (idempotencyKey) {
    const existing = db.diagnosisResults.find((item) => item.idempotencyKey === idempotencyKey);
    if (existing) return existing;
  }
  const studentId = String(result.studentId || result.userId || "").trim();
  if (!studentId) return null;
  const item = {
    id: result.id || uid("diag"),
    studentId,
    eventId: String(result.eventId || "").trim(),
    topic: String(result.topic || "").trim(),
    masteryScore: normalizeLearningScore(result.masteryScore),
    masteryLevel: String(result.masteryLevel || "").trim(),
    errorTags: Array.isArray(result.errorTags) ? result.errorTags.map(String).filter(Boolean).slice(0, 20) : [],
    missingPoints: Array.isArray(result.missingPoints) ? result.missingPoints.map(String).filter(Boolean).slice(0, 20) : [],
    evidence: Array.isArray(result.evidence) ? result.evidence.slice(0, 12) : [],
    finalAnswer: String(result.finalAnswer || "").slice(0, 3000),
    modelOrWorkflow: String(result.modelOrWorkflow || "").trim(),
    idempotencyKey,
    createdAt: now()
  };
  db.diagnosisResults.unshift(item);
  db.diagnosisResults = db.diagnosisResults.slice(0, 3000);
  const evidence = appendLearningEvidence(db, { studentId, evidenceType: "diagnosis", relatedNodeIds: result.nodeId ? [result.nodeId] : [], summary: item.finalAnswer || item.topic, eventId: item.eventId });
  (item.errorTags || []).forEach((tag) => upsertMisconceptionRecord(db, { studentId, nodeId: result.nodeId || "", misconceptionType: tag, evidenceId: evidence?.id || "", action: "diagnosed", detail: item.finalAnswer, status: "active" }));
  return item;
}

function syncStudentMasteryFromProfile(db, userId, topics = [], options = {}) {
  db.studentMastery = Array.isArray(db.studentMastery) ? db.studentMastery : [];
  const profile = ensureLearningProfile(db, userId);
  const user = getUser(db, userId);
  const subject = String(options.subject || user?.subject || "").trim();
  const uniqueTopics = Array.from(new Set((Array.isArray(topics) ? topics : [topics]).map(String).map((item) => item.trim()).filter(Boolean))).slice(0, 12);
  uniqueTopics.forEach((topic) => {
    const mastery = profile.mastery?.[topic];
    if (!mastery) return;
    const existing = db.studentMastery.find((item) => item.studentId === userId && item.subject === subject && item.knowledgePoint === topic);
    const snapshot = {
      studentId: userId,
      subject,
      knowledgePoint: topic,
      graphId: String(options.graphId || existing?.graphId || "").trim(),
      nodeId: String(options.nodeId || existing?.nodeId || "").trim(),
      score: normalizeLearningScore(mastery.score),
      status: String(mastery.status || "").trim(),
      evidenceCount: Array.isArray(mastery.evidence) ? mastery.evidence.length : 0,
      lastEventId: String(options.lastEventId || existing?.lastEventId || "").trim(),
      updatedAt: mastery.updatedAt || now()
    };
    if (existing) Object.assign(existing, snapshot);
    else db.studentMastery.push(snapshot);
    appendNodeMasterySnapshot(db, userId, snapshot.nodeId || topic, snapshot.score, options.source || "mastery_update", snapshot.lastEventId);
  });
  return db.studentMastery.filter((item) => item.studentId === userId);
}

function normalizeDifyCallbackPayload(body = {}) {
  const root = typeof body === "string" ? parseJsonish(body, {}) : body;
  const rootObject = root && typeof root === "object" && !Array.isArray(root) ? root : {};
  const rawCallbackPayload = rootObject.callback_payload ?? rootObject.payload ?? rootObject[""] ?? rootObject.body ?? root;
  const callbackPayload = parseJsonish(rawCallbackPayload, rawCallbackPayload || {});
  const callbackObject = callbackPayload && typeof callbackPayload === "object" && !Array.isArray(callbackPayload) ? callbackPayload : {};
  const structured = parseJsonish(rootObject.structured_result ?? callbackObject.structured_result, rootObject.structured_result || callbackObject.structured_result || {});
  const payload = {
    ...callbackObject,
    ...rootObject
  };
  payload.structured_result = {
    ...(typeof structured === "object" ? structured : {}),
    ...(typeof payload.structured_result === "object" ? payload.structured_result : {})
  };
  return payload;
}

function difyCitationsFromEvidence(evidence = []) {
  const items = Array.isArray(evidence) ? evidence : arrayFromJsonish(evidence);
  return items.slice(0, 8).map((item, index) => {
    const source = item && typeof item === "object" ? item : { quote: String(item || "") };
    return {
      id: source.id || `E${index + 1}`,
      type: source.type || "dify-evidence",
      title: source.title || source.sourceName || "Dify RAG 证据",
      sourceName: source.sourceName || source.title || "",
      subject: source.subject || "机器学习",
      chapter: source.chapter || "",
      page: source.page || "",
      quote: source.quote || source.text || source.content || "",
      materialId: source.materialId || "",
      ownerId: source.ownerId || "",
      global: Boolean(source.global),
      classId: source.classId || "",
      ragChannel: source.ragChannel || "dify",
      graphId: source.graphId || "",
      nodeId: source.nodeId || ""
    };
  });
}

function syncDifyDiagnosisCallback(db, rawBody, req) {
  const payload = normalizeDifyCallbackPayload(rawBody);
  const structured = payload.structured_result || {};
  const userId = String(payload.student_id || payload.studentId || payload.userId || "").trim();
  const topic = String(payload.topic_label || structured.topic_label || "机器学习诊断").trim();
  const question = String(payload.question || structured.question || "").trim();
  const studentAnswer = String(payload.student_answer || payload.studentAnswer || "").trim();
  const finalAnswer = String(payload.final_answer || structured.final_answer || structured.standard_answer || "").trim();
  if (!userId) {
    return {
      skipped: true,
      reason: "missing_student_id",
      message: "Dify 测试运行未提供 student_id，项目端已跳过数据库写入；从前端 AI 助教触发时会自动传入当前学生 ID。",
      topic,
      hasFinalAnswer: Boolean(finalAnswer)
    };
  }
  const user = getUser(db, userId);
  if (!user) {
    throw Object.assign(new Error("Dify 回调中的 student_id 不存在"), { status: 404 });
  }
  const rawScore = Number(payload.mastery_score ?? structured.mastery_score);
  const normalizedScore = Number.isFinite(rawScore) ? (rawScore > 1 ? rawScore / 100 : rawScore) : null;
  const errors = arrayFromJsonish(payload.error_tags || structured.error_tags);
  const missing = arrayFromJsonish(payload.missing_points || structured.missing_points);
  const masteryLevel = String(payload.mastery_level || structured.mastery_level || "");
  const ragEvidence = parseJsonish(payload.rag_evidence ?? structured.rag_evidence, payload.rag_evidence || structured.rag_evidence || []);
  const citations = difyCitationsFromEvidence(ragEvidence);
  const syncMode = String(payload.sync_mode || payload.syncMode || "").trim();
  const conversationId = String(payload.conversation_id || payload.conversationId || "").trim();
  const workflow = buildMlDiagnosisWorkflowTrace({
    retrieval: { hits: [], courseHits: [], mistakeHits: [] },
    citations,
    mode: studentAnswer ? "grade" : "qa",
    topics: [topic].filter(Boolean),
    hasStudentAnswer: Boolean(studentAnswer)
  });
  let profile = ensureLearningProfile(db, userId);
  const shouldWriteMastery = normalizedScore !== null && (Boolean(studentAnswer) || (masteryLevel && masteryLevel !== "未诊断" && normalizedScore > 0));
  if (shouldWriteMastery) {
    profile = setTopicMasteryScore(
      db,
      userId,
      topic,
      normalizedScore,
      `Dify 工作流回调：${question.slice(0, 80) || topic}`,
      masteryLevel
    );
  }
  const callbackRequestId = String(payload.request_id || payload.requestId || "").trim();
  const learningEvent = recordLearningEvent(db, {
    studentId: userId,
    eventType: "dify_diagnosis",
    source: "dify",
    subject: String(payload.subject || structured.subject || user.subject || ""),
    knowledgePoint: topic,
    score: normalizedScore,
    payload: {
      requestId: callbackRequestId,
      syncMode,
      conversationId,
      question,
      studentAnswer,
      finalAnswer,
      masteryLevel,
      errorTags: errors,
      missingPoints: missing,
      citations
    },
    idempotencyKey: callbackRequestId ? `dify:${callbackRequestId}` : ""
  });
  recordDiagnosisResult(db, {
    studentId: userId,
    eventId: learningEvent?.id || "",
    topic,
    masteryScore: normalizedScore,
    masteryLevel,
    errorTags: errors,
    missingPoints: missing,
    evidence: Array.isArray(ragEvidence) ? ragEvidence : [],
    finalAnswer,
    modelOrWorkflow: "dify-student-diagnosis",
    idempotencyKey: callbackRequestId ? `dify-diagnosis:${callbackRequestId}` : ""
  });
  if (shouldWriteMastery) {
    syncStudentMasteryFromProfile(db, userId, [topic], {
      subject: String(payload.subject || structured.subject || user.subject || ""),
      lastEventId: learningEvent?.id || ""
    });
  }
  let wrongNote = null;
  if (studentAnswer && (errors.length || missing.length || (normalizedScore !== null && normalizedScore < 0.75))) {
    wrongNote = addWrongNote(db, userId, {
      source: "Dify 工作流诊断",
      topic,
      question,
      answer: studentAnswer,
      analysis: errors.length ? `错因：${errors.join("、")}` : "Dify 工作流建议复盘该知识点。",
      recommendation: missing.length ? `补齐：${missing.join("、")}` : "按标准解释重写答案并完成同类题。"
    });
  }
  if (learningEvent && wrongNote) learningEvent.payload.wrongNoteId = wrongNote.id;
  let conversation = null;
  const skipConversationWrite = syncMode === "api-return" || syncMode === "api_return";
  if (!skipConversationWrite && (question || finalAnswer)) {
    conversation = conversationId ? (db.conversations || []).find((item) => item.id === conversationId && item.userId === userId) : null;
    if (conversation) {
      if (question && !(conversation.messages || []).some((message) => message.role === "user" && message.content === question)) {
        conversation.messages.push({ id: uid("msg"), role: "user", content: [question, studentAnswer ? `学生答案：${studentAnswer}` : ""].filter(Boolean).join("\n\n"), createdAt: now() });
      }
      conversation.messages.push({
        id: uid("msg"),
        role: "assistant",
        content: finalAnswer || "Dify 工作流已完成诊断，但未返回 final_answer。",
        citations,
        confidence: "dify",
        mode: studentAnswer ? "grade" : "qa",
        intent: studentAnswer ? "grade" : "qa",
        strategy: "Dify 多 RAG 学习诊断工作流",
        knowledgePoints: [topic],
        workflow,
        workflowResult: {
          ...structured,
          topic_label: topic,
          mastery_score: Number.isFinite(rawScore) ? rawScore : 0,
          mastery_level: masteryLevel || "未诊断",
          error_tags: errors,
          missing_points: missing,
          rag_evidence: Array.isArray(ragEvidence) ? ragEvidence : [],
          final_answer: finalAnswer,
          source: "dify-callback",
          request_id: payload.request_id || payload.requestId || ""
        },
        retrieved: [],
        createdAt: now()
      });
      conversation.updatedAt = now();
    } else {
      conversation = {
        id: uid("conv"),
        userId,
        role: user.role,
        title: question.slice(0, 24) || `Dify 诊断：${topic}`.slice(0, 24),
        mode: studentAnswer ? "grade" : "qa",
        messages: [
          { id: uid("msg"), role: "user", content: [question, studentAnswer ? `学生答案：${studentAnswer}` : ""].filter(Boolean).join("\n\n"), createdAt: now() },
          {
            id: uid("msg"),
            role: "assistant",
            content: finalAnswer || "Dify 工作流已完成诊断，但未返回 final_answer。",
            citations,
            confidence: "dify",
            mode: studentAnswer ? "grade" : "qa",
            intent: studentAnswer ? "grade" : "qa",
            strategy: "Dify 多 RAG 学习诊断工作流",
            knowledgePoints: [topic],
            workflow,
            workflowResult: {
              ...structured,
              topic_label: topic,
              mastery_score: Number.isFinite(rawScore) ? rawScore : 0,
              mastery_level: masteryLevel || "未诊断",
              error_tags: errors,
              missing_points: missing,
              rag_evidence: Array.isArray(ragEvidence) ? ragEvidence : [],
              final_answer: finalAnswer,
              source: "dify-callback",
              request_id: payload.request_id || payload.requestId || ""
            },
            retrieved: [],
            createdAt: now()
          }
        ],
        createdAt: now(),
        updatedAt: now()
      };
      db.conversations.unshift(conversation);
    }
  }
  db.agentRuns = Array.isArray(db.agentRuns) ? db.agentRuns : [];
  db.agentRuns.unshift({
    id: uid("run"),
    userId,
    conversationId: conversation?.id || conversationId || "",
    mode: studentAnswer ? "grade" : "qa",
    prompt: question.slice(0, 240),
    confidence: "dify",
    citations,
    retrieved: [],
    intent: studentAnswer ? "grade" : "qa",
    strategy: "Dify 多 RAG 学习诊断工作流",
    knowledgePoints: [topic],
    tools: ["dify_workflow_callback", "structured_json_output", shouldWriteMastery ? "update_mastery" : ""].filter(Boolean),
    workflow,
    workflowResult: {
      ...structured,
      topic_label: topic,
      mastery_score: Number.isFinite(rawScore) ? rawScore : 0,
      mastery_level: masteryLevel || "未诊断",
      error_tags: errors,
      missing_points: missing,
      rag_evidence: Array.isArray(ragEvidence) ? ragEvidence : [],
      final_answer: finalAnswer,
      source: "dify-callback",
      request_id: payload.request_id || payload.requestId || "",
      sync_mode: syncMode
    },
    steps: workflow.steps,
    createdAt: now()
  });
  db.agentRuns = db.agentRuns.slice(0, 200);
  recordAudit(db, null, "dify.diagnosis_callback", {
    actorId: "dify-workflow",
    actorRole: "integration",
    resourceType: "learningProfile",
    resourceId: userId,
    meta: { topic, masteryScore: shouldWriteMastery ? normalizedScore : null, wrongNoteId: wrongNote?.id || "", conversationId: conversation?.id || conversationId || "", syncMode }
  }, req);
  return {
    userId,
    topic,
    skippedConversationWrite: skipConversationWrite,
    conversationId: conversation?.id || conversationId || "",
    wrongNoteId: wrongNote?.id || "",
    masteryUpdated: shouldWriteMastery,
    mastery: profile.mastery?.[topic] || null
  };
}

function gradeSubmissionWithFeedback(db, homework, submission) {
  const rubric = parseRubricInput(homework.rubric?.length ? homework.rubric : homework.rubricText, homework);
  const rubricResults = rubric.map((criterion) => evaluateCriterion(criterion, submission.answerText));
  const rubricScore = rubricResults.reduce((sum, item) => sum + item.score, 0);
  const fallbackScore = scoreMatch(homework.answer, submission.answerText);
  const score = rubricResults.length ? Math.max(0, Math.min(100, rubricScore)) : fallbackScore;
  const referenceTokens = tokenizeForSearch(`${homework.answer} ${rubric.map((item) => item.expected).join(" ")}`);
  const answerTokens = new Set(tokenizeForSearch(submission.answerText));
  const missing = referenceTokens.filter((token) => !answerTokens.has(token)).slice(0, 8);
  const topics = inferQuestionTopics(`${homework.title} ${homework.description} ${homework.answer}`, "");
  const strengths = score >= 75 ? "答案覆盖了主要要点，结构基本完整。" : "答案已经给出部分相关内容，但关键条件或步骤还不完整。";
  const weakness = missing.length ? `缺少或表达不清：${missing.join("、")}。` : "主要关键词已覆盖，建议补充更完整的推理过程。";
  const comment = [
    `AI 评分建议：${score} 分（需教师确认后才作为正式成绩）。`,
    strengths,
    weakness,
    "建议教师复核图片/视频附件中的关键步骤，最终分数以教师确认为准。"
  ].join(" ");
  return { score, comment, missing, topics, rubric, rubricResults };
}

function findOrCreateDirectThread(db, userA, userB) {
  let thread = db.chatThreads.find((item) => item.type === "direct" && item.memberIds.includes(userA) && item.memberIds.includes(userB));
  if (!thread) {
    const a = getUser(db, userA);
    const b = getUser(db, userB);
    thread = {
      id: uid("thread"),
      type: "direct",
      name: `${a ? a.name : userA} / ${b ? b.name : userB}`,
      memberIds: [userA, userB],
      messages: [],
      createdAt: now(),
      updatedAt: now()
    };
    db.chatThreads.push(thread);
  }
  return thread;
}

function areFriends(db, userId, friendId) {
  return db.friendships.some((item) => item.userId === userId && item.friendId === friendId);
}

function publicChatThreadForUser(thread, userId) {
  return {
    ...thread,
    memberIds: Array.isArray(thread.memberIds) ? thread.memberIds : [],
    adminIds: Array.isArray(thread.adminIds) ? thread.adminIds : [],
    pendingInviteIds: Array.isArray(thread.pendingInviteIds) ? thread.pendingInviteIds : [],
    messages: (thread.messages || []).filter((message) => !(message.deletedFor || []).includes(userId))
  };
}

function visibleFriendRequests(db, userId) {
  return (db.friendRequests || [])
    .filter((item) => item.fromUserId === userId || item.toUserId === userId)
    .slice(-120);
}

function visibleChatInvites(db, userId) {
  const ownedGroupIds = new Set((db.chatThreads || [])
    .filter((thread) => thread.type === "group" && thread.ownerId === userId)
    .map((thread) => thread.id));
  return (db.chatInvites || [])
    .filter((item) => item.fromUserId === userId || item.toUserId === userId || ownedGroupIds.has(item.threadId))
    .slice(-160);
}

function addSystemChatMessage(thread, content) {
  thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
  thread.messages.push({
    id: uid("chat"),
    fromUserId: "system",
    system: true,
    content: String(content || ""),
    createdAt: now(),
    deletedFor: []
  });
  thread.updatedAt = now();
}

function addFriendship(db, userId, friendId) {
  if (userId === friendId) throw Object.assign(new Error("不能添加自己为好友"), { status: 400 });
  if (!areFriends(db, userId, friendId)) db.friendships.push({ userId, friendId, createdAt: now() });
  if (!areFriends(db, friendId, userId)) db.friendships.push({ userId: friendId, friendId: userId, createdAt: now() });
  return findOrCreateDirectThread(db, userId, friendId);
}

function resolveUserByTarget(db, targetText) {
  const target = normalizeAccountInput(targetText);
  if (!target) return { error: Object.assign(new Error("请输入用户 ID 或姓名"), { status: 400 }) };
  const loginId = extractLoginId(target);
  let user = loginId ? db.users.find((item) => item.id === loginId) : null;
  if (!user) {
    const nameMatches = db.users.filter((item) => item.name === target);
    if (nameMatches.length > 1) return { error: Object.assign(new Error("该姓名对应多个用户，请使用 8 位 ID"), { status: 409 }) };
    user = nameMatches[0] || null;
  }
  if (!user) return { error: Object.assign(new Error("未找到用户，请检查 ID 或姓名"), { status: 404 }) };
  return { user };
}

function createFriendRequest(db, fromUserId, toUserId, message = "") {
  if (fromUserId === toUserId) throw Object.assign(new Error("不能添加自己为好友"), { status: 400 });
  const toUser = ensureUser(db, toUserId);
  if (areFriends(db, fromUserId, toUserId)) {
    return { status: "already_friends", thread: findOrCreateDirectThread(db, fromUserId, toUserId), friend: toUser };
  }
  const reverse = (db.friendRequests || []).find((item) => item.status === "pending" && item.fromUserId === toUserId && item.toUserId === fromUserId);
  if (reverse) {
    return { status: "accepted_reverse", request: respondFriendRequest(db, reverse.id, fromUserId, "accept"), thread: findOrCreateDirectThread(db, fromUserId, toUserId), friend: toUser };
  }
  let request = (db.friendRequests || []).find((item) => item.status === "pending" && item.fromUserId === fromUserId && item.toUserId === toUserId);
  if (!request) {
    request = {
      id: uid("friendReq"),
      fromUserId,
      toUserId,
      message: String(message || "").slice(0, 160),
      status: "pending",
      createdAt: now(),
      updatedAt: now()
    };
    db.friendRequests.unshift(request);
  }
  return { status: "pending", request, friend: toUser };
}

function respondFriendRequest(db, requestId, userId, action) {
  const request = (db.friendRequests || []).find((item) => item.id === requestId);
  if (!request) throw Object.assign(new Error("好友申请不存在"), { status: 404 });
  if (request.toUserId !== userId) throw Object.assign(new Error("只能处理发给自己的好友申请"), { status: 403 });
  if (request.status !== "pending") throw Object.assign(new Error("该好友申请已处理"), { status: 409 });
  request.status = action === "accept" ? "accepted" : "rejected";
  request.respondedAt = now();
  request.updatedAt = now();
  if (request.status === "accepted") request.threadId = addFriendship(db, request.fromUserId, request.toUserId).id;
  return request;
}

function ensureGroupOwner(thread, userId) {
  if (!thread || thread.type !== "group") throw Object.assign(new Error("群聊不存在"), { status: 404 });
  if (thread.ownerId !== userId) throw Object.assign(new Error("只有群主可以执行该操作"), { status: 403 });
}

function createChatInvite(db, thread, fromUserId, toUserId) {
  if (!thread || thread.type !== "group") throw Object.assign(new Error("群聊不存在"), { status: 404 });
  if (!thread.memberIds.includes(fromUserId)) throw Object.assign(new Error("只有群成员可以邀请好友入群"), { status: 403 });
  if (thread.memberIds.includes(toUserId)) return null;
  if (!areFriends(db, fromUserId, toUserId)) throw Object.assign(new Error("只能邀请自己的好友入群"), { status: 403 });
  let invite = (db.chatInvites || []).find((item) => item.threadId === thread.id && item.toUserId === toUserId && item.status === "pending");
  if (!invite) {
    invite = {
      id: uid("chatInvite"),
      threadId: thread.id,
      groupName: thread.name,
      fromUserId,
      toUserId,
      status: "pending",
      createdAt: now(),
      updatedAt: now()
    };
    db.chatInvites.unshift(invite);
  }
  thread.pendingInviteIds = Array.from(new Set([...(thread.pendingInviteIds || []), toUserId]));
  thread.updatedAt = now();
  return invite;
}

function respondChatInvite(db, inviteId, userId, action) {
  const invite = (db.chatInvites || []).find((item) => item.id === inviteId);
  if (!invite) throw Object.assign(new Error("群聊邀请不存在"), { status: 404 });
  if (invite.toUserId !== userId) throw Object.assign(new Error("只能处理发给自己的群聊邀请"), { status: 403 });
  if (invite.status !== "pending") throw Object.assign(new Error("该群聊邀请已处理"), { status: 409 });
  const thread = db.chatThreads.find((item) => item.id === invite.threadId && item.type === "group");
  if (!thread) throw Object.assign(new Error("群聊不存在"), { status: 404 });
  invite.status = action === "accept" ? "accepted" : "rejected";
  invite.respondedAt = now();
  invite.updatedAt = now();
  thread.pendingInviteIds = (thread.pendingInviteIds || []).filter((id) => id !== userId);
  if (invite.status === "accepted" && !thread.memberIds.includes(userId)) {
    thread.memberIds.push(userId);
    const user = getUser(db, userId);
    addSystemChatMessage(thread, `${user?.name || userId} 已加入群聊`);
  }
  thread.updatedAt = now();
  return { invite, thread };
}

function classTeacherIdsForUser(db, user) {
  if (!user || user.role !== "student") return [];
  const classIds = user.classIds || [];
  return Array.from(new Set((db.classes || [])
    .filter((klass) => classIds.includes(klass.id) || (klass.studentIds || []).includes(user.id))
    .map((klass) => klass.teacherId)
    .filter(Boolean)));
}

function syncUserPrimaryClassName(db, user, excludedClassId = "") {
  if (!user || user.role !== "student") return;
  const classIds = Array.isArray(user.classIds) ? user.classIds.map(String) : [];
  const primaryClass = (db.classes || []).find((klass) => klass.id !== excludedClassId && classIds.includes(klass.id));
  user.className = primaryClass?.name || "";
  user.updatedAt = now();
}

function removeStudentFromClass(db, klass, studentId) {
  const id = String(studentId || "");
  const student = getUser(db, id);
  const classStudentIds = Array.isArray(klass.studentIds) ? klass.studentIds.map(String) : [];
  const wasInClass = classStudentIds.includes(id);
  let hadUserClass = false;

  klass.studentIds = classStudentIds.filter((item) => item !== id);
  klass.updatedAt = now();

  if (student) {
    const classIds = Array.isArray(student.classIds) ? student.classIds.map(String) : [];
    hadUserClass = classIds.includes(klass.id);
    student.classIds = classIds.filter((classId) => classId !== klass.id);
    syncUserPrimaryClassName(db, student);
  }

  return { student, removed: wasInClass || hadUserClass };
}

function visibleKnowledgeGraphs(db, userId) {
  const user = ensureUser(db, userId);
  if (user.role === "admin") return db.knowledgeGraphs || [];
  return (db.knowledgeGraphs || []).filter((graph) => (
    graph.ownerId === userId
    || (user.role === "student" && graph.global)
  ));
}

function routePattern(pathname, pattern) {
  const a = pathname.split("/").filter(Boolean);
  const b = pattern.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < b.length; i += 1) {
    if (b[i].startsWith(":")) params[b[i].slice(1)] = decodeURIComponent(a[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

function getRelevantState(db, userId) {
  const user = ensureUser(db, userId);
  const classIds = user.role === "teacher"
    ? db.classes.filter((item) => item.teacherId === userId).map((item) => item.id)
    : (user.classIds || []);
  const visibleUserIds = new Set([userId]);
  db.friendships.filter((item) => item.userId === userId).forEach((item) => visibleUserIds.add(item.friendId));
  visibleFriendRequests(db, userId).forEach((item) => {
    visibleUserIds.add(item.fromUserId);
    visibleUserIds.add(item.toUserId);
  });
  visibleChatInvites(db, userId).forEach((item) => {
    visibleUserIds.add(item.fromUserId);
    visibleUserIds.add(item.toUserId);
  });
  db.chatThreads.filter((thread) => thread.memberIds.includes(userId)).forEach((thread) => thread.memberIds.forEach((id) => visibleUserIds.add(id)));
  db.classes
    .filter((item) => item.teacherId === userId || item.studentIds.includes(userId))
    .forEach((klass) => {
      visibleUserIds.add(klass.teacherId);
      klass.studentIds.forEach((id) => visibleUserIds.add(id));
    });
  db.submissions
    .filter((item) => item.studentId === userId || db.homework.some((homework) => homework.id === item.homeworkId && homework.teacherId === userId))
    .forEach((item) => visibleUserIds.add(item.studentId));
  return {
    user: publicUser(user),
    users: (user.role === "admin" ? db.users : db.users.filter((item) => visibleUserIds.has(item.id))).map(publicUser),
    knowledgeGraphs: visibleKnowledgeGraphs(db, userId).map((graph) => enhanceGraphForEducation(graph)),
    conversations: db.conversations.filter((conv) => conv.userId === userId),
    models: db.models.filter((model) => model.ownerId === userId),
    friends: db.friendships.filter((item) => item.userId === userId).map((item) => publicUser(getUser(db, item.friendId))).filter(Boolean),
    friendRequests: visibleFriendRequests(db, userId),
    chatInvites: visibleChatInvites(db, userId),
    chatThreads: db.chatThreads.filter((thread) => thread.memberIds.includes(userId)).map((thread) => publicChatThreadForUser(thread, userId)),
    classes: db.classes.filter((item) => item.teacherId === userId || item.studentIds.includes(userId)),
    homework: db.homework.filter((item) => item.teacherId === userId || classIds.includes(item.classId)),
    submissions: db.submissions.filter((item) => item.studentId === userId || db.homework.some((homework) => homework.id === item.homeworkId && homework.teacherId === userId)),
    courseMaterials: visibleCourseMaterials(db, userId).map(publicCourseMaterial),
    learningProfile: ensureLearningProfile(db, userId),
    wrongNotes: (db.wrongNotes || []).filter((item) => item.userId === userId || (user.role === "teacher" && db.classes.some((klass) => klass.teacherId === userId && (klass.studentIds || []).includes(item.userId)))).slice(0, 300),
    studentMastery: (db.studentMastery || []).filter((item) => item.studentId === userId || (user.role === "teacher" && db.classes.some((klass) => klass.teacherId === userId && (klass.studentIds || []).includes(item.studentId)))).slice(0, 500),
    misconceptionRecords: (db.misconceptionRecords || []).filter((item) => item.studentId === userId || (user.role === "teacher" && db.classes.some((klass) => klass.teacherId === userId && (klass.studentIds || []).includes(item.studentId)))).slice(0, 300),
    prePostAssessments: (db.prePostAssessments || []).filter((item) => item.studentId === userId).slice(0, 100),
    learningPathRecommendations: (db.learningPathRecommendations || []).filter((item) => item.studentId === userId).slice(0, 50),
    nodeMasterySnapshots: (db.nodeMasterySnapshots || []).filter((item) => item.studentId === userId).slice(0, 500),
    experimentSubmissions: (db.experimentSubmissions || []).filter((item) => item.studentId === userId).slice(0, 100),
    learningEvidence: (db.learningEvidence || []).filter((item) => item.studentId === userId || (user.role === "teacher" && db.classes.some((klass) => klass.teacherId === userId && (klass.studentIds || []).includes(item.studentId)))).slice(0, 500),
    studentReflections: (db.studentReflections || []).filter((item) => item.studentId === userId).slice(0, 80),
    knowledgeCorrections: (db.knowledgeCorrections || []).filter((item) => item.studentId === userId).slice(0, 80),
    aiAnswerReviews: (db.aiAnswerReviews || []).filter((item) => item.studentId === userId).slice(0, 80),
    learningCycles: (db.learningCycles || []).filter((item) => item.studentId === userId).slice(0, 20),
    studentNodeAnnotations: (db.studentNodeAnnotations || []).filter((item) => item.studentId === userId).slice(0, 200),
    studentEthicsSettings: getStudentEthicsSettings(db, userId),
    studentDataDeletionRequests: (db.studentDataDeletionRequests || []).filter((item) => item.studentId === userId).slice(0, 20),
    learningAnalytics: learningAnalytics(db, userId),
    studentPortfolio: user.role === "student" ? buildStudentPortfolio(db, userId) : null,
    agentRuns: (db.agentRuns || []).filter((item) => item.userId === userId).slice(0, 30)
  };
}

function reportDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleString("zh-CN", { hour12: false });
}

function reportCompactText(value, maxLength = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function reportScorePercent(value) {
  const normalized = normalizeLearningScore(value);
  return normalized === null ? "" : Math.round(normalized * 100);
}

function reportHtmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function reportEventLabel(type) {
  return {
    ai_diagnosis: "AI 诊断",
    ai_question: "AI 问答",
    dify_diagnosis: "AI 诊断",
    knowledge_test_evaluate: "知识测验",
    homework_grade_confirmed: "作业批改确认",
    wrong_note: "错题记录",
    ai_answer_review: "AI 审辩",
    knowledge_point_corrected: "知识点纠正",
    student_node_annotation: "图谱节点证据",
    data_deletion_request: "数据管理",
    manual_mastery_update: "掌握度调整",
    student_mastery_snapshot: "掌握度快照"
  }[String(type || "")] || String(type || "学习事件");
}

function reportStatusLabel(status) {
  return {
    submitted: "已提交",
    review_pending: "待教师确认",
    graded: "已批改"
  }[String(status || "")] || String(status || "未提交");
}

function sectionColumns(rows = []) {
  const seen = new Set();
  rows.forEach((row) => Object.keys(row || {}).forEach((key) => seen.add(key)));
  return Array.from(seen);
}

function buildAdminExportReport(db) {
  const students = (db.users || [])
    .filter((user) => user.role === "student")
    .sort((a, b) => String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id)));
  const studentIds = new Set(students.map((student) => student.id));
  const aliasByStudentId = new Map(students.map((student, index) => [student.id, `S${String(index + 1).padStart(3, "0")}`]));
  const classById = new Map((db.classes || []).map((klass) => [klass.id, klass]));
  const homeworkById = new Map((db.homework || []).map((item) => [item.id, item]));
  const graphById = new Map((db.knowledgeGraphs || []).map((item) => [item.id, item]));
  const userById = new Map((db.users || []).map((user) => [user.id, user]));
  const profileByUserId = new Map((db.learningProfiles || []).map((profile) => [profile.userId, profile]));
  const events = (db.learningEvents || []).filter((event) => studentIds.has(event.studentId));

  const classNamesForStudent = (student) => {
    const ids = new Set(Array.isArray(student.classIds) ? student.classIds : []);
    (db.classes || []).forEach((klass) => {
      if ((klass.studentIds || []).includes(student.id)) ids.add(klass.id);
    });
    const names = Array.from(ids).map((id) => classById.get(id)?.name).filter(Boolean);
    return names.length ? names.join("、") : (student.className || "未加入班级");
  };
  const eventsForStudent = (studentId) => events
    .filter((event) => event.studentId === studentId)
    .sort((a, b) => String(a.occurredAt || a.createdAt || "").localeCompare(String(b.occurredAt || b.createdAt || "")));

  const anonymousStudents = students.map((student) => {
    const profile = profileByUserId.get(student.id) || {};
    const studentEvents = eventsForStudent(student.id);
    const masteryItems = Object.values(profile.mastery || {});
    const averageMastery = masteryItems.length
      ? `${Math.round(masteryItems.reduce((sum, item) => sum + Number(item.score || 0), 0) / masteryItems.length * 100)}%`
      : "未诊断";
    return {
      匿名编号: aliasByStudentId.get(student.id),
      班级: classNamesForStudent(student),
      学习事件数: studentEvents.length,
      AI对话数: (db.conversations || []).filter((conv) => conv.userId === student.id).length,
      作业提交数: (db.submissions || []).filter((item) => item.studentId === student.id).length,
      错题数: (db.wrongNotes || []).filter((item) => item.userId === student.id).length,
      平均掌握度: averageMastery,
      最近活动: reportDate(studentEvents.at(-1)?.occurredAt || profile.updatedAt || student.updatedAt || student.createdAt)
    };
  });

  const learningTimeline = events
    .sort((a, b) => String(a.occurredAt || a.createdAt || "").localeCompare(String(b.occurredAt || b.createdAt || "")))
    .map((event) => ({
      匿名编号: aliasByStudentId.get(event.studentId),
      时间: reportDate(event.occurredAt || event.createdAt),
      类型: reportEventLabel(event.eventType),
      学科: event.subject || "",
      知识点: event.knowledgePoint || "",
      分数: event.score === null || event.score === undefined ? "" : `${reportScorePercent(event.score)}%`,
      来源: event.source || "",
      摘要: reportCompactText(event.payload?.prompt || event.payload?.question || event.payload?.homeworkTitle || event.payload?.evidence || event.payload?.analysis || "", 140)
    }));

  const prePostScores = students.map((student) => {
    const scored = [];
    eventsForStudent(student.id).forEach((event) => {
      if (event.score !== null && event.score !== undefined) scored.push({ at: event.occurredAt || event.createdAt, score: event.score, source: reportEventLabel(event.eventType), topic: event.knowledgePoint || "" });
    });
    (db.submissions || []).filter((item) => item.studentId === student.id && item.score !== undefined).forEach((submission) => {
      const homework = homeworkById.get(submission.homeworkId);
      scored.push({ at: submission.gradedAt || submission.confirmedAt || submission.updatedAt || submission.createdAt, score: submission.score, source: "作业成绩", topic: homework?.title || "" });
    });
    (db.diagnosisResults || []).filter((item) => item.studentId === student.id && item.masteryScore !== null && item.masteryScore !== undefined).forEach((result) => {
      scored.push({ at: result.createdAt, score: result.masteryScore, source: result.modelOrWorkflow || "诊断结果", topic: result.topic || "" });
    });
    scored.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
    const first = scored[0];
    const last = scored.at(-1);
    const pre = reportScorePercent(first?.score);
    const post = reportScorePercent(last?.score);
    return {
      匿名编号: aliasByStudentId.get(student.id),
      前测时间: reportDate(first?.at),
      前测来源: first?.source || "",
      前测知识点: first?.topic || "",
      前测成绩: pre === "" ? "" : `${pre}%`,
      后测时间: reportDate(last?.at),
      后测来源: last?.source || "",
      后测知识点: last?.topic || "",
      后测成绩: post === "" ? "" : `${post}%`,
      变化: pre === "" || post === "" ? "暂无成对数据" : `${post - pre >= 0 ? "+" : ""}${post - pre}%`,
      记录数: scored.length
    };
  });

  const aiConversationSummary = (db.conversations || [])
    .filter((conv) => studentIds.has(conv.userId))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .map((conv) => {
      const messages = Array.isArray(conv.messages) ? conv.messages : [];
      const userMessages = messages.filter((message) => message.role === "user");
      const assistantMessages = messages.filter((message) => message.role === "assistant");
      return {
        匿名编号: aliasByStudentId.get(conv.userId),
        对话标题: conv.title || "新的对话",
        模式: conv.mode || "",
        开始时间: reportDate(conv.createdAt),
        最近更新: reportDate(conv.updatedAt),
        轮次数: Math.max(userMessages.length, assistantMessages.length),
        学生问题摘要: reportCompactText(userMessages.map((message) => message.content).join("；"), 180),
        AI回答摘要: reportCompactText(assistantMessages.map((message) => message.content).join("；"), 180)
      };
    });

  const masteryGroups = new Map();
  events.filter((event) => event.knowledgePoint && event.score !== null && event.score !== undefined).forEach((event) => {
    const key = `${event.studentId}:${event.subject || ""}:${event.knowledgePoint}`;
    const items = masteryGroups.get(key) || [];
    items.push(event);
    masteryGroups.set(key, items);
  });
  (db.studentMastery || []).filter((item) => studentIds.has(item.studentId)).forEach((item) => {
    const key = `${item.studentId}:${item.subject || ""}:${item.knowledgePoint}`;
    if (!masteryGroups.has(key)) masteryGroups.set(key, [{ ...item, eventType: "student_mastery_snapshot", occurredAt: item.updatedAt }]);
  });
  const masteryChanges = Array.from(masteryGroups.values()).map((items) => {
    items.sort((a, b) => String(a.occurredAt || a.createdAt || "").localeCompare(String(b.occurredAt || b.createdAt || "")));
    const first = items[0];
    const last = items.at(-1);
    const start = reportScorePercent(first?.score);
    const end = reportScorePercent(last?.score);
    return {
      匿名编号: aliasByStudentId.get(last.studentId),
      学科: last.subject || first.subject || "",
      知识点: last.knowledgePoint || first.knowledgePoint || "",
      关联图谱: graphById.get(last.graphId || first.graphId)?.title || "",
      初始掌握度: start === "" ? "" : `${start}%`,
      当前掌握度: end === "" ? "" : `${end}%`,
      变化: start === "" || end === "" ? "暂无变化" : `${end - start >= 0 ? "+" : ""}${end - start}%`,
      最近证据: reportEventLabel(last.eventType),
      最近更新时间: reportDate(last.occurredAt || last.createdAt)
    };
  });

  const homeworkResults = (db.submissions || [])
    .filter((submission) => studentIds.has(submission.studentId))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
    .map((submission) => {
      const homework = homeworkById.get(submission.homeworkId);
      const klass = homework ? classById.get(homework.classId) : null;
      const teacher = homework ? userById.get(homework.teacherId) : null;
      return {
        匿名编号: aliasByStudentId.get(submission.studentId),
        班级: klass?.name || "",
        作业或测验: homework?.title || submission.homeworkId || "",
        学科: homework?.subject || klass?.subject || "",
        教师: teacher?.name || "",
        状态: reportStatusLabel(submission.status),
        分数: submission.score === undefined ? "" : `${reportScorePercent(submission.score)}%`,
        AI建议分: submission.aiSuggestedScore === undefined ? "" : `${reportScorePercent(submission.aiSuggestedScore)}%`,
        提交时间: reportDate(submission.createdAt || submission.updatedAt),
        批改时间: reportDate(submission.gradedAt || submission.confirmedAt),
        反馈摘要: reportCompactText(submission.comment || submission.aiComment || submission.feedback?.reliability || "", 160)
      };
    });

  const testResults = events
    .filter((event) => event.eventType === "knowledge_test_evaluate")
    .sort((a, b) => String(b.occurredAt || b.createdAt || "").localeCompare(String(a.occurredAt || a.createdAt || "")))
    .map((event) => ({
      匿名编号: aliasByStudentId.get(event.studentId),
      时间: reportDate(event.occurredAt || event.createdAt),
      学科: event.subject || "",
      知识点: event.knowledgePoint || "",
      题目ID: event.payload?.questionId || "",
      本题正确率: event.payload?.accuracy === undefined ? "" : `${Math.round(Number(event.payload.accuracy || 0))}%`,
      整体正确率: event.payload?.overall?.accuracy === undefined ? (event.score === undefined ? "" : `${reportScorePercent(event.score)}%`) : `${Math.round(Number(event.payload.overall.accuracy || 0))}%`,
      掌握判断: event.payload?.overall?.masteryLevel || "",
      缺失要点: Array.isArray(event.payload?.missing) ? event.payload.missing.join("、") : ""
    }));

  const wrongNoteChanges = (db.wrongNotes || [])
    .filter((note) => studentIds.has(note.userId))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((note) => ({
      匿名编号: aliasByStudentId.get(note.userId),
      时间: reportDate(note.createdAt),
      来源: note.source || "",
      知识点: note.topic || "",
      错题摘要: reportCompactText(note.question, 160),
      错答摘要: reportCompactText(note.answer, 120),
      错因分析: reportCompactText(note.analysis, 160),
      改进建议: reportCompactText(note.recommendation, 160)
    }));

  const reflectionPattern = /反思|复盘|总结|心得|收获|困惑|计划|自评/;
  const studentReflections = [];
  (db.conversations || []).filter((conv) => studentIds.has(conv.userId)).forEach((conv) => {
    (conv.messages || []).filter((message) => message.role === "user" && reflectionPattern.test(String(message.content || ""))).forEach((message) => {
      studentReflections.push({ 匿名编号: aliasByStudentId.get(conv.userId), 时间: reportDate(message.createdAt || conv.updatedAt), 来源: conv.title || "AI 对话", 摘要: reportCompactText(message.content, 220) });
    });
  });
  wrongNoteChanges.forEach((note) => {
    if (reflectionPattern.test(`${note.错题摘要} ${note.错答摘要} ${note.错因分析}`)) {
      studentReflections.push({ 匿名编号: note.匿名编号, 时间: note.时间, 来源: `错题反思：${note.知识点}`, 摘要: reportCompactText([note.错题摘要, note.错因分析, note.改进建议].filter(Boolean).join("；"), 220) });
    }
  });
  studentReflections.sort((a, b) => String(b.时间 || "").localeCompare(String(a.时间 || "")));

  const teacherGuidance = [];
  (db.submissions || []).filter((submission) => studentIds.has(submission.studentId) && (submission.comment || submission.aiComment || submission.feedback)).forEach((submission) => {
    const homework = homeworkById.get(submission.homeworkId);
    const teacher = homework ? userById.get(homework.teacherId) : null;
    teacherGuidance.push({
      匿名编号: aliasByStudentId.get(submission.studentId),
      时间: reportDate(submission.confirmedAt || submission.gradedAt || submission.aiGradedAt || submission.updatedAt),
      教师: teacher?.name || "",
      类型: submission.comment ? "教师评价" : "AI批改建议",
      关联任务: homework?.title || submission.homeworkId || "",
      记录摘要: reportCompactText(submission.comment || submission.aiComment || submission.feedback?.reliability || "", 220)
    });
  });
  (db.conversations || []).filter((conv) => ["teacher", "admin"].includes(userById.get(conv.userId)?.role)).forEach((conv) => {
    const owner = userById.get(conv.userId);
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    teacherGuidance.push({ 匿名编号: "全班/备课", 时间: reportDate(conv.updatedAt || conv.createdAt), 教师: owner?.name || "", 类型: "教师 AI 指导记录", 关联任务: conv.title || "教师对话", 记录摘要: reportCompactText(messages.map((message) => message.content).join("；"), 220) });
  });
  teacherGuidance.sort((a, b) => String(b.时间 || "").localeCompare(String(a.时间 || "")));

  const sections = [
    { key: "anonymousStudents", title: "匿名学生列表", rows: anonymousStudents },
    { key: "learningTimeline", title: "学习周期时间线", rows: learningTimeline },
    { key: "prePostScores", title: "前测/后测成绩", rows: prePostScores },
    { key: "aiConversationSummary", title: "AI 对话摘要", rows: aiConversationSummary },
    { key: "masteryChanges", title: "知识图谱掌握度变化", rows: masteryChanges },
    { key: "homeworkResults", title: "作业结果", rows: homeworkResults },
    { key: "testResults", title: "测验结果", rows: testResults },
    { key: "wrongNoteChanges", title: "错题变化", rows: wrongNoteChanges },
    { key: "studentReflections", title: "学生反思摘录", rows: studentReflections },
    { key: "teacherGuidance", title: "教师评价或指导记录", rows: teacherGuidance }
  ].map((section) => ({ ...section, columns: sectionColumns(section.rows) }));

  return {
    generatedAt: now(),
    scope: "管理员端匿名学习数据导出",
    summary: {
      students: students.length,
      classes: (db.classes || []).length,
      learningEvents: learningTimeline.length,
      aiConversations: aiConversationSummary.length,
      homeworkResults: homeworkResults.length,
      testResults: testResults.length,
      wrongNotes: wrongNoteChanges.length,
      reflections: studentReflections.length,
      teacherGuidance: teacherGuidance.length
    },
    sections
  };
}

function adminReportJson(report) {
  return JSON.stringify(report, null, 2);
}

function adminReportCsv(report) {
  const rows = [["区块", "序号", "字段", "值"]];
  report.sections.forEach((section) => {
    if (!section.rows.length) rows.push([section.title, "", "状态", "暂无数据"]);
    section.rows.forEach((row, index) => {
      Object.entries(row).forEach(([key, value]) => rows.push([section.title, index + 1, key, value]));
    });
  });
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

function adminReportHtml(report, { print = false } = {}) {
  const summaryCards = Object.entries(report.summary || {}).map(([key, value]) => `
    <article><span>${reportHtmlEscape(key)}</span><strong>${reportHtmlEscape(value)}</strong></article>
  `).join("");
  const sections = report.sections.map((section) => {
    const columns = section.columns.length ? section.columns : ["状态"];
    const rows = section.rows.length ? section.rows : [{ 状态: "暂无数据" }];
    return `
      <section>
        <h2>${reportHtmlEscape(section.title)}</h2>
        <table>
          <thead><tr>${columns.map((column) => `<th>${reportHtmlEscape(column)}</th>`).join("")}</tr></thead>
          <tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${reportHtmlEscape(row[column] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </section>
    `;
  }).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>管理员匿名学习数据导出</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 28px; font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif; color: #132033; background: #f5f8fb; }
    header { margin-bottom: 22px; }
    h1 { margin: 0 0 8px; font-size: 26px; }
    h2 { margin: 28px 0 12px; font-size: 18px; }
    p { margin: 0; color: #627086; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
    .summary article { padding: 14px; border: 1px solid #dbe5ee; border-radius: 8px; background: #fff; }
    .summary span { display: block; color: #627086; font-size: 12px; }
    .summary strong { display: block; margin-top: 6px; color: #145f85; font-size: 24px; }
    section { page-break-inside: avoid; margin-bottom: 18px; }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    th, td { border: 1px solid #dbe5ee; padding: 8px 10px; text-align: left; vertical-align: top; font-size: 12px; line-height: 1.55; }
    th { background: #eaf3f8; color: #16354a; font-weight: 700; }
    @media print { body { padding: 14mm; background: #fff; } th, td { font-size: 10px; } }
  </style>
</head>
<body>
  <header><h1>管理员匿名学习数据导出</h1><p>生成时间：${reportHtmlEscape(reportDate(report.generatedAt))}</p></header>
  <div class="summary">${summaryCards}</div>
  ${sections}
  ${print ? "<script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>" : ""}
</body>
</html>`;
}

function buildAdminExportPayload(db, format = "json") {
  const report = buildAdminExportReport(db);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const normalizedFormat = ["json", "csv", "html", "pdf"].includes(format) ? format : "json";
  if (normalizedFormat === "csv") return { format: "csv", fileName: `admin-learning-export-${stamp}.csv`, mime: "text/csv;charset=utf-8", content: adminReportCsv(report), report };
  if (normalizedFormat === "html" || normalizedFormat === "pdf") {
    return {
      format: normalizedFormat,
      fileName: normalizedFormat === "pdf" ? `admin-learning-export-${stamp}-print.html` : `admin-learning-export-${stamp}.html`,
      mime: "text/html;charset=utf-8",
      content: adminReportHtml(report, { print: normalizedFormat === "pdf" }),
      report
    };
  }
  return { format: "json", fileName: `admin-learning-export-${stamp}.json`, mime: "application/json;charset=utf-8", content: adminReportJson(report), report };
}

async function handleApi(req, res, pathname, searchParams) {
  const method = req.method;
  const db = readDb();

  if (method === "GET" && pathname === "/api/healthz") {
    const storage = dbStorageMetadata();
    const vectorStorage = knowledgeChunkStorage();
    const embedding = getEmbeddingProvider();
    return send(res, 200, {
      ok: true,
      status: "ok",
      version: process.env.npm_package_version || "1.0.0",
      time: now(),
      storage: storage.label,
      storageDriver: storage.driver,
      storagePath: storage.path,
      embedding: {
        provider: embedding.provider,
        model: embedding.model,
        enabled: embedding.enabled,
        chunks: vectorStorage?.knowledgeChunkStats?.() || null
      }
    });
  }

  if (method === "GET" && pathname === "/api/readyz") {
    const storage = dbStorageMetadata();
    const checks = {
      dataDirWritable: checkDataDirWritable(),
      runtimeDirWritable: checkRuntimeDirWritable(),
      sessionSecretConfigured: SESSION_SECRET_CONFIGURED,
      cookieSecure: process.env.COOKIE_SECURE === "true",
      studentModelConfigured: isConfiguredSecret(OPENAI_API_KEY),
      difyWorkflowConfigured: isDifyWorkflowConfigured(),
      difyTeacherWorkflowConfigured: isDifyTeacherWorkflowConfigured(),
      difyCallbackTokenConfigured: isDifyCallbackTokenConfigured(),
      storage: storage.label,
      storageDriver: storage.driver,
      storagePath: storage.path,
      uploadSessions: uploadSessions.size,
      graphJobs: graphJobs.size
    };
    const embedding = getEmbeddingProvider();
    checks.embeddingProviderConfigured = embedding.enabled;
    const warnings = [];
    if (!checks.sessionSecretConfigured) warnings.push("未配置强随机 SESSION_SECRET，仅适合本地开发");
    if (!checks.studentModelConfigured) warnings.push("未配置有效 OPENAI_API_KEY，学生端 AI 助教无法调用后端直连模型");
    if (!checks.difyTeacherWorkflowConfigured) warnings.push("未配置有效 DIFY_TEACHER_WORKFLOW_API_KEY，教师端教学 AI 助教会返回配置错误");
    if (!checks.difyCallbackTokenConfigured) warnings.push("未配置强随机 DIFY_CALLBACK_TOKEN，Dify 回调接口将拒绝默认令牌");
    if (!checks.embeddingProviderConfigured) warnings.push("未配置真实 Embedding，课程检索将暂时使用兼容性哈希向量；配置 EMBEDDING_API_KEY 后重建索引");
    if (process.env.NODE_ENV === "production" && !checks.cookieSecure) warnings.push("生产环境建议启用 COOKIE_SECURE=true 并使用 HTTPS");
    const ready = checks.dataDirWritable
      && checks.runtimeDirWritable
      && (process.env.NODE_ENV !== "production" || (
        checks.sessionSecretConfigured
        && checks.cookieSecure
        && checks.studentModelConfigured
        && checks.difyTeacherWorkflowConfigured
        && checks.difyCallbackTokenConfigured
      ));
    return send(res, ready ? 200 : 503, {
      ok: ready,
      status: ready ? "ready" : "not-ready",
      version: process.env.npm_package_version || "1.0.0",
      time: now(),
      checks,
      warnings
    });
  }

  if (method === "GET" && pathname === "/api/admin/export") {
    const actor = requireActor(req, db);
    requireRole(actor, ["admin"]);
    const format = String(searchParams.get("format") || "json").toLowerCase();
    const payload = buildAdminExportPayload(db, format);
    recordAudit(db, actor, "admin.export", {
      resourceType: "adminExport",
      resourceId: payload.fileName,
      meta: { format: payload.format, summary: payload.report.summary }
    }, req);
    writeDb(db);
    return send(res, 200, { ok: true, ...payload });
  }

  if (method === "POST" && pathname === "/api/auth/register") {
    const body = await readBody(req);
    assertRequired(body, ["name", "password", "role"]);
    const role = String(body.role || "").trim();
    if (!["teacher", "student"].includes(role)) throw Object.assign(new Error("身份必须是 teacher 或 student"), { status: 400 });
    const name = normalizeDisplayName(body.name);
    const password = normalizePasswordInput(body.password);
    const subject = role === "teacher" ? normalizeOptionalProfileField(body.subject, 40) : "";
    const className = role === "student" ? normalizeOptionalProfileField(body.className || body.subject, 60) : "";
    const user = {
      id: generateUserId(db),
      name,
      role,
      passwordHash: hashPassword(password),
      subject,
      className,
      classIds: [],
      avatar: name.slice(0, 1) || "用",
      createdAt: now(),
      lastLoginAt: now(),
      lastLoginIp: requestIp(req),
      failedLoginCount: 0,
      lockUntil: ""
    };
    db.users.push(user);
    recordAudit(db, user, "auth.register", { resourceType: "user", resourceId: user.id }, req);
    recordAudit(db, user, "auth.login", { resourceType: "user", resourceId: user.id, meta: { reason: "register_auto_login" } }, req);
    const state = getRelevantState(db, user.id);
    writeDb(db);
    return send(res, 201, { ok: true, user: publicUser(user), state, message: `注册成功，系统分配 ID：${user.id}` }, { "set-cookie": sessionCookie(user) });
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    const body = await readBody(req);
    assertRequired(body, ["account", "password"]);
    const account = normalizeAccountInput(body.account);
    if (!account) return sendError(res, 400, "账号不能为空");
    const password = String(body.password || "");
    if (password.length > 128) return sendError(res, 400, "密码不能超过 128 位");
    const loginId = extractLoginId(account);
    let user = loginId ? db.users.find((item) => item.id === loginId) : null;
    if (!user) {
      const nameMatches = db.users.filter((item) => item.name === account);
      if (nameMatches.length > 1) {
        recordAudit(db, null, "auth.login_failed", { meta: { account, reason: "duplicate_name" } }, req);
        writeDb(db);
        return sendError(res, 409, "该用户名存在多个账号，请使用系统分配的 8 位 ID 登录");
      }
      user = nameMatches[0] || null;
    }
    if (!user) {
      recordAudit(db, null, "auth.login_failed", { meta: { account, reason: "not_found" } }, req);
      writeDb(db);
      return sendError(res, 401, "账号或密码错误");
    }
    if (user.lockUntil && new Date(user.lockUntil).getTime() > Date.now()) {
      return sendError(res, 429, "登录失败次数过多，请稍后再试");
    }
    if (!verifyPassword(user, password)) {
      user.failedLoginCount = Number(user.failedLoginCount || 0) + 1;
      if (user.failedLoginCount >= LOGIN_MAX_FAILURES) {
        user.lockUntil = new Date(Date.now() + LOGIN_COOLDOWN_MS).toISOString();
      }
      recordAudit(db, user, "auth.login_failed", { resourceType: "user", resourceId: user.id, meta: { failedLoginCount: user.failedLoginCount } }, req);
      writeDb(db);
      return sendError(res, 401, "账号或密码错误");
    }
    migratePasswordIfNeeded(user, password);
    user.failedLoginCount = 0;
    user.lockUntil = "";
    user.lastLoginAt = now();
    user.lastLoginIp = requestIp(req);
    recordAudit(db, user, "auth.login", { resourceType: "user", resourceId: user.id }, req);
    writeDb(db);
    return send(res, 200, { ok: true, user: publicUser(user), state: getRelevantState(db, user.id) }, { "set-cookie": sessionCookie(user) });
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    const actor = getSessionUser(req, db);
    if (actor) {
      recordAudit(db, actor, "auth.logout", { resourceType: "user", resourceId: actor.id }, req);
      writeDb(db);
    }
    return send(res, 200, { ok: true }, { "set-cookie": clearSessionCookie() });
  }

  if (method === "GET" && pathname === "/api/session") {
    const actor = getSessionUser(req, db);
    if (!actor) return sendError(res, 401, "未登录");
    res.sessionActor = actor;
    return send(res, 200, { ok: true, user: publicUser(actor), state: getRelevantState(db, actor.id) });
  }

  if (method === "POST" && pathname === "/api/integrations/dify/diagnosis-callback") {
    if (!isDifyCallbackAuthorized(req)) return sendError(res, 401, "Dify 回调令牌无效");
    const body = await readBody(req);
    const synced = syncDifyDiagnosisCallback(db, body, req);
    writeDb(db);
    return send(res, 200, { ok: true, synced });
  }

  if (method === "POST" && pathname === "/api/integrations/dify/graph-context") {
    if (!isDifyCallbackAuthorized(req)) return sendError(res, 401, "Dify 图谱查询令牌无效");
    const body = await readBody(req);
    const requestUserId = String(body.request_user_id || body.requestUserId || body.user_id || body.userId || body.student_id || "").trim();
    const user = requestUserId ? getUser(db, requestUserId) : null;
    const hits = graphDatabaseHitsForWorkflow(db, user?.id || "", {
      question: body.question || body.query || "",
      subject: body.subject || "",
      chapter: body.chapter || "",
      knowledgePoint: body.knowledge_point || body.knowledgePoint || "",
      graphId: body.graph_id || body.graphId || "",
      nodeId: body.node_id || body.nodeId || "",
      limit: Math.max(1, Math.min(12, Number(body.limit || 8)))
    });
    const docs = difyProjectDocsFromHits(hits, "项目知识图谱数据库", 12);
    recordAudit(db, user || null, "dify.graph_context", {
      resourceType: "knowledgeGraph",
      resourceId: String(body.graph_id || body.graphId || ""),
      meta: { requestUserId, subject: body.subject || "", hits: docs.length }
    }, req);
    writeDb(db);
    return send(res, 200, {
      ok: true,
      source: "project-knowledge-graph-db",
      request_user_id: requestUserId,
      graph_id: String(body.graph_id || body.graphId || ""),
      node_id: String(body.node_id || body.nodeId || ""),
      documents: docs
    });
  }

  const actor = requireActor(req, db);
  res.sessionActor = actor;

  if (method === "GET" && pathname === "/api/state") {
    return send(res, 200, { ok: true, state: getRelevantState(db, actor.id) });
  }

  if (method === "GET" && pathname === "/api/student/portfolio") {
    requireRole(actor, ["student", "admin"]);
    const userId = queryUserId(searchParams, actor, "userId", "student");
    const anonymous = ["1", "true", "yes"].includes(String(searchParams.get("anonymous") || "").toLowerCase());
    return send(res, 200, { ok: true, portfolio: buildStudentPortfolio(db, userId, { anonymous }) });
  }

  if (method === "GET" && pathname === "/api/student/portfolio/export") {
    requireRole(actor, ["student", "admin"]);
    const userId = queryUserId(searchParams, actor, "userId", "student");
    const format = String(searchParams.get("format") || "json").toLowerCase();
    const anonymous = ["1", "true", "yes"].includes(String(searchParams.get("anonymous") || "").toLowerCase());
    const payload = buildStudentPortfolioExportPayload(db, userId, format, { anonymous });
    recordAudit(db, actor, "student.portfolio_export", {
      resourceType: "studentPortfolio",
      resourceId: userId,
      meta: { format: payload.format, anonymous, evidence: payload.portfolio.learningCycle.evidenceCounts }
    }, req);
    writeDb(db);
    return send(res, 200, { ok: true, ...payload });
  }

  if (method === "GET" && pathname === "/api/student/learning-cycle/templates") {
    requireRole(actor, ["student", "admin", "teacher"]);
    return send(res, 200, { ok: true, templates: learningCycleTemplateLibrary() });
  }

  if (method === "POST" && pathname === "/api/student/learning-cycle/suggest") {
    const body = await readBody(req);
    requireRole(actor, ["student", "admin"]);
    const userId = actor.role === "admin" && body.userId ? String(body.userId) : actor.id;
    ensureActorCanUseId(actor, userId, "student");
    const suggestion = suggestLearningCycleFromProfile(db, userId, body);
    recordAudit(db, actor, "student.learning_cycle_suggest", {
      resourceType: "learningCycle",
      resourceId: userId,
      meta: { title: suggestion.title, subject: suggestion.subject, focusNodes: suggestion.focusNodes }
    }, req);
    writeDb(db);
    return send(res, 200, { ok: true, suggestion, templates: learningCycleTemplateLibrary() });
  }

  if (method === "GET" && pathname === "/api/student/learning-cycle") {
    requireRole(actor, ["student", "admin"]);
    const userId = queryUserId(searchParams, actor, "userId", "student");
    const portfolio = buildStudentPortfolio(db, userId);
    return send(res, 200, { ok: true, cycle: portfolio.learningCycle, portfolio });
  }

  if (method === "POST" && pathname === "/api/student/learning-cycle") {
    const body = await readBody(req);
    requireRole(actor, ["student", "admin"]);
    const userId = actor.role === "admin" && body.userId ? String(body.userId) : actor.id;
    ensureActorCanUseId(actor, userId, "student");
    const cycle = upsertStudentLearningCycle(db, userId, body);
    recordAudit(db, actor, "student.learning_cycle_upsert", {
      resourceType: "learningCycle",
      resourceId: cycle.id,
      meta: { title: cycle.title, subject: cycle.subject, status: cycle.status }
    }, req);
    writeDb(db);
    return send(res, 200, { ok: true, cycle: buildStudentPortfolio(db, userId).learningCycle, portfolio: buildStudentPortfolio(db, userId) });
  }

  if (method === "POST" && pathname === "/api/student/learning-cycle/tasks") {
    const body = await readBody(req);
    requireRole(actor, ["student", "admin"]);
    const userId = actor.role === "admin" && body.userId ? String(body.userId) : actor.id;
    ensureActorCanUseId(actor, userId, "student");
    const cycle = updateLearningCycleTask(db, userId, body);
    recordAudit(db, actor, "student.learning_cycle_task", {
      resourceType: "learningCycle",
      resourceId: cycle.id,
      meta: { taskKey: body.taskKey || body.key, done: body.done }
    }, req);
    writeDb(db);
    const portfolio = buildStudentPortfolio(db, userId);
    return send(res, 200, { ok: true, cycle: portfolio.learningCycle, portfolio, learningAnalytics: learningAnalytics(db, userId) });
  }

  if (method === "POST" && pathname === "/api/student/reflections") {
    const body = await readBody(req);
    requireRole(actor, ["student", "admin"]);
    const userId = actor.role === "admin" && body.userId ? String(body.userId) : actor.id;
    ensureActorCanUseId(actor, userId, "student");
    const result = createStudentReflection(db, userId, body);
    recordAudit(db, actor, "student.reflection_create", {
      resourceType: "studentReflection",
      resourceId: result.reflection.id,
      meta: { topic: result.reflection.knowledgePoint, contextType: result.reflection.contextType }
    }, req);
    writeDb(db);
    return send(res, 201, { ok: true, ...result, portfolio: buildStudentPortfolio(db, userId), learningAnalytics: learningAnalytics(db, userId) });
  }

  if (method === "POST" && pathname === "/api/student/knowledge-corrections") {
    const body = await readBody(req);
    requireRole(actor, ["student", "admin"]);
    const userId = actor.role === "admin" && body.userId ? String(body.userId) : actor.id;
    ensureActorCanUseId(actor, userId, "student");
    const result = applyKnowledgeCorrection(db, userId, body);
    const correctionEvent = recordLearningEvent(db, { studentId: userId, eventType: "misconception_intervention", source: "student-correction", knowledgePoint: result.correction.correctedTopic, nodeId: body.nodeId || "", payload: { correctionId: result.correction.id, fromTopic: result.correction.fromTopic, correctedTopic: result.correction.correctedTopic, intervention: body.intervention || "订正与变式练习" }, evidenceType: "intervention" });
    result.correction.eventId = correctionEvent?.id || "";
    const misconception = (db.misconceptionRecords || []).find((item) => item.id === result.correction.misconceptionId || (item.studentId === userId && item.misconceptionType === result.correction.fromTopic));
    if (misconception) { misconception.status = "intervened"; misconception.lastSeen = now(); misconception.interventionHistory = [...(misconception.interventionHistory || []), { at: now(), action: "correction_submitted", detail: result.correction.reason || "学生完成订正", evidenceId: result.correction.id }].slice(-20); }
    recordAudit(db, actor, "student.knowledge_correction", {
      resourceType: "knowledgeCorrection",
      resourceId: result.correction.id,
      meta: { fromTopic: result.correction.fromTopic, correctedTopic: result.correction.correctedTopic }
    }, req);
    writeDb(db);
    return send(res, 201, { ok: true, ...result, portfolio: buildStudentPortfolio(db, userId), learningAnalytics: learningAnalytics(db, userId) });
  }

  if (method === "POST" && pathname === "/api/student/ai-answer-reviews") {
    const body = await readBody(req);
    requireRole(actor, ["student", "admin"]);
    const userId = actor.role === "admin" && body.userId ? String(body.userId) : actor.id;
    ensureActorCanUseId(actor, userId, "student");
    const result = createAiAnswerReview(db, userId, body);
    recordAudit(db, actor, "student.ai_answer_review", {
      resourceType: "aiAnswerReview",
      resourceId: result.review.id,
      meta: { topic: result.review.topic, reviewType: result.review.reviewType, accepted: result.review.accepted }
    }, req);
    writeDb(db);
    return send(res, 201, { ok: true, ...result, portfolio: buildStudentPortfolio(db, userId), learningAnalytics: learningAnalytics(db, userId) });
  }

  if (method === "POST" && pathname === "/api/student/node-annotations") {
    const body = await readBody(req);
    requireRole(actor, ["student", "admin"]);
    const userId = actor.role === "admin" && body.userId ? String(body.userId) : actor.id;
    ensureActorCanUseId(actor, userId, "student");
    const result = createStudentNodeAnnotation(db, userId, body);
    recordAudit(db, actor, "student.node_annotation", {
      resourceType: "studentNodeAnnotation",
      resourceId: result.annotation.id,
      meta: { graphId: result.annotation.graphId, nodeId: result.annotation.nodeId, status: result.annotation.status }
    }, req);
    writeDb(db);
    return send(res, 201, { ok: true, ...result, portfolio: buildStudentPortfolio(db, userId), learningAnalytics: learningAnalytics(db, userId) });
  }

  if (method === "POST" && pathname === "/api/student/ethics-settings") {
    const body = await readBody(req);
    requireRole(actor, ["student", "admin"]);
    const userId = actor.role === "admin" && body.userId ? String(body.userId) : actor.id;
    ensureActorCanUseId(actor, userId, "student");
    const settings = updateStudentEthicsSettings(db, userId, body);
    recordAudit(db, actor, "student.ethics_settings", {
      resourceType: "studentEthicsSettings",
      resourceId: userId,
      meta: settings
    }, req);
    writeDb(db);
    return send(res, 200, { ok: true, settings, portfolio: buildStudentPortfolio(db, userId), learningAnalytics: learningAnalytics(db, userId) });
  }

  if (method === "POST" && pathname === "/api/student/data-deletion-requests") {
    const body = await readBody(req);
    requireRole(actor, ["student", "admin"]);
    const userId = actor.role === "admin" && body.userId ? String(body.userId) : actor.id;
    ensureActorCanUseId(actor, userId, "student");
    const request = requestStudentDataDeletion(db, userId, body);
    recordAudit(db, actor, "student.data_deletion_request", {
      resourceType: "studentDataDeletionRequest",
      resourceId: request.id,
      meta: { scopes: request.scopes }
    }, req);
    writeDb(db);
    return send(res, 201, { ok: true, request, requests: (db.studentDataDeletionRequests || []).filter((item) => item.studentId === userId).slice(0, 20), portfolio: buildStudentPortfolio(db, userId) });
  }

  if (method === "POST" && pathname === "/api/knowledge-tests/generate") {
    const body = await readBody(req);
    requireRole(actor, ["student", "admin"]);
    const userId = actor.role === "admin" && body.userId ? String(body.userId) : actor.id;
    const quiz = await buildKnowledgeTestQuestions(db, userId, {
      subject: String(body.subject || ""),
      materialId: String(body.materialId || body.material_id || ""),
      count: Math.min(5, Math.max(3, Number(body.count || 4))),
      phase: String(body.phase || "diagnostic"),
      nodeId: String(body.nodeId || body.node_id || "")
    });
    recordAudit(db, actor, "knowledge_test.generate", {
      resourceType: "knowledgeTest",
      resourceId: quiz.id,
      meta: { subject: quiz.subject, materialId: quiz.materialId, topic: quiz.topic }
    }, req);
    return send(res, 200, { ok: true, quiz });
  }

  if (method === "POST" && pathname === "/api/knowledge-tests/evaluate") {
    const body = await readBody(req);
    requireRole(actor, ["student", "admin"]);
    const userId = actor.role === "admin" && body.userId ? String(body.userId) : actor.id;
    const result = evaluateKnowledgeTestAnswer(db, userId, body.question || {}, body.answer, {
      quizId: String(body.quizId || body.quiz_id || ""),
      subject: String(body.subject || ""),
      materialId: String(body.materialId || body.material_id || ""),
      attempts: body.attempts || [],
      questionCount: body.questionCount || body.question_count || body.totalQuestions || body.total_questions,
      phase: String(body.phase || body.question?.phase || "diagnostic"),
      previousAccuracy: Number(body.previousAccuracy || body.previous_accuracy || 0)
      ,durationMs: Number(body.durationMs || body.duration_ms || 0),
      version: String(body.version || body.question?.version || "v1")
    });
    const learningEvent = recordLearningEvent(db, {
      studentId: userId,
      eventType: "knowledge_test_evaluate",
      source: "knowledge-test",
      subject: String(body.subject || body.question?.subject || ""),
      knowledgePoint: result.topic,
      graphId: String(body.question?.graphId || ""),
      nodeId: String(body.question?.nodeId || ""),
      score: result.overall?.masteryScore ?? result.overall?.accuracy ?? result.accuracy,
      payload: {
        quizId: String(body.quizId || body.quiz_id || ""),
        questionId: String(body.question?.id || ""),
        prompt: body.question?.prompt || "",
        answer: body.answer || "",
        accuracy: result.accuracy,
        overall: result.overall,
        matched: result.matched,
        missing: result.missing,
        questionVersion: body.question?.version || "v1",
        difficulty: body.question?.difficulty || "中",
        knowledgePoint: body.question?.knowledgePoint || result.topic,
        misconceptionTags: body.question?.misconceptionTags || [],
        source: body.question?.source || body.question?.sourceTitle || "课程资料",
        durationMs: Number(body.durationMs || body.duration_ms || 0),
        answerLength: String(body.answer || "").length,
        understandingCheck: result.accuracy >= 70 && (result.missing || []).length <= 2 ? "likely_understood" : "needs_variant_verification"
      },
      idempotencyKey: String(body.quizId || body.quiz_id || "") && String(body.question?.id || "")
        ? `knowledge-test:${body.quizId || body.quiz_id}:${body.question.id}:${result.overall?.answered || ""}`
        : ""
    });
    recordDiagnosisResult(db, {
      studentId: userId,
      eventId: learningEvent?.id || "",
      topic: result.topic,
      masteryScore: result.overall?.masteryScore ?? result.overall?.accuracy ?? result.accuracy,
      masteryLevel: result.overall?.masteryLevel || result.masteryLevel || "",
      errorTags: [],
      missingPoints: result.missing || [],
      evidence: body.question?.citations || [],
      finalAnswer: result.feedback || "",
      modelOrWorkflow: "knowledge-test",
      idempotencyKey: learningEvent?.id ? `knowledge-test-diagnosis:${learningEvent.id}` : ""
    });
    syncStudentMasteryFromProfile(db, userId, [result.topic], {
      subject: String(body.subject || body.question?.subject || ""),
      graphId: String(body.question?.graphId || ""),
      nodeId: String(body.question?.nodeId || ""),
      lastEventId: learningEvent?.id || ""
    });
    recordAudit(db, actor, "knowledge_test.evaluate", {
      resourceType: "knowledgeTest",
      resourceId: String(body.quizId || body.quiz_id || ""),
      meta: { topic: result.topic, accuracy: result.accuracy, overallAccuracy: result.overall?.accuracy, masteryLevel: result.overall?.masteryLevel }
    }, req);
    writeDb(db);
    return send(res, 200, { ok: true, result, learningProfile: ensureLearningProfile(db, userId) });
  }

  if (method === "GET" && pathname === "/api/users/search") {
    const userId = queryUserId(searchParams, actor);
    const query = String(searchParams.get("query") || "").trim().toLowerCase();
    const role = searchParams.get("role");
    const users = db.users
      .filter((user) => user.id !== userId)
      .filter((user) => !role || user.role === role)
      .filter((user) => !query || user.id.toLowerCase().includes(query) || user.name.toLowerCase().includes(query))
      .slice(0, 20)
      .map(publicUser);
    return send(res, 200, { ok: true, users });
  }

  let params = routePattern(pathname, "/api/users/:id");
  if (method === "PUT" && params) {
    if (actor.role !== "admin" && params.id !== actor.id) return sendError(res, 403, "只能修改自己的个人信息");
    const body = await readBody(req);
    const user = ensureUser(db, params.id);
    ["name", "subject", "className", "email", "phone"].forEach((key) => {
      if (body[key] !== undefined) user[key] = String(body[key]);
    });
    if (body.classIds && Array.isArray(body.classIds)) user.classIds = body.classIds.map(String);
    user.updatedAt = now();
    recordAudit(db, actor, "user.update", { resourceType: "user", resourceId: user.id }, req);
    writeDb(db);
    return send(res, 200, { ok: true, user: publicUser(user) });
  }

  if (method === "GET" && pathname === "/api/graphs") {
    const userId = queryUserId(searchParams, actor);
    const subject = searchParams.get("subject");
    let graphs = visibleKnowledgeGraphs(db, userId);
    if (subject) graphs = graphs.filter((graph) => graph.subject === subject);
    return send(res, 200, { ok: true, graphs: graphs.map((graph) => enhanceGraphForEducation(graph)) });
  }

  if (method === "POST" && pathname === "/api/uploads/start") {
    cleanupUploadSessions();
    const body = await readBody(req);
    assertRequired(body, ["userId", "fileName", "size"]);
    const size = Number(body.size || 0);
    if (!Number.isFinite(size) || size <= 0) return sendError(res, 400, "文件大小不正确");
    if (hasConfiguredUploadLimit() && size > MAX_UPLOAD_SIZE) {
      return sendError(res, 413, `上传文件过大，当前限制为 ${Math.round(MAX_UPLOAD_SIZE / 1024 / 1024)}MB`);
    }
    const session = createUploadSession({
      userId: body.userId,
      fileName: body.fileName,
      fileType: body.fileType,
      size
    });
    recordAudit(db, actor, "upload.start", { resourceType: "upload", resourceId: session.id, meta: { fileName: session.fileName, size } }, req);
    return send(res, 201, { ok: true, upload: publicUploadSession(session) });
  }

  params = routePattern(pathname, "/api/uploads/:id/chunk");
  if (method === "POST" && params) {
    const session = getUploadSession(params.id);
    if (actor.role !== "admin" && session.userId !== actor.id) return sendError(res, 403, "不能上传其他账号的文件");
    const index = Number(searchParams.get("index") || session.chunks);
    const offset = Number(searchParams.get("offset") || session.received);
    if (offset !== session.received) return sendError(res, 409, "上传分块顺序不一致，请重新上传");
    const chunk = await readBinaryBody(req, MAX_UPLOAD_CHUNK_SIZE);
    if (!chunk.length) return sendError(res, 400, "上传分块为空");
    if (session.received + chunk.length > session.size) return sendError(res, 400, "上传内容超过声明文件大小");
    fs.appendFileSync(session.filePath, chunk);
    session.received += chunk.length;
    session.chunks = Math.max(session.chunks, index + 1);
    session.updatedAt = now();
    persistUploadSessions();
    return send(res, 200, { ok: true, upload: publicUploadSession(session) });
  }

  if (method === "POST" && pathname === "/api/graphs/generate-upload") {
    const body = await readBody(req);
    assertRequired(body, ["userId", "subject"]);
    const uploadIds = Array.isArray(body.uploadIds)
      ? body.uploadIds.map(String).filter(Boolean)
      : [String(body.uploadId || "")].filter(Boolean);
    if (!uploadIds.length) return sendError(res, 400, "请至少上传一个文件");
    if (uploadIds.length > 10) return sendError(res, 400, "一次最多汇总 10 个文件生成图谱");
    const sessions = uploadIds.map((uploadId) => getUploadSession(uploadId));
    sessions.forEach((session) => {
      if (session.userId !== body.userId) throw Object.assign(new Error("不能使用其他账号的上传文件"), { status: 403 });
      if (session.received !== session.size) throw Object.assign(new Error(`文件 ${session.fileName} 尚未上传完成`), { status: 400 });
      assertStoredUploadSafe(session);
    });
    const subject = normalizeSubject(body.subject);
    const title = body.title || `${subject}知识图谱`;
    const sourceName = body.sourceName || sessions.map((session) => session.fileName).join("、");
    const extractor = body.extractor || AI_UNLIMITED_EXTRACTOR;
    const job = createGraphJob({
      userId: body.userId,
      subject,
      title,
      sourceName,
      fileSize: sessions.reduce((sum, session) => sum + Number(session.size || 0), 0),
      fileCount: sessions.length,
      extractor,
      uploadIds: sessions.map((session) => session.id),
      sourceFiles: sessions.map((session) => ({ id: session.id, name: session.fileName, size: session.size, type: session.fileType }))
    });
    recordAudit(db, actor, "graph.generate_upload", { resourceType: "graphJob", resourceId: job.id, meta: { subject, title, sourceName, fileCount: sessions.length } }, req);
    send(res, 202, { ok: true, job: publicGraphJob(job) });
    processGraphGenerationJob(job.id, {
      userId: body.userId,
      subject,
      title,
      sourceName,
      sourceText: requestText(body.sourceText),
      extractor,
      uploadIds: sessions.map((session) => session.id),
      files: sessions.map((session) => ({
        name: session.fileName,
        type: session.fileType,
        filePath: session.filePath
      }))
    });
    return;
  }

  if (method === "GET" && pathname === "/api/graphs/jobs") {
    cleanupGraphJobs();
    const jobs = Array.from(graphJobs.values())
      .filter((job) => actor.role === "admin" || job.meta?.userId === actor.id)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, 40)
      .map(publicGraphJob);
    return send(res, 200, { ok: true, jobs });
  }

  params = routePattern(pathname, "/api/graphs/jobs/:id");
  if (method === "GET" && params) {
    cleanupGraphJobs();
    const job = graphJobs.get(params.id);
    if (!job) return notFound(res);
    if (actor.role !== "admin" && job.meta?.userId !== actor.id) return sendError(res, 403, "无权查看该任务");
    return send(res, 200, { ok: true, job: publicGraphJob(job) });
  }

  params = routePattern(pathname, "/api/graphs/jobs/:id/cancel");
  if (method === "POST" && params) {
    const job = graphJobs.get(params.id);
    if (!job) return notFound(res);
    if (actor.role !== "admin" && job.meta?.userId !== actor.id) return sendError(res, 403, "无权终止该任务");
    const canceled = cancelGraphJob(params.id);
    recordAudit(db, actor, "graph.job_cancel", { resourceType: "graphJob", resourceId: params.id }, req);
    return send(res, 200, { ok: true, job: publicGraphJob(canceled) });
  }

  if (method === "POST" && pathname === "/api/graphs/generate-file") {
    const userId = queryUserId(searchParams, actor);
    const subject = normalizeSubject(searchParams.get("subject"));
    const title = searchParams.get("title") || `${subject}知识图谱`;
    const sourceText = searchParams.get("sourceText") || "";
    const sourceName = searchParams.get("sourceName") || "上传书本";
    const extractor = searchParams.get("extractor") || AI_UNLIMITED_EXTRACTOR;
    assertRequired({ userId, subject }, ["userId", "subject"]);
    const buffer = await readBinaryBody(req, MAX_UPLOAD_SIZE);
    if (!buffer.length) return sendError(res, 400, "上传文件为空");
    const fileType = searchParams.get("fileType") || req.headers["content-type"] || "";
    assertUploadContent({ name: sourceName, type: fileType, buffer: buffer.subarray(0, Math.min(buffer.length, 8192)) });
    const job = createGraphJob({
      userId,
      subject,
      title,
      sourceName,
      fileSize: buffer.length,
      extractor
    });
    recordAudit(db, actor, "graph.generate_file", { resourceType: "graphJob", resourceId: job.id, meta: { subject, title, sourceName } }, req);
    send(res, 202, { ok: true, job: publicGraphJob(job) });
    processGraphGenerationJob(job.id, {
      userId,
      subject,
      title,
      sourceName,
      sourceText,
      extractor,
      file: {
        name: sourceName,
        type: fileType,
        buffer
      }
    });
    return;
  }

  if (method === "POST" && pathname === "/api/graphs/generate") {
    const body = await readBody(req);
    assertRequired(body, ["userId", "subject"]);
    const uploaded = body.file?.dataUrl ? await extractCourseMaterialUpload(body.file) : { text: "", meta: null };
    const sourceText = [uploaded.text, requestText(body.sourceText)].filter(Boolean).join("\n\n");
    const graph = buildGraphFromText({
      ownerId: body.userId,
      title: body.title,
      subject: body.subject,
      sourceName: body.sourceName || uploaded.meta?.name,
      sourceText,
      extraction: uploaded.meta ? { ...uploaded.meta, agent: body.extractor || "local-pdf-text-agent" } : null
    });
    db.knowledgeGraphs.push(graph);
    recordAudit(db, actor, "graph.generate", { resourceType: "graph", resourceId: graph.id, meta: { subject: graph.subject, title: graph.title } }, req);
    writeDb(db);
    return send(res, 201, { ok: true, graph });
  }

  if (method === "POST" && pathname === "/api/graphs/import") {
    const body = await readBody(req);
    assertRequired(body, ["userId", "graph"]);
    const graph = validateGraph(body.graph, {
      ownerId: body.userId,
      subject: body.subject,
      title: body.title,
      sourceName: body.sourceName
    });
    db.knowledgeGraphs.push(graph);
    recordAudit(db, actor, "graph.import", { resourceType: "graph", resourceId: graph.id, meta: { subject: graph.subject, title: graph.title } }, req);
    writeDb(db);
    return send(res, 201, { ok: true, graph });
  }

  params = routePattern(pathname, "/api/graphs/:id/upload-global");
  if (method === "POST" && params) {
    const body = await readBody(req);
    const graph = db.knowledgeGraphs.find((item) => item.id === params.id);
    if (!graph) return notFound(res);
    if (actor.role !== "admin" && graph.ownerId !== body.userId) return sendError(res, 403, "只能上传自己的图谱");
    graph.global = true;
    graph.updatedAt = now();
    recordAudit(db, actor, "graph.upload_global", { resourceType: "graph", resourceId: graph.id }, req);
    writeDb(db);
    return send(res, 200, { ok: true, graph: enhanceGraphForEducation(graph) });
  }

  params = routePattern(pathname, "/api/graphs/:id");
  if (method === "GET" && params) {
    const graph = db.knowledgeGraphs.find((item) => item.id === params.id);
    if (!graph) return notFound(res);
    if (!visibleKnowledgeGraphs(db, actor.id).some((item) => item.id === graph.id)) return sendError(res, 403, "无权查看该图谱");
    return send(res, 200, { ok: true, graph: enhanceGraphForEducation(graph) });
  }
  if (method === "PUT" && params) {
    const body = await readBody(req);
    const graph = db.knowledgeGraphs.find((item) => item.id === params.id);
    if (!graph) return notFound(res);
    if (actor.role !== "admin" && (graph.ownerId !== actor.id || graph.global)) return sendError(res, 403, "只能编辑自己未公开的图谱");
    if (body.nodeId) {
      const node = graph.nodes.find((item) => String(item.id) === String(body.nodeId));
      if (!node) return sendError(res, 404, "知识点不存在");
      const fields = ["label", "group", "details", "learningGoal", "masteryStandard"];
      fields.forEach((key) => { if (body[key] !== undefined) node[key] = String(body[key] || "").slice(0, 1000); });
      ["prerequisites", "misconceptions", "diagnosticQuestions", "remediationResources", "verificationQuestions"].forEach((key) => {
        if (body[key] !== undefined) node[key] = Array.isArray(body[key]) ? body[key].map((item) => String(item).trim()).filter(Boolean).slice(0, 20) : String(body[key] || "").split(/\n|；|;/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
      });
    }
    if (Array.isArray(body.links)) {
      graph.links = body.links.map((link) => ({ source: String(link.source), target: String(link.target), label: String(link.label || "关联").slice(0, 100), type: String(link.type || "semantic").slice(0, 40), pedagogy: String(link.pedagogy || "").slice(0, 300) })).slice(0, 1000);
    }
    graph.updatedAt = now();
    recordAudit(db, actor, "graph.update", { resourceType: "graph", resourceId: graph.id, meta: { nodeId: body.nodeId || "", links: Array.isArray(body.links) ? body.links.length : undefined } }, req);
    writeDb(db);
    return send(res, 200, { ok: true, graph: enhanceGraphForEducation(graph) });
  }
  if (method === "DELETE" && params) {
    const userId = queryUserId(searchParams, actor);
    const index = db.knowledgeGraphs.findIndex((item) => item.id === params.id);
    if (index < 0) return notFound(res);
    if (actor.role !== "admin" && db.knowledgeGraphs[index].ownerId !== userId) return sendError(res, 403, "只能删除自己的图谱");
    recordAudit(db, actor, "graph.delete", { resourceType: "graph", resourceId: params.id }, req);
    db.knowledgeGraphs.splice(index, 1);
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  if (method === "GET" && pathname === "/api/materials") {
    const userId = queryUserId(searchParams, actor);
    const subject = searchParams.get("subject");
    let materials = visibleCourseMaterials(db, userId);
    if (subject) materials = materials.filter((item) => item.subject === normalizeSubject(subject));
    return send(res, 200, { ok: true, materials: materials.map(publicCourseMaterial) });
  }

  if (method === "GET" && pathname === "/api/ml/question-bank") {
    const userId = queryUserId(searchParams, actor);
    const subject = normalizeSubject(searchParams.get("subject") || "机器学习");
    const topic = String(searchParams.get("topic") || "").trim();
    const nodeId = String(searchParams.get("nodeId") || "").trim();
    const limit = Math.min(50, Math.max(1, Number(searchParams.get("limit") || 10)));
    const visible = visibleCourseMaterials(db, userId).map((item) => item.id);
    const questions = (db.mlQuestionBank || []).filter((item) => item.subject === subject && item.status !== "retired" && visible.includes(item.materialId))
      .filter((item) => !topic || item.topic === topic || String(item.topic).includes(topic))
      .filter((item) => !nodeId || item.nodeId === nodeId).slice(0, limit);
    return send(res, 200, { ok: true, subject, questions, knowledgePoints: (db.mlKnowledgePoints || []).filter((item) => item.subject === subject) });
  }

  if (method === "POST" && pathname === "/api/materials") {
    const body = await readBody(req);
    assertRequired(body, ["userId", "subject"]);
    const user = ensureUser(db, body.userId);
    if (body.global && user.role !== "teacher" && user.role !== "admin") return sendError(res, 403, "只有教师可以发布学生可检索资料");
    let uploaded = { text: "", meta: null };
    if (body.file?.dataUrl) {
      uploaded = await extractCourseMaterialUpload(body.file);
    }
    const sourceText = [uploaded.text, requestText(body.sourceText)].filter(Boolean).join("\n\n");
    if (!sourceText.trim()) return sendError(res, 400, "没有识别到可入库的课程资料文本，请上传 PDF/Word/PPTX/TXT，扫描版 PDF 会自动尝试 OCR");
    const material = createCourseMaterial({
      ownerId: user.id,
      subject: body.subject,
      title: body.title || body.file?.name || "课程资料",
      sourceName: body.sourceName || body.file?.name || "手动录入",
      type: body.file?.type || "text/plain",
      text: sourceText,
      global: ["teacher", "admin"].includes(user.role) ? Boolean(body.global) : false,
      classId: body.classId
    });
    material.extraction = uploaded.meta ? { ...uploaded.meta, agent: "course-rag-material-agent" } : null;
    db.courseMaterials.unshift(material);
    recordAudit(db, actor, "material.create", { resourceType: "courseMaterial", resourceId: material.id, meta: { title: material.title, subject: material.subject } }, req);
    writeDb(db);
    const embedding = await tryIndexCourseMaterialEmbeddings(db, [material.id]);
    return send(res, 201, { ok: true, embedding, material: publicCourseMaterial(material) });
  }

  if (method === "POST" && pathname === "/api/materials/from-upload") {
    const body = await readBody(req);
    assertRequired(body, ["userId", "uploadId", "subject"]);
    const user = ensureUser(db, body.userId);
    const session = getUploadSession(body.uploadId);
    if (session.userId !== body.userId) return sendError(res, 403, "不能使用其他账号的上传文件");
    if (session.received !== session.size) return sendError(res, 400, "文件尚未上传完成");
    assertStoredUploadSafe(session);
    let uploaded = { text: "", meta: null };
    try {
      uploaded = await extractCourseMaterialUpload({
        name: session.fileName,
        type: session.fileType,
        filePath: session.filePath
      });
      const sourceText = [uploaded.text, requestText(body.sourceText)].filter(Boolean).join("\n\n");
      if (!sourceText.trim()) return sendError(res, 400, "没有识别到可入库的课程资料文本，请上传 PDF/Word/PPTX/TXT，扫描版 PDF 会自动尝试 OCR");
      const material = createCourseMaterial({
        ownerId: user.id,
        subject: body.subject,
        title: body.title || session.fileName || "课程资料",
        sourceName: body.sourceName || session.fileName || "上传资料",
        type: session.fileType || "application/octet-stream",
        text: sourceText,
        global: ["teacher", "admin"].includes(user.role) ? Boolean(body.global) : false,
        classId: body.classId
      });
      material.extraction = uploaded.meta ? { ...uploaded.meta, agent: "course-rag-material-agent" } : null;
      db.courseMaterials.unshift(material);
      recordAudit(db, actor, "material.create_from_upload", { resourceType: "courseMaterial", resourceId: material.id, meta: { title: material.title, subject: material.subject } }, req);
      writeDb(db);
      const embedding = await tryIndexCourseMaterialEmbeddings(db, [material.id]);
      return send(res, 201, { ok: true, embedding, material: publicCourseMaterial(material) });
    } finally {
      cleanupUploadSession(body.uploadId, true);
    }
  }

  if (method === "POST" && pathname === "/api/materials/retrieval-test") {
    const body = await readBody(req);
    assertRequired(body, ["userId", "query"]);
    const user = ensureUser(db, body.userId);
    if (actor.role !== "admin" && actor.id !== user.id) return sendError(res, 403, "只能测试自己的可见资料");
    const visible = visibleCourseMaterials(db, user.id);
    const material = body.materialId ? visible.find((item) => item.id === body.materialId) : null;
    if (body.materialId && !material) return sendError(res, 404, "资料不存在或不可见");
    let hits = await searchCourseKnowledge(db, user.id, body.query, {
      subject: body.subject || material?.subject || "",
      limit: 12
    });
    if (material) hits = hits.filter((hit) => hit.materialId === material.id);
    const publicHits = hits.slice(0, 8).map((hit) => {
      const hitMaterial = hit.materialId ? visible.find((item) => item.id === hit.materialId) || db.courseMaterials.find((item) => item.id === hit.materialId) : null;
      return {
        type: hit.type,
        score: hit.score,
        title: hit.title,
        sourceName: hit.sourceName,
        subject: hit.subject,
        chapter: hit.chapter,
        page: hit.page,
        quote: hit.quote,
        materialId: hit.materialId,
        chunkId: hit.chunkId,
        graphId: hit.graphId,
        nodeId: hit.nodeId,
        studentVisible: Boolean(hitMaterial?.global),
        scoreDetail: hit.scoreDetail
      };
    });
    recordAudit(db, actor, "material.retrieval_test", { resourceType: "courseMaterial", resourceId: material?.id || "", meta: { query: String(body.query).slice(0, 120), hits: publicHits.length } }, req);
    writeDb(db);
    return send(res, 200, { ok: true, materialId: material?.id || "", query: body.query, hits: publicHits });
  }

  params = routePattern(pathname, "/api/materials/:id");
  if (method === "DELETE" && params) {
    const userId = queryUserId(searchParams, actor);
    const index = db.courseMaterials.findIndex((item) => item.id === params.id);
    if (index < 0) return notFound(res);
    if (actor.role !== "admin" && db.courseMaterials[index].ownerId !== userId) return sendError(res, 403, "只能删除自己上传的课程资料");
    recordAudit(db, actor, "material.delete", { resourceType: "courseMaterial", resourceId: params.id }, req);
    db.courseMaterials.splice(index, 1);
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  if (method === "GET" && pathname === "/api/conversations") {
    const userId = queryUserId(searchParams, actor);
    return send(res, 200, { ok: true, conversations: db.conversations.filter((item) => item.userId === userId) });
  }

  if (method === "POST" && pathname === "/api/conversations") {
    const body = await readBody(req);
    assertRequired(body, ["userId"]);
    const user = ensureUser(db, body.userId);
    const conv = {
      id: uid("conv"),
      userId: user.id,
      role: user.role,
      title: body.title || "新的对话",
      mode: body.mode || "explain",
      messages: [],
      createdAt: now(),
      updatedAt: now()
    };
    db.conversations.unshift(conv);
    recordAudit(db, actor, "conversation.create", { resourceType: "conversation", resourceId: conv.id }, req);
    writeDb(db);
    return send(res, 201, { ok: true, conversation: conv });
  }

  if (method === "POST" && pathname === "/api/wrong-notes") {
    const body = await readBody(req);
    assertRequired(body, ["userId"]);
    const note = addWrongNote(db, body.userId, {
      source: body.source || "对话操作",
      topic: String(body.topic || "待归类").slice(0, 60),
      question: String(body.question || "").slice(0, 500),
      answer: String(body.answer || "").slice(0, 1000),
      analysis: String(body.analysis || "").slice(0, 500),
      recommendation: String(body.recommendation || "").slice(0, 500)
    });
    recordLearningEvent(db, {
      studentId: body.userId,
      eventType: "wrong_note",
      source: note.source,
      knowledgePoint: note.topic,
      payload: {
        wrongNoteId: note.id,
        question: note.question,
        answer: note.answer,
        analysis: note.analysis,
        recommendation: note.recommendation
      },
      idempotencyKey: `wrong-note:${note.id}`
    });
    recordAudit(db, actor, "wrong_note.create", { resourceType: "wrongNote", resourceId: note.id, meta: { topic: note.topic } }, req);
    writeDb(db);
    return send(res, 201, { ok: true, wrongNote: note, learningAnalytics: learningAnalytics(db, body.userId) });
  }

  if (method === "POST" && pathname === "/api/learning-data/pre-post") {
    const body = await readBody(req); assertRequired(body, ["studentId"]); ensureActorCanUseId(actor, body.studentId, "student");
    const assessment = createPrePostAssessment(db, body);
    const event = recordLearningEvent(db, { studentId: body.studentId, eventType: "assessment_completed", source: assessment.assessmentType, score: assessment.score, payload: { assessmentId: assessment.id, nodeScores: assessment.nodeScores }, evidenceType: "assessment" });
    writeDb(db); return send(res, 201, { ok: true, assessment, event });
  }
  if (method === "POST" && pathname === "/api/learning-data/path-recommendations") {
    const body = await readBody(req); assertRequired(body, ["studentId"]); ensureActorCanUseId(actor, body.studentId, "student");
    const path = createLearningPathRecommendation(db, body);
    const event = recordLearningEvent(db, { studentId: body.studentId, eventType: "learning_path_recommended", source: "path-engine", payload: { pathId: path.id, reason: path.reason, targetNodes: path.targetNodes }, evidenceType: "learning_path" });
    writeDb(db); return send(res, 201, { ok: true, path, event });
  }
  if (method === "POST" && pathname === "/api/learning-data/experiment-submissions") {
    const body = await readBody(req); assertRequired(body, ["studentId", "experimentId"]); ensureActorCanUseId(actor, body.studentId, "student");
    const submission = createExperimentSubmissionRecord(db, body);
    const event = recordLearningEvent(db, { studentId: body.studentId, eventType: "experiment_submitted", source: "experiment-workshop", payload: { experimentSubmissionId: submission.id, experimentId: submission.experimentId, resultSummary: submission.resultSummary }, evidenceType: "experiment" });
    appendLearningEvidence(db, { studentId: body.studentId, evidenceType: "experiment", eventId: event?.id || "", summary: submission.resultSummary });
    writeDb(db); return send(res, 201, { ok: true, submission, event });
  }
  if (method === "POST" && pathname === "/api/learning-data/evidence") {
    const body = await readBody(req); assertRequired(body, ["studentId"]); ensureActorCanUseId(actor, body.studentId, "student");
    const evidence = appendLearningEvidence(db, body); writeDb(db); return send(res, 201, { ok: true, evidence });
  }

  if (method === "POST" && pathname === "/api/mastery/update") {
    const body = await readBody(req);
    assertRequired(body, ["userId"]);
    const topics = Array.isArray(body.topics) ? body.topics.map(String) : [String(body.topic || "")];
    const delta = Number.isFinite(Number(body.delta)) ? Number(body.delta) : 0.08;
    const profile = updateTopicMastery(db, body.userId, topics, delta, String(body.evidence || "用户在对话中标记掌握"));
    const learningEvent = recordLearningEvent(db, {
      studentId: body.userId,
      eventType: "manual_mastery_update",
      source: "user-action",
      subject: String(body.subject || ""),
      knowledgePoint: topics[0] || "",
      score: profile.mastery?.[topics[0]]?.score,
      payload: {
        topics,
        delta,
        evidence: String(body.evidence || "")
      }
    });
    syncStudentMasteryFromProfile(db, body.userId, topics, {
      subject: String(body.subject || ""),
      lastEventId: learningEvent?.id || ""
    });
    recordAudit(db, actor, "mastery.update", { resourceType: "learningProfile", resourceId: body.userId, meta: { topics } }, req);
    writeDb(db);
    return send(res, 200, { ok: true, profile, learningAnalytics: learningAnalytics(db, body.userId) });
  }

  if (method === "POST" && pathname === "/api/ai/jobs") {
    const body = await readBody(req);
    assertRequired(body, ["userId", "prompt"]);
    assertActorOwnsUser(actor, body.userId);
    const job = getBackgroundQueue().enqueue("ai_chat", { actorId: actor.id, body }, { createdBy: actor.id, maxAttempts: 3 });
    recordAudit(db, actor, "ai.chat_queued", { resourceType: "backgroundJob", resourceId: job.id, meta: { type: job.type } }, req);
    writeDb(db);
    return send(res, 202, { ok: true, job: publicBackgroundJob(job) });
  }

  params = routePattern(pathname, "/api/jobs/:id");
  if (method === "GET" && params) {
    const job = getBackgroundQueue().get(params.id);
    if (!job) return notFound(res);
    if (actor.role !== "admin" && job.createdBy !== actor.id) return sendError(res, 403, "无权查看该后台任务");
    return send(res, 200, { ok: true, job: publicBackgroundJob(job) });
  }

  if (method === "POST" && pathname === "/api/ai/chat") {
    const body = await readBody(req);
    assertRequired(body, ["userId", "prompt"]);
    assertActorOwnsUser(actor, body.userId);
    const user = ensureUser(db, body.userId);
    let conv = body.conversationId ? db.conversations.find((item) => item.id === body.conversationId && item.userId === user.id) : null;
    if (!conv) {
      conv = {
        id: uid("conv"),
        userId: user.id,
        role: user.role,
        title: String(body.prompt).slice(0, 24) || "新的对话",
        mode: body.mode || "explain",
        messages: [],
        createdAt: now(),
        updatedAt: now()
      };
      db.conversations.unshift(conv);
    }
    const userMessage = { id: uid("msg"), role: "user", content: String(body.prompt), createdAt: now() };
    const agentAnswer = await buildEducationalAgentAnswer(db, user, body);
    const assistantMessage = {
      id: uid("msg"),
      role: "assistant",
      content: agentAnswer.content,
      citations: agentAnswer.citations,
      confidence: agentAnswer.confidence,
      mode: agentAnswer.mode,
      intent: agentAnswer.intent,
      strategy: agentAnswer.strategy,
      knowledgePoints: agentAnswer.knowledgePoints,
      graphContext: agentAnswer.graphContext,
      learningPanel: agentAnswer.learningPanel,
      workflow: agentAnswer.workflow,
      workflowResult: agentAnswer.workflowResult,
      actions: agentAnswer.actions,
      retrieved: agentAnswer.retrieved,
      createdAt: now()
    };
    conv.mode = agentAnswer.mode || body.mode || conv.mode;
    conv.messages.push(userMessage, assistantMessage);
    conv.updatedAt = now();
    if (conv.title === "新的对话") conv.title = String(body.prompt).slice(0, 24);
    db.agentRuns = Array.isArray(db.agentRuns) ? db.agentRuns : [];
    db.agentRuns.unshift({
      id: uid("run"),
      userId: user.id,
      conversationId: conv.id,
      mode: conv.mode,
      prompt: String(body.prompt).slice(0, 240),
      confidence: agentAnswer.confidence,
      citations: agentAnswer.citations,
      retrieved: agentAnswer.retrieved,
      intent: agentAnswer.intent,
      strategy: agentAnswer.strategy,
      knowledgePoints: agentAnswer.knowledgePoints,
      graphFocus: agentAnswer.learningPanel?.graphFocus || null,
      tools: agentAnswer.tools || [],
      workflow: agentAnswer.workflow,
      workflowResult: agentAnswer.workflowResult,
      steps: agentAnswer.workflow?.steps || ML_DIAGNOSIS_WORKFLOW_STEP_TITLES,
      createdAt: now()
    });
    db.agentRuns = db.agentRuns.slice(0, 200);
    recordAudit(db, actor, "ai.chat", { resourceType: "conversation", resourceId: conv.id, meta: { mode: conv.mode, confidence: agentAnswer.confidence } }, req);
    writeDb(db);
    return send(res, 200, { ok: true, conversation: conv, messages: [userMessage, assistantMessage] });
  }

  params = routePattern(pathname, "/api/conversations/:id");
  if (method === "DELETE" && params) {
    const userId = queryUserId(searchParams, actor);
    const index = db.conversations.findIndex((item) => item.id === params.id && item.userId === userId);
    if (index < 0) return notFound(res);
    recordAudit(db, actor, "conversation.delete", { resourceType: "conversation", resourceId: params.id }, req);
    db.conversations.splice(index, 1);
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  if (method === "GET" && pathname === "/api/models") {
    const userId = queryUserId(searchParams, actor);
    const subject = searchParams.get("subject");
    let models = db.models.filter((item) => item.ownerId === userId);
    if (subject) models = models.filter((item) => item.subject === subject);
    return send(res, 200, { ok: true, models });
  }

  if (method === "POST" && pathname === "/api/models") {
    const body = await readBody(req);
    assertRequired(body, ["userId", "name", "subject"]);
    const existing = body.id ? db.models.find((item) => item.id === body.id && item.ownerId === body.userId) : null;
    const payload = {
      ownerId: body.userId,
      name: String(body.name),
      subject: normalizeSubject(body.subject),
      mode: body.mode || "ideal",
      components: Array.isArray(body.components) ? body.components : [],
      notes: String(body.notes || ""),
      experiment: sanitizeExperimentRecord(body.experiment),
      updatedAt: now()
    };
    if (existing) {
      Object.assign(existing, payload);
      recordAudit(db, actor, "model.update", { resourceType: "model", resourceId: existing.id }, req);
      writeDb(db);
      return send(res, 200, { ok: true, model: existing });
    }
    const model = { id: uid("model"), ...payload, createdAt: now() };
    db.models.unshift(model);
    if (model.experiment?.workshop) {
      const workshop = model.experiment.workshop;
      const experimentSubmission = createExperimentSubmissionRecord(db, { studentId: body.userId, experimentId: workshop.experimentKey || model.id, artifacts: workshop.evidenceFiles || [], resultSummary: workshop.runResult || "", aiFeedback: workshop.conclusionCheck?.detail || "", reflection: { findings: workshop.findings || "", mismatch: workshop.mismatch || "", improvement: workshop.improvement || "" }, modelId: model.id });
      const event = recordLearningEvent(db, { studentId: body.userId, eventType: "experiment_submitted", source: "experiment-workshop", subject: model.subject, payload: { experimentSubmissionId: experimentSubmission.id, experimentId: experimentSubmission.experimentId, resultSummary: experimentSubmission.resultSummary }, evidenceType: "experiment" });
      appendLearningEvidence(db, { studentId: body.userId, evidenceType: "experiment", eventId: event?.id || "", summary: experimentSubmission.resultSummary });
    }
    recordAudit(db, actor, "model.create", { resourceType: "model", resourceId: model.id }, req);
    writeDb(db);
    return send(res, 201, { ok: true, model });
  }

  if (method === "POST" && pathname === "/api/model-code/generate") {
    const body = await readBody(req);
    assertRequired(body, ["userId", "prompt"]);
    if (actor.role !== "admin" && actor.id !== body.userId) return sendError(res, 403, "只能为自己的账号生成算法");
    const subject = normalizeSubject(body.subject || "机器学习");
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return sendError(res, 400, "算法需求不能为空");
    if (prompt.length > 1200) return sendError(res, 400, "算法需求不能超过 1200 字");
    const codeMode = String(body.codeMode || "teaching").slice(0, 40);
    const difficulty = String(body.difficulty || "standard").slice(0, 40);
    const hits = await searchCourseKnowledge(db, body.userId, prompt, { subject, limit: 5 });
    const relevantHits = hits.filter((hit) => Number(hit.score || 0) >= 0.8);
    let rawGenerated = null;
    let openAiError = null;
    if (isConfiguredSecret(OPENAI_API_KEY)) {
      try {
        rawGenerated = await generateAlgorithmWithOpenAI(prompt + "\nCode mode: " + codeMode + "\nDifficulty: " + difficulty, subject, null, relevantHits);
      } catch (error) {
        openAiError = error;
      }
    }
    if (!rawGenerated && relevantHits.length) {
      rawGenerated = courseAlgorithmGeneration(prompt, relevantHits);
    }
    if (!rawGenerated) {
      rawGenerated = localAlgorithmGeneration(prompt, subject, openAiError ? publicGenerationFallbackReason(openAiError) : "OpenAI API Key 未配置");
    }
    const generated = await verifyGeneratedAlgorithm(rawGenerated, prompt, subject);
    if (!generated.explanation) generated.explanation = simpleAlgorithmExplanation(prompt, generated, relevantHits, { codeMode, difficulty });
    const workflow = buildModelCodeWorkflow({ hits: relevantHits, generated });
    const experiment = buildExperimentRecord({ userId: body.userId, subject, prompt, codeMode, difficulty, generated: { ...generated, workflow }, hits: relevantHits });
    recordAudit(db, actor, "model.code_generate", {
      resourceType: "modelCode",
      resourceId: "",
      meta: {
        subject,
        sourceType: generated.sourceType,
        hits: relevantHits.length,
        title: String(generated.title || "").slice(0, 80)
      }
    }, req);
    writeDb(db);
    return send(res, 200, { ok: true, ...generated, agentName: "ML Lab Code Agent", codeMode, difficulty, workflow, experiment });
  }

  if (method === "POST" && pathname === "/api/model-code/run") {
    const body = await readBody(req);
    assertRequired(body, ["userId", "code"]);
    const subject = normalizeSubject(body.subject || "machine learning");
    const prompt = String(body.prompt || body.title || "repair and run machine learning lab code").slice(0, 1200);
    const contextHits = body.autoRepair ? (await searchCourseKnowledge(db, body.userId, prompt, { subject, limit: 5 })).filter((hit) => Number(hit.score || 0) >= 0.8) : [];
    const result = body.autoRepair ? await runModelCodeWithAutoRepair({ code: body.code, prompt, subject, contextHits }) : await runModelCodeSnippet(body.code);
    const workflow = buildModelCodeWorkflow({ hits: contextHits, generated: { sourceType: "manual", repairAttempts: result.repairAttempts || 0, verifiedRun: result }, run: result, repairHistory: result.repairHistory || [] });
    recordAudit(db, actor, "model.code_run", {
      resourceType: "modelCode",
      resourceId: "",
      meta: {
        subject: String(body.subject || "机器学习").slice(0, 40),
        title: String(body.title || "自定义代码").slice(0, 80),
        success: result.success,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        autoRepair: Boolean(body.autoRepair),
        repairAttempts: result.repairAttempts || 0
      }
    }, req);
    writeDb(db);
    return send(res, 200, { ok: true, ...result, workflow });
  }

  params = routePattern(pathname, "/api/models/:id");
  if (method === "DELETE" && params) {
    const userId = queryUserId(searchParams, actor);
    const index = db.models.findIndex((item) => item.id === params.id && item.ownerId === userId);
    if (index < 0) return notFound(res);
    recordAudit(db, actor, "model.delete", { resourceType: "model", resourceId: params.id }, req);
    db.models.splice(index, 1);
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  if (method === "GET" && pathname === "/api/chat") {
    const userId = queryUserId(searchParams, actor);
    return send(res, 200, {
      ok: true,
      friends: db.friendships.filter((item) => item.userId === userId).map((item) => publicUser(getUser(db, item.friendId))).filter(Boolean),
      friendRequests: visibleFriendRequests(db, userId),
      chatInvites: visibleChatInvites(db, userId),
      threads: db.chatThreads.filter((thread) => thread.memberIds.includes(userId)).map((thread) => publicChatThreadForUser(thread, userId))
    });
  }

  if (method === "POST" && pathname === "/api/friends") {
    const body = await readBody(req);
    assertRequired(body, ["userId", "target"]);
    const resolved = resolveUserByTarget(db, body.target);
    if (resolved.error) throw resolved.error;
    const result = createFriendRequest(db, body.userId, resolved.user.id, body.message);
    recordAudit(db, actor, result.status === "pending" ? "friend.request" : "friend.add", { resourceType: "user", resourceId: resolved.user.id, meta: { status: result.status } }, req);
    writeDb(db);
    return send(res, result.status === "pending" ? 201 : 200, { ok: true, ...result, friend: publicUser(resolved.user) });
  }

  params = routePattern(pathname, "/api/friend-requests/:id/respond");
  if (method === "POST" && params) {
    const body = await readBody(req);
    assertRequired(body, ["userId", "action"]);
    const request = respondFriendRequest(db, params.id, body.userId, body.action === "accept" ? "accept" : "reject");
    recordAudit(db, actor, "friend.request_respond", { resourceType: "friendRequest", resourceId: request.id, meta: { status: request.status } }, req);
    writeDb(db);
    return send(res, 200, { ok: true, request, state: getRelevantState(db, body.userId) });
  }

  params = routePattern(pathname, "/api/friends/:friendId");
  if (method === "DELETE" && params) {
    const userId = queryUserId(searchParams, actor);
    db.friendships = db.friendships.filter((item) => !(item.userId === userId && item.friendId === params.friendId) && !(item.userId === params.friendId && item.friendId === userId));
    db.friendRequests = (db.friendRequests || []).filter((item) => !(
      item.status === "pending"
      && ((item.fromUserId === userId && item.toUserId === params.friendId) || (item.fromUserId === params.friendId && item.toUserId === userId))
    ));
    recordAudit(db, actor, "friend.delete", { resourceType: "user", resourceId: params.friendId }, req);
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && pathname === "/api/chat/groups") {
    const body = await readBody(req);
    assertRequired(body, ["ownerId", "name"]);
    const owner = ensureUser(db, body.ownerId);
    const selectedIds = Array.from(new Set(Array.isArray(body.memberIds) ? body.memberIds.map(String) : []))
      .filter((id) => id !== owner.id && getUser(db, id));
    const thread = {
      id: uid("thread"),
      type: "group",
      name: String(body.name || "新的群聊").trim().slice(0, 40) || "新的群聊",
      ownerId: owner.id,
      adminIds: [owner.id],
      memberIds: [owner.id],
      pendingInviteIds: [],
      messages: [],
      createdAt: now(),
      updatedAt: now()
    };
    addSystemChatMessage(thread, `${owner.name || owner.id} 创建了群聊`);
    db.chatThreads.unshift(thread);
    const invites = [];
    selectedIds.forEach((friendId) => {
      const invite = createChatInvite(db, thread, owner.id, friendId);
      if (invite) invites.push(invite);
    });
    recordAudit(db, actor, "chat.group_create", { resourceType: "chatThread", resourceId: thread.id }, req);
    writeDb(db);
    return send(res, 201, { ok: true, thread, invites });
  }

  params = routePattern(pathname, "/api/chat/groups/:id/invites");
  if (method === "POST" && params) {
    const body = await readBody(req);
    assertRequired(body, ["fromUserId", "memberIds"]);
    const thread = db.chatThreads.find((item) => item.id === params.id && item.type === "group");
    if (!thread) return notFound(res);
    if (!thread.memberIds.includes(body.fromUserId)) return sendError(res, 403, "只有群成员可以邀请好友入群");
    const memberIds = Array.from(new Set(Array.isArray(body.memberIds) ? body.memberIds.map(String) : []));
    const invites = [];
    memberIds.forEach((memberId) => {
      const invite = createChatInvite(db, thread, body.fromUserId, memberId);
      if (invite) invites.push(invite);
    });
    recordAudit(db, actor, "chat.group_invite", { resourceType: "chatThread", resourceId: thread.id, meta: { count: invites.length } }, req);
    writeDb(db);
    return send(res, 201, { ok: true, thread, invites });
  }

  params = routePattern(pathname, "/api/chat/invites/:id/respond");
  if (method === "POST" && params) {
    const body = await readBody(req);
    assertRequired(body, ["userId", "action"]);
    const result = respondChatInvite(db, params.id, body.userId, body.action === "accept" ? "accept" : "reject");
    recordAudit(db, actor, "chat.invite_respond", { resourceType: "chatInvite", resourceId: result.invite.id, meta: { status: result.invite.status } }, req);
    writeDb(db);
    return send(res, 200, { ok: true, ...result, state: getRelevantState(db, body.userId) });
  }

  params = routePattern(pathname, "/api/chat/groups/:id");
  if (method === "DELETE" && params) {
    const body = await readBody(req);
    assertRequired(body, ["userId"]);
    const index = db.chatThreads.findIndex((item) => item.id === params.id && item.type === "group");
    if (index < 0) return notFound(res);
    ensureGroupOwner(db.chatThreads[index], body.userId);
    db.chatInvites = (db.chatInvites || []).filter((invite) => invite.threadId !== params.id);
    recordAudit(db, actor, "chat.group_dissolve", { resourceType: "chatThread", resourceId: params.id }, req);
    db.chatThreads.splice(index, 1);
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  params = routePattern(pathname, "/api/chat/groups/:id/members/:memberId");
  if (method === "DELETE" && params) {
    const body = await readBody(req);
    assertRequired(body, ["userId"]);
    const thread = db.chatThreads.find((item) => item.id === params.id && item.type === "group");
    if (!thread) return notFound(res);
    const removingSelf = body.userId === params.memberId;
    if (!removingSelf) ensureGroupOwner(thread, body.userId);
    if (params.memberId === thread.ownerId) return sendError(res, 400, "群主不能退出，请先解散群聊");
    thread.memberIds = thread.memberIds.filter((id) => id !== params.memberId);
    thread.adminIds = (thread.adminIds || []).filter((id) => id !== params.memberId);
    thread.pendingInviteIds = (thread.pendingInviteIds || []).filter((id) => id !== params.memberId);
    const member = getUser(db, params.memberId);
    addSystemChatMessage(thread, removingSelf ? `${member?.name || params.memberId} 退出了群聊` : `${member?.name || params.memberId} 已被移出群聊`);
    recordAudit(db, actor, removingSelf ? "chat.group_leave" : "chat.group_remove_member", { resourceType: "chatThread", resourceId: thread.id, meta: { memberId: params.memberId } }, req);
    writeDb(db);
    return send(res, 200, { ok: true, thread });
  }

  if (method === "POST" && pathname === "/api/chat/messages") {
    const body = await readBody(req);
    assertRequired(body, ["threadId", "fromUserId", "content"]);
    const thread = db.chatThreads.find((item) => item.id === body.threadId && item.memberIds.includes(body.fromUserId));
    if (!thread) return notFound(res);
    if (thread.type === "direct") {
      const otherId = thread.memberIds.find((id) => id !== body.fromUserId);
      if (!otherId || !areFriends(db, body.fromUserId, otherId)) return sendError(res, 403, "双方成为好友后才能继续私聊");
    }
    const content = String(body.content || "").trim();
    if (!content) return sendError(res, 400, "消息内容不能为空");
    if (content.length > 2000) return sendError(res, 400, "单条消息不能超过 2000 字");
    const message = { id: uid("chat"), fromUserId: body.fromUserId, content, createdAt: now(), deletedFor: [] };
    thread.messages.push(message);
    thread.updatedAt = now();
    recordAudit(db, actor, "chat.message_send", { resourceType: "chatThread", resourceId: thread.id }, req);
    writeDb(db);
    return send(res, 201, { ok: true, message, thread });
  }

  if (method === "DELETE" && pathname === "/api/chat/messages") {
    const body = await readBody(req);
    assertRequired(body, ["threadId", "userId", "messageIds"]);
    const thread = db.chatThreads.find((item) => item.id === body.threadId && item.memberIds.includes(body.userId));
    if (!thread) return notFound(res);
    thread.messages.forEach((message) => {
      if (body.messageIds.includes(message.id)) {
        message.deletedFor = Array.from(new Set([...(message.deletedFor || []), body.userId]));
      }
    });
    thread.updatedAt = now();
    recordAudit(db, actor, "chat.message_delete", { resourceType: "chatThread", resourceId: thread.id, meta: { count: body.messageIds.length } }, req);
    writeDb(db);
    return send(res, 200, { ok: true, thread });
  }

  if (method === "GET" && pathname === "/api/classes") {
    const teacherId = actor.role === "teacher" ? actor.id : (actor.role === "admin" ? searchParams.get("teacherId") : "");
    const studentId = actor.role === "student" ? actor.id : (actor.role === "admin" ? searchParams.get("studentId") : "");
    let classes = db.classes;
    if (teacherId) classes = classes.filter((item) => item.teacherId === teacherId);
    if (studentId) classes = classes.filter((item) => item.studentIds.includes(studentId));
    return send(res, 200, { ok: true, classes });
  }

  if (method === "POST" && pathname === "/api/classes") {
    const body = await readBody(req);
    assertRequired(body, ["teacherId", "name", "subject"]);
    const teacher = ensureUser(db, body.teacherId);
    if (!["teacher", "admin"].includes(teacher.role)) return sendError(res, 403, "只有教师可以创建班级");
    const klass = {
      id: uid("class"),
      teacherId: teacher.id,
      name: String(body.name),
      subject: normalizeSubject(body.subject),
      inviteCode: crypto.randomBytes(4).toString("hex").toUpperCase(),
      studentIds: [],
      importedRoster: [],
      applications: [],
      createdAt: now(),
      updatedAt: now()
    };
    db.classes.unshift(klass);
    recordAudit(db, actor, "class.create", { resourceType: "class", resourceId: klass.id, meta: { name: klass.name, subject: klass.subject } }, req);
    writeDb(db);
    return send(res, 201, { ok: true, class: klass });
  }

  params = routePattern(pathname, "/api/classes/:id");
  if (method === "DELETE" && params) {
    const body = await readBody(req);
    requireRole(actor, ["teacher", "admin"]);
    const klass = db.classes.find((item) => item.id === params.id);
    if (!klass) return notFound(res);
    const teacherId = String(body.teacherId || actor.id);
    if (actor.role !== "admin" && klass.teacherId !== actor.id) return sendError(res, 403, "只能解散自己创建的班级");
    if (actor.role === "admin" && body.teacherId && klass.teacherId !== teacherId) return sendError(res, 403, "班级不属于指定教师");

    const classStudentIds = new Set(klass.studentIds || []);
    const classHomeworkIds = new Set(db.homework.filter((item) => item.classId === klass.id).map((item) => item.id));
    const removed = {
      students: classStudentIds.size,
      homework: classHomeworkIds.size,
      submissions: db.submissions.filter((item) => classHomeworkIds.has(item.homeworkId)).length
    };

    db.users.forEach((user) => {
      if (!Array.isArray(user.classIds) || !user.classIds.includes(klass.id)) return;
      user.classIds = user.classIds.filter((classId) => classId !== klass.id);
      if (user.className === klass.name || classStudentIds.has(user.id)) {
        syncUserPrimaryClassName(db, user, klass.id);
      } else {
        user.updatedAt = now();
      }
    });


    db.courseMaterials.forEach((material) => {
      if (material.classId === klass.id) {
        material.classId = "";
        material.updatedAt = now();
      }
    });

    db.homework = db.homework.filter((item) => item.classId !== klass.id);
    db.submissions = db.submissions.filter((item) => !classHomeworkIds.has(item.homeworkId));
    db.classes = db.classes.filter((item) => item.id !== klass.id);

    recordAudit(db, actor, "class.delete", { resourceType: "class", resourceId: klass.id, meta: { name: klass.name, ...removed } }, req);
    writeDb(db);
    return send(res, 200, { ok: true, removed });
  }

  params = routePattern(pathname, "/api/classes/:id/import-students");
  if (method === "POST" && params) {
    const body = await readBody(req);
    requireRole(actor, ["teacher", "admin"]);
    const klass = db.classes.find((item) => item.id === params.id);
    if (!klass) return notFound(res);
    const teacherId = String(body.teacherId || actor.id);
    if (actor.role !== "admin" && klass.teacherId !== actor.id) return sendError(res, 403, "只能导入自己的班级");
    if (actor.role === "admin" && body.teacherId && klass.teacherId !== teacherId) return sendError(res, 403, "班级不属于指定教师");
    klass.studentIds = Array.isArray(klass.studentIds) ? klass.studentIds.map(String) : [];
    klass.importedRoster = Array.isArray(klass.importedRoster) ? klass.importedRoster : [];
    const rows = Array.isArray(body.students) ? body.students : [];
    const added = [];
    rows.forEach((row) => {
      const name = String(row.name || "").trim();
      const studentNo = String(row.id || "").trim();
      if (!name && !studentNo) return;
      let user = studentNo ? db.users.find((item) => item.role === "student" && item.id === studentNo) : null;
      if (!user) {
        user = {
          id: studentNo && /^\d{8}$/.test(studentNo) && !db.users.some((item) => item.id === studentNo) ? studentNo : generateUserId(db),
          name: name || `学生${studentNo || db.users.length + 1}`,
          role: "student",
          passwordHash: hashPassword("123456"),
          subject: "",
          className: "",
          classIds: [],
          avatar: (name || "学").slice(0, 1),
          createdAt: now()
        };
        db.users.push(user);
      }
      if (!klass.studentIds.includes(user.id)) klass.studentIds.push(user.id);
      user.classIds = Array.from(new Set([...(user.classIds || []), klass.id]));
      syncUserPrimaryClassName(db, user);
      if (!klass.importedRoster.some((item) => item.id === user.id)) {
        klass.importedRoster.push({ id: user.id, name: user.name, source: "import", createdAt: now() });
      }
      added.push(publicUser(user));
    });
    klass.updatedAt = now();
    recordAudit(db, actor, "class.import_students", { resourceType: "class", resourceId: klass.id, meta: { count: added.length } }, req);
    writeDb(db);
    return send(res, 200, { ok: true, added, class: klass });
  }

  params = routePattern(pathname, "/api/classes/:id/apply");
  if (method === "POST" && params) {
    const body = await readBody(req);
    assertRequired(body, ["studentId"]);
    requireRole(actor, ["student", "admin"]);
    assertActorOwnsUser(actor, body.studentId);
    const klass = db.classes.find((item) => item.id === params.id || item.inviteCode === params.id);
    if (!klass) return notFound(res);
    const student = ensureUser(db, body.studentId);
    if (student.role !== "student") return sendError(res, 403, "只有学生可以加入班级");
    if (actor.role === "student" && actor.id !== student.id) return sendError(res, 403, "只能为自己加入班级");
    klass.studentIds = Array.isArray(klass.studentIds) ? klass.studentIds.map(String) : [];
    klass.importedRoster = Array.isArray(klass.importedRoster) ? klass.importedRoster : [];
    klass.applications = Array.isArray(klass.applications) ? klass.applications : [];
    const existsInRoster = klass.importedRoster.some((item) => item.id === student.id || item.name === student.name);
    const alreadyJoined = klass.studentIds.includes(student.id) || (student.classIds || []).includes(klass.id);
    const pendingApplication = klass.applications.find((item) => item.studentId === student.id && item.status === "pending");
    if (pendingApplication && !alreadyJoined) {
      return send(res, 200, { ok: true, application: pendingApplication, class: klass });
    }
    const autoApprove = alreadyJoined || existsInRoster;
    if (autoApprove && !klass.studentIds.includes(student.id)) klass.studentIds.push(student.id);
    if (autoApprove) {
      student.classIds = Array.from(new Set([...(student.classIds || []), klass.id]));
      syncUserPrimaryClassName(db, student);
    }
    const application = {
      id: uid("app"),
      studentId: student.id,
      studentName: student.name,
      status: autoApprove ? "approved" : "pending",
      reason: alreadyJoined ? "已在班级中，无需重复加入" : (existsInRoster ? "导入名单匹配，自动通过" : "不在导入名单，等待教师同意"),
      createdAt: now(),
      updatedAt: now()
    };
    klass.applications.unshift(application);
    klass.updatedAt = now();
    recordAudit(db, actor, "class.apply", { resourceType: "class", resourceId: klass.id }, req);
    writeDb(db);
    return send(res, 200, { ok: true, application, class: klass });
  }

  params = routePattern(pathname, "/api/classes/:id/applications/:applicationId");
  if (method === "POST" && params) {
    const body = await readBody(req);
    requireRole(actor, ["teacher", "admin"]);
    const klass = db.classes.find((item) => item.id === params.id);
    if (!klass) return notFound(res);
    const teacherId = String(body.teacherId || actor.id);
    if (actor.role !== "admin" && klass.teacherId !== actor.id) return sendError(res, 403, "只能审核自己班级的申请");
    if (actor.role === "admin" && body.teacherId && klass.teacherId !== teacherId) return sendError(res, 403, "班级不属于指定教师");
    klass.applications = Array.isArray(klass.applications) ? klass.applications : [];
    const application = klass.applications.find((item) => item.id === params.applicationId);
    if (!application) return notFound(res);
    if (application.status !== "pending") return send(res, 200, { ok: true, application, class: klass });
    const action = String(body.action || "").toLowerCase();
    if (!["accept", "approve", "approved", "reject", "rejected"].includes(action)) return sendError(res, 400, "审核动作必须是 accept 或 reject");
    const approved = ["accept", "approve", "approved"].includes(action);
    application.status = approved ? "approved" : "rejected";
    application.reason = approved ? "教师已同意加入班级" : "教师已拒绝加入班级";
    application.reviewedBy = actor.id;
    application.updatedAt = now();
    if (approved) {
      const student = ensureUser(db, application.studentId);
      if (student.role !== "student") return sendError(res, 400, "申请账号不是学生");
      klass.studentIds = Array.isArray(klass.studentIds) ? klass.studentIds.map(String) : [];
      if (!klass.studentIds.includes(student.id)) klass.studentIds.push(student.id);
      student.classIds = Array.from(new Set([...(student.classIds || []), klass.id]));
      syncUserPrimaryClassName(db, student);
    }
    klass.updatedAt = now();
    recordAudit(db, actor, approved ? "class.application_approve" : "class.application_reject", {
      resourceType: "class",
      resourceId: klass.id,
      meta: { applicationId: application.id, studentId: application.studentId }
    }, req);
    writeDb(db);
    return send(res, 200, { ok: true, application, class: klass });
  }

  params = routePattern(pathname, "/api/classes/:id/students/:studentId");
  if (method === "DELETE" && params) {
    requireRole(actor, ["teacher", "student", "admin"]);
    const klass = db.classes.find((item) => item.id === params.id);
    if (!klass) return notFound(res);
    const studentId = String(params.studentId || "");
    const student = getUser(db, studentId);
    const isSelfLeave = actor.role === "student" && actor.id === studentId;
    const isTeacherOwner = actor.role === "teacher" && klass.teacherId === actor.id;
    if (actor.role === "student" && !isSelfLeave) return sendError(res, 403, "只能退出自己的班级");
    if (!isSelfLeave && actor.role !== "admin" && !isTeacherOwner) return sendError(res, 403, "只能移除自己班级的学生");
    if (student && student.role !== "student") return sendError(res, 400, "只能移除学生账号");
    const hasMembership = (klass.studentIds || []).includes(studentId) || (student?.classIds || []).includes(klass.id);
    if (!hasMembership) return sendError(res, 404, "该学生不在此班级");
    const result = removeStudentFromClass(db, klass, studentId);
    const action = isSelfLeave ? "class.leave" : "class.remove_student";
    recordAudit(db, actor, action, {
      resourceType: "class",
      resourceId: klass.id,
      meta: { studentId, studentName: result.student?.name || "" }
    }, req);
    writeDb(db);
    return send(res, 200, { ok: true, removed: result.removed, class: klass, student: result.student ? publicUser(result.student) : null });
  }

  if (method === "GET" && pathname === "/api/homework") {
    const teacherId = actor.role === "teacher" ? actor.id : (actor.role === "admin" ? searchParams.get("teacherId") : "");
    const studentId = actor.role === "student" ? actor.id : (actor.role === "admin" ? searchParams.get("studentId") : "");
    let homework = db.homework;
    if (teacherId) homework = homework.filter((item) => item.teacherId === teacherId);
    if (studentId) {
      const user = ensureUser(db, studentId);
      const ids = user.classIds || [];
      homework = homework.filter((item) => ids.includes(item.classId));
    }
    const homeworkIds = new Set(homework.map((item) => item.id));
    const submissions = db.submissions.filter((item) => {
      if (!homeworkIds.has(item.homeworkId)) return false;
      if (actor.role === "student") return item.studentId === actor.id;
      if (actor.role === "teacher") return db.homework.some((homeworkItem) => homeworkItem.id === item.homeworkId && homeworkItem.teacherId === actor.id);
      return true;
    });
    return send(res, 200, { ok: true, homework, submissions });
  }

  if (method === "POST" && pathname === "/api/homework") {
    const body = await readBody(req);
    assertRequired(body, ["teacherId", "classId", "title"]);
    requireRole(actor, ["teacher", "admin"]);
    const klass = db.classes.find((item) => item.id === body.classId && item.teacherId === body.teacherId);
    if (!klass) return sendError(res, 404, "班级不存在或无权限");
    const homework = {
      id: uid("homework"),
      teacherId: body.teacherId,
      classId: body.classId,
      title: String(body.title),
      description: String(body.description || ""),
      answer: String(body.answer || ""),
      rubric: parseRubricInput(body.rubric, {
        title: body.title,
        description: body.description,
        answer: body.answer
      }),
      rubricText: rubricToText(parseRubricInput(body.rubric, {
        title: body.title,
        description: body.description,
        answer: body.answer
      })),
      taskType: String(body.taskType || "standard").slice(0, 60),
      errorTag: String(body.errorTag || "").slice(0, 160),
      difficulty: String(body.difficulty || "基础").slice(0, 40),
      dueAt: body.dueAt ? String(body.dueAt).slice(0, 60) : "",
      resources: Array.isArray(body.resources) ? body.resources.map((item) => String(item).slice(0, 180)).slice(0, 12) : [],
      targetStudentIds: Array.isArray(body.targetStudentIds) ? body.targetStudentIds.map(String).slice(0, 500) : [],
      remediationMetrics: { baselineErrorCount: Math.max(0, Number(body.baselineErrorCount || 0)), baselineStudentCount: Math.max(0, Number(body.baselineStudentCount || 0)), completedCount: 0, improvedCount: 0, errorEliminatedCount: 0 },
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      createdAt: now(),
      updatedAt: now()
    };
    db.homework.unshift(homework);
    recordAudit(db, actor, "homework.create", { resourceType: "homework", resourceId: homework.id, meta: { title: homework.title, classId: homework.classId } }, req);
    writeDb(db);
    return send(res, 201, { ok: true, homework });
  }

  params = routePattern(pathname, "/api/homework/:id");
  if (method === "PUT" && params) {
    const body = await readBody(req);
    const homework = db.homework.find((item) => item.id === params.id);
    if (!homework) return notFound(res);
    if (homework.teacherId !== body.teacherId) return sendError(res, 403, "无权修改该作业");
    if (body.classId) {
      const klass = db.classes.find((item) => item.id === body.classId && item.teacherId === body.teacherId);
      if (!klass) return sendError(res, 404, "班级不存在或无权限");
      homework.classId = body.classId;
    }
    if (body.title !== undefined) homework.title = String(body.title || homework.title);
    if (body.description !== undefined) homework.description = String(body.description || "");
    if (body.answer !== undefined) homework.answer = String(body.answer || "");
    if (body.taskType !== undefined) homework.taskType = String(body.taskType || "standard").slice(0, 60);
    if (body.errorTag !== undefined) homework.errorTag = String(body.errorTag || "").slice(0, 160);
    if (body.difficulty !== undefined) homework.difficulty = String(body.difficulty || "基础").slice(0, 40);
    if (body.dueAt !== undefined) homework.dueAt = String(body.dueAt || "").slice(0, 60);
    if (Array.isArray(body.resources)) homework.resources = body.resources.map((item) => String(item).slice(0, 180)).slice(0, 12);
    if (body.rubric !== undefined || body.answer !== undefined || body.description !== undefined || body.title !== undefined) {
      homework.rubric = parseRubricInput(body.rubric !== undefined ? body.rubric : homework.rubricText, homework);
      homework.rubricText = rubricToText(homework.rubric);
    }
    if (Array.isArray(body.attachments) && body.attachments.length) homework.attachments = body.attachments;
    homework.updatedAt = now();
    recordAudit(db, actor, "homework.update", { resourceType: "homework", resourceId: homework.id }, req);
    writeDb(db);
    return send(res, 200, { ok: true, homework });
  }

  if (method === "DELETE" && params) {
    const body = await readBody(req);
    const homework = db.homework.find((item) => item.id === params.id);
    if (!homework) return notFound(res);
    if (homework.teacherId !== body.teacherId) return sendError(res, 403, "无权删除该作业");
    recordAudit(db, actor, "homework.delete", { resourceType: "homework", resourceId: homework.id }, req);
    db.homework = db.homework.filter((item) => item.id !== homework.id);
    db.submissions = db.submissions.filter((item) => item.homeworkId !== homework.id);
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  params = routePattern(pathname, "/api/homework/:id/submit");
  if (method === "POST" && params) {
    const body = await readBody(req);
    assertRequired(body, ["studentId"]);
    requireRole(actor, ["student", "admin"]);
    assertActorOwnsUser(actor, body.studentId);
    const homework = db.homework.find((item) => item.id === params.id);
    if (!homework) return notFound(res);
    const student = ensureUser(db, body.studentId);
    if (!(student.classIds || []).includes(homework.classId)) return sendError(res, 403, "该学生不在作业所属班级");
    let submission = db.submissions.find((item) => item.homeworkId === homework.id && item.studentId === student.id);
    const payload = {
      homeworkId: homework.id,
      studentId: student.id,
      answerText: String(body.answerText || ""),
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      status: "submitted",
      updatedAt: now()
    };
    if (submission) {
      Object.assign(submission, payload);
    } else {
      submission = { id: uid("submission"), ...payload, createdAt: now() };
      db.submissions.unshift(submission);
    }
    ["score", "comment", "feedback", "aiSuggestedScore", "aiComment", "aiGradedAt", "gradedAt", "confirmedAt", "confirmedBy", "gradeType"].forEach((key) => {
      delete submission[key];
    });
    recordAudit(db, actor, "homework.submit", { resourceType: "submission", resourceId: submission.id, meta: { homeworkId: homework.id } }, req);
    writeDb(db);
    const multimodalJob = submission.attachments.length
      ? getBackgroundQueue().enqueue("homework_multimodal", { submissionId: submission.id }, { createdBy: actor.id, maxAttempts: 2 })
      : null;
    return send(res, 201, { ok: true, submission, multimodalJob: publicBackgroundJob(multimodalJob) });
  }

  params = routePattern(pathname, "/api/submissions/:id/ai-grade");
  if (method === "POST" && params) {
    const body = await readBody(req);
    requireRole(actor, ["teacher", "admin"]);
    const submission = db.submissions.find((item) => item.id === params.id);
    if (!submission) return notFound(res);
    const homework = db.homework.find((item) => item.id === submission.homeworkId);
    if (!homework || homework.teacherId !== body.teacherId) return sendError(res, 403, "无批改权限");
    const feedback = gradeSubmissionWithFeedback(db, homework, submission);
    submission.aiSuggestedScore = feedback.score;
    submission.status = "review_pending";
    submission.gradeType = "ai_suggestion";
    submission.aiComment = feedback.comment;
    submission.feedback = {
      missing: feedback.missing,
      topics: feedback.topics,
      rubric: feedback.rubric,
      rubricResults: feedback.rubricResults,
      teacherReviewRequired: true,
      reliability: "AI 给出评分建议，最终结果建议由教师确认"
    };
    submission.aiGradedAt = now();
    submission.updatedAt = now();
    recordAudit(db, actor, "submission.ai_grade", { resourceType: "submission", resourceId: submission.id, meta: { suggestedScore: feedback.score, homeworkId: homework.id } }, req);
    writeDb(db);
    return send(res, 200, { ok: true, submission });
  }

  params = routePattern(pathname, "/api/submissions/:id/manual-grade");
  if (method === "POST" && params) {
    const body = await readBody(req);
    requireRole(actor, ["teacher", "admin"]);
    const submission = db.submissions.find((item) => item.id === params.id);
    if (!submission) return notFound(res);
    const homework = db.homework.find((item) => item.id === submission.homeworkId);
    if (!homework || homework.teacherId !== body.teacherId) return sendError(res, 403, "无批改权限");
    const finalScore = Number.isFinite(Number(body.score)) ? Number(body.score) : Number(submission.aiSuggestedScore || 0);
    submission.score = Math.max(0, Math.min(100, Math.round(finalScore)));
    submission.status = "graded";
    submission.gradeType = submission.aiSuggestedScore !== undefined ? "teacher_confirmed" : "manual";
    submission.comment = String(body.comment || "");
    submission.gradedAt = now();
    submission.confirmedAt = now();
    submission.confirmedBy = actor.id;
    submission.updatedAt = now();
    const topics = submission.feedback?.topics?.length ? submission.feedback.topics : inferQuestionTopics(`${homework.title} ${homework.description}`, "");
    updateTopicMastery(db, submission.studentId, topics, submission.score >= 80 ? 0.06 : submission.score >= 60 ? 0.01 : -0.06, `教师确认批改：${homework.title} ${submission.score} 分`);
    const profile = ensureLearningProfile(db, submission.studentId);
    profile.gradedCount = Number(profile.gradedCount || 0) + 1;
    recordLearningActivity(db, submission.studentId, {
      kind: "graded",
      mode: "homework",
      prompt: homework.title,
      topics,
      score: submission.score,
      minutes: 5
    });
    const learningEvent = recordLearningEvent(db, {
      studentId: submission.studentId,
      classId: homework.classId,
      teacherId: homework.teacherId,
      eventType: "homework_grade_confirmed",
      source: "teacher-confirmed-grade",
      subject: homework.subject || "",
      knowledgePoint: topics[0] || "",
      homeworkId: homework.id,
      submissionId: submission.id,
      score: submission.score,
      payload: {
        homeworkTitle: homework.title,
        topics,
        comment: submission.comment,
        gradeType: submission.gradeType,
        feedback: submission.feedback || null
      },
      idempotencyKey: `homework-grade:${submission.id}:${submission.confirmedAt}`
    });
    recordDiagnosisResult(db, {
      studentId: submission.studentId,
      eventId: learningEvent?.id || "",
      topic: topics[0] || homework.title || "",
      masteryScore: submission.score,
      masteryLevel: profile.mastery?.[topics[0]]?.status || "",
      errorTags: [],
      missingPoints: submission.feedback?.missing || [],
      evidence: submission.feedback?.rubricResults || [],
      finalAnswer: submission.comment || submission.aiComment || "",
      modelOrWorkflow: "teacher-confirmed-grade",
      idempotencyKey: learningEvent?.id ? `homework-grade-diagnosis:${learningEvent.id}` : ""
    });
    syncStudentMasteryFromProfile(db, submission.studentId, topics, {
      subject: homework.subject || "",
      lastEventId: learningEvent?.id || ""
    });
    if (submission.score < 75 && topics[0]) {
      addWrongNote(db, submission.studentId, {
        source: `作业：${homework.title}`,
        topic: topics[0],
        question: homework.description,
        answer: submission.answerText,
        analysis: submission.comment || submission.aiComment || "教师确认分数较低，建议回看评分标准。",
        recommendation: "先补齐缺失要点，再生成 2 道同类题练习。"
      });
    }
    if (submission.feedback) {
      submission.feedback.teacherReviewRequired = false;
      submission.feedback.confirmedScore = submission.score;
      submission.feedback.confirmedAt = submission.confirmedAt;
    }
    recordAudit(db, actor, "submission.manual_grade", { resourceType: "submission", resourceId: submission.id, meta: { score: submission.score, homeworkId: homework.id } }, req);
    writeDb(db);
    return send(res, 200, { ok: true, submission });
  }

  return notFound(res);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  }[ext] || "application/octet-stream";
}

function staticHeaders(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = { ...SECURITY_HEADERS, "content-type": contentType(filePath) };
  if (NO_CACHE_STATIC_EXTENSIONS.has(ext)) {
    headers["cache-control"] = "no-store, no-cache, must-revalidate, proxy-revalidate";
    headers["pragma"] = "no-cache";
    headers["expires"] = "0";
  }
  return headers;
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, fallback) => {
        if (fallbackError) {
          res.writeHead(404, SECURITY_HEADERS);
          res.end("Not found");
        } else {
          res.writeHead(200, staticHeaders(path.join(PUBLIC_DIR, "index.html")));
          res.end(fallback);
        }
      });
      return;
    }
    res.writeHead(200, staticHeaders(filePath));
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname, url.searchParams);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    sendError(res, status, error.message || "服务器错误");
  }
});

function listenWithFallback(port, attemptsLeft = 20) {
  server.once("error", (error) => {
    if ((error.code === "EADDRINUSE" || error.code === "EACCES") && !process.env.PORT && attemptsLeft > 0) {
      listenWithFallback(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(error);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    ensureDataDir();
    loadRuntimeState();
    readDb();
    getBackgroundQueue();
    console.log(`智慧教育智能体平台已启动：http://${HOST}:${port}`);
  });
}

listenWithFallback(PORT);
