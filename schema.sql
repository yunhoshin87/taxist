-- ============================================================================
-- TAXIST D1 Database Schema (초기 스키마)
--
-- Cloudflare D1(SQLite 호환)에 적용되는 기본 테이블 정의 + 초기 데이터.
-- `wrangler d1 execute taxist-db --file=schema.sql` 형태로 최초 1회 적용한다.
--
-- 주의: 운영 DB는 이 파일 적용 이후 다음 마이그레이션이 추가로 적용되어
-- 있다. 이 파일만 보고 전체 스키마를 파악하면 안 되고, scripts/ 아래의
-- 마이그레이션 SQL도 함께 확인해야 한다:
--   - scripts/migrate_fts.sql     → documents_fts (FTS5 전문검색 가상테이블) 추가
--   - scripts/migrate_summary.sql → documents.nts_doc_id, documents.is_summary
--                                    컬럼 추가 (NTS 온디맨드 상세조회 캐싱용,
--                                    functions/_lib/docs.js 참고)
--   - answers.content_edited 컬럼  → 사용자가 AI 답변을 편집한 내용 저장
--                                    (functions/api/answers/[id].js 참고,
--                                    이 컬럼을 추가하는 마이그레이션 파일은
--                                    history상 별도 ALTER TABLE로 적용됨)
-- ============================================================================

-- 회원 (일반회원 role='user' / 관리자 role='admin')
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  email        TEXT    UNIQUE NOT NULL,   -- 실제로는 "로그인 아이디"로 사용 (이메일 형식 검증 없음)
  password_hash TEXT   NOT NULL,          -- "salt:hash" 형식 (functions/_lib/auth.js hashPassword 참고)
  org          TEXT,                      -- 소속 기관/부서
  tax_categories TEXT  DEFAULT '[]',      -- 가입 시 선택한 담당 세목, JSON 배열 문자열로 저장
  role         TEXT    DEFAULT 'user',    -- 'user' | 'admin'
  status       TEXT    DEFAULT 'trial',   -- 'trial' | 'expired' | 'active'(결제) | 'suspended'
  joined_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  trial_ends_at DATETIME,                 -- 가입일 + 30일 (functions/api/auth/register.js에서 설정)
  last_login_at DATETIME
);

-- 질문 (회원이 등록한 세무행정 질의)
CREATE TABLE IF NOT EXISTS questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id),
  tax_category TEXT,
  title        TEXT,
  content      TEXT,
  status       TEXT DEFAULT 'pending',    -- 'processing' | 'done' | 'error' (questions/index.js 흐름 참고)
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 답변 (AI가 생성한 질의회신, 질문과 1:1 관계)
CREATE TABLE IF NOT EXISTS answers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id  INTEGER REFERENCES questions(id),
  content      TEXT,                      -- Gemini가 생성한 원본 답변 (마크다운)
  sources      TEXT DEFAULT '[]',         -- 답변 생성에 사용된 참고문서 이름, JSON 배열 문자열
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  -- content_edited TEXT  -- (마이그레이션으로 추가됨) 사용자가 편집한 답변 본문, NULL이면 미편집
);

-- 자료 폴더 (세목/업무 단위 트리 구조, 관리자페이지에서 활성/비활성 관리)
CREATE TABLE IF NOT EXISTS folders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  path         TEXT    NOT NULL,          -- 로컬 수집 경로(법령자료/... 등)와 매핑되는 표시용 경로
  tax_category TEXT    DEFAULT 'all',     -- 'all'이면 모든 세목 공통으로 검색 대상에 포함
  is_active    INTEGER DEFAULT 1,         -- 0이면 이 폴더의 문서는 답변 검색에서 제외
  parent_id    INTEGER,                   -- 폴더 트리 구조용 (현재 UI는 1단계만 주로 사용)
  sort_order   INTEGER DEFAULT 0
);

-- 문서 (법령/판례/해석례/관리자 업로드 자료 — 답변 생성의 근거 데이터)
CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id    INTEGER REFERENCES folders(id),
  name         TEXT    NOT NULL,
  file_path    TEXT,                      -- 로컬 마크다운 파일 경로 (시딩 스크립트가 채움)
  content      TEXT,                      -- 문서 본문 (FTS5 검색 대상, functions/_lib/docs.js가 조회)
  tax_category TEXT    DEFAULT 'all',
  is_active    INTEGER DEFAULT 1
  -- , nts_doc_id TEXT     (마이그레이션으로 추가됨) NTS 시스템 문서 ID, 온디맨드 상세조회 키
  -- , is_summary INTEGER  (마이그레이션으로 추가됨) 1이면 요약본만 저장된 상태(전문은 아직 미조회)
  ,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 기본 관리자 계정 — 비밀번호 해시가 평문 마커("CHANGE_ME")로 들어가 있고,
-- functions/api/auth/login.js가 이 마커를 보면 "admin1234"로만 1회 로그인을
-- 허용하는 특수 처리를 한다. 운영 환경에서는 로그인 후 가능한 빨리 DB에서
-- password_hash를 정식 해시로 교체해야 한다(현재 비밀번호 변경 UI는 없음).
INSERT OR IGNORE INTO users (name, email, password_hash, role, status)
VALUES ('관리자', 'admin@taxist.kr', 'CHANGE_ME', 'admin', 'active');

-- 기본 폴더 구조 — scripts/fetch_*.mjs 로 수집한 법령자료/판례자료 등을
-- 매핑하기 위한 초기 폴더 목록. id는 AUTOINCREMENT라 이 INSERT 순서가
-- 곧 id 값이 되며, functions/_lib/docs.js의 INTERP_FOLDER_MAP/PREC_FOLDER_MAP은
-- 이 id 값(예: 13~17은 판례 폴더)을 하드코딩으로 참조하므로, 폴더를
-- 추가/재정렬할 때는 그 매핑도 함께 갱신해야 한다.
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

-- 조회 성능을 위한 인덱스 (questions/answers/documents의 가장 빈번한 조회 패턴 기준)
CREATE INDEX IF NOT EXISTS idx_questions_user ON questions(user_id);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(tax_category);
