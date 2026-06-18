/**
 * TAXIST 월간 증분 수집 스크립트
 *
 * NTS(taxlaw.nts.go.kr 비공개 AJAX)에서 지난 1개월간 신규 등록된 해석례·불복결정례를
 * "본문 전문까지" 조회해(fetch_all_taxlaw_full.mjs와 달리 상세 조회를 수행) Cloudflare D1에 upsert하고
 * FTS5(전문 검색 인덱스)를 재인덱싱합니다.
 *
 * 사용법:
 *   node scripts/fetch_incremental.mjs              # 최근 1개월(기본 35일, 월 단위 중복 방지 목적)
 *   node scripts/fetch_incremental.mjs --days 60    # 최근 60일
 *   node scripts/fetch_incremental.mjs --dry-run    # D1 저장 없이 목록만 확인(인증 토큰도 불필요)
 *
 * 자동화 예시 (cron):
 *   0 3 1 * *  cd /path/to/taxist && node scripts/fetch_incremental.mjs >> logs/incremental.log 2>&1
 *
 * 실행 시점 / 다른 스크립트와의 관계:
 *   - GitHub Actions 워크플로(.github/workflows/update_laws.yml)에는 등록되어 있지 않다.
 *     위 cron 예시처럼 별도 서버/로컬 환경에서 매월 1회 수동 또는 자체 cron으로 실행하는 보조 스크립트다.
 *   - fetch_all.mjs(법령/판례 → 마크다운 파일, law.go.kr 공식 API)나
 *     fetch_all_taxlaw_full.mjs(해석례 전체 백필 → 마크다운, 목록 요약만)와 호출 관계가 없는 독립 스크립트다.
 *   - 유일하게 결과를 로컬 파일이 아닌 Cloudflare D1 documents 테이블에 직접 upsert하고, 실행에는
 *     `npx wrangler login`으로 생성된 OAuth 토큰(~/.wrangler/config/default.toml)이 필요하다(--dry-run 제외).
 */

import fs    from "fs";
import path  from "path";
import https from "https";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

// ── 설정 ────────────────────────────────────────────────────────
const ACCOUNT_ID  = "143f2323446f7c53f496c331d3f6ebd2";
const DATABASE_ID = "f257e814-b8ff-4ba3-a45b-55981035b44a";
const NTS_HOST    = "taxlaw.nts.go.kr";
// 본문 전문까지 조회하는 상세 호출(action 함수)마다 1초 대기 — 목록만 가져오는 fetch_all_taxlaw_full.mjs(600ms)보다
// 더 긴 지연을 두는 이유는 상세 조회가 서버에 더 큰 부하를 주는 요청이라 더 보수적으로 접근하기 때문으로 추정된다.
const DELAY_MS    = 1000;

const DRY_RUN = process.argv.includes("--dry-run");
const daysArg = process.argv.indexOf("--days");
const DAYS    = daysArg >= 0 ? parseInt(process.argv[daysArg + 1]) : 35; // 35일 (월 중복 방지) — 매월 1회 실행 간격(약 30일)보다 며칠 더 길게 잡아 실행 간 빈 날짜가 생기지 않도록 함

// ── 세목·폴더 매핑 ───────────────────────────────────────────────
const TAX_FOLDER_MAP = [
  { codes: ["303", "307"], tax: "법인세",  folderId: 30 },
  { codes: ["302"],        tax: "소득세",  folderId: 31 },
  { codes: ["304"],        tax: "부가세",  folderId: 32 },
  { codes: ["308", "309"], tax: "재산세",  folderId: 33 },
  { codes: ["301", "315"], tax: "징세",    folderId: 34 },
];
const DOC_TYPES = [
  { code: "01", name: "사전답변",     collection: "question,question_gr" },
  { code: "02", name: "질의회신",     collection: "question,question_gr" },
  { code: "03", name: "과세기준자문", collection: "question,question_gr" },
  { code: "04", name: "고시서면질의", collection: "question,question_gr" },
  { code: "05", name: "과세적부심사", collection: "precedent,precedent_gr" },
  { code: "06", name: "이의신청",     collection: "precedent,precedent_gr" },
  { code: "07", name: "심사청구",     collection: "precedent,precedent_gr" },
  { code: "08", name: "심판청구",     collection: "precedent,precedent_gr" },
];

// ── 인증 ────────────────────────────────────────────────────────
// D1 REST API 호출에 필요한 Cloudflare 인증 토큰을 wrangler CLI가 로그인 시 저장해둔 설정 파일에서
// 직접 읽어온다 — 토큰을 코드/환경변수로 별도 관리하지 않고 `wrangler login`이 이미 만들어둔 자격증명을 재사용.
function getToken() {
  const cfgPath = path.join(process.env.USERPROFILE || process.env.HOME || "", ".wrangler", "config", "default.toml");
  const cfg = fs.readFileSync(cfgPath, "utf8");
  const m = cfg.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("`npx wrangler login` 먼저 실행하세요.");
  return m[1];
}
const TOKEN = DRY_RUN ? "" : getToken();
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

function log(msg) { console.log(`${new Date().toLocaleString("ko-KR")}  ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── D1 ──────────────────────────────────────────────────────────
// DRY_RUN이면 실제 DB를 건드리지 않고 빈 결과를 반환 — 목록 수집 로직만 점검하고 싶을 때
// 토큰 없이도(getToken 호출도 건너뜀) 안전하게 시험 실행할 수 있게 한다.
async function d1Query(sql, params = []) {
  if (DRY_RUN) return { results: [] };
  const res = await fetch(D1_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`D1: ${JSON.stringify(json.errors)}`);
  return json.result?.[0] || { results: [] };
}

// ── NTS HTTP ─────────────────────────────────────────────────────
// 세션 쿠키 jar: 이 비공개 AJAX는 유효한 세션 쿠키 없이 호출하면 정상 JSON이 아닌 안내/오류 페이지를 반환하므로
// 매 응답의 Set-Cookie를 누적해 다음 요청에 그대로 실어 보낸다(fetch_all_taxlaw_full.mjs와 동일한 패턴).
let _cookies = "";

function httpsPost(body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: NTS_HOST, port: 443, path: "/action.do", method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, */*; q=0.01",
        "Referer": `https://${NTS_HOST}/qt/USEQTA001L.do?ntstDcmClCd=02`,
        "Origin": `https://${NTS_HOST}`,
        "User-Agent": "Mozilla/5.0 Chrome/120",
        ...(_cookies ? { Cookie: _cookies } : {}),
      },
      timeout: 25000,
    };
    const req = https.request(opts, res => {
      const sc = res.headers["set-cookie"] || [];
      if (sc.length) {
        const map = Object.fromEntries((_cookies||"").split("; ").filter(Boolean).map(p=>p.split("=")));
        sc.forEach(c => { const [k,v] = c.split(";")[0].split("="); map[k]=v; });
        _cookies = Object.entries(map).map(([k,v])=>`${k}=${v}`).join("; ");
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", d => data += d);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(body);
    req.end();
  });
}

// 문서유형 목록 화면을 GET으로 방문해 세션 쿠키를 최초 발급받는다. action.do(AJAX 본 호출) 전에
// 반드시 거쳐야 하는 절차로, action() 내부에서도 응답이 비정상이면 재호출해 세션을 재발급한다.
async function ntsSession() {
  await new Promise((resolve, reject) => {
    const opts = {
      hostname: NTS_HOST, port: 443,
      path: "/qt/USEQTA001L.do?ntstDcmClCd=02", method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 Chrome/120", "Accept-Language": "ko-KR" },
      timeout: 20000,
    };
    const req = https.request(opts, res => {
      const sc = res.headers["set-cookie"] || [];
      if (sc.length) {
        const map = {};
        sc.forEach(c => { const [k,v] = c.split(";")[0].split("="); map[k]=v; });
        _cookies = Object.entries(map).map(([k,v])=>`${k}=${v}`).join("; ");
      }
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Session Timeout")); });
    req.end();
  });
}

// action.do 공통 호출 헬퍼. 최대 3회 재시도: 세션이 만료되어 JSON 대신 HTML("<!"로 시작)이 오면
// ntsSession()으로 세션을 다시 발급받고 1.5초 대기 후 재시도하며, 그 외 네트워크 예외는 2초 대기 후 재시도한다.
// 매 호출 시작 시 DELAY_MS(1초) sleep을 둬 비공개 엔드포인트에 과도하게 빠른 연속 요청을 보내지 않도록 한다.
async function action(actionId, paramData) {
  await sleep(DELAY_MS);
  const body = new URLSearchParams({ actionId, paramData: JSON.stringify(paramData) }).toString();
  for (let i = 0; i < 3; i++) {
    try {
      const text = await httpsPost(body);
      if (!text || text.trimStart().startsWith("<!")) {
        await ntsSession(); await sleep(1500); continue;
      }
      const json = JSON.parse(text);
      return json.status === "SUCCESS" ? (json.data || json) : null;
    } catch (e) {
      if (i < 2) await sleep(2000);
    }
  }
  return null;
}

// 응답 필드에 섞인 단순 HTML 마크업(<br>, &nbsp; 등)을 정규식으로 제거 — 본문이 짧은 인라인 태그 위주라
// 별도 HTML 파서 없이 가벼운 치환으로 충분하다(fetch_all_taxlaw_full.mjs와 동일한 처리 방식).
function stripHtml(s) {
  return (s||"").replace(/<br\s*\/?>/gi,"\n").replace(/<[^>]+>/g,"")
    .replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
}

// 상세 조회 응답(dvo)을 D1 documents.content에 저장할 마크다운 본문으로 변환.
// 질의요지(gist)·회신(answer)이 모두 없으면 의미 있는 내용이 아니라고 보고 null을 반환해 호출부에서 스킵하게 한다.
function buildContent(dvo) {
  const title  = stripHtml(dvo.ntstDcmTtl||"");
  const docNo  = stripHtml(dvo.ntstDcmDscmCntn||"");
  const date   = (dvo.ntstDcmRgtDt||"").replace(/(\d{4})(\d{2})(\d{2}).*/,"$1-$2-$3");
  const tax    = stripHtml(dvo.ntstTlawClNm||"");
  const gist   = stripHtml(dvo.ntstDcmGistCntn||"");
  const answer = stripHtml(dvo.ntstDcmCntn||"");
  const kw     = stripHtml(dvo.ntstDcmMatrCntn||"");
  if (!gist && !answer) return null;

  return [
    `# ${title||"해석례"}`, "",
    "| 항목 | 내용 |", "|---|---|",
    ...(docNo  ? [`| 문서번호 | ${docNo} |`]         : []),
    ...(date   ? [`| 등록일   | ${date} |`]           : []),
    ...(tax    ? [`| 세목     | ${tax} |`]            : []),
    ...(kw     ? [`| 키워드   | ${kw.slice(0,200)} |`]: []),
    "",
    ...(gist   ? ["## 질의요지", "", gist, ""] : []),
    ...(answer ? ["## 회신",     "", answer, ""] : []),
  ].join("\n");
}

// ── 날짜 범위 계산 ───────────────────────────────────────────────
// "오늘 - days일" ~ "오늘"을 YYYYMMDD 형식으로 변환 — NTS API의 bltnStrtDt/bltnEndDt 파라미터 형식에 맞춤
function getDateRange(days) {
  const end   = new Date();
  const start = new Date(Date.now() - days * 86400000);
  const fmt   = d => d.toISOString().slice(0,10).replace(/-/g,"");
  return { startDt: fmt(start), endDt: fmt(end) };
}

// ── 신규 문서 수집 ───────────────────────────────────────────────
// 세목(TAX_FOLDER_MAP) × 문서유형(DOC_TYPES) 조합마다 목록 API를 페이지네이션(viewCount=20)으로 끝까지 순회한다.
// fetch_all_taxlaw_full.mjs가 연도 단위로 쪼개 2,500건 한계를 우회하는 것과 달리, 여기서는 수집 기간이
// 최근 35일로 짧아 한 세목×문서유형 조합의 건수가 한계에 걸릴 일이 거의 없으므로 연도 분할이 필요 없다.
async function collectNewDocs(days) {
  const { startDt, endDt } = getDateRange(days);
  log(`수집 기간: ${startDt} ~ ${endDt} (최근 ${days}일)`);

  const allDocs = [];

  for (const taxInfo of TAX_FOLDER_MAP) {
    for (const docType of DOC_TYPES) {
      let offset = 1, total = null;

      while (total === null || offset <= total) {
        const data = await action("ASIPDI002PR01", {
          startCount: offset, viewCount: 20,
          schDtBase: "DCM_RGT_DTM",
          bltnStrtDt: startDt, bltnEndDt: endDt,
          collectionName: docType.collection,
          dcmClCdCtl: [`001_${docType.code}`],
          exclVcbCtl: [], icldVcbCtl: [],
          ntstTlawClCdList: taxInfo.codes,
          sortField: "DCM_RGT_DTM/DESC",
        });

        if (!data) break;
        const inner = data[`ASIPDI002PR01`] || data;
        const items = inner?.body || [];

        if (total === null) {
          const catList = inner?.top?.[0]?.categoryMap?.SUB_ID_CATEGORY || [];
          total = parseInt(catList.find(c => c.name === `001_${docType.code}`)?.count || "0");
          if (total > 0) log(`  ${taxInfo.tax} / ${docType.name}: ${total}건`);
        }

        for (const item of items) {
          const ntsId = item?.dcm?.DOC_ID || item?.dcm?.NTST_DCM_ID;
          const title = stripHtml(item?.dcm?.DCM_NM || item?.dcm?.NTST_DCM_TTL || "");
          if (ntsId && title) {
            allDocs.push({ ntsId, title, tax: taxInfo.tax, folderId: taxInfo.folderId, type: docType.name });
          }
        }

        offset += items.length;
        if (!items.length) break;
      }
    }
  }

  log(`신규 문서 총 ${allDocs.length}건 수집`);
  return allDocs;
}

// ── D1 upsert ───────────────────────────────────────────────────
// nts_doc_id(NTS 원본 문서 ID)를 고유 키로 사용해 이미 수집된 문서면 UPDATE, 아니면 INSERT —
// 같은 기간을 여러 번 실행해도(DAYS를 35일로 여유 있게 잡아 겹치는 기간이 생김) 중복 레코드가 쌓이지 않도록 한다.
async function upsertDoc(doc, content) {
  // nts_doc_id로 기존 문서 확인
  const existing = await d1Query(
    "SELECT id FROM documents WHERE nts_doc_id = ?", [doc.ntsId]
  );

  if (existing.results?.length) {
    // 기존 문서 업데이트
    await d1Query(
      "UPDATE documents SET content=?, is_summary=0, updated_at=CURRENT_TIMESTAMP WHERE nts_doc_id=?",
      [content, doc.ntsId]
    );
    return "updated";
  } else {
    // 신규 삽입
    await d1Query(
      `INSERT INTO documents (folder_id, name, content, tax_category, is_active, nts_doc_id, is_summary, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 0, CURRENT_TIMESTAMP)`,
      [doc.folderId, `[${doc.type}] ${doc.title.slice(0,120)}`, content, doc.tax, doc.ntsId]
    );
    return "inserted";
  }
}

// ── FTS5 재인덱싱 ────────────────────────────────────────────────
// documents 테이블이 변경된 뒤 FTS5 가상 테이블의 'rebuild' 명령으로 전문 검색 인덱스를 갱신.
// wrangler CLI를 별도 프로세스로 호출하는 이유는 D1의 FTS5 rebuild가 일반 REST query API 호출(d1Query)이 아니라
// wrangler가 제공하는 d1 execute 경로를 통해 안정적으로 수행되기 때문으로 보인다.
function rebuildFts() {
  try {
    execSync(
      `npx wrangler d1 execute taxist-db --remote --command "INSERT INTO documents_fts(documents_fts) VALUES('rebuild')"`,
      { stdio: "inherit", cwd: BASE_DIR }
    );
    log("FTS5 재인덱싱 완료");
  } catch (e) {
    log(`FTS5 재인덱싱 실패: ${e.message}`);
  }
}

// ── 메인 ────────────────────────────────────────────────────────
async function main() {
  const now = new Date().toLocaleString("ko-KR");
  log("========================================");
  log(`TAXIST 월간 증분 수집 시작 (${now})`);
  log(`기간: 최근 ${DAYS}일 | DRY_RUN: ${DRY_RUN}`);
  log("========================================");

  await ntsSession();

  const docs = await collectNewDocs(DAYS);
  if (!docs.length) { log("신규 문서 없음. 종료."); return; }

  let inserted = 0, updated = 0, fail = 0;

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    try {
      // 상세 전문 조회 — 목록 단계에서는 제목만 알 수 있으므로, 문서 ID로 본문(질의요지/회신)을 추가 조회한다.
      // ASIQTB002PR01: 문서 상세 조회 액션ID(목록 조회의 ASIPDI002PR01과 별개)
      const detailData = await action("ASIQTB002PR01", { dcmDVO: { ntstDcmId: doc.ntsId } });
      if (!detailData) { fail++; continue; }
      const dvo = (detailData["ASIQTB002PR01"] || detailData)?.dcmDVO;
      if (!dvo) { fail++; continue; }
      const content = buildContent(dvo);
      if (!content) { fail++; continue; }

      const result = await upsertDoc(doc, content);
      if (result === "inserted") inserted++;
      else updated++;

      if ((i+1) % 20 === 0) log(`  진행: ${i+1}/${docs.length} (신규 ${inserted}, 갱신 ${updated}, 실패 ${fail})`);
    } catch (e) {
      fail++;
      log(`  오류 [${doc.ntsId}]: ${e.message}`);
    }
  }

  log(`\n[결과] 신규: ${inserted}건, 갱신: ${updated}건, 실패: ${fail}건`);

  if (!DRY_RUN && (inserted + updated) > 0) {
    log("FTS5 재인덱싱 중...");
    rebuildFts();
  }

  // 업데이트 로그 기록
  if (!DRY_RUN) {
    const logEntry = `\n## ${new Date().toLocaleDateString("ko-KR")} 월간 증분 수집\n\n- 신규: ${inserted}건\n- 갱신: ${updated}건\n- 실패: ${fail}건\n- 수집 기간: 최근 ${DAYS}일\n`;
    fs.appendFileSync(path.join(BASE_DIR, "update_log.md"), logEntry);
  }

  log("완료.");
}

main().catch(e => { log(`치명적 오류: ${e.message}`); process.exit(1); });
