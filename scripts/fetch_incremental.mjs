/**
 * TAXIST 월간 증분 수집 스크립트
 *
 * NTS에서 지난 1개월간 신규 등록된 해석례·불복결정례를 수집해
 * D1에 upsert하고 FTS5를 재인덱싱합니다.
 *
 * 사용법:
 *   node scripts/fetch_incremental.mjs              # 최근 1개월
 *   node scripts/fetch_incremental.mjs --days 60    # 최근 60일
 *   node scripts/fetch_incremental.mjs --dry-run    # DB 저장 없이 목록만 확인
 *
 * 자동화 예시 (cron):
 *   0 3 1 * *  cd /path/to/taxist && node scripts/fetch_incremental.mjs >> logs/incremental.log 2>&1
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
const DELAY_MS    = 1000;

const DRY_RUN = process.argv.includes("--dry-run");
const daysArg = process.argv.indexOf("--days");
const DAYS    = daysArg >= 0 ? parseInt(process.argv[daysArg + 1]) : 35; // 35일 (월 중복 방지)

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

function stripHtml(s) {
  return (s||"").replace(/<br\s*\/?>/gi,"\n").replace(/<[^>]+>/g,"")
    .replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
}

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
function getDateRange(days) {
  const end   = new Date();
  const start = new Date(Date.now() - days * 86400000);
  const fmt   = d => d.toISOString().slice(0,10).replace(/-/g,"");
  return { startDt: fmt(start), endDt: fmt(end) };
}

// ── 신규 문서 수집 ───────────────────────────────────────────────
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
      // 상세 전문 조회
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
