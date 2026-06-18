// ============================================================================
// 답변 생성을 위한 참고 문서 검색 (RAG의 "Retrieval" 단계)
//
// 사용자 질문이 들어오면, D1(SQLite 기반)에 저장된 법령·판례·해석례·관리자
// 업로드 자료 중 질문과 관련성이 높은 문서를 골라 Gemini 프롬프트에 넣을
// 컨텍스트로 만든다. 흐름은 대략:
//
//   1) 질문에서 핵심 키워드 추출 (불용어 제거 + 빈도 기반)
//   2) FTS5(SQLite 전문검색)로 키워드 매칭 문서 검색
//   3) 세목별 해석례/판례 폴더에서 최신 문서 보충 (FTS만으로는 다양성 부족)
//   4) 세목 매핑 기반 폴백 검색 (위 결과가 너무 적을 때)
//   5) "요약본"만 있는 해석례 문서는 국세청 사이트에서 전문을 온디맨드로
//      가져와 D1에 캐싱 (다음 질문부터는 즉시 재사용)
//   6) 토큰 절약을 위해 문서에서 키워드와 관련된 단락만 추출해 길이 제한
// ============================================================================

// ── 한국어 불용어 ──────────────────────────────────────────────
// 키워드 추출 시 의미가 거의 없는 조사/어미/범용 단어를 제거하기 위한 목록.
// 형태소 분석기(예: mecab) 없이 순수 JS로 동작해야 하므로 완벽한 형태소
// 분리는 불가능하지만, 자주 등장하는 불용어를 하드코딩해 정확도를 보완한다.
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

// ── 키워드 추출 (순수 JS, 외부 API 호출 없음) ───────────────────
// 질문 텍스트를 공백/특수문자로 토큰화 → 불용어·숫자·1글자 제거 →
// 등장 빈도 기준 상위 8개를 키워드로 채택한다. 형태소 분석이 아니므로
// 조사가 붙은 변형(예: "법인세는" vs "법인세가")은 다른 토큰으로 잡힐 수
// 있으나, FTS5 검색에서는 OR 조건으로 묶이므로 실용적으로는 충분하다.
function extractKeywords(text) {
  const words = text
    .replace(/[^가-힣a-zA-Z0-9\s]/g, ' ') // 한글/영문/숫자 외 문자는 공백으로 치환
    .split(/\s+/)
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  const freq = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1]) // 빈도 내림차순
    .slice(0, 8)
    .map(([w]) => w);
}

// ── FTS5 쿼리용 이스케이프 ─────────────────────────────────────
// SQLite FTS5의 MATCH 구문은 키워드를 큰따옴표로 감싸야 특수문자/공백이
// 포함된 토큰도 안전하게 매칭된다. 큰따옴표 자체는 ""로 escape.
function ftsEscape(kw) {
  return `"${kw.replace(/"/g, '""')}"`;
}

// ── 문서 본문에서 키워드와 관련된 단락만 추출 ──────────────────
// Gemini 프롬프트에 넣을 토큰 수를 줄이기 위해, 문서 전체가 아니라
// 키워드가 많이 등장하는 단락 위주로 잘라낸다(컨텍스트 압축).
function extractRelevantSections(content, keywords, maxChars = 1800) {
  if (!content) return '';

  // 판례 자료 파일은 "## 1. 사건명", "## 2. 사건명" ... 형태로 여러 건이
  // 한 파일에 모여 있다. 이 경우 일반 단락 분리(빈 줄 기준)가 아니라
  // 사건 단위("## N.")로 통째로 잘라야 사건번호+판시사항+판결요지가
  // 한 묶음으로 유지된다.
  const isPrecDoc = /^## \d+\./m.test(content);

  let paragraphs;
  if (isPrecDoc) {
    paragraphs = content
      .split(/(?=^## \d+\.)/m) // "## N." 앞에서 분리(lookahead라 구분자 보존)
      .map(p => p.trim())
      .filter(p => p.length > 60); // 너무 짧은 조각(헤더만 있는 등)은 제외
  } else {
    // 일반 문서: 빈 줄 2개 이상, 또는 ##/### 헤더 앞에서 분리
    paragraphs = content
      .split(/\n{2,}|(?=\n##\s)|(?=\n###\s)/)
      .map(p => p.trim())
      .filter(p => p.length > 40);
  }

  // 문서번호·사건번호가 포함된 단락은 답변에서 인용 가능성이 높으므로
  // 가산점을 줘서 우선 선택되게 한다.
  const docNoRe = /서면[-\s]|재정경제부|기획재정부|법인세제과|조심\s*\d|국심|과세기준|사전답변|대법원\s*\d{4}|사건번호|선고일자/;

  const scored = paragraphs.map(p => {
    const lower = p.toLowerCase();
    // 단락 안에 각 키워드가 몇 번 등장하는지 합산 → 관련도 점수
    const hits = keywords.reduce((n, kw) => {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); // 정규식 특수문자 escape
      return n + (lower.match(re) || []).length;
    }, 0);
    const bonus = docNoRe.test(p) ? 1 : 0;
    return { text: p, hits: hits + bonus };
  });

  // 점수 높은 단락부터 채워나가되, maxChars(문서당 글자 한도)를 넘지 않게 자른다
  const sorted = [...scored].sort((a, b) => b.hits - a.hits);
  const sections = [];
  let total = 0;
  for (const s of sorted) {
    if (s.hits === 0) break; // 키워드가 하나도 없는 단락부터는 더 볼 필요 없음
    if (total + s.text.length > maxChars) break;
    sections.push(s.text);
    total += s.text.length;
  }

  // 키워드 매칭 단락이 하나도 없으면(질문과 무관하거나 추출 실패) 문서 앞부분을 그대로 사용
  if (!sections.length) return content.slice(0, maxChars);
  return sections.join('\n\n');
}

// ── NTS(국세법령정보시스템) 온디맨드 상세 조회 ───────────────────
// 해석례/결정례를 대량 수집할 때는 API 부담을 줄이기 위해 "요약본"만
// 저장해두고(is_summary=1), 실제로 그 문서가 답변에 쓰일 때만 국세청
// 사이트에서 전문(질의요지+회신 전체)을 가져와 D1에 캐싱한다.
// 한 번 캐싱된 문서는 is_summary=0으로 갱신되어 다음부터는 즉시 재사용된다.

const NTS_HOST = "https://taxlaw.nts.go.kr";

// 국세법령정보시스템은 세션 쿠키(JSESSIONID)가 있어야 상세조회 API가 동작한다.
// 목록 페이지를 한 번 GET해서 Set-Cookie로 내려오는 세션을 얻어온다.
async function getNtsSession() {
  try {
    const res = await fetch(`${NTS_HOST}/qt/USEQTA001L.do?ntstDcmClCd=02`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
    });
    const cookie = res.headers.get("set-cookie") || "";
    return cookie.split(";")[0]; // "JSESSIONID=..." 부분만 추출
  } catch {
    return null; // 실패 시 세션 없이 시도 → 아래 fetchNtsDetail에서 실패 처리
  }
}

// 국세법령정보시스템의 비공개 AJAX 엔드포인트(action.do)를 호출해 문서 상세를 가져온다.
// (이 사이트는 공식 API 키를 제공하지 않으므로, 실제 웹페이지가 호출하는
//  내부 액션을 그대로 흉내내는 방식 — scripts/fetch_taxlaw_interp.mjs의
//  수집 로직과 동일한 엔드포인트/파라미터를 사용한다.)
async function fetchNtsDetail(ntsDocId, cookie) {
  try {
    const body = new URLSearchParams({
      actionId: "ASIQTB002PR01", // 해석례/결정례 상세조회 액션 ID
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
    // 세션이 만료되면 JSON 대신 로그인 HTML이 내려오므로 그 경우는 실패로 처리
    if (!text || text.trimStart().startsWith("<!")) return null;
    const json = JSON.parse(text);
    if (json.status !== "SUCCESS") return null;
    return (json.data?.["ASIQTB002PR01"] || json.data)?.dcmDVO || null;
  } catch {
    return null; // 네트워크 오류 등 → 호출부에서 fallback(기존 요약본) 사용
  }
}

// NTS 상세조회 응답(dvo)을 마크다운 문서로 변환한다.
// 응답에 본문이 비어있으면(드물게 발생) 기존 요약본(fallbackContent)을 그대로 유지.
function buildFullContent(dvo, fallbackContent) {
  const strip = (s) => (s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

  const title   = strip(dvo.ntstDcmTtl || "");
  const docNo   = strip(dvo.ntstDcmDscmCntn || "");
  // ntstDcmRgtDt는 "등록일"(문서가 시스템에 등록된 날짜)이며 결정일/회신일과
  // 다를 수 있다. 별도의 결정일 필드를 API가 제공하지 않으므로 "등록일"로
  // 명시해 표기한다(허위로 "결정일"이라고 표시하지 않음).
  const date    = (dvo.ntstDcmRgtDt || "").replace(/(\d{4})(\d{2})(\d{2}).*/, "$1-$2-$3");
  const tax     = strip(dvo.ntstTlawClNm || "");
  const gist    = strip(dvo.ntstDcmGistCntn || "");   // 질의요지
  const answer  = strip(dvo.ntstDcmCntn || "");        // 회신 전문
  const keyword = strip(dvo.ntstDcmMatrCntn || "");

  if (!answer && !gist) return fallbackContent; // 본문을 못 가져왔으면 기존 요약본 유지

  const lines = [`# ${title || "해석례"}`, ""];
  lines.push("| 항목 | 내용 |", "|---|---|");
  if (docNo)   lines.push(`| 문서번호 | ${docNo} |`);
  if (date)    lines.push(`| 등록일   | ${date} |`);
  if (tax)     lines.push(`| 세목     | ${tax} |`);
  if (keyword) lines.push(`| 키워드   | ${keyword.slice(0, 100)} |`);
  lines.push("");
  if (gist)   lines.push("## 질의요지", "", gist, "");
  if (answer) lines.push("## 회신", "", answer, "");
  return lines.join("\n");
}

// ── 세목 → 관련 폴더명 매핑 (2순위 폴백 검색용) ──────────────────
// FTS5 검색 결과가 부족할 때, 회원의 담당 세목과 이름이 비슷한 폴더에서
// 문서를 보충한다. 세목 하나가 여러 법률 영역(국세기본법, 조세특례 등)에
// 걸쳐 있을 수 있어 1:N 매핑이다.
const CATEGORY_MAP = {
  '법인세':  ['법인세', '국세기본', '조세특례', '국제조세', '불복절차', '해석례-법인세'],
  '부가세':  ['부가세', '국세기본', '조세특례', '불복절차', '해석례-부가세'],
  '조사':    ['국세기본', '불복절차', '해석례-조사'],
  '징세':    ['국세기본', '불복절차', '해석례-징세'],
  '재산세':  ['지방세', '종합부동산세', '국세기본', '불복절차', '해석례-재산세'],
  '개인세':  ['소득세', '상속증여세', '국세기본', '조세특례', '불복절차', '해석례-개인세'],
};

// ── 세목별 해석례 폴더 ID 매핑 (1.5순위 — 항상 보충) ─────────────
// folders 테이블의 실제 id를 하드코딩한 매핑. 새 해석례 폴더를 추가하면
// 이 매핑도 함께 갱신해야 한다(관리자페이지에서 폴더를 만들어도 자동
// 반영되지 않음 — 코드 수정 필요).
// 폴더 35 = "NTS-기타"(tax_category='all') : 세목 구분 없는 공통 해석례라
// 모든 세목 매핑에 공통으로 포함된다.
const INTERP_FOLDER_MAP = {
  '법인세': [27, 35],
  '부가세': [20, 35],
  '소득세': [21, 35],
  '징세':   [22, 35],
  '재산세': [23, 35],
  '조사':   [24, 35],
  '개인세': [25, 35],
};

// ── 세목별 판례 폴더 ID 매핑 (1.7순위 — 항상 보충) ───────────────
const PREC_FOLDER_MAP = {
  '법인세': [13],
  '부가세': [14],
  '소득세': [15],
  '개인세': [15],
  '징세':   [16],
  '재산세': [17],
  '조사':   [16],
};

/**
 * 질문에 대한 참고 문서 목록을 검색해 반환한다 (Gemini 프롬프트에 그대로 삽입됨).
 *
 * @param {D1Database} db          Cloudflare D1 바인딩 (env.DB)
 * @param {string} taxCategory     회원/질문의 세목 (법인세/부가세/...)
 * @param {string} question        질문 원문 (키워드 추출에 사용, 빈 문자열이면 키워드 검색 생략)
 * @returns {Promise<Array<{id, name, content, ...}>>}  컨텍스트 압축이 끝난 문서 배열
 */
export async function loadDocuments(db, taxCategory, question = '') {
  const keywords = question ? extractKeywords(question) : [];
  let docs = [];

  // ── 1순위: FTS5 전문검색 (키워드가 2개 이상 추출됐을 때만 시도) ──
  // 키워드가 너무 적으면 OR 검색이 과도하게 광범위해져 의미가 없으므로 스킵.
  if (keywords.length >= 2) {
    try {
      const ftsQuery = keywords.map(ftsEscape).join(' OR ');

      // documents_fts는 documents 테이블과 별도로 유지되는 FTS5 가상 테이블
      // (schema.sql / migrate_fts.sql 참고). rank는 SQLite FTS5의 관련도 점수.
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

        // FTS 검색 결과(rank)순서를 유지하기 위해 재정렬
        const rankMap = Object.fromEntries(ftsRows.map(r => [r.doc_id, r.rank]));
        docs = results.sort((a, b) => (rankMap[a.id] || 0) - (rankMap[b.id] || 0));
      }
    } catch (e) {
      // FTS 테이블이 없거나 쿼리 오류가 나도 전체 요청이 실패하지 않도록 흡수
      console.error('FTS search failed:', e?.message);
    }
  }

  // ── 1.5순위: 세목별 해석례 폴더에서 최신 문서 보충 ───────────────
  // FTS 검색만으로는 "판례 및 결정례" 섹션에 다양한 유형(심사청구 등)이
  // 누락되기 쉬워서, 세목에 맞는 해석례 폴더 최신 문서를 항상 추가한다.
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
        if (!existing.has(r.id)) docs.push(r); // FTS 결과와 중복되지 않는 것만 추가
      }
    }
  } catch (e) {
    console.error('Interp folder search failed:', e?.message);
  }

  // ── 1.7순위: 세목별 판례 폴더에서 최신 문서 보충 ─────────────────
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

  // ── 2순위: 세목 매핑 기반 폴백 검색 (위 결과가 3건 미만일 때만) ───
  // FTS5 매칭이 거의 없는 질문(키워드가 너무 일반적이거나 추출 실패)에
  // 대한 안전망. 폴더명이 CATEGORY_MAP의 키워드를 포함하는 폴더에서
  // 세목이 일치하는 문서를 최신순으로 가져온다.
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

  // ── 온디맨드 NTS 상세 조회 (is_summary=1인 문서만 대상) ──────────
  // 대량 수집 시 절약을 위해 요약본만 저장된 문서가 실제로 이번 답변에
  // 쓰이게 되면, 그 순간 전문을 가져와 품질을 높이고 D1에 캐싱해둔다.
  const summaryDocs = docs.filter(d => d.is_summary && d.nts_doc_id);
  if (summaryDocs.length > 0) {
    try {
      const cookie = await getNtsSession();
      if (cookie) {
        // 응답 시간을 줄이기 위해 최대 5건만, 병렬로 조회한다
        const toFetch = summaryDocs.slice(0, 5);
        const results = await Promise.allSettled(
          toFetch.map(d => fetchNtsDetail(d.nts_doc_id, cookie))
        );
        for (let i = 0; i < toFetch.length; i++) {
          const r = results[i];
          if (r.status === 'fulfilled' && r.value) {
            const fullContent = buildFullContent(r.value, toFetch[i].content);
            // D1 캐시 업데이트 — is_summary를 0으로 내려 다음 질문부터는
            // 이 온디맨드 조회를 다시 거치지 않고 즉시 전문을 사용하게 한다.
            try {
              await db.prepare(
                'UPDATE documents SET content = ?, is_summary = 0 WHERE id = ?'
              ).bind(fullContent, toFetch[i].id).run();
            } catch { /* 캐시 갱신 실패는 답변 생성 자체를 막지 않도록 무시 */ }
            // 이번 요청에도 즉시 반영(캐시 업데이트를 기다리지 않고 메모리상 객체를 갱신)
            const doc = docs.find(d => d.id === toFetch[i].id);
            if (doc) doc.content = fullContent;
          }
          // 실패(rejected)했거나 값이 없으면 기존 요약본(content)을 그대로 사용
        }
      }
    } catch (e) {
      console.error('NTS 온디맨드 조회 오류:', e?.message);
    }
  }

  // ── 컨텍스트 압축: 관련 단락만 추출 + 총 길이 제한 ───────────────
  // Gemini 입력 토큰을 절약하기 위해 문서 전체를 넣지 않고, 키워드와
  // 관련된 부분만 추출한다. 문서당 최대 PER_DOC자, 전체 합계 MAX_TOTAL자로
  // 제한해 토큰 폭증과 응답 지연(잘림)을 방지한다.
  const MAX_TOTAL = 24000; // 판례·해석례 포함으로 한도 상향
  const PER_DOC   = 2400;  // 문서당 최대 (판례 케이스 3-4건 수용)

  const selected = [];
  let total = 0;

  for (const doc of docs.slice(0, 10)) { // 후보가 너무 많아도 최대 10건까지만 검토
    if (total >= MAX_TOTAL) break;
    const section = keywords.length
      ? extractRelevantSections(doc.content, keywords, PER_DOC)
      : doc.content.slice(0, PER_DOC); // 키워드가 없으면(질문 없이 호출된 경우) 앞부분만 사용
    if (!section.trim()) continue;

    const clipped = section.slice(0, MAX_TOTAL - total); // 전체 한도를 넘지 않게 마지막 문서를 잘라냄
    selected.push({ ...doc, content: clipped });
    total += clipped.length;
  }

  return selected;
}
