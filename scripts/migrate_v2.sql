-- ============================================================
-- v2 마이그레이션: 간단 질의 / 공유 링크 / 평가 / 템플릿
-- ============================================================

-- 1. 질문 유형: full(일반 질의 보고서) | quick(간단 질의 직접 답변)
ALTER TABLE questions ADD COLUMN question_type TEXT DEFAULT 'full';

-- 2. 답변 품질 평가 (1: 도움됨 / -1: 아쉬움 / NULL: 미평가)
ALTER TABLE answers ADD COLUMN rating INTEGER;

-- 3. 보고서 공유 토큰 (NULL이면 비공개, 생성 시 UUID)
ALTER TABLE answers ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_answers_share_token ON answers(share_token);

-- 4. 질문 템플릿
CREATE TABLE IF NOT EXISTS question_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_templates_user_id ON question_templates(user_id);
