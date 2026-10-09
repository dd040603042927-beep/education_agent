const path = require("path");
const { createJsonStore } = require("./jsonStore");

function normalizeDriver(value) {
  return String(value || "sqlite").trim().toLowerCase();
}

function createStorage(options) {
  const driver = normalizeDriver(options.driver);
  if (driver === "json") return createJsonStore(options);
  if (driver === "sqlite") {
    const { createSqliteStore } = require("./sqliteStore");
    return createSqliteStore({
      ...options,
      sqlitePath: options.sqlitePath || path.join(options.dataDir || process.cwd(), "education.db")
    });
  }
  throw new Error(`Unsupported STORAGE_DRIVER: ${driver}`);
}

module.exports = { createStorage };
