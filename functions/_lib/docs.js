// 활성 폴더 기반 문서 로딩

const CATEGORY_MAP = {
  "법인세":  ["법인세", "국세기본", "조세특례", "국제조세", "불복절차"],
  "부가세":  ["부가세", "국세기본", "조세특례", "불복절차"],
  "조사":    ["국세기본", "불복절차"],
  "징세":    ["국세기본", "불복절차"],
  "재산세":  ["지방세", "종합부동산세", "국세기본", "불복절차"],
  "개인세":  ["소득세", "상속증여세", "국세기본", "조세특례", "불복절차"],
};

export async function loadDocuments(db, taxCategory, maxChars = 60000) {
  // 관련 폴더 목록 결정
  const relatedFolders = CATEGORY_MAP[taxCategory] || ["국세기본"];

  // 활성 폴더의 활성 문서 조회 (관련 세목 우선)
  const { results } = await db.prepare(`
    SELECT d.id, d.name, d.content, d.tax_category, f.name AS folder_name
    FROM documents d
    JOIN folders f ON d.folder_id = f.id
    WHERE f.is_active = 1
      AND d.is_active = 1
      AND d.content IS NOT NULL
      AND (
        d.tax_category = ?
        OR d.tax_category = 'all'
        OR f.tax_category = ?
        OR f.tax_category = 'all'
      )
    ORDER BY
      CASE WHEN d.tax_category = ? THEN 0 ELSE 1 END,
      d.updated_at DESC
    LIMIT 20
  `).bind(taxCategory, taxCategory, taxCategory).all();

  // 토큰 한도 내에서 문서 선택
  const selected = [];
  let total = 0;
  for (const doc of results) {
    if (!doc.content) continue;
    const size = doc.content.length;
    if (total + size > maxChars) {
      // 잘라서 포함
      selected.push({ ...doc, content: doc.content.slice(0, maxChars - total) });
      break;
    }
    selected.push(doc);
    total += size;
  }

  return selected;
}
