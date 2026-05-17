// 질문 키워드 기반 관련 문서 검색 (FTS5 + 단락 스코링)

// ── 한국어 불용어 ──────────────────────────────────────────────
const STOPWORDS = new Set([
  '있', '없', '하', '되', '것', '수', '이', '그', '저', '우리', '제', '본',
  '을', '를', '이', '가', '은', '는', '의', '에', '와', '과', '도', '만',
  '로', '으로', '에서', '에게', '까지', '부터', '처럼', '보다', '라고',
  '하여', '하며', '하고', '해서', '하면', '하는', '한', '할', '하지',
  '합니다', '입니다', '습니다', '십니다', '겠습니다', '되었습니다',
  '어떤', '어떻게', '무엇', '왜', '언제', '어디', '누가', '무슨', '몇',
  '대해', '대한', '관한', '관련', '경우', '때', '때문', '위해', '위한',
  '통해', '통한', '따라', '따른', '의한', '의해', '또한', '또는', '그리고',
  '하지만', '그러나', '따라서', '그래서', '이에', '이를', '이가',
  '기준', '방법', '이라', '라는', '라고', '에는', '에도', '으로서', '으로써',
  '가능', '필요', '요청', '질의', '검토', '확인', '여부', '관련하여',
]);

// ── 키워드 추출 (순수 JS, API 호출 없음) ───────────────────────
function extractKeywords(text) {
  const words = text
    .replace(/[^가-힣a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  const freq = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);
}

// ── FTS5 쿼리용 이스케이프 ─────────────────────────────────────
function ftsEscape(kw) {
  return `"${kw.replace(/"/g, '""')}"`;
}

// ── 단락에서 키워드 관련 섹션만 추출 ──────────────────────────
function extractRelevantSections(content, keywords, maxChars = 1800) {
  if (!content) return '';

  // 단락 분리 (법령 조문 단위, 판례 항목 단위)
  const paragraphs = content
    .split(/\n{2,}|(?=\n##\s)|(?=\n###\s)/)
    .map(p => p.trim())
    .filter(p => p.length > 40);

  // 문서번호 포함 단락은 가산점 (서면-, 재정경제부, 조심, 과세기준 등)
  const docNoRe = /서면[-\s]|재정경제부|기획재정부|법인세제과|조심\s*\d|국심|과세기준|사전답변/;

  // 각 단락을 키워드 히트 수로 스코링
  const scored = paragraphs.map(p => {
    const lower = p.toLowerCase();
    const hits = keywords.reduce((n, kw) => {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      return n + (lower.match(re) || []).length;
    }, 0);
    const bonus = docNoRe.test(p) ? 1 : 0;
    return { text: p, hits: hits + bonus };
  });

  // 히트 수 기준 정렬 후 maxChars까지 수집
  const sorted = [...scored].sort((a, b) => b.hits - a.hits);
  const sections = [];
  let total = 0;
  for (const s of sorted) {
    if (s.hits === 0) break; // 히트 없는 단락은 제외
    if (total + s.text.length > maxChars) break;
    sections.push(s.text);
    total += s.text.length;
  }

  // 관련 단락이 없으면 앞부분 반환
  if (!sections.length) return content.slice(0, maxChars);

  return sections.join('\n\n');
}

// ── 세목-폴더 매핑 (폴백용) ────────────────────────────────────
// 법령·판례 외에 해석례(해석례-세목) 폴더도 포함
const CATEGORY_MAP = {
  '법인세':  ['법인세', '국세기본', '조세특례', '국제조세', '불복절차', '해석례-법인세'],
  '부가세':  ['부가세', '국세기본', '조세특례', '불복절차', '해석례-부가세'],
  '조사':    ['국세기본', '불복절차', '해석례-조사'],
  '징세':    ['국세기본', '불복절차', '해석례-징세'],
  '재산세':  ['지방세', '종합부동산세', '국세기본', '불복절차', '해석례-재산세'],
  '개인세':  ['소득세', '상속증여세', '국세기본', '조세특례', '불복절차', '해석례-개인세'],
};

// ── 해석례 폴더 ID 범위 (seed_interp.mjs 기준) ───────────────
const INTERP_FOLDER_IDS = [20, 21, 22, 23, 24, 25, 26, 27]; // 해석례-부가세~해석례-법인세

// ── 세목별 해석례 폴더 ID 매핑 ──────────────────────────────
const INTERP_FOLDER_MAP = {
  '법인세': [27],
  '부가세': [20],
  '소득세': [21],
  '징세':   [22],
  '재산세': [23],
  '조사':   [24],
  '개인세': [25],
};

// ── 메인: 문서 로딩 ───────────────────────────────────────────
export async function loadDocuments(db, taxCategory, question = '') {
  const keywords = question ? extractKeywords(question) : [];
  let docs = [];

  // ── 1순위: FTS5 전문검색 (키워드가 있을 때) ──────────────────
  if (keywords.length >= 2) {
    try {
      const ftsQuery = keywords.map(ftsEscape).join(' OR ');

      // FTS5로 관련 문서 rowid 획득 (rank = BM25 관련도)
      const { results: ftsRows } = await db.prepare(`
        SELECT f.rowid AS doc_id, rank
        FROM documents_fts f
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT 12
      `).bind(ftsQuery).all();

      if (ftsRows.length > 0) {
        const ids = ftsRows.map(r => r.doc_id);
        const placeholders = ids.map(() => '?').join(',');

        const { results } = await db.prepare(`
          SELECT d.id, d.name, d.content, d.tax_category, f.name AS folder_name
          FROM documents d
          JOIN folders f ON d.folder_id = f.id
          WHERE d.id IN (${placeholders})
            AND d.is_active = 1
            AND f.is_active = 1
            AND d.content IS NOT NULL
        `).bind(...ids).all();

        // FTS rank 순서로 재정렬
        const rankMap = Object.fromEntries(ftsRows.map(r => [r.doc_id, r.rank]));
        docs = results.sort((a, b) => (rankMap[a.id] || 0) - (rankMap[b.id] || 0));
      }
    } catch (e) {
      console.error('FTS search failed:', e?.message);
    }
  }

  // ── 1.5순위: 해석례 폴더 직접 포함 (해당 세목 해석례 항상 추가) ──
  try {
    const interpFolderIds = INTERP_FOLDER_MAP[taxCategory] || [];
    if (interpFolderIds.length > 0) {
      const interpPlaceholders = interpFolderIds.map(() => '?').join(',');
      const { results: interpDocs } = await db.prepare(`
        SELECT d.id, d.name, d.content, d.tax_category, f.name AS folder_name
        FROM documents d
        JOIN folders f ON d.folder_id = f.id
        WHERE d.folder_id IN (${interpPlaceholders})
          AND d.is_active = 1
          AND f.is_active = 1
          AND d.content IS NOT NULL
        ORDER BY d.updated_at DESC
        LIMIT 4
      `).bind(...interpFolderIds).all();

      const existing = new Set(docs.map(d => d.id));
      for (const r of interpDocs) {
        if (!existing.has(r.id)) docs.push(r);
      }
    }
  } catch (e) {
    console.error('Interp folder search failed:', e?.message);
  }

  // ── 2순위: 세목 기반 폴백 (FTS 결과 없을 때) ─────────────────
  if (docs.length < 3) {
    const related = CATEGORY_MAP[taxCategory] || ['국세기본'];
    const folderLike = related.map(() => 'f.name LIKE ?').join(' OR ');
    const binds = [
      taxCategory, taxCategory, taxCategory,
      ...related.map(f => `%${f}%`),
    ];

    const { results } = await db.prepare(`
      SELECT d.id, d.name, d.content, d.tax_category, f.name AS folder_name
      FROM documents d
      JOIN folders f ON d.folder_id = f.id
      WHERE f.is_active = 1 AND d.is_active = 1 AND d.content IS NOT NULL
        AND (d.tax_category = ? OR d.tax_category = 'all'
             OR f.tax_category = ? OR f.tax_category = 'all')
        AND (${folderLike})
      ORDER BY CASE WHEN d.tax_category = ? THEN 0 ELSE 1 END, d.updated_at DESC
      LIMIT 8
    `).bind(...binds).all();

    // 기존 FTS 결과와 중복 제거 후 병합
    const existing = new Set(docs.map(d => d.id));
    for (const r of results) {
      if (!existing.has(r.id)) docs.push(r);
    }
  }

  // ── 관련 단락만 추출해서 컨텍스트 압축 ──────────────────────
  const MAX_TOTAL = 20000; // 총 컨텍스트 한도 (약 5,000 토큰)
  const PER_DOC   = 1800;  // 문서당 최대 추출 글자

  const selected = [];
  let total = 0;

  for (const doc of docs.slice(0, 8)) {
    if (total >= MAX_TOTAL) break;
    const section = keywords.length
      ? extractRelevantSections(doc.content, keywords, PER_DOC)
      : doc.content.slice(0, PER_DOC);
    if (!section.trim()) continue;

    const clipped = section.slice(0, MAX_TOTAL - total);
    selected.push({ ...doc, content: clipped });
    total += clipped.length;
  }

  return selected;
}
