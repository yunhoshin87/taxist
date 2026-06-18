-- ─────────────────────────────────────────────────────────────────
-- D1(Cloudflare SQLite) 마이그레이션: documents 테이블에 FTS5 전문검색 인덱스 추가
--
-- 목적: documents.content(법령/판례/해석례 본문)에 대해 LIKE 검색보다 빠르고 한국어 토큰 단위로
--       매칭되는 전문검색을 지원하기 위함. SQLite 외부 콘텐츠 테이블(content='documents')
--       방식이라 본문을 FTS 테이블에 중복 저장하지 않고 documents.id(rowid)만 참조한다.
-- 실행 방법(추정): npx wrangler d1 execute taxist-db --remote --file=scripts/migrate_fts.sql
--   (migrate_summary.sql과 동일한 방식의 1회성 D1 마이그레이션. --remote 생략 시 로컬 D1에 적용됨)
-- 실행 시점: 1회성 마이그레이션. documents_fts 테이블이 이미 있으면 CREATE는 안전하게 스킵되지만,
--           두 번째 문장(INSERT)은 재실행 시 중복 행이 쌓일 수 있으니 재실행 전 documents_fts를
--           DELETE하거나, 신규 환경(테이블이 아직 없는 D1)에 처음 한 번만 실행하는 것을 권장.
-- ─────────────────────────────────────────────────────────────────

-- FTS5 가상 테이블 생성 (문서 내용 검색용)
-- tokenize='unicode61 remove_diacritics 1': 유니코드 기반 토크나이저로 한글을 포함한 텍스트를
-- 토큰화하고, 발음 구별 기호를 제거해 검색 매칭 범위를 넓힌다.
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  content,
  content='documents',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 1'
);

-- 기존 문서로 FTS 인덱스 채우기 — 마이그레이션 시점에 이미 존재하는 활성(is_active=1) 문서들을
-- 한 번에 색인해, 이후 신규/수정 문서는 애플리케이션 코드(import_collected.mjs 등)에서
-- 별도로 FTS 인덱스를 갱신해야 함(이 스크립트는 최초 적재만 담당).
INSERT INTO documents_fts(rowid, content)
  SELECT id, COALESCE(content, '') FROM documents WHERE is_active = 1;
