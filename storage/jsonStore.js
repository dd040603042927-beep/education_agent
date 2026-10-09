const fs = require("fs");
const crypto = require("crypto");

function createJsonStore(options) {
  const {
    dbPath,
    ensureDataDir,
    initialData,
    normalizeData,
    writeJson
  } = options;

  if (!dbPath) throw new Error("json storage requires dbPath");
  if (typeof ensureDataDir !== "function") throw new Error("json storage requires ensureDataDir");
  if (typeof initialData !== "function") throw new Error("json storage requires initialData");
  if (typeof writeJson !== "function") throw new Error("json storage requires writeJson");

  function read() {
    ensureDataDir();
    if (!fs.existsSync(dbPath)) {
      writeJson(dbPath, initialData());
    }
    const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    if (typeof normalizeData === "function" && normalizeData(db)) {
      write(db);
    }
    return db;
  }

  function write(db) {
    writeJson(dbPath, db);
  }

  function metadata() {
    return {
      driver: "json",
      label: "json-atomic",
      path: dbPath
    };
  }

  function jobs(db) {
    db.backgroundJobs = Array.isArray(db.backgroundJobs) ? db.backgroundJobs : [];
    return db.backgroundJobs;
  }

  function enqueueJob(job = {}) {
    const db = read();
    const timestamp = new Date().toISOString();
    const item = { id: job.id || `job_${crypto.randomBytes(8).toString("hex")}`, type: String(job.type || "unknown"), status: "queued", payload: job.payload || {}, result: null, error: "", attempts: 0, maxAttempts: Math.max(1, Number(job.maxAttempts || 3)), runAfter: job.runAfter || timestamp, createdBy: String(job.createdBy || ""), createdAt: timestamp, startedAt: "", completedAt: "", updatedAt: timestamp };
    jobs(db).push(item); write(db); return item;
  }

  function getJob(id) { return jobs(read()).find((item) => item.id === id) || null; }
  function recoverJobs() { const db = read(); let changed = false; jobs(db).forEach((item) => { if (item.status === "running") { item.status = "queued"; item.error = "interrupted by restart"; item.updatedAt = new Date().toISOString(); changed = true; } }); if (changed) write(db); }
  function claimNextJob() { const db = read(); const timestamp = new Date().toISOString(); const item = jobs(db).find((job) => job.status === "queued" && job.runAfter <= timestamp); if (!item) return null; item.status = "running"; item.attempts += 1; item.startedAt = timestamp; item.updatedAt = timestamp; write(db); return item; }
  function completeJob(id, result) { const db = read(); const item = jobs(db).find((job) => job.id === id); if (!item) return null; item.status = "complete"; item.result = result; item.error = ""; item.completedAt = item.updatedAt = new Date().toISOString(); write(db); return item; }
  function failJob(id, error, retryable) { const db = read(); const item = jobs(db).find((job) => job.id === id); if (!item) return null; const timestamp = new Date().toISOString(); const retry = retryable && item.attempts < item.maxAttempts; item.status = retry ? "queued" : "failed"; item.error = String(error || "job failed").slice(0, 2000); item.runAfter = retry ? new Date(Date.now() + 1000).toISOString() : timestamp; item.completedAt = retry ? "" : timestamp; item.updatedAt = timestamp; write(db); return item; }

  return { read, write, metadata, enqueueJob, recoverJobs, claimNextJob, completeJob, failJob, getJob };
}

module.exports = { createJsonStore };
