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
 *
 * 다른 스크립트와의 관계 (왜 이 스크립트가 따로 존재하는가):
 *   - 자세한 배경은 scripts/HANDOFF_수집작업.md 참고. 요약하면 D1 적재를 직접 하지 않고
 *     "수집(이 스크립트)"과 "DB 반영(import_collected.mjs)"을 의도적으로 분리한 결과물이다.
 *     D1에 쓰려면 소유자의 Cloudflare 인증 토큰이 필요한데, 이를 외부 AI/PC와 공유하는 것은
 *     보안상 위험하므로, 토큰이 전혀 필요 없는 "수집만" 하는 이 스크립트를 별도로 만들어
 *     다른 환경(다른 AI, 다른 PC)에 통째로 넘겨 실행시킬 수 있게 했다.
 *   - GitHub Actions 자동화(fetch_all.mjs, .github/workflows/update_laws.yml)와는 무관하다.
 *     fetch_all.mjs는 국가법령정보센터(law.go.kr) 공식 Open API로 법령/판례를 받아오는 스크립트이고,
 *     이 스크립트는 국세법령정보시스템(taxlaw.nts.go.kr)의 비공개 AJAX(action.do)를 호출해
 *     이미 요약(summary)으로만 저장된 NTS 해석례의 "전문"을 보강 수집하는 별도 작업이다.
 *   - 수집 결과(collected.jsonl)는 소유자 환경의 import_collected.mjs로 D1에 반영되고,
 *     그 안에서 FTS5 인덱스도 함께 재구성된다(이 스크립트는 D1/FTS를 전혀 건드리지 않음).
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
const DELAY_MS   = 1000;   // 요청 간 딜레이(ms). 비공개 사이트라 공식 API보다 더 보수적으로(1초) 잡아 NTS 서버에 부담을 주지 않도록 함. 늘려도 무방
const ARG        = process.argv;
const ONLY_HASID = ARG.includes("--has-id");
const ONLY_NOID  = ARG.includes("--no-id");
const LIMIT      = ARG.includes("--limit") ? Number(ARG[ARG.indexOf("--limit") + 1]) : Infinity;

// ── 입력/체크포인트 로드 ────────────────────────────────────────
// 입력 파일(pending_docs.jsonl)은 소유자가 export_pending.mjs로 D1에서 미완료 목록을 뽑아 전달해주는 파일이라
// 이 스크립트 자체에는 D1 접근 코드가 전혀 없다. 파일이 없으면 즉시 종료해 잘못된 빈 상태로 진행되지 않게 한다.
function loadDocs() {
  if (!fs.existsSync(IN_FILE)) {
    console.error(`입력 파일 없음: ${IN_FILE}\n소유자에게 pending_docs.jsonl 을 받아 scripts/ 에 두세요.`);
    process.exit(1);
  }
  return fs.readFileSync(IN_FILE, "utf8").trim().split("\n")
    .filter(Boolean).map(l => JSON.parse(l));
}
// 체크포인트: 처리 완료된 문서 id 집합. 11,866건 같은 대량 작업은 중간에 네트워크 끊김/PC 종료로
// 멈출 수 있으므로, 같은 명령을 재실행했을 때 이미 끝난 건을 건너뛰고 이어서 진행할 수 있게 한다.
function loadDone() {
  try { return new Set(JSON.parse(fs.readFileSync(CHECKPOINT, "utf8")).done_ids); }
  catch { return new Set(); }
}
function saveDone(set) {
  fs.writeFileSync(CHECKPOINT, JSON.stringify({ done_ids: [...set] }, null, 0));
}

// append 모드로 열어 재실행 시에도 기존에 수집한 결과가 덮어써지지 않고 그대로 보존되게 함
const outStream = fs.createWriteStream(OUT_FILE, { flags: "a" });
function emit(rec) { outStream.write(JSON.stringify(rec) + "\n"); }

// ── NTS HTTP ────────────────────────────────────────────────────
// NTS 사이트는 비공개 내부 AJAX(action.do)라 공식 SDK/문서가 없다. fetch 대신 내장 https 모듈을
// 직접 써서 응답 헤더(Set-Cookie)를 손수 추적해야 세션을 유지할 수 있다.
let _cookies = "";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 브라우저처럼 보이는 User-Agent/Referer/Origin을 흉내내야 NTS 서버가 정상 응답을 준다.
// (실제 브라우저 요청이 아니면 막히거나 빈/에러 페이지를 반환하는 경우가 있었음)
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
      // 매 응답마다 Set-Cookie를 누적 병합해 세션 쿠키(JSESSIONID 등)를 유지.
      // 쿠키가 끊기면 이후 action.do 호출이 로그인/세션 페이지(HTML)를 반환하게 됨.
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

// 세션 초기화: 메인 검색 페이지를 한 번 GET해서 세션 쿠키를 발급받는다.
// 이게 없으면 이후 action.do POST 요청이 세션 없음으로 거부되거나 빈 응답을 줄 수 있다.
// 실패해도(예: ECONNRESET) 치명적이지 않으므로 로그만 남기고 계속 진행(어차피 ntsAction 안에서 재시도 시 다시 호출됨).
async function ntsSession() {
  try { await httpsRequest("GET", "/qt/USEQTA001L.do?ntstDcmClCd=02"); }
  catch (e) { console.log(`세션 초기화 실패(무시): ${e.message}`); }
}

// 비공개 AJAX 액션 호출 공통 헬퍼. actionId로 어떤 내부 기능을 호출할지 지정하고
// paramData(JSON)를 폼인코딩으로 실어 보낸다 — NTS 프론트엔드가 실제로 쓰는 방식을 그대로 재현.
// 최대 3회 재시도하는 이유: 세션이 만료되어 HTML(로그인/에러 페이지)이 오는 경우가 잦아서,
// 응답이 JSON이 아니라 "<!"로 시작하는 HTML이면 세션을 재초기화하고 다시 시도한다.
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
// NTS 응답 필드에는 <br>, &nbsp; 등 HTML 태그/엔티티가 그대로 섞여 있어,
// 별도 HTML 파서 없이 정규식으로 가볍게 제거/치환만 한다(이 정도 단순 변환에는 충분하고 의존성도 줄어듦).
function stripHtml(s) {
  return (s || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\r\n/g, "\n").trim();
}
// D1 documents.content에 그대로 들어갈 Markdown을 만든다.
// 질의요지/회신 둘 다 비어 있으면 사실상 내용이 없는 응답이므로 null을 반환해 호출 측에서 실패로 처리하게 함.
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
// nts_doc_id를 이미 알고 있는 경우(빠른 경로, --has-id) 상세조회 액션 하나로 바로 전문을 가져온다.
async function fetchDetailById(ntstDcmId) {
  const data = await ntsAction("ASIQTB002PR01", { dcmDVO: { ntstDcmId } });
  if (!data) return null;
  const dvo = (data["ASIQTB002PR01"] || data)?.dcmDVO;
  return dvo ? buildFullContent(dvo) : null;
}

// ── 제목 검색 → ID 확보 ─────────────────────────────────────────
// nts_doc_id가 없는 문서(--no-id, 느린 경로)는 문서 제목으로 NTS 검색을 해서 ID를 먼저 찾아야 한다.
// 제목 그대로 검색하면 "[질의회신]" 같은 분류 접두어나 법조문 인용("제19조의2제6항...")이
// 노이즈가 되어 검색 적중률이 떨어지므로, 핵심 키워드만 남기고 30자로 잘라 검색어로 쓴다.
function extractKeyword(name) {
  const clean = (name || "")
    .replace(/^\[(질의회신|사전답변|과세기준자문|고시서면질의|과세적부심사|이의신청|심사청구|심판청구)\]\s*/, "")
    .replace(/「[^」]+」/g, "")
    .replace(/제\d+조[^,。]+/g, "")
    .trim();
  return clean.slice(0, 30);
}
// 짧은 키워드(4자 미만)는 검색 결과가 너무 광범위해 오탐이 많으므로 차라리 포기하고 null 반환.
// 문서 분류를 모르므로 질의회신류(question*)와 판례/심판류(precedent*) 두 컬렉션, 각각의 세부
// 분류코드(001_xx)를 순서대로 모두 시도해 첫 매칭을 채택한다 — 정확한 분류를 모르는 상태에서
// 가능한 조합을 훑는 가장 단순한 방법이라 택함(API가 분류를 안 알려주거나 사전에 알 수 없음).
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
      // 상위 5건(viewCount:5) 중 첫 번째를 그대로 신뢰 — 제목 검색이라 완전 정확 매칭은 보장 못하지만
      // 점수순(SCORE/DESC) 정렬이므로 1위가 가장 근접한 문서일 확률이 높다는 전제.
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
  // --has-id / --no-id 필터: nts_doc_id 유무에 따라 처리 속도가 크게 달라서(직접조회 vs 제목검색)
  // 빠른 것부터 먼저 끝내고 싶을 때 분리 실행할 수 있게 함. 둘 다 없으면(옵션 없음) 전체 처리.
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
    // 성공/실패와 무관하게 처리 완료로 표시 — 실패한 건을 매 재실행마다 다시 시도하면 시간이 끝없이
    // 소요되므로, 일단 한 번 시도한 건은 건너뛴다(완전 재시도가 필요하면 체크포인트 파일을 직접 삭제).
    done.add(doc.id);
    if (++n % 50 === 0) {
      console.log(`  진행 ${n}/${pending.length} (수집 ${ok}, 실패 ${miss})`);
      saveDone(done);   // 50건마다 중간 저장 — 장시간 작업 중 중단되어도 손실을 최소화
    }
  }
  saveDone(done);
  outStream.end();
  console.log(`\n완료: 수집 ${ok}건, 실패 ${miss}건`);
  console.log(`결과 → ${OUT_FILE}`);
  console.log("이 collected.jsonl 파일을 소유자에게 전달하세요.");
}
main().catch(e => { console.error("치명적 오류:", e.message); process.exit(1); });
