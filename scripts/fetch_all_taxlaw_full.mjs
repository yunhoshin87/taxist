/**
 * taxlaw.nts.go.kr 전체 데이터 수집 (고속판)
 *
 * 전략:
 *  - 상세 조회 없음 (목록 요약만 수집) → 50배 빠름
 *  - 세목코드(14개) × 연도(2010~2026) 분할로 2,500건 API 한계 우회
 *  - 체크포인트 기반 이어받기
 *  - ECONNRESET 시 최대 5초 대기 후 재시도 (기존 최대 12초)
 *
 * 사용법:
 *   node scripts/fetch_all_taxlaw_full.mjs          # 새로 시작
 *   node scripts/fetch_all_taxlaw_full.mjs --resume  # 이어받기
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

const ITEMS_PER_FILE = 300;
const PAGE_SIZE      = 50;
const DELAY_PAGE     = 600;  // ms between pages (no detail fetches needed)

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
function stripHtml(s) {
  return (s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

// ── HTTP ─────────────────────────────────────────────────────
const agent = new https.Agent({ keepAlive: true, maxSockets: 1, timeout: 25000 });
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

async function initSession(code = "02") {
  try {
    await request({ method: "GET", path: `/qt/USEQTA001L.do?ntstDcmClCd=${code}` });
  } catch (e) { /* ignore */ }
}

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

      if (!res.body || res.body.trimStart().startsWith("<!")) {
        await initSession(); await sleep(2000 * (i + 1));
        continue;
      }
      const json = JSON.parse(res.body);
      if (json.status === "SUCCESS") return json.data || json;
      return null;
    } catch (e) {
      await initSession(); await sleep(Math.min(3000 * (i + 1), 5000));
    }
  }
  return null;
}

// ── 목록 페이지 조회 ─────────────────────────────────────────
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
function loadCkpt() {
  try { return JSON.parse(fs.readFileSync(CKPT_FILE, "utf8")); }
  catch { return {}; }
}
function saveCkpt(data) {
  fs.writeFileSync(CKPT_FILE, JSON.stringify(data, null, 2));
}

// ── 단위 수집: 타입 × 세목 × 연도 ───────────────────────────
async function collectChunk(docType, tc, year, ckpt) {
  const key = `${docType.code}_${tc.code}_${year}`;
  if (ckpt[key]?.done) return 0;

  const startDt = `${year}0101`;
  const endDt   = `${year}1231`;

  const { items: first, total } = await fetchPage(docType, tc.code, startDt, endDt, 1);
  if (total === 0) { ckpt[key] = { done: true, saved: 0 }; return 0; }

  const startPage = ckpt[key]?.nextPage || 1;
  let saved   = ckpt[key]?.saved || 0;
  let fileIdx = ckpt[key]?.fileIdx || 1;
  let batch   = [];
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
        const fname = `${docType.name}_${tc.name}_${year}_${String(fileIdx).padStart(3, "0")}.md`;
        fs.writeFileSync(path.join(OUT_DIR, fname), toMd(batch, `${docType.name} ${tc.name} ${year}`), "utf8");
        batch = []; fileIdx++;
      }
    }

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
