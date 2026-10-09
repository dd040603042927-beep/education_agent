const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { createStorage } = require("../storage");
const { createSqliteStore } = require("../storage/sqliteStore");
const { createEmbeddingProvider } = require("../storage/embeddingProvider");
const { applyWeightedMasteryEvidence } = require("../services/mastery");

const ROOT = path.join(__dirname, "..");
const schemaPath = path.join(ROOT, "storage", "schema.sql");

function fixture() {
  return {
    users: [{ id: "student", role: "student", settings: { theme: "dark" } }],
    courseMaterials: [{
      id: "book", title: "动手学机器学习", subject: "机器学习", updatedAt: "2026-09-28",
      chunks: [{ id: "book_chunk_1", chapter: "梯度下降", page: 3, text: "学习率控制参数更新步长。", keywords: ["学习率", "参数更新"], embedding: [1, 0, 0] }]
    }],
    learningProfiles: [],
    learningEvents: [{
      id: "event", studentId: "student", classId: "", teacherId: "", subject: "ML",
      eventType: "knowledge_test_evaluate", source: "test", knowledgePoint: "KNN", graphId: "", nodeId: "",
      homeworkId: "", submissionId: "", score: 0, durationSeconds: 0,
      payload: { answer: "零分", citations: [] }, idempotencyKey: "event-key", occurredAt: "2026-09-28", createdAt: "2026-09-28"
    }],
    diagnosisResults: [{
      id: "diagnosis", studentId: "student", eventId: "event", topic: "KNN", masteryScore: null,
      masteryLevel: "未掌握", errorTags: ["概念"], missingPoints: [], evidence: [{ text: "evidence" }],
      finalAnswer: "answer", modelOrWorkflow: "test", createdAt: "2026-09-28", idempotencyKey: "diagnosis-key"
    }],
    studentMastery: [{
      studentId: "student", subject: "ML", knowledgePoint: "KNN", graphId: "", nodeId: "",
      score: 0, status: "未掌握", evidenceCount: 1, lastEventId: "event", updatedAt: "2026-09-28"
    }]
  };
}

function workspace(context) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "education-storage-test-"));
  context.after(() => {
    assert.equal(path.dirname(path.resolve(tempRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tempRoot).startsWith("education-storage-test-"));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

function runScript(tempRoot, script, args = []) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_DIR: tempRoot,
      JSON_DB_PATH: path.join(tempRoot, "db.json"),
      DATABASE_URL: path.join(tempRoot, "education.db"),
      BACKUP_DIR: path.join(tempRoot, "backups"),
      LOG_DIR: path.join(tempRoot, "logs"),
      STORAGE_DRIVER: "sqlite"
    }
  });
}

test("SQLite is the default; learning tables survive restart and are authoritative", (context) => {
  const tempRoot = workspace(context);
  const sqlitePath = path.join(tempRoot, "education.db");
  const store = createStorage({ sqlitePath, schemaPath, initialData: fixture });
  assert.equal(store.metadata().driver, "sqlite");
  assert.deepStrictEqual(store.read(), fixture());
  store.close();
  const sql = new DatabaseSync(sqlitePath);
  const state = JSON.parse(sql.prepare("SELECT value_json FROM app_state WHERE key = 'db'").get().value_json);
  for (const key of ["learningEvents", "diagnosisResults", "studentMastery"]) assert.ok(!Object.hasOwn(state, key));
  assert.equal(sql.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  sql.prepare("UPDATE student_mastery SET score = ?").run(0.75);
  sql.exec("DELETE FROM diagnosis_results");
  sql.close();
  const reopened = createSqliteStore({ sqlitePath, schemaPath });
  try {
    const actual = reopened.read();
    assert.equal(actual.studentMastery[0].score, 0.75);
    assert.deepStrictEqual(actual.diagnosisResults, []);
    assert.deepStrictEqual(actual.learningEvents, fixture().learningEvents);
  } finally {
    reopened.close();
  }
});

test("knowledge_chunks preserve metadata and update only matching content", (context) => {
  const tempRoot = workspace(context);
  const sqlitePath = path.join(tempRoot, "education.db");
  const store = createSqliteStore({ sqlitePath, schemaPath });
  try {
    const db = fixture();
    store.write(db);
    const rows = store.readKnowledgeChunks();
    assert.equal(rows.length, 1);
    assert.deepStrictEqual(rows[0].embedding, [1, 0, 0]);
    store.updateKnowledgeChunkEmbeddings([{ id: rows[0].id, contentSha256: rows[0].contentSha256, embedding: [0, 1, 0], provider: "openai-compatible", model: "test-embedding" }]);
    assert.deepStrictEqual(store.readKnowledgeChunks()[0].embedding, [0, 1, 0]);
    const changed = fixture();
    changed.courseMaterials[0].chunks[0].text = "学习率过大可能导致训练震荡。";
    store.write(changed);
    const changedRow = store.readKnowledgeChunks()[0];
    assert.equal(changedRow.embedding, null);
    assert.equal(changedRow.embeddingProvider, "");
  } finally {
    store.close();
  }
});

test("background jobs survive restart and retry interrupted work", (context) => {
  const tempRoot = workspace(context);
  const sqlitePath = path.join(tempRoot, "education.db");
  const store = createSqliteStore({ sqlitePath, schemaPath });
  const queued = store.enqueueJob({ type: "ai_chat", payload: { prompt: "解释 KNN" }, createdBy: "student", maxAttempts: 2 });
  const claimed = store.claimNextJob();
  assert.equal(claimed.id, queued.id);
  assert.equal(claimed.status, "running");
  store.close();

  const reopened = createSqliteStore({ sqlitePath, schemaPath });
  try {
    reopened.recoverJobs();
    assert.equal(reopened.getJob(queued.id).status, "queued");
    const retry = reopened.claimNextJob();
    assert.equal(retry.attempts, 2);
    const complete = reopened.completeJob(queued.id, { conversationId: "conv" });
    assert.equal(complete.status, "complete");
    assert.deepStrictEqual(complete.result, { conversationId: "conv" });
  } finally {
    reopened.close();
  }
});

test("mastery combines evidence by weight and ignores scoreless events", () => {
  const initial = { score: 0.5, evidence: [] };
  const scored = applyWeightedMasteryEvidence(initial, { score: 0.9, weight: 0.5, source: "knowledge_test" });
  assert.equal(scored.score, 0.7);
  const scoreless = applyWeightedMasteryEvidence(scored, { score: null, weight: 0.8, source: "question" });
  assert.equal(scoreless.score, 0.7);
  assert.equal(scoreless.evidence.length, 2);
});

test("OpenAI-compatible embedding provider validates ordered vectors", async (context) => {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: payload.input.map((_, index) => ({ index, embedding: index ? [0, 1] : [1, 0] })) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  const provider = createEmbeddingProvider({ provider: "openai", apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-embedding" });
  const result = await provider.embedTexts(["梯度下降", "学习率"]);
  assert.equal(result.provider, "openai-compatible");
  assert.equal(result.model, "test-embedding");
  assert.deepStrictEqual(result.embeddings, [[1, 0], [0, 1]]);
});

test("writes preserve ordering, null durations, diagnosis idempotency and deletions", (context) => {
  const tempRoot = workspace(context);
  const store = createSqliteStore({ sqlitePath: path.join(tempRoot, "education.db"), schemaPath });
  try {
    const db = fixture();
    db.learningEvents.unshift({ ...db.learningEvents[0], id: "new-event", idempotencyKey: "new-key", durationSeconds: null });
    store.write(db);
    assert.deepStrictEqual(store.read(), db);
    db.learningEvents = [];
    db.diagnosisResults[0].eventId = "";
    store.write(db);
    assert.deepStrictEqual(store.read(), db);
  } finally {
    store.close();
  }
});

test("constraint failures roll back app_state and all learning tables", (context) => {
  const tempRoot = workspace(context);
  const store = createSqliteStore({ sqlitePath: path.join(tempRoot, "education.db"), schemaPath });
  try {
    store.write(fixture());
    for (const key of ["learningEvents", "diagnosisResults", "studentMastery"]) {
      const invalid = fixture();
      invalid.users = [];
      invalid[key].push({ ...invalid[key][0] });
      assert.throws(() => store.write(invalid), /UNIQUE/);
      assert.deepStrictEqual(store.read(), fixture());
    }
    const invalid = fixture();
    invalid.learningEvents.push({ ...invalid.learningEvents[0], id: "duplicate-key" });
    assert.throws(() => store.write(invalid), /UNIQUE/);
    assert.deepStrictEqual(store.read(), fixture());
  } finally {
    store.close();
  }
});

test("legacy app_state is moved to tables and old schemas gain diagnosis idempotency", (context) => {
  const tempRoot = workspace(context);
  const sqlitePath = path.join(tempRoot, "education.db");
  const legacy = new DatabaseSync(sqlitePath);
  legacy.exec(fs.readFileSync(schemaPath, "utf8"));
  legacy.exec("ALTER TABLE diagnosis_results DROP COLUMN idempotency_key");
  legacy.prepare("INSERT INTO app_state VALUES ('db', ?, 'legacy')").run(JSON.stringify(fixture()));
  legacy.close();
  const store = createSqliteStore({ sqlitePath, schemaPath });
  try {
    assert.deepStrictEqual(store.read(), fixture());
    assert.deepStrictEqual(store.read(), fixture());
  } finally {
    store.close();
  }
});

test("existing JSON must be migrated instead of silently seeding SQLite", (context) => {
  const tempRoot = workspace(context);
  const dbPath = path.join(tempRoot, "db.json");
  fs.writeFileSync(dbPath, JSON.stringify(fixture()));
  const store = createStorage({ dbPath, sqlitePath: path.join(tempRoot, "education.db"), schemaPath, initialData: fixture });
  try {
    assert.throws(() => store.read(), /migrate:sqlite/);
  } finally {
    store.close();
  }
});

test("migration replaces from JSON only, backs up old SQLite, and refuses accidental reimport", (context) => {
  const tempRoot = workspace(context);
  const sqlitePath = path.join(tempRoot, "education.db");
  const original = JSON.stringify(fixture(), null, 2);
  fs.writeFileSync(path.join(tempRoot, "db.json"), original);
  const old = createSqliteStore({ sqlitePath, schemaPath });
  old.write({ ...fixture(), users: [{ id: "old-only" }] });
  old.close();
  assert.notEqual(runScript(tempRoot, "migrate_json_to_sqlite.js").status, 0);
  const result = runScript(tempRoot, "migrate_json_to_sqlite.js", ["--replace"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(fs.readFileSync(path.join(tempRoot, "db.json"), "utf8"), original);
  assert.equal(fs.readFileSync(path.join(report.backupDir, "db.json"), "utf8"), original);
  const previous = createSqliteStore({ sqlitePath: report.previousSqlite, schemaPath });
  assert.deepStrictEqual(previous.read().users, [{ id: "old-only" }]);
  previous.close();
  const current = createSqliteStore({ sqlitePath, schemaPath });
  assert.deepStrictEqual(current.read(), fixture());
  current.close();
  assert.equal(report.counts.learningEvents, 1);
  assert.equal(report.verified.exactRoundTrip, true);
  assert.notEqual(runScript(tempRoot, "migrate_json_to_sqlite.js").status, 0);
});

test("failed migration validation leaves the previous database untouched", (context) => {
  const tempRoot = workspace(context);
  const sqlitePath = path.join(tempRoot, "education.db");
  const old = createSqliteStore({ sqlitePath, schemaPath });
  old.write(fixture());
  old.close();
  const invalid = fixture();
  invalid.learningEvents.push({ ...invalid.learningEvents[0] });
  fs.writeFileSync(path.join(tempRoot, "db.json"), JSON.stringify(invalid));
  const result = runScript(tempRoot, "migrate_json_to_sqlite.js", ["--replace"]);
  assert.notEqual(result.status, 0);
  const current = createSqliteStore({ sqlitePath, schemaPath });
  assert.deepStrictEqual(current.read(), fixture());
  current.close();
});

test("migration refuses replacement while SQLite connections remain open", (context) => {
  const tempRoot = workspace(context);
  const sqlitePath = path.join(tempRoot, "education.db");
  const store = createSqliteStore({ sqlitePath, schemaPath });
  try {
    store.write(fixture());
    fs.writeFileSync(path.join(tempRoot, "db.json"), JSON.stringify({ ...fixture(), users: [] }));
    const result = runScript(tempRoot, "migrate_json_to_sqlite.js", ["--replace"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sidecars|busy/);
    assert.deepStrictEqual(store.read(), fixture());
  } finally {
    store.close();
  }
});

test("migration rejects lossy conversion rather than silently dropping source fields", (context) => {
  const tempRoot = workspace(context);
  const source = fixture();
  source.learningEvents[0].unsupportedField = "preserve me";
  fs.writeFileSync(path.join(tempRoot, "db.json"), JSON.stringify(source));
  const result = runScript(tempRoot, "migrate_json_to_sqlite.js");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preserve every JSON field/);
  assert.ok(!fs.existsSync(path.join(tempRoot, "education.db")));
});

test("backup captures committed WAL data while a connection remains open", (context) => {
  const tempRoot = workspace(context);
  const sqlitePath = path.join(tempRoot, "education.db");
  const store = createSqliteStore({ sqlitePath, schemaPath });
  try {
    store.write(fixture());
    assert.ok(fs.existsSync(`${sqlitePath}-wal`));
    const result = runScript(tempRoot, "backup_data.js");
    assert.equal(result.status, 0, result.stderr);
    const backupDir = path.join(tempRoot, "backups", fs.readdirSync(path.join(tempRoot, "backups"))[0]);
    const backup = createSqliteStore({ sqlitePath: path.join(backupDir, "data", "education.db"), schemaPath });
    assert.deepStrictEqual(backup.read(), fixture());
    backup.close();
    assert.ok(!fs.existsSync(path.join(backupDir, "data", "education.db-wal")));
  } finally {
    store.close();
  }
});

test("maintenance commands update SQLite without modifying archived JSON", (context) => {
  const tempRoot = workspace(context);
  const sqlitePath = path.join(tempRoot, "education.db");
  const store = createSqliteStore({ sqlitePath, schemaPath });
  store.write(fixture());
  store.close();
  const jsonPath = path.join(tempRoot, "db.json");
  fs.writeFileSync(jsonPath, "archived-json");
  for (const script of ["aggregate_student_mastery.js", "import_ml_book_question_bank.js"]) {
    const result = runScript(tempRoot, script);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(jsonPath, "utf8"), "archived-json");
  }
  const current = createSqliteStore({ sqlitePath, schemaPath });
  const db = current.read();
  assert.equal(db.studentMastery.length, 1);
  assert.ok(db.mlQuestionBank.length > 0);
  current.close();
});
