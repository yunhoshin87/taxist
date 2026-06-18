-- ─────────────────────────────────────────────────────────────────
-- NTS 요약/전문 수집 진행상황 점검용 조회 쿼리 (읽기 전용, DB 변경 없음)
--
-- 목적: migrate_summary.sql로 추가된 is_summary / nts_doc_id 컬럼을 기준으로, 폴더(세목)별로
--       "아직 요약본만 있는 문서(summary_count)", 그중 "전문 수집이 가능한 nts_doc_id 보유 건(has_nts_id)",
--       "제목 검색이 필요한 건(no_nts_id)", "이미 전문이 채워진 건(full_count)"을 한눈에 집계해
--       export_pending.mjs로 다음 수집 배치를 만들기 전에 진행률을 가늠하는 용도.
-- 실행 방법(추정): npx wrangler d1 execute taxist-db --remote --file=scripts/check_summary.sql
--   (SELECT만 있는 점검 쿼리이므로 --remote/로컬 어느 쪽으로 실행해도 데이터에 영향 없음)
-- 실행 시점: 반복 실행 가능. 수집 작업 전후로 언제든 상태 확인용으로 돌려도 안전함(읽기 전용).
-- ─────────────────────────────────────────────────────────────────
SELECT
  f.name AS folder_name,
  f.tax_category,
  COUNT(*) AS total,
  -- 요약본 상태로 남아있는 문서 수 (= 아직 전문 미수집)
  SUM(CASE WHEN d.is_summary = 1 THEN 1 ELSE 0 END) AS summary_count,
  -- nts_doc_id가 있어 전문을 직접 조회로 빠르게 가져올 수 있는 건수
  SUM(CASE WHEN d.is_summary = 1 AND d.nts_doc_id IS NOT NULL THEN 1 ELSE 0 END) AS has_nts_id,
  -- nts_doc_id가 없어 제목 검색을 거쳐야 하는(느린) 건수
  SUM(CASE WHEN d.is_summary = 1 AND d.nts_doc_id IS NULL THEN 1 ELSE 0 END) AS no_nts_id,
  -- 전문 수집이 이미 완료된 문서 수
  SUM(CASE WHEN d.is_summary = 0 THEN 1 ELSE 0 END) AS full_count
FROM documents d
JOIN folders f ON d.folder_id = f.id
WHERE d.is_active = 1
GROUP BY f.id, f.name, f.tax_category
ORDER BY summary_count DESC;
