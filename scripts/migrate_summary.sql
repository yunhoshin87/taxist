-- NTS 요약 데이터 지원을 위한 D1 마이그레이션
-- 실행: npx wrangler d1 execute taxist-db --remote --file=scripts/migrate_summary.sql

ALTER TABLE documents ADD COLUMN nts_doc_id TEXT;
ALTER TABLE documents ADD COLUMN is_summary INTEGER DEFAULT 0;

-- NTS 요약 데이터용 폴더 생성 (FTS5 전용, 직접 폴백에서는 제외)
INSERT OR IGNORE INTO folders (id, name, path, tax_category, is_active, sort_order) VALUES
  (30, 'NTS-법인세',  'NTS해석례/법인세',  '법인세', 1, 30),
  (31, 'NTS-소득세',  'NTS해석례/소득세',  '개인세', 1, 31),
  (32, 'NTS-부가세',  'NTS해석례/부가세',  '부가세', 1, 32),
  (33, 'NTS-재산세',  'NTS해석례/재산세',  '재산세', 1, 33),
  (34, 'NTS-징세',    'NTS해석례/징세',    '징세',   1, 34),
  (35, 'NTS-기타',    'NTS해석례/기타',    'all',    1, 35);
