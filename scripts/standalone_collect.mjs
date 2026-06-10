/**
 * [다른 AI / 다른 PC 전용] NTS 해석례 전문 수집 — 독립 실행 (D1·토큰 불필요)
 *
 * 입력:  scripts/pending_docs.jsonl   (소유자가 전달해 줌. 각 줄 {id,name,nts_doc_id,tax_category})
 * 출력:  scripts/collected.jsonl      (각 줄 {id, content, nts_doc_id})
 * 체크포인트: scripts/collect_checkpoint.json  (중단 후 재실행하면 이어서 진행)
 *
 * 하는 일:
 *   - nts_doc_id 있는 문서 → NTS API로 전문 직접 조회
 *   - nts_doc_id 없는 문서 → 제목 키워드로 NTS 검색 → ID 확보 → 전문 조회
 *   - 수집한 전문을 Markdown으로 정리해 collected.jsonl 에 한 줄씩 append
 *
 * 사용법:
 *   node scripts/standalone_collect.mjs              # 전체
 *   node scripts/standalone_collect.mjs --has-id     # nts_doc_id 있는 것만 (빠름, 먼저 권장)
 *   node scripts/standalone_collect.mjs --no-id      # nts_doc_id 없는 것만 (느림, 제목검색)
 *   node scripts/standalone_collect.mjs --limit 500  # 테스트로 500건만
 *
 * 요구사항: Node.js 18+ (내장 https/fetch 사용, 외부 패키지 없음)
 * 네트워크: https://taxlaw.nts.go.kr 접근 가능해야 함 (국세청 공개 사이트, 인증 불필요)
 */
import fs   from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

const IN_FILE     = path.join(BASE_DIR, "scripts", "pending_docs.jsonl");
const OUT_FILE    = path.join(BASE_DIR, "scripts", "collected.jsonl");
const CHECKPOINT  = path.join(BASE_DIR, "scripts", "collect_checkpoint.json");

const NTS_HOST   = "taxlaw.nts.go.kr";
const DELAY_MS   = 1000;   // 요청 간 딜레이(ms). NTS 부하 줄이려면 늘려도 됨
const ARG        = process.argv;
const ONLY_HASID = ARG.includes("--has-id");
const ONLY_NOID  = ARG.includes("--no-id");
const LIMIT      = ARG.includes("--limit") ? Number(ARG[ARG.indexOf("--limit") + 1]) : Infinity;

// ── 입력/체크포인트 로드 ────────────────────────────────────────
function loadDocs() {
  if (!fs.existsSync(IN_FILE)) {
    console.error(`입력 파일 없음: ${IN_FILE}\n소유자에게 pending_docs.jsonl 을 받아 scripts/ 에 두세요.`);
    process.exit(1);
  }
  return fs.readFileSync(IN_FILE, "utf8").trim().split("\n")
    .filter(Boolean).map(l => JSON.parse(l));
}
function loadDone() {
  try { return new Set(JSON.parse(fs.readFileSync(CHECKPOINT, "utf8")).done_ids); }
  catch { return new Set(); }
}
function saveDone(set) {
  fs.writeFileSync(CHECKPOINT, JSON.stringify({ done_ids: [...set] }, null, 0));
}

const outStream = fs.createWriteStream(OUT_FILE, { flags: "a" });
function emit(rec) { outStream.write(JSON.stringify(rec) + "\n"); }

// ── NTS HTTP ────────────────────────────────────────────────────
let _cookies = "";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpsRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120",
      "Accept-Language": "ko-KR,ko;q=0.9",
      "Connection": "keep-alive",
      ...(_cookies ? { Cookie: _cookies } : {}),
    };
    if (method === "POST" && body) {
      headers["Content-Type"]     = "application/x-www-form-urlencoded";
      headers["Content-Length"]   = Buffer.byteLength(body);
      headers["X-Requested-With"] = "XMLHttpRequest";
      headers["Accept"]           = "application/json, */*; q=0.01";
      headers["Origin"]           = `https://${NTS_HOST}`;
      headers["Referer"]          = `https://${NTS_HOST}/qt/USEQTA001L.do?ntstDcmClCd=02`;
    }
    const opts = { hostname: NTS_HOST, port: 443, path: urlPath, method, headers, timeout: 25000 };
    const req = https.request(opts, res => {
      const setCookies = res.headers["set-cookie"] || [];
      if (setCookies.length) {
        const map = Object.fromEntries((_cookies || "").split("; ").filter(Boolean).map(p => p.split("=")));
        for (const c of setCookies) { const [k, v] = c.split(";")[0].split("="); map[k] = v; }
        _cookies = Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", d => data += d);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("NTS 요청 타임아웃")); });
    if (body) req.write(body);
    req.end();
  });
}

async function ntsSession() {
  try { await httpsRequest("GET", "/qt/USEQTA001L.do?ntstDcmClCd=02"); }
  catch (e) { console.log(`세션 초기화 실패(무시): ${e.message}`); }
}

async function ntsAction(actionId, paramData) {
  await sleep(DELAY_MS);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const body = new URLSearchParams({ actionId, paramData: JSON.stringify(paramData) }).toString();
      const res  = await httpsRequest("POST", "/action.do", body);
      if (!res.body || res.body.trimStart().startsWith("<!")) {
        await ntsSession(); await sleep(1500); continue;
      }
      const json = JSON.parse(res.body);
      if (json.status === "SUCCESS") return json.data || json;
      return null;
    } catch { if (attempt < 2) await sleep(2000); }
  }
  return null;
}

// ── 전문 → Markdown ─────────────────────────────────────────────
function stripHtml(s) {
  return (s || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\r\n/g, "\n").trim();
}
function buildFullContent(dvo) {
  const title   = stripHtml(dvo.ntstDcmTtl || "");
  const docNo   = stripHtml(dvo.ntstDcmDscmCntn || "");
  const date    = (dvo.ntstDcmRgtDt || "").replace(/(\d{4})(\d{2})(\d{2}).*/, "$1-$2-$3");
  const tax     = stripHtml(dvo.ntstTlawClNm || "");
  const gist    = stripHtml(dvo.ntstDcmGistCntn || "");
  const answer  = stripHtml(dvo.ntstDcmCntn || "");
  const keyword = stripHtml(dvo.ntstDcmMatrCntn || "");
  if (!gist && !answer) return null;
  const lines = [`# ${title || "해석례"}`, "", "| 항목 | 내용 |", "|---|---|"];
  if (docNo)   lines.push(`| 문서번호 | ${docNo} |`);
  if (date)    lines.push(`| 등록일   | ${date} |`);
  if (tax)     lines.push(`| 세목     | ${tax} |`);
  if (keyword) lines.push(`| 키워드   | ${keyword.slice(0, 200)} |`);
  lines.push("");
  if (gist)   lines.push("## 질의요지", "", gist, "");
  if (answer) lines.push("## 회신", "", answer, "");
  return lines.join("\n");
}
async function fetchDetailById(ntstDcmId) {
  const data = await ntsAction("ASIQTB002PR01", { dcmDVO: { ntstDcmId } });
  if (!data) return null;
  const dvo = (data["ASIQTB002PR01"] || data)?.dcmDVO;
  return dvo ? buildFullContent(dvo) : null;
}

// ── 제목 검색 → ID 확보 ─────────────────────────────────────────
function extractKeyword(name) {
  const clean = (name || "")
    .replace(/^\[(질의회신|사전답변|과세기준자문|고시서면질의|과세적부심사|이의신청|심사청구|심판청구)\]\s*/, "")
    .replace(/「[^」]+」/g, "")
    .replace(/제\d+조[^,。]+/g, "")
    .trim();
  return clean.slice(0, 30);
}
async function searchNtsId(name) {
  const keyword = extractKeyword(name);
  if (!keyword || keyword.length < 4) return null;
  const trySets = [
    { coll: "question,question_gr",   codes: ["02", "01", "03", "04"] },
    { coll: "precedent,precedent_gr", codes: ["05", "06", "07", "08"] },
  ];
  for (const { coll, codes } of trySets) {
    for (const code of codes) {
      const data = await ntsAction("ASIPDI002PR01", {
        startCount: 1, viewCount: 5,
        schDtBase: "DCM_RGT_DTM", bltnStrtDt: "", bltnEndDt: "",
        collectionName: coll, dcmClCdCtl: [`001_${code}`],
        exclVcbCtl: [], icldVcbCtl: [keyword], ntstTlawClCdList: [],
        sortField: "SCORE/DESC",
      });
      const items = (data?.["ASIPDI002PR01"] || data)?.body || [];
      const id = items[0]?.dcm?.DOC_ID || items[0]?.dcm?.NTST_DCM_ID;
      if (id) return id;
    }
  }
  return null;
}

// ── 메인 ────────────────────────────────────────────────────────
async function main() {
  console.log("NTS 세션 초기화...");
  await ntsSession();

  let docs = loadDocs();
  if (ONLY_HASID) docs = docs.filter(d => d.nts_doc_id);
  if (ONLY_NOID)  docs = docs.filter(d => !d.nts_doc_id);

  const done = loadDone();
  let pending = docs.filter(d => !done.has(d.id));
  if (pending.length > LIMIT) pending = pending.slice(0, LIMIT);

  console.log(`대상 ${docs.length}건, 이미 완료 ${done.size}건, 이번 실행 ${pending.length}건`);

  let ok = 0, miss = 0, n = 0;
  for (const doc of pending) {
    try {
      let ntsId = doc.nts_doc_id;
      if (!ntsId) ntsId = await searchNtsId(doc.name);   // 제목 검색
      const content = ntsId ? await fetchDetailById(ntsId) : null;
      if (content) { emit({ id: doc.id, content, nts_doc_id: String(ntsId) }); ok++; }
      else { miss++; }
    } catch (e) {
      miss++;
      console.log(`  [오류] id=${doc.id}: ${e.message}`);
    }
    done.add(doc.id);
    if (++n % 50 === 0) {
      console.log(`  진행 ${n}/${pending.length} (수집 ${ok}, 실패 ${miss})`);
      saveDone(done);
    }
  }
  saveDone(done);
  outStream.end();
  console.log(`\n완료: 수집 ${ok}건, 실패 ${miss}건`);
  console.log(`결과 → ${OUT_FILE}`);
  console.log("이 collected.jsonl 파일을 소유자에게 전달하세요.");
}
main().catch(e => { console.error("치명적 오류:", e.message); process.exit(1); });
