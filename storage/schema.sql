PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_events (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  class_id TEXT NOT NULL DEFAULT '',
  teacher_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  knowledge_point TEXT NOT NULL DEFAULT '',
  graph_id TEXT NOT NULL DEFAULT '',
  node_id TEXT NOT NULL DEFAULT '',
  homework_id TEXT NOT NULL DEFAULT '',
  submission_id TEXT NOT NULL DEFAULT '',
  score REAL,
  duration_seconds INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_events_idempotency
  ON learning_events(idempotency_key)
  WHERE idempotency_key <> '';

CREATE INDEX IF NOT EXISTS idx_learning_events_student_time
  ON learning_events(student_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_learning_events_topic
  ON learning_events(student_id, subject, knowledge_point);

CREATE INDEX IF NOT EXISTS idx_learning_events_class_time
  ON learning_events(class_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS diagnosis_results (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  event_id TEXT DEFAULT NULL,
  topic TEXT NOT NULL DEFAULT '',
  mastery_score REAL,
  mastery_level TEXT NOT NULL DEFAULT '',
  error_tags_json TEXT NOT NULL DEFAULT '[]',
  missing_points_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  final_answer TEXT NOT NULL DEFAULT '',
  model_or_workflow TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY(event_id) REFERENCES learning_events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_diagnosis_results_student_time
  ON diagnosis_results(student_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_diagnosis_results_topic
  ON diagnosis_results(student_id, topic);

CREATE TABLE IF NOT EXISTS student_mastery (
  student_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  knowledge_point TEXT NOT NULL,
  graph_id TEXT NOT NULL DEFAULT '',
  node_id TEXT NOT NULL DEFAULT '',
  score REAL,
  status TEXT NOT NULL DEFAULT '',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  last_event_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(student_id, subject, knowledge_point)
);

CREATE INDEX IF NOT EXISTS idx_student_mastery_student_score
  ON student_mastery(student_id, score);

CREATE TABLE IF NOT EXISTS external_id_mappings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_user_id TEXT NOT NULL DEFAULT '',
  internal_user_id TEXT NOT NULL DEFAULT '',
  external_class_id TEXT NOT NULL DEFAULT '',
  internal_class_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(provider, external_user_id, external_class_id)
);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  file_name TEXT NOT NULL DEFAULT '',
  file_hash TEXT NOT NULL DEFAULT '',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL,
  graph_id TEXT NOT NULL DEFAULT '',
  chapter TEXT NOT NULL DEFAULT '',
  page INTEGER,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  embedding_json TEXT,
  embedding_provider TEXT NOT NULL DEFAULT '',
  embedding_model TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_material
  ON knowledge_chunks(material_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding
  ON knowledge_chunks(embedding_provider, embedding_model);

CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_background_jobs_ready
  ON background_jobs(status, run_after, created_at);
