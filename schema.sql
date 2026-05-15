-- TAXIST D1 Database Schema

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  email        TEXT    UNIQUE NOT NULL,
  password_hash TEXT   NOT NULL,
  org          TEXT,
  tax_categories TEXT  DEFAULT '[]',
  role         TEXT    DEFAULT 'user',
  status       TEXT    DEFAULT 'trial',
  joined_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  trial_ends_at DATETIME,
  last_login_at DATETIME
);

CREATE TABLE IF NOT EXISTS questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id),
  tax_category TEXT,
  title        TEXT,
  content      TEXT,
  status       TEXT DEFAULT 'pending',
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS answers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id  INTEGER REFERENCES questions(id),
  content      TEXT,
  sources      TEXT DEFAULT '[]',
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS folders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  tax_category TEXT    DEFAULT 'all',
  is_active    INTEGER DEFAULT 1,
  parent_id    INTEGER,
  sort_order   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id    INTEGER REFERENCES folders(id),
  name         TEXT    NOT NULL,
  file_path    TEXT,
  content      TEXT,
  tax_category TEXT    DEFAULT 'all',
  is_active    INTEGER DEFAULT 1,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 기본 관리자 계정 (비밀번호: admin1234 - 배포 후 반드시 변경)
INSERT OR IGNORE INTO users (name, email, password_hash, role, status)
VALUES ('관리자', 'admin@taxist.kr', 'CHANGE_ME', 'admin', 'active');

-- 기본 폴더 구조
INSERT OR IGNORE INTO folders (name, path, tax_category, sort_order) VALUES
  ('국세기본', '법령자료/국세기본', 'all', 1),
  ('소득세',   '법령자료/소득세',   '개인세', 2),
  ('법인세',   '법령자료/법인세',   '법인세', 3),
  ('부가세',   '법령자료/부가세',   '부가세', 4),
  ('상속증여세','법령자료/상속증여세','개인세', 5),
  ('종합부동산세','법령자료/종합부동산세','재산세', 6),
  ('소비세기타','법령자료/소비세기타','all', 7),
  ('조세특례', '법령자료/조세특례', 'all', 8),
  ('관세',     '법령자료/관세',     'all', 9),
  ('지방세',   '법령자료/지방세',   '재산세', 10),
  ('불복절차', '법령자료/불복절차', 'all', 11),
  ('국제조세', '법령자료/국제조세', '법인세', 12),
  ('판례-법인세','판례자료',        '법인세', 13),
  ('판례-부가세','판례자료',        '부가세', 14),
  ('판례-소득세','판례자료',        '개인세', 15),
  ('판례-징세', '판례자료',         '징세', 16),
  ('판례-재산세','판례자료',        '재산세', 17),
  ('법인세자료','법인세자료',       '법인세', 18);

CREATE INDEX IF NOT EXISTS idx_questions_user ON questions(user_id);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(tax_category);
