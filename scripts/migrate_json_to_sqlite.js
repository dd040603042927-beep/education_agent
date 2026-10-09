const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { createSqliteStore } = require("../storage/sqliteStore");
const { ROOT, DATA_DIR, JSON_DB_PATH, SQLITE_PATH, SCHEMA_PATH } = require("./storage_cli");

function main() {
  if (JSON_DB_PATH.toLowerCase() === SQLITE_PATH.toLowerCase()) throw new Error("Source and target paths must differ.");
  if (fs.existsSync(SQLITE_PATH) && !process.argv.includes("--replace")) {
    throw new Error("Target SQLite already exists. Stop the server and use --replace to back it up and replace it from JSON.");
  }
  const source = fs.readFileSync(JSON_DB_PATH);
  const db = JSON.parse(source.toString("utf8"));
  if (!db || typeof db !== "object" || Array.isArray(db) || !Array.isArray(db.users)) {
    throw new Error("Invalid JSON database: expected an object with a users array.");
  }
  for (const key of ["learningEvents", "diagnosisResults", "studentMastery"]) {
    if (db[key] === undefined) db[key] = [];
    if (!Array.isArray(db[key])) throw new Error(`Invalid collection: ${key}`);
  }

  const backupRoot = path.resolve(process.env.BACKUP_DIR || path.join(ROOT, "backups"));
  fs.mkdirSync(backupRoot, { recursive: true });
  const backupDir = fs.mkdtempSync(path.join(backupRoot, `sqlite-cutover-${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  fs.writeFileSync(path.join(backupDir, "db.json"), source);
  if (fs.existsSync(path.join(ROOT, ".env"))) fs.copyFileSync(path.join(ROOT, ".env"), path.join(backupDir, "config.env"));

  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
  const stagingPath = `${SQLITE_PATH}.migrating-${crypto.randomUUID()}`;
  const store = createSqliteStore({ sqlitePath: stagingPath, schemaPath: SCHEMA_PATH });
  try {
    store.write(db);
    assert.deepStrictEqual(store.read(), db, "Migration must preserve every JSON field and record exactly");
  } finally {
    store.close();
  }
  const staged = new DatabaseSync(stagingPath, { readOnly: true });
  try {
    assert.equal(staged.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepStrictEqual(staged.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    staged.close();
  }

  let previousSqlite = null;
  if (fs.existsSync(SQLITE_PATH)) {
    previousSqlite = path.join(backupDir, "education-before.db");
    const previous = new DatabaseSync(SQLITE_PATH);
    try {
      previous.prepare("VACUUM INTO ?").run(previousSqlite);
      const checkpoint = previous.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (checkpoint.busy) throw new Error("SQLite is busy. Stop all writers before migration.");
    } finally {
      previous.close();
    }
  }
  if (fs.existsSync(`${SQLITE_PATH}-wal`) || fs.existsSync(`${SQLITE_PATH}-shm`)) {
    throw new Error("SQLite sidecars are still present. Close all database connections before migration.");
  }
  assert.ok(source.equals(fs.readFileSync(JSON_DB_PATH)), "JSON changed during migration. Stop all writers and retry.");
  fs.renameSync(stagingPath, SQLITE_PATH);

  const report = {
    createdAt: new Date().toISOString(),
    sourceJson: JSON_DB_PATH,
    sourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
    sqlitePath: SQLITE_PATH,
    backupDir,
    previousSqlite,
    verified: { exactRoundTrip: true, integrity: "ok", foreignKeys: "ok" },
    counts: Object.fromEntries(Object.entries(db).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]))
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const reportText = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(backupDir, "migration-report.json"), reportText, "utf8");
  fs.writeFileSync(path.join(DATA_DIR, "migration-report.json"), reportText, "utf8");
  console.log(reportText);
}

main();
