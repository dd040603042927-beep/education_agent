const fs = require("fs");
const path = require("path");

const { DatabaseSync } = require("node:sqlite");
const { ROOT, DATA_DIR, SQLITE_PATH } = require("./storage_cli");
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(ROOT, "logs"));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(ROOT, "backups"));

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function copyRecursive(source, target) {
  if (path.resolve(source) === BACKUP_DIR) return;
  if (!fs.existsSync(source)) return;
  if (source.endsWith("-wal") || source.endsWith("-shm")) return;
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    fs.readdirSync(source).forEach((name) => copyRecursive(path.join(source, name), path.join(target, name)));
    return;
  }
  if (!fs.existsSync(path.dirname(target))) fs.mkdirSync(path.dirname(target), { recursive: true });
  if (source === SQLITE_PATH || source.endsWith(".db")) {
    const sqlite = new DatabaseSync(source, { readOnly: true });
    try {
      sqlite.prepare("VACUUM INTO ?").run(target);
    } finally {
      sqlite.close();
    }
    return;
  }
  fs.copyFileSync(source, target);
}

function directorySize(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).reduce((sum, name) => {
    const filePath = path.join(dir, name);
    const stat = fs.statSync(filePath);
    return sum + (stat.isDirectory() ? directorySize(filePath) : stat.size);
  }, 0);
}

function main() {
  const target = path.join(BACKUP_DIR, `backup-${stamp()}`);
  fs.mkdirSync(target, { recursive: true });
  copyRecursive(DATA_DIR, path.join(target, "data"));
  copyRecursive(LOG_DIR, path.join(target, "logs"));
  const relativeSqlite = path.relative(DATA_DIR, SQLITE_PATH);
  const externalSqlite = relativeSqlite.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSqlite);
  if (externalSqlite && fs.existsSync(SQLITE_PATH)) copyRecursive(SQLITE_PATH, path.join(target, "database", "education.db"));
  const manifest = {
    createdAt: new Date().toISOString(),
    source: ROOT,
    includes: ["data", "logs"],
    storageDriver: process.env.STORAGE_DRIVER || "sqlite",
    sqliteSource: SQLITE_PATH,
    sqliteBackup: externalSqlite ? "database/education.db" : path.join("data", relativeSqlite),
    bytes: directorySize(target)
  };
  fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`backup created: ${target}`);
  console.log(`bytes: ${manifest.bytes}`);
}

main();
