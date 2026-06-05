// 질문 키워드 기반 관련 문서 검색 (FTS5 + 단락 스코링 + NTS 온디맨드 상세 캐싱)

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

  // 판례 파일 감지: "## N. 사건명" 패턴이면 케이스 단위로 분리
  // 사건번호 테이블 + 판시사항 + 판결요지가 한 단위로 추출되어야 함
  const isPrecDoc = /^## \d+\./m.test(content);

  let paragraphs;
  if (isPrecDoc) {
    paragraphs = content
      .split(/(?=^## \d+\.)/m)
      .map(p => p.trim())
      .filter(p => p.length > 60);
  } else {
    paragraphs = content
      .split(/\n{2,}|(?=\n##\s)|(?=\n###\s)/)
      .map(p => p.trim())
      .filter(p => p.length > 40);
  }

  // 문서번호·사건번호 포함 단락 가산점
  const docNoRe = /서면[-\s]|재정경제부|기획재정부|법인세제과|조심\s*\d|국심|과세기준|사전답변|대법원\s*\d{4}|사건번호|선고일자/;

  const scored = paragraphs.map(p => {
    const lower = p.toLowerCase();
    const hits = keywords.reduce((n, kw) => {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      return n + (lower.match(re) || []).length;
    }, 0);
    const bonus = docNoRe.test(p) ? 1 : 0;
    return { text: p, hits: hits + bonus };
  });

  const sorted = [...scored].sort((a, b) => b.hits - a.hits);
  const sections = [];
  let total = 0;
  for (const s of sorted) {
    if (s.hits === 0) break;
    if (total + s.text.length > maxChars) break;
    sections.push(s.text);
    total += s.text.length;
  }

  if (!sections.length) return content.slice(0, maxChars);
  return sections.join('\n\n');
}

// ── NTS 온디맨드 상세 조회 (요약 문서 → 전문 캐싱) ───────────

const NTS_HOST = "https://taxlaw.nts.go.kr";

async function getNtsSession() {
  try {
    const res = await fetch(`${NTS_HOST}/qt/USEQTA001L.do?ntstDcmClCd=02`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
    });
    const cookie = res.headers.get("set-cookie") || "";
    return cookie.split(";")[0]; // JSESSIONID=...
  } catch {
    return null;
  }
}

async function fetchNtsDetail(ntsDocId, cookie) {
  try {
    const body = new URLSearchParams({
      actionId: "ASIQTB002PR01",
      paramData: JSON.stringify({ dcmDVO: { ntstDcmId: ntsDocId } }),
    });
    const res = await fetch(`${NTS_HOST}/action.do`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, */*; q=0.01",
        "Referer": `${NTS_HOST}/qt/USEQTA001L.do?ntstDcmClCd=02`,
        "Origin": NTS_HOST,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.trimStart().startsWith("<!")) return null;
    const json = JSON.parse(text);
    if (json.status !== "SUCCESS") return null;
    return (json.data?.["ASIQTB002PR01"] || json.data)?.dcmDVO || null;
  } catch {
    return null;
  }
}

function buildFullContent(dvo, fallbackContent) {
  const strip = (s) => (s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

  const title   = strip(dvo.ntstDcmTtl || "");
  const docNo   = strip(dvo.ntstDcmDscmCntn || "");
  const date    = (dvo.ntstDcmRgtDt || "").replace(/(\d{4})(\d{2})(\d{2}).*/, "$1-$2-$3");
  const tax     = strip(dvo.ntstTlawClNm || "");
  const gist    = strip(dvo.ntstDcmGistCntn || "");
  const answer  = strip(dvo.ntstDcmCntn || "");
  const keyword = strip(dvo.ntstDcmMatrCntn || "");

  if (!answer && !gist) return fallbackContent;

  const lines = [`# ${title || "해석례"}`, ""];
  lines.push("| 항목 | 내용 |", "|---|---|");
  if (docNo)   lines.push(`| 문서번호 | ${docNo} |`);
  if (date)    lines.push(`| 등록일   | ${date} |`);
  if (tax)     lines.push(`| 세목     | ${tax} |`);
  if (keyword) lines.push(`| 키워드   | ${keyword.slice(0, 100)} |`);
  lines.push("");
  if (gist) {
    lines.push("## 질의요지", "", gist, "");
  }
  if (answer) {
    lines.push("## 회신", "", answer, "");
  }
  return lines.join("\n");
}

// ── 세목-폴더 매핑 (폴백용) ────────────────────────────────────
const CATEGORY_MAP = {
  '법인세':  ['법인세', '국세기본', '조세특례', '국제조세', '불복절차', '해석례-법인세'],
  '부가세':  ['부가세', '국세기본', '조세특례', '불복절차', '해석례-부가세'],
  '조사':    ['국세기본', '불복절차', '해석례-조사'],
  '징세':    ['국세기본', '불복절차', '해석례-징세'],
  '재산세':  ['지방세', '종합부동산세', '국세기본', '불복절차', '해석례-재산세'],
  '개인세':  ['소득세', '상속증여세', '국세기본', '조세특례', '불복절차', '해석례-개인세'],
};

// ── 세목별 해석례 폴더 ID 매핑 ──────────────────────────────
// 폴더 35 = NTS-기타 (tax_category='all') : 세목 구분 없이 모든 세목에 포함
const INTERP_FOLDER_MAP = {
  '법인세': [27, 35],
  '부가세': [20, 35],
  '소득세': [21, 35],
  '징세':   [22, 35],
  '재산세': [23, 35],
  '조사':   [24, 35],
  '개인세': [25, 35],
};

// ── 세목별 판례 폴더 ID 매핑 ────────────────────────────────
const PREC_FOLDER_MAP = {
  '법인세': [13],
  '부가세': [14],
  '소득세': [15],
  '개인세': [15],
  '징세':   [16],
  '재산세': [17],
  '조사':   [16],
};

// ── 메인: 문서 로딩 ───────────────────────────────────────────
export async function loadDocuments(db, taxCategory, question = '') {
  const keywords = question ? extractKeywords(question) : [];
  let docs = [];

  // ── 1순위: FTS5 전문검색 (키워드가 있을 때) ──────────────────
  if (keywords.length >= 2) {
    try {
      const ftsQuery = keywords.map(ftsEscape).join(' OR ');

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
          SELECT d.id, d.name, d.content, d.tax_category, f.name AS folder_name,
                 d.nts_doc_id, d.is_summary
          FROM documents d
          JOIN folders f ON d.folder_id = f.id
          WHERE d.id IN (${placeholders})
            AND d.is_active = 1
            AND f.is_active = 1
            AND d.content IS NOT NULL
        `).bind(...ids).all();

        const rankMap = Object.fromEntries(ftsRows.map(r => [r.doc_id, r.rank]));
        docs = results.sort((a, b) => (rankMap[a.id] || 0) - (rankMap[b.id] || 0));
      }
    } catch (e) {
      console.error('FTS search failed:', e?.message);
    }
  }

  // ── 1.5순위: 해석례 폴더 직접 포함 (항상 추가) ──────────────
  try {
    const interpIds = INTERP_FOLDER_MAP[taxCategory] || [];
    if (interpIds.length > 0) {
      const ph = interpIds.map(() => '?').join(',');
      const { results: interpDocs } = await db.prepare(`
        SELECT d.id, d.name, d.content, d.tax_category, f.name AS folder_name,
               d.nts_doc_id, d.is_summary
        FROM documents d
        JOIN folders f ON d.folder_id = f.id
        WHERE d.folder_id IN (${ph})
          AND d.is_active = 1 AND f.is_active = 1 AND d.content IS NOT NULL
        ORDER BY d.updated_at DESC LIMIT 4
      `).bind(...interpIds).all();

      const existing = new Set(docs.map(d => d.id));
      for (const r of interpDocs) {
        if (!existing.has(r.id)) docs.push(r);
      }
    }
  } catch (e) {
    console.error('Interp folder search failed:', e?.message);
  }

  // ── 1.7순위: 판례 폴더 직접 포함 (항상 추가) ────────────────
  try {
    const precIds = PREC_FOLDER_MAP[taxCategory] || [];
    if (precIds.length > 0) {
      const ph = precIds.map(() => '?').join(',');
      const { results: precDocs } = await db.prepare(`
        SELECT d.id, d.name, d.content, d.tax_category, f.name AS folder_name,
               d.nts_doc_id, d.is_summary
        FROM documents d
        JOIN folders f ON d.folder_id = f.id
        WHERE d.folder_id IN (${ph})
          AND d.is_active = 1 AND f.is_active = 1 AND d.content IS NOT NULL
        ORDER BY d.updated_at DESC LIMIT 2
      `).bind(...precIds).all();

      const existing = new Set(docs.map(d => d.id));
      for (const r of precDocs) {
        if (!existing.has(r.id)) docs.push(r);
      }
    }
  } catch (e) {
    console.error('Prec folder search failed:', e?.message);
  }

  // ── 2순위: 세목 기반 폴백 (FTS 결과 부족할 때) ───────────────
  if (docs.length < 3) {
    const related = CATEGORY_MAP[taxCategory] || ['국세기본'];
    const folderLike = related.map(() => 'f.name LIKE ?').join(' OR ');
    const binds = [
      taxCategory, taxCategory, taxCategory,
      ...related.map(f => `%${f}%`),
    ];

    const { results } = await db.prepare(`
      SELECT d.id, d.name, d.content, d.tax_category, f.name AS folder_name,
             d.nts_doc_id, d.is_summary
      FROM documents d
      JOIN folders f ON d.folder_id = f.id
      WHERE f.is_active = 1 AND d.is_active = 1 AND d.content IS NOT NULL
        AND (d.tax_category = ? OR d.tax_category = 'all'
             OR f.tax_category = ? OR f.tax_category = 'all')
        AND (${folderLike})
      ORDER BY CASE WHEN d.tax_category = ? THEN 0 ELSE 1 END, d.updated_at DESC
      LIMIT 8
    `).bind(...binds).all();

    const existing = new Set(docs.map(d => d.id));
    for (const r of results) {
      if (!existing.has(r.id)) docs.push(r);
    }
  }

  // ── 온디맨드 NTS 상세 조회 (is_summary=1 문서에 대해) ────────
  const summaryDocs = docs.filter(d => d.is_summary && d.nts_doc_id);
  if (summaryDocs.length > 0) {
    try {
      const cookie = await getNtsSession();
      if (cookie) {
        // 최대 5건 병렬 조회
        const toFetch = summaryDocs.slice(0, 5);
        const results = await Promise.allSettled(
          toFetch.map(d => fetchNtsDetail(d.nts_doc_id, cookie))
        );
        for (let i = 0; i < toFetch.length; i++) {
          const r = results[i];
          if (r.status === 'fulfilled' && r.value) {
            const fullContent = buildFullContent(r.value, toFetch[i].content);
            // D1 캐시 업데이트 (다음 질문부터는 즉시 사용)
            try {
              await db.prepare(
                'UPDATE documents SET content = ?, is_summary = 0 WHERE id = ?'
              ).bind(fullContent, toFetch[i].id).run();
            } catch { /* 캐시 실패는 무시 */ }
            // 현재 요청에 즉시 반영
            const doc = docs.find(d => d.id === toFetch[i].id);
            if (doc) doc.content = fullContent;
          }
        }
      }
    } catch (e) {
      console.error('NTS 온디맨드 조회 오류:', e?.message);
    }
  }

  // ── 관련 단락만 추출해서 컨텍스트 압축 ──────────────────────
  const MAX_TOTAL = 24000; // 판례·해석례 포함으로 한도 상향
  const PER_DOC   = 2400;  // 문서당 최대 (판례 케이스 3-4건 수용)

  const selected = [];
  let total = 0;

  for (const doc of docs.slice(0, 10)) {
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
