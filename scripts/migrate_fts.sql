-- FTS5 전문검색 인덱스 생성 (문서 내용 검색용)
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  content,
  content='documents',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 1'
);

-- 기존 문서로 FTS 인덱스 채우기
INSERT INTO documents_fts(rowid, content)
  SELECT id, COALESCE(content, '') FROM documents WHERE is_active = 1;
