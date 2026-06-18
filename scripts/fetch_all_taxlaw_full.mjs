/**
 * taxlaw.nts.go.kr (국세법령정보시스템) 전체 데이터 수집 (고속판)
 *
 * 목적: 비공개 AJAX 엔드포인트(action.do)를 호출해 세법해석례·심판결정례 등을
 *   "목록 요약"(제목/요지/등록일/세목) 단위로 대량 백필(backfill)하여 해석례자료/ 에 마크다운으로 저장한다.
 *   fetch_incremental.mjs가 다루는 "본문 전문 + D1 upsert"와 달리, 이 스크립트는 상세 조회를 하지 않고
 *   목록 API만 반복 호출하므로 훨씬 빠르게(주석상 50배) 전체 분량을 받을 수 있다.
 *
 * 전략:
 *  - 상세 조회 없음 (목록 요약만 수집) → 50배 빠름
 *  - 세목코드(14개) × 연도(2010~2026) 분할로 2,500건 API 한계 우회
 *    (이 비공개 API는 한 조건당 약 2,500건까지만 반환하는 것으로 추정되어, 세목×연도로 잘게 쪼개
 *     각 조각이 2,500건을 넘지 않도록 분할 수집한다)
 *  - 체크포인트 기반 이어받기 (대량 수집이라 중간에 끊겨도 처음부터 다시 받지 않도록 진행 상태를 파일로 보존)
 *  - ECONNRESET 시 최대 5초 대기 후 재시도 (기존 최대 12초)
 *
 * 사용법:
 *   node scripts/fetch_all_taxlaw_full.mjs          # 새로 시작 (체크포인트 무시)
 *   node scripts/fetch_all_taxlaw_full.mjs --resume  # 이어받기 (taxlaw_checkpoint.json 기준으로 중단 지점부터 재개)
 *
 * 실행 시점 / 다른 스크립트와의 관계:
 *   - GitHub Actions 워크플로(.github/workflows/update_laws.yml)에는 등록되어 있지 않다.
 *     즉 자동 스케줄 실행 대상이 아니며, 최초 대량 백필이나 데이터 누락 복구가 필요할 때
 *     사람이 로컬/서버에서 수동으로 실행하는 보조 스크립트다.
 *   - fetch_all.mjs(법령/판례, law.go.kr 공식 API)나 fetch_incremental.mjs(월간 증분, D1 upsert)와
 *     서로 호출 관계가 없는 완전히 독립된 스크립트이며, 결과물도 D1이 아닌 로컬 마크다운 파일(해석례자료/)로만 저장된다.
 */

import fs   from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");
const OUT_DIR   = path.join(BASE_DIR, "해석례자료");
const CKPT_FILE = path.join(BASE_DIR, "taxlaw_checkpoint.json");
const MANIFEST  = path.join(BASE_DIR, "law_manifest.json");
const NTS_HOST  = "taxlaw.nts.go.kr";
const RESUME    = process.argv.includes("--resume");

const ITEMS_PER_FILE = 300; // 마크다운 파일 1개당 최대 300건 — 파일이 너무 커지지 않도록 적당한 크기로 분할 저장
const PAGE_SIZE      = 50;  // 목록 API 1회 호출당 50건 요청(요청 수와 서버 부담의 균형점으로 추정)
const DELAY_PAGE     = 600;  // ms between pages (no detail fetches needed)
// 상세 조회가 없어 호출이 빠른 만큼, 페이지마다 600ms를 두어 비공개 엔드포인트에 과도한 연속 요청을 보내지 않도록 함

// ── 세목 코드 (300계열) ──────────────────────────────────────
const TAX_CODES = [
  { code: "303", name: "법인세" },
  { code: "305", name: "종합소득세" },
  { code: "306", name: "부가가치세" },
  { code: "307", name: "양도소득세" },
  { code: "308", name: "상속증여세" },
  { code: "309", name: "조세특례" },
  { code: "310", name: "국제조세" },
  { code: "311", name: "종합부동산세" },
  { code: "312", name: "원천세" },
  { code: "313", name: "소비세" },
  { code: "101", name: "국세기본법" },
  { code: "102", name: "국세징수법" },
  { code: "999", name: "기타" },
];

// ── 수집 연도 (2010~2026) ────────────────────────────────────
const YEARS = [];
for (let y = 2010; y <= 2026; y++) YEARS.push(y);

// ── 문서 유형 ────────────────────────────────────────────────
const DOC_TYPES = [
  { code: "02", name: "질의회신",     coll: "question,question_gr" },
  { code: "01", name: "사전답변",     coll: "question,question_gr" },
  { code: "03", name: "과세기준자문", coll: "question,question_gr" },
  { code: "05", name: "과세적부심사", coll: "precedent,precedent_gr" },
  { code: "06", name: "이의신청",     coll: "precedent,precedent_gr" },
  { code: "07", name: "심사청구",     coll: "precedent,precedent_gr" },
  { code: "08", name: "심판청구",     coll: "precedent,precedent_gr" },
];

// ── 유틸 ────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
function mkdirp(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log(msg)  { process.stdout.write(`${new Date().toLocaleTimeString("ko-KR")}  ${msg}\n`); }
// AJAX 응답 필드(GIST_CNTN 등)에는 <br>, &nbsp; 같은 단순 HTML 마크업이 섞여 있어 정규식으로 충분히 정리 가능.
// 별도 HTML 파서 라이브러리를 추가하는 비용 대신 가벼운 정규식 치환으로 처리한다.
function stripHtml(s) {
  return (s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

// ── HTTP ─────────────────────────────────────────────────────
// maxSockets: 1 — 동시 연결을 1개로 제한해 비공개 엔드포인트에 병렬 요청을 보내지 않도록 함(차단 회피).
// keepAlive로 TCP 연결을 재사용해 매 요청마다 핸드셰이크 비용이 드는 것을 줄인다.
const agent = new https.Agent({ keepAlive: true, maxSockets: 1, timeout: 25000 });
// 이 비공개 AJAX는 세션 쿠키가 있어야 정상 JSON을 응답하므로(없으면 로그인/에러 페이지 HTML이 내려옴),
// 응답의 Set-Cookie를 모아 다음 요청에 그대로 실어 보내는 간단한 쿠키 jar 역할을 한다.
let _cookies = "";

function request(opts, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      ...opts, hostname: NTS_HOST, port: 443, agent,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Connection": "keep-alive",
        ...(opts.headers || {}),
        ...(_cookies ? { Cookie: _cookies } : {}),
      },
    }, res => {
      const cks = res.headers["set-cookie"] || [];
      if (cks.length) {
        const map = Object.fromEntries((_cookies || "").split("; ").filter(Boolean).map(p => p.split("=")));
        cks.forEach(c => { const [k, v] = c.split(";")[0].split("="); if (k) map[k] = v || ""; });
        _cookies = Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
      }
      let data = ""; res.setEncoding("utf8");
      res.on("data", d => data += d);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(25000, () => req.destroy(new Error("Timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// 문서유형 화면(USEQTA001L.do)을 GET으로 한 번 방문해 세션 쿠키를 발급/갱신한다.
// action.do 호출 전에는 항상 이 화면을 거쳐야 정상적인 세션으로 인식되는 것으로 보인다.
async function initSession(code = "02") {
  try {
    await request({ method: "GET", path: `/qt/USEQTA001L.do?ntstDcmClCd=${code}` });
  } catch (e) { /* ignore */ }
}

// action.do(비공개 AJAX 게이트웨이) 공통 POST 헬퍼. Referer/Origin/X-Requested-With를 실제 브라우저처럼
// 채우는 이유는 이 값들이 없으면 서버가 비정상 요청으로 간주해 거부하기 때문으로 추정된다.
// 최대 4회 재시도: 세션 만료로 응답이 JSON이 아닌 HTML(로그인/에러 페이지, "<!"로 시작)로 오는 경우가 흔해
// 매 실패마다 initSession()으로 세션을 다시 발급받고, 재시도 횟수에 비례해 대기시간을 늘려가며(최대 5초) 서버 부담을 줄인다.
async function actionPost(actionId, paramData, referer) {
  const bodyStr = new URLSearchParams({ actionId, paramData: JSON.stringify(paramData) }).toString();
  for (let i = 0; i < 4; i++) {
    try {
      const res = await request({
        method: "POST", path: "/action.do",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(bodyStr),
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "Referer": `https://${NTS_HOST}${referer}`,
          "Origin": `https://${NTS_HOST}`,
        },
      }, bodyStr);

      // "<!"로 시작하면 JSON이 아니라 HTML(세션 만료/오류 페이지)이 온 것 — 세션을 새로 받고 재시도
      if (!res.body || res.body.trimStart().startsWith("<!")) {
        await initSession(); await sleep(2000 * (i + 1));
        continue;
      }
      const json = JSON.parse(res.body);
      if (json.status === "SUCCESS") return json.data || json;
      return null;
    } catch (e) {
      // ECONNRESET 등 네트워크 오류 — 세션 재발급 후 최대 5초까지 점증 대기하며 재시도(파일 헤더 주석 참고)
      await initSession(); await sleep(Math.min(3000 * (i + 1), 5000));
    }
  }
  return null;
}

// ── 목록 페이지 조회 ─────────────────────────────────────────
// ASIPDI002PR01: 문서 목록 검색 액션ID. 세목코드(taxCode)·기간(startDt~endDt)·문서유형(docType)으로
// 조건을 좁혀 보내야 한 번에 2,500건 한계를 넘지 않게 분할 수집할 수 있다(collectChunk에서 세목×연도로 호출).
async function fetchPage(docType, taxCode, startDt, endDt, startCount) {
  await sleep(DELAY_PAGE);
  const data = await actionPost("ASIPDI002PR01", {
    startCount, viewCount: PAGE_SIZE,
    schDtBase: "DCM_RGT_DTM",
    bltnStrtDt: startDt,
    bltnEndDt:  endDt,
    collectionName: docType.coll,
    dcmClCdCtl: [`001_${docType.code}`],
    exclVcbCtl: [], icldVcbCtl: [],
    ntstTlawClCdList: taxCode ? [taxCode] : [],
    sortField: "DCM_RGT_DTM/DESC",
  }, `/qt/USEQTA001L.do?ntstDcmClCd=${docType.code}`);

  if (!data) return { items: [], total: 0 };
  const inner = data["ASIPDI002PR01"] || data;
  const items = inner?.body || [];
  const cats  = inner?.top?.[0]?.categoryMap?.SUB_ID_CATEGORY || [];
  const total = parseInt(cats.find(c => c.name === `001_${docType.code}`)?.count || "0");
  return { items, total };
}

// ── 목록 항목 정규화 (요약) ───────────────────────────────────
// 상세 조회 없이 목록 응답에 포함된 필드(제목/요지/등록일/세목)만으로 요약 레코드를 구성한다.
// 이것이 fetch_incremental.mjs의 본문 전문 수집과 달리 "고속판"이 될 수 있는 이유다.
function normalize(raw, typeName, taxName) {
  const dcm = raw?.dcm || {};
  return {
    id:    dcm.DOC_ID || dcm.NTST_DCM_ID || "",
    title: stripHtml(dcm.DCM_NM || dcm.NTST_DCM_TTL || ""),
    gist:  stripHtml(dcm.GIST_CNTN || ""),
    date:  (dcm.NTST_DCM_RGT_DT || "").replace(/(\d{4})(\d{2})(\d{2}).*/, "$1-$2-$3"),
    tax:   stripHtml(dcm.NTST_TLAW_CL_NM || "") || taxName,
    type:  typeName,
  };
}

// ── MD 변환 ─────────────────────────────────────────────────
function toMd(list, title) {
  const lines = [
    `# ${title}`, "",
    `> **수록 건수:** ${list.length}건`,
    `> **수집일자:** ${new Date().toISOString().slice(0, 10)}`,
    `> **출처:** [국세법령정보시스템](https://taxlaw.nts.go.kr)`,
    "", "---", "",
  ];
  list.forEach((p, i) => {
    lines.push(`## ${i + 1}. ${p.title || `항목 ${i + 1}`}`, "");
    lines.push("| 항목 | 내용 |", "|---|---|");
    if (p.id)   lines.push(`| NTS_ID | ${p.id} |`);
    if (p.date) lines.push(`| 등록일 | ${p.date} |`);
    if (p.tax)  lines.push(`| 세목   | ${p.tax} |`);
    if (p.type) lines.push(`| 유형   | ${p.type} |`);
    lines.push("");
    if (p.gist) lines.push("**[요지]**", "", p.gist.slice(0, 500), "");
    lines.push("---", "");
  });
  return lines.join("\n");
}

// ── 체크포인트 ───────────────────────────────────────────────
// 전체 작업 단위는 문서유형(7) × 세목(13) × 연도(17) = 1,547개 청크에 달해 한 번에 끝내지 못하고
// 중간에 끊길 가능성이 높다. 청크별 진행 상태(다음 페이지, 저장 건수, 파일 인덱스, 완료 여부)를
// taxlaw_checkpoint.json에 기록해 --resume 시 처음부터가 아니라 중단된 페이지부터 재개할 수 있게 한다.
function loadCkpt() {
  try { return JSON.parse(fs.readFileSync(CKPT_FILE, "utf8")); }
  catch { return {}; }
}
function saveCkpt(data) {
  fs.writeFileSync(CKPT_FILE, JSON.stringify(data, null, 2));
}

// ── 단위 수집: 타입 × 세목 × 연도 ───────────────────────────
// 문서유형 × 세목코드 × 연도 조합 하나가 "청크" 단위. 이 비공개 API가 한 조건당 최대 약 2,500건만
// 반환하는 것으로 추정되므로, 연도 단위까지 잘게 쪼개 어떤 청크도 그 한계에 걸리지 않게 한다.
async function collectChunk(docType, tc, year, ckpt) {
  const key = `${docType.code}_${tc.code}_${year}`;
  if (ckpt[key]?.done) return 0; // 이미 완료된 청크는 --resume 시 재수집하지 않고 즉시 스킵

  const startDt = `${year}0101`;
  const endDt   = `${year}1231`;

  const { items: first, total } = await fetchPage(docType, tc.code, startDt, endDt, 1);
  if (total === 0) { ckpt[key] = { done: true, saved: 0 }; return 0; }

  const startPage = ckpt[key]?.nextPage || 1;
  let saved   = ckpt[key]?.saved || 0;
  let fileIdx = ckpt[key]?.fileIdx || 1;
  let batch   = [];
  // 페이지 경계에서 동일 문서가 중복 반환되는 경우를 막기 위한 문서ID 중복 제거 집합
  const seen  = new Set();

  const maxPages = Math.min(Math.ceil(total / PAGE_SIZE), 50); // 최대 2,500건/청크

  for (let page = startPage; page <= maxPages; page++) {
    const { items } = page === 1
      ? { items: first }
      : await fetchPage(docType, tc.code, startDt, endDt, (page - 1) * PAGE_SIZE + 1);
    if (!items.length) break;

    for (const raw of items) {
      const id = raw?.dcm?.DOC_ID || raw?.dcm?.NTST_DCM_ID || "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      batch.push(normalize(raw, docType.name, tc.name));
      saved++;

      if (batch.length >= ITEMS_PER_FILE) {
        // 파일명 규칙: {문서유형}_{세목}_{연도}_{3자리 일련번호}.md — 청크 내에서도 ITEMS_PER_FILE(300)
        // 단위로 잘라 저장해 파일 하나가 지나치게 커지는 것을 방지
        const fname = `${docType.name}_${tc.name}_${year}_${String(fileIdx).padStart(3, "0")}.md`;
        fs.writeFileSync(path.join(OUT_DIR, fname), toMd(batch, `${docType.name} ${tc.name} ${year}`), "utf8");
        batch = []; fileIdx++;
      }
    }

    // 페이지 처리마다 체크포인트 저장 — 수천 개 청크를 도는 장시간 작업이므로 중단 시점까지의
    // 진행을 잃지 않도록 자주 기록한다(원자적 저장은 아니지만 손실 범위를 한 페이지로 제한).
    ckpt[key] = { nextPage: page + 1, saved, fileIdx };
    saveCkpt(ckpt);
  }

  if (batch.length) {
    const fname = `${docType.name}_${tc.name}_${year}_${String(fileIdx).padStart(3, "0")}.md`;
    fs.writeFileSync(path.join(OUT_DIR, fname), toMd(batch, `${docType.name} ${tc.name} ${year}`), "utf8");
  }

  ckpt[key] = { done: true, saved, fileIdx };
  saveCkpt(ckpt);
  return saved;
}

// ── 메인 ────────────────────────────────────────────────────
async function main() {
  log("══════════════════════════════════════════════");
  log("taxlaw.nts.go.kr 전체 수집 (목록 요약, 고속판)");
  log(`모드: ${RESUME ? "이어받기" : "새로 시작"}`);
  log("══════════════════════════════════════════════");

  mkdirp(OUT_DIR);
  const ckpt = RESUME ? loadCkpt() : {};
  const manifest = (() => {
    try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); }
    catch { return {}; }
  })();

  await initSession("02");

  let grandTotal = 0;
  let lastLog    = Date.now();

  for (const dt of DOC_TYPES) {
    log(`\n[${dt.name}] 시작`);
    await initSession(dt.code);
    let typeTotal = 0;

    for (const tc of TAX_CODES) {
      for (const year of YEARS) {
        const n = await collectChunk(dt, tc, year, ckpt);
        if (n > 0) {
          typeTotal  += n;
          grandTotal += n;
          // 50건 이상 수집됐거나 30초마다 진행 로그
          if (n >= 50 || Date.now() - lastLog > 30000) {
            log(`  ${dt.name}/${tc.name}/${year}: +${n}건 → 누계 ${grandTotal.toLocaleString()}건`);
            lastLog = Date.now();
          }
        }
      }
    }

    log(`[${dt.name}] 완료: ${typeTotal.toLocaleString()}건`);
    manifest[`collect_${dt.code}`] = { name: dt.name, total: typeTotal, date: new Date().toISOString().slice(0, 10) };
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  }

  log("\n══════════════════════════════════════════════");
  log(`전체 완료: ${grandTotal.toLocaleString()}건`);
  log(`저장 위치: ${OUT_DIR}`);
  log("이어받기: node scripts/fetch_all_taxlaw_full.mjs --resume");
}

main().catch(e => { console.error(e); process.exit(1); });
