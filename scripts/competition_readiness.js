const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf8");
  const env = {};
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index < 0) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    env[key] = value;
  });
  return env;
}

function resolveEnv(name) {
  return process.env[name] || readEnvFile(ENV_PATH)[name] || "";
}

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function addIssue(list, level, message) {
  list.push({ level, message });
}

function main() {
  const issues = [];
  const checks = [];
  const env = {
    HOST: resolveEnv("HOST"),
    PORT: resolveEnv("PORT"),
    DATA_DIR: resolveEnv("DATA_DIR"),
    LOG_DIR: resolveEnv("LOG_DIR"),
    STORAGE_DRIVER: resolveEnv("STORAGE_DRIVER"),
    SESSION_SECRET: resolveEnv("SESSION_SECRET"),
    DIFY_CALLBACK_TOKEN: resolveEnv("DIFY_CALLBACK_TOKEN"),
    OPENAI_API_KEY: resolveEnv("OPENAI_API_KEY"),
    DIFY_STUDENT_WORKFLOW_API_KEY: resolveEnv("DIFY_STUDENT_WORKFLOW_API_KEY"),
    DIFY_TEACHER_WORKFLOW_API_KEY: resolveEnv("DIFY_TEACHER_WORKFLOW_API_KEY")
  };

  if (!env.SESSION_SECRET || /replace-with|change-me|secret/i.test(env.SESSION_SECRET)) {
    addIssue(issues, "error", "SESSION_SECRET 未设置为强随机值");
  }
  if (!env.DIFY_CALLBACK_TOKEN || /replace-me|change-me|token/i.test(env.DIFY_CALLBACK_TOKEN)) {
    addIssue(issues, "warn", "DIFY_CALLBACK_TOKEN 仍像占位值，Dify 回调可能被拒绝");
  }
  if (!env.DATA_DIR) addIssue(issues, "warn", "DATA_DIR 未显式设置，建议指向 ./data");
  if (!env.LOG_DIR) addIssue(issues, "warn", "LOG_DIR 未显式设置，建议指向 ./logs");
  if (!env.STORAGE_DRIVER) addIssue(issues, "warn", "STORAGE_DRIVER 未显式设置，默认使用 SQLite；已有 JSON 请先迁移");
  if (!env.OPENAI_API_KEY) addIssue(issues, "warn", "OPENAI_API_KEY 未设置，若依赖 OpenAI 回答需补充");
  if (!env.DIFY_STUDENT_WORKFLOW_API_KEY) addIssue(issues, "warn", "DIFY_STUDENT_WORKFLOW_API_KEY 未设置，学生端工作流无法联通");
  if (!env.DIFY_TEACHER_WORKFLOW_API_KEY) addIssue(issues, "warn", "DIFY_TEACHER_WORKFLOW_API_KEY 未设置，教师端工作流无法联通");

  const requiredFiles = [
    "server.js",
    "package.json",
    "README.md",
    "DEPLOYMENT.md",
    "public/index.html",
    "public/app.js",
    "public/styles.css",
    "scripts/release_smoke_test.js",
    "scripts/backup_data.js",
    "scripts/migrate_json_to_sqlite.js",
    "scripts/aggregate_student_mastery.js"
  ];
  const requiredDirs = ["public", "scripts", "storage", "data", "logs", "backups"];

  for (const file of requiredFiles) {
    const ok = exists(file);
    checks.push({ name: file, ok });
    if (!ok) addIssue(issues, "error", `缺少关键文件：${file}`);
  }
  for (const dir of requiredDirs) {
    const ok = exists(dir);
    checks.push({ name: dir, ok });
    if (!ok) addIssue(issues, "error", `缺少关键目录：${dir}`);
  }

  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, "data"));
  const databaseUrl = resolveEnv("DATABASE_URL") || resolveEnv("SQLITE_PATH");
  const dbPath = env.STORAGE_DRIVER === "json" ? path.join(dataDir, "db.json")
    : databaseUrl ? path.resolve(databaseUrl.replace(/^file:/, "")) : path.join(dataDir, "education.db");
  if (!fs.existsSync(dbPath)) {
    addIssue(issues, "warn", `当前数据库不存在：${dbPath}；已有 JSON 请先迁移，否则先启动服务初始化`);
  }

  console.log("教育智能体竞赛部署体检");
  console.log("");
  console.log("环境变量");
  Object.entries(env).forEach(([key, value]) => {
    const status = value ? "OK" : "EMPTY";
    console.log(`- ${key}: ${status}`);
  });

  console.log("");
  console.log("文件检查");
  checks.forEach((item) => {
    console.log(`- ${item.ok ? "OK" : "MISS"} ${item.name}`);
  });

  console.log("");
  if (!issues.length) {
    console.log("结论: 通过。当前项目具备竞赛部署基础。");
    process.exit(0);
  }

  const errors = issues.filter((item) => item.level === "error");
  const warns = issues.filter((item) => item.level === "warn");
  if (errors.length) {
    console.log("关键问题");
    errors.forEach((item) => console.log(`- ${item.message}`));
  }
  if (warns.length) {
    console.log("建议修正");
    warns.forEach((item) => console.log(`- ${item.message}`));
  }
  console.log("");
  console.log(errors.length ? "结论: 未通过，请先修正关键问题。" : "结论: 可用，但建议补全警告项。");
  process.exit(errors.length ? 1 : 0);
}

main();
