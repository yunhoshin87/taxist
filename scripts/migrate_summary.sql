-- ─────────────────────────────────────────────────────────────────
-- NTS 요약 데이터 지원을 위한 D1 마이그레이션
--
-- 목적: 국세법령정보시스템(taxlaw.nts.go.kr)에서 먼저 "요약본"만 대량 수집해 documents에 채워두고,
--       이후 별도 작업(standalone_collect.mjs → import_collected.mjs)으로 전문을 채워 넣는
--       2단계 수집 전략을 지원하기 위해 컬럼/폴더를 추가한다.
--   - nts_doc_id: NTS 사이트의 원문 문서 ID. 전문 수집 시 이 ID로 직접 조회하면 제목 검색보다 빠르고 정확함.
--   - is_summary: 1이면 아직 요약본 상태(전문 미수집), 0이면 전문이 채워진 상태.
--                 import_collected.mjs가 전문을 반영하면서 1 → 0으로 전환한다.
-- 실행: npx wrangler d1 execute taxist-db --remote --file=scripts/migrate_summary.sql
--   (--remote 생략 시 로컬 D1에 적용. 운영 D1에는 --remote로 실행해야 함)
-- 실행 시점: 1회성 스키마 마이그레이션. ALTER TABLE은 같은 컬럼이 이미 있으면 에러가 나므로
--           이미 적용된 D1에 재실행하지 말 것(재실행이 필요하면 ALTER 문은 빼고 INSERT OR IGNORE 부분만 실행).
--           INSERT OR IGNORE 부분은 같은 id(PK)가 있으면 자동으로 스킵되므로 재실행해도 안전함.
-- ─────────────────────────────────────────────────────────────────

-- documents 테이블에 NTS 연동용 컬럼 2개 추가 (기존 행은 NULL / 기본값 0으로 채워짐)
ALTER TABLE documents ADD COLUMN nts_doc_id TEXT;
ALTER TABLE documents ADD COLUMN is_summary INTEGER DEFAULT 0;

-- NTS 요약 데이터를 분류해 담을 전용 폴더 6개 생성 (세목별로 구분)
-- "FTS5 전용, 직접 폴백에서는 제외"라는 기존 주석이 의미하는 바: 이 폴더들은 전문검색(FTS5) 결과에는
-- 노출되지만, 폴더를 직접 탐색하는 일반 UI 폴백 경로에서는 의도적으로 숨겨진(혹은 후순위) 폴더라는 뜻으로 추정됨.
-- id 30~35는 기존 폴더 id와 충돌하지 않도록 따로 확보된 번호대이며, INSERT OR IGNORE라
-- 이미 존재하면(재실행 시) 조용히 무시되어 중복 생성되지 않는다.
INSERT OR IGNORE INTO folders (id, name, path, tax_category, is_active, sort_order) VALUES
  (30, 'NTS-법인세',  'NTS해석례/법인세',  '법인세', 1, 30),
  (31, 'NTS-소득세',  'NTS해석례/소득세',  '개인세', 1, 31),
  (32, 'NTS-부가세',  'NTS해석례/부가세',  '부가세', 1, 32),
  (33, 'NTS-재산세',  'NTS해석례/재산세',  '재산세', 1, 33),
  (34, 'NTS-징세',    'NTS해석례/징세',    '징세',   1, 34),
  (35, 'NTS-기타',    'NTS해석례/기타',    'all',    1, 35);
