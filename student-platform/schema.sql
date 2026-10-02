PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','teacher','student')),
  student_id TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  csrf TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, display_name TEXT NOT NULL,
  school_grade INTEGER NOT NULL CHECK(school_grade BETWEEN 1 AND 12),
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  teacher_id TEXT NOT NULL REFERENCES users(id), school_grade INTEGER NOT NULL,
  curriculum TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  valid_from TEXT NOT NULL, valid_until TEXT,
  CHECK(valid_until IS NULL OR valid_until > valid_from)
);
CREATE INDEX IF NOT EXISTS memberships_roster ON memberships(class_id, student_id);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, class_id TEXT NOT NULL REFERENCES classes(id),
  teacher_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK(status IN ('scheduled','completed','cancelled')),
  objectives TEXT NOT NULL, curriculum TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  CHECK(ends_at > starts_at)
);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lesson_id TEXT NOT NULL REFERENCES lessons(id),
  student_id TEXT NOT NULL REFERENCES students(id), author_id TEXT NOT NULL REFERENCES users(id),
  domain TEXT NOT NULL, knowledge_point TEXT NOT NULL, observed_response TEXT NOT NULL,
  result TEXT NOT NULL, score REAL, evidence_ref TEXT, next_action TEXT NOT NULL,
  observed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  confirmed_by TEXT REFERENCES users(id), confirmed_at TEXT, revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS observations_history ON observations(student_id, status, observed_at);
CREATE TABLE IF NOT EXISTS follow_ups (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, student_id TEXT NOT NULL REFERENCES students(id),
  lesson_id TEXT NOT NULL REFERENCES lessons(id), observation_id TEXT REFERENCES observations(id),
  type TEXT NOT NULL, description TEXT NOT NULL, due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open', completed_at TEXT, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS account_bindings (
  tenant_id TEXT NOT NULL, teacher_id TEXT NOT NULL REFERENCES users(id),
  lessonfold_user_id TEXT NOT NULL UNIQUE, verified_by TEXT NOT NULL REFERENCES users(id),
  verified_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(tenant_id, teacher_id)
);
CREATE TABLE IF NOT EXISTS launches (
  token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, teacher_id TEXT NOT NULL REFERENCES users(id),
  lesson_id TEXT NOT NULL REFERENCES lessons(id), expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS delegations (
  token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, teacher_id TEXT NOT NULL REFERENCES users(id),
  lesson_id TEXT NOT NULL REFERENCES lessons(id), lessonfold_user_id TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publications (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, lesson_id TEXT NOT NULL REFERENCES lessons(id),
  snapshot TEXT NOT NULL, content_hash TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  action TEXT NOT NULL, object_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance (
  lesson_id TEXT NOT NULL REFERENCES lessons(id), student_id TEXT NOT NULL REFERENCES students(id),
  status TEXT NOT NULL CHECK(status IN ('present','absent','leave','late')),
  recorded_by TEXT NOT NULL REFERENCES users(id), recorded_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(lesson_id,student_id)
);
