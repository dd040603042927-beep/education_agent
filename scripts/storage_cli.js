const fs = require("fs");
const path = require("path");
const { createStorage } = require("../storage");
const { resolveSqlitePath } = require("../storage/sqliteStore");

const ROOT = path.join(__dirname, "..");
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const JSON_DB_PATH = path.resolve(process.env.JSON_DB_PATH || path.join(DATA_DIR, "db.json"));
const SQLITE_PATH = resolveSqlitePath(process.env.DATABASE_URL || process.env.SQLITE_PATH, path.join(DATA_DIR, "education.db"));
const SCHEMA_PATH = path.join(ROOT, "storage", "schema.sql");

function openStorage() {
  return createStorage({
    driver: process.env.STORAGE_DRIVER,
    dbPath: JSON_DB_PATH,
    sqlitePath: SQLITE_PATH,
    schemaPath: SCHEMA_PATH,
    ensureDataDir: () => fs.mkdirSync(DATA_DIR, { recursive: true }),
    initialData: () => { throw new Error("Database is empty. Start the server or migrate existing JSON first."); },
    writeJson: (filePath, db) => {
      fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(db, null, 2), "utf8");
      fs.renameSync(`${filePath}.tmp`, filePath);
    }
  });
}

module.exports = { ROOT, DATA_DIR, JSON_DB_PATH, SQLITE_PATH, SCHEMA_PATH, openStorage };
