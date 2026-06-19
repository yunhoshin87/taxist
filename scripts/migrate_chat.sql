-- 대화형 질의 메시지 테이블
-- 보고서 생성 후 추가 질문/답변을 저장한다.
-- question_id 기준으로 대화 이력을 보관하며, 질문/답변은 role 컬럼으로 구분한다.

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_question_id ON chat_messages(question_id);
