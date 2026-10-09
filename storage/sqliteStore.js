const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function resolveSqlitePath(value, fallbackPath) {
  const raw = String(value || "").trim();
  if (!raw) return fallbackPath;
  if (raw.startsWith("file:")) return path.resolve(raw.slice("file:".length));
  return path.resolve(raw);
}

function jsonText(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function toScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  if (score > 1 && score <= 100) return Number((score / 100).toFixed(4));
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

function createSqliteStore(options) {
  const {
    sqlitePath,
    schemaPath,
    ensureDataDir,
    initialData,
    normalizeData
  } = options;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (error) {
    throw new Error("SQLite storage requires Node.js with node:sqlite support. Use STORAGE_DRIVER=json or run the migration with a newer Node.js runtime.");
  }

  const dbPath = resolveSqlitePath(sqlitePath, path.join(process.cwd(), "data", "education.db"));
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (typeof ensureDataDir === "function") ensureDataDir();

  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec(schemaSql);
  if (!sqlite.prepare("PRAGMA table_info(diagnosis_results)").all().some((column) => column.name === "idempotency_key")) {
    sqlite.exec("ALTER TABLE diagnosis_results ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '';");
  }

  const readState = sqlite.prepare("SELECT value_json FROM app_state WHERE key = ?");
  const writeState = sqlite.prepare(`
    INSERT INTO app_state (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);

  function syncLearningTables(db) {
    sqlite.exec("DELETE FROM diagnosis_results;");
    sqlite.exec("DELETE FROM student_mastery;");
    sqlite.exec("DELETE FROM learning_events;");

    const insertEvent = sqlite.prepare(`
      INSERT INTO learning_events (
        id, student_id, class_id, teacher_id, subject, event_type, source,
        knowledge_point, graph_id, node_id, homework_id, submission_id,
        score, duration_seconds, payload_json, idempotency_key, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDiagnosis = sqlite.prepare(`
      INSERT INTO diagnosis_results (
        id, student_id, event_id, topic, mastery_score, mastery_level,
        error_tags_json, missing_points_json, evidence_json, final_answer,
        model_or_workflow, created_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMastery = sqlite.prepare(`
      INSERT INTO student_mastery (
        student_id, subject, knowledge_point, graph_id, node_id, score,
        status, evidence_count, last_event_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    (db.learningEvents || []).forEach((item) => {
      insertEvent.run(
        item.id,
        item.studentId || item.student_id || "",
        item.classId || item.class_id || "",
        item.teacherId || item.teacher_id || "",
        item.subject || "",
        item.eventType || item.event_type || "unknown",
        item.source || "",
        item.knowledgePoint || item.knowledge_point || "",
        item.graphId || item.graph_id || "",
        item.nodeId || item.node_id || "",
        item.homeworkId || item.homework_id || "",
        item.submissionId || item.submission_id || "",
        toScore(item.score),
        item.durationSeconds == null && item.duration_seconds == null ? null : Number(item.durationSeconds ?? item.duration_seconds),
        jsonText(item.payload || {}),
        item.idempotencyKey || item.idempotency_key || "",
        item.occurredAt || item.occurred_at || item.createdAt || "",
        item.createdAt || item.created_at || ""
      );
    });

    const eventIds = new Set((db.learningEvents || []).map((item) => item.id).filter(Boolean));
    (db.diagnosisResults || []).forEach((item) => {
      const eventId = item.eventId || item.event_id || "";
      insertDiagnosis.run(
        item.id,
        item.studentId || item.student_id || "",
        eventIds.has(eventId) ? eventId : null,
        item.topic || "",
        toScore(item.masteryScore ?? item.mastery_score),
        item.masteryLevel || item.mastery_level || "",
        jsonText(item.errorTags || item.error_tags || []),
        jsonText(item.missingPoints || item.missing_points || []),
        jsonText(item.evidence || []),
        item.finalAnswer || item.final_answer || "",
        item.modelOrWorkflow || item.model_or_workflow || "",
        item.createdAt || item.created_at || "",
        item.idempotencyKey || item.idempotency_key || ""
      );
    });

    (db.studentMastery || []).forEach((item) => {
      insertMastery.run(
        item.studentId || item.student_id || "",
        item.subject || "",
        item.knowledgePoint || item.knowledge_point || "",
        item.graphId || item.graph_id || "",
        item.nodeId || item.node_id || "",
        toScore(item.score),
        item.status || "",
        Number(item.evidenceCount || item.evidence_count || 0),
        item.lastEventId || item.last_event_id || "",
        item.updatedAt || item.updated_at || ""
      );
    });
  }

  const learningTables = {
    learningEvents: "learning_events",
    diagnosisResults: "diagnosis_results",
    studentMastery: "student_mastery"
  };

  function readLearningTable(table) {
    return sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => {
      return Object.fromEntries(Object.entries(row).map(([column, value]) => {
        const name = column.replace(/_json$/, "").replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        return [name, column.endsWith("_json") ? JSON.parse(value) : column === "event_id" ? value || "" : value];
      }));
    });
  }

  function contentSha256(value) {
    return crypto.createHash("sha256").update(String(value || "")).digest("hex");
  }

  function syncKnowledgeChunkMetadata(db) {
    const expectedIds = new Set();
    const upsert = sqlite.prepare(`
      INSERT INTO knowledge_chunks (
        id, material_id, graph_id, chapter, page, content, content_sha256,
        embedding_json, embedding_provider, embedding_model, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        material_id = excluded.material_id,
        graph_id = excluded.graph_id,
        chapter = excluded.chapter,
        page = excluded.page,
        content = excluded.content,
        content_sha256 = excluded.content_sha256,
        embedding_json = excluded.embedding_json,
        embedding_provider = excluded.embedding_provider,
        embedding_model = excluded.embedding_model,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `);
    (Array.isArray(db.courseMaterials) ? db.courseMaterials : []).forEach((material) => {
      (material.chunks || []).forEach((chunk) => {
        const content = String(chunk.text || "");
        if (!content.trim()) return;
        expectedIds.add(chunk.id);
        const existing = sqlite.prepare("SELECT content_sha256, embedding_json, embedding_provider, embedding_model, created_at FROM knowledge_chunks WHERE id = ?").get(chunk.id);
        const legacyEmbedding = Array.isArray(chunk.embedding) ? chunk.embedding : null;
        const contentHash = contentSha256(content);
        const contentChanged = existing && existing.content_sha256 !== contentHash;
        const timestamp = chunk.createdAt || material.updatedAt || new Date().toISOString();
        upsert.run(
          chunk.id,
          material.id,
          chunk.graphId || "",
          chunk.chapter || material.title || "",
          Number.isFinite(Number(chunk.page)) ? Number(chunk.page) : null,
          content,
          contentHash,
          contentChanged ? null : (existing?.embedding_json || (legacyEmbedding ? JSON.stringify(legacyEmbedding) : null)),
          contentChanged ? "" : (existing?.embedding_provider || (legacyEmbedding ? chunk.embeddingProvider || "legacy-hash" : "")),
          contentChanged ? "" : (existing?.embedding_model || (legacyEmbedding ? chunk.embeddingModel || "legacy-64" : "")),
          JSON.stringify({ materialId: material.id, subject: material.subject || "", title: material.title || "", sourceName: material.sourceName || "", keywords: chunk.keywords || [] }),
          existing?.created_at || timestamp,
          new Date().toISOString()
        );
      });
    });
    const stale = sqlite.prepare("SELECT id FROM knowledge_chunks").all().map((row) => row.id).filter((id) => !expectedIds.has(id));
    if (stale.length) {
      const remove = sqlite.prepare("DELETE FROM knowledge_chunks WHERE id = ?");
      stale.forEach((id) => remove.run(id));
    }
  }

  function readKnowledgeChunks(options = {}) {
    const clauses = [];
    const values = [];
    if (options.materialIds?.length) {
      clauses.push(`material_id IN (${options.materialIds.map(() => "?").join(",")})`);
      values.push(...options.materialIds);
    }
    const rows = sqlite.prepare(`SELECT * FROM knowledge_chunks${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY rowid`).all(...values);
    return rows.map((row) => ({
      id: row.id,
      materialId: row.material_id,
      graphId: row.graph_id,
      chapter: row.chapter,
      page: row.page,
      content: row.content,
      contentSha256: row.content_sha256,
      embedding: row.embedding_json ? JSON.parse(row.embedding_json) : null,
      embeddingProvider: row.embedding_provider,
      embeddingModel: row.embedding_model,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  function updateKnowledgeChunkEmbeddings(items = []) {
    sqlite.exec("BEGIN IMMEDIATE;");
    try {
      const update = sqlite.prepare(`
        UPDATE knowledge_chunks
        SET embedding_json = ?, embedding_provider = ?, embedding_model = ?, updated_at = ?
        WHERE id = ? AND content_sha256 = ?
      `);
      const timestamp = new Date().toISOString();
      items.forEach((item) => update.run(JSON.stringify(item.embedding), item.provider || "", item.model || "", timestamp, item.id, item.contentSha256));
      sqlite.exec("COMMIT;");
    } catch (error) {
      sqlite.exec("ROLLBACK;");
      throw error;
    }
  }

  function knowledgeChunkStats() {
    return sqlite.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN embedding_json IS NOT NULL AND embedding_provider <> 'legacy-hash' THEN 1 ELSE 0 END) AS embedded,
        MAX(embedding_model) AS model
      FROM knowledge_chunks
    `).get();
  }

  function jobRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      payload: JSON.parse(row.payload_json || "{}"),
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error || "",
      attempts: Number(row.attempts || 0),
      maxAttempts: Number(row.max_attempts || 3),
      runAfter: row.run_after,
      createdBy: row.created_by,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at
    };
  }

  function enqueueJob(job = {}) {
    const timestamp = new Date().toISOString();
    const id = String(job.id || `job_${crypto.randomBytes(8).toString("hex")}`);
    sqlite.prepare(`
      INSERT INTO background_jobs (id, type, status, payload_json, result_json, error, attempts, max_attempts, run_after, created_by, created_at, started_at, completed_at, updated_at)
      VALUES (?, ?, 'queued', ?, NULL, '', 0, ?, ?, ?, ?, '', '', ?)
    `).run(id, String(job.type || "unknown"), jsonText(job.payload || {}), Math.max(1, Number(job.maxAttempts || 3)), job.runAfter || timestamp, String(job.createdBy || ""), timestamp, timestamp);
    return getJob(id);
  }

  function recoverJobs() {
    const timestamp = new Date().toISOString();
    sqlite.prepare("UPDATE background_jobs SET status = 'queued', error = 'interrupted by restart', updated_at = ? WHERE status = 'running'").run(timestamp);
  }

  function claimNextJob() {
    const timestamp = new Date().toISOString();
    sqlite.exec("BEGIN IMMEDIATE;");
    try {
      const row = sqlite.prepare("SELECT * FROM background_jobs WHERE status = 'queued' AND run_after <= ? ORDER BY created_at LIMIT 1").get(timestamp);
      if (!row) {
        sqlite.exec("COMMIT;");
        return null;
      }
      sqlite.prepare("UPDATE background_jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(timestamp, timestamp, row.id);
      const claimed = sqlite.prepare("SELECT * FROM background_jobs WHERE id = ?").get(row.id);
      sqlite.exec("COMMIT;");
      return jobRow(claimed);
    } catch (error) {
      sqlite.exec("ROLLBACK;");
      throw error;
    }
  }

  function completeJob(id, result) {
    const timestamp = new Date().toISOString();
    sqlite.prepare("UPDATE background_jobs SET status = 'complete', result_json = ?, error = '', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(jsonText(result), timestamp, timestamp, id);
    return getJob(id);
  }

  function failJob(id, error, retryable) {
    const job = getJob(id);
    if (!job) return null;
    const timestamp = new Date().toISOString();
    const shouldRetry = retryable && job.attempts < job.maxAttempts;
    const backoff = new Date(Date.now() + Math.min(30000, 1000 * (2 ** Math.max(0, job.attempts - 1)))).toISOString();
    sqlite.prepare("UPDATE background_jobs SET status = ?, error = ?, run_after = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(shouldRetry ? "queued" : "failed", String(error || "job failed").slice(0, 2000), shouldRetry ? backoff : timestamp, shouldRetry ? "" : timestamp, timestamp, id);
    return getJob(id);
  }

  function getJob(id) {
    return jobRow(sqlite.prepare("SELECT * FROM background_jobs WHERE id = ?").get(id));
  }

  function read() {
    sqlite.exec("BEGIN;");
    let db;
    let legacy;
    try {
      const row = readState.get("db");
      if (row) {
        db = JSON.parse(row.value_json);
        legacy = Object.keys(learningTables).some((key) => Object.hasOwn(db, key));
        if (!legacy) {
          Object.entries(learningTables).forEach(([key, table]) => {
            db[key] = readLearningTable(table);
          });
        }
      }
      sqlite.exec("COMMIT;");
    } catch (error) {
      sqlite.exec("ROLLBACK;");
      throw error;
    }
    if (!db) {
      if (options.dbPath && fs.existsSync(options.dbPath)) {
        throw new Error("Existing JSON database found. Run npm run migrate:sqlite before starting SQLite storage.");
      }
      const seeded = initialData();
      write(seeded);
      return seeded;
    }
    const normalized = typeof normalizeData === "function" && normalizeData(db);
    const needsChunkSync = Array.isArray(db.courseMaterials) && db.courseMaterials.length > 0 && knowledgeChunkStats().total === 0;
    if (legacy || normalized || needsChunkSync) write(db);
    return db;
  }

  function write(db) {
    const updatedAt = new Date().toISOString();
    sqlite.exec("BEGIN IMMEDIATE;");
    try {
      const state = { ...db };
      Object.keys(learningTables).forEach((key) => delete state[key]);
      writeState.run("db", JSON.stringify(state), updatedAt);
      syncLearningTables(db);
      syncKnowledgeChunkMetadata(db);
      sqlite.exec("COMMIT;");
    } catch (error) {
      sqlite.exec("ROLLBACK;");
      throw error;
    }
  }

  function metadata() {
    return {
      driver: "sqlite",
      label: "sqlite-learning-tables+app-state",
      path: dbPath
    };
  }

  return {
    read,
    write,
    metadata,
    readKnowledgeChunks,
    updateKnowledgeChunkEmbeddings,
    knowledgeChunkStats,
    enqueueJob,
    recoverJobs,
    claimNextJob,
    completeJob,
    failJob,
    getJob,
    close: () => sqlite.close()
  };
}

module.exports = { createSqliteStore, resolveSqlitePath };
