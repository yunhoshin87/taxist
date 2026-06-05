SELECT
  f.name AS folder_name,
  f.tax_category,
  COUNT(*) AS total,
  SUM(CASE WHEN d.is_summary = 1 THEN 1 ELSE 0 END) AS summary_count,
  SUM(CASE WHEN d.is_summary = 1 AND d.nts_doc_id IS NOT NULL THEN 1 ELSE 0 END) AS has_nts_id,
  SUM(CASE WHEN d.is_summary = 1 AND d.nts_doc_id IS NULL THEN 1 ELSE 0 END) AS no_nts_id,
  SUM(CASE WHEN d.is_summary = 0 THEN 1 ELSE 0 END) AS full_count
FROM documents d
JOIN folders f ON d.folder_id = f.id
WHERE d.is_active = 1
GROUP BY f.id, f.name, f.tax_category
ORDER BY summary_count DESC;
