/**
 * 국세법령정보시스템(taxlaw.nts.go.kr) 세법해석례·불복결정례 수집
 * API 키 불필요 — 내부 AJAX 엔드포인트(/action.do) 사용
 *
 * [목적]
 * taxlaw.nts.go.kr은 공개 REST API를 제공하지 않으므로, 실제 검색 화면이 내부적으로
 * 호출하는 비공개 AJAX 엔드포인트(/action.do, actionId=ASIPDI002PR01 목록조회 /
 * ASIQTB002PR01 상세조회)를 직접 호출해 세목×문서유형(질의회신/심판청구 등)별로
 * 세법해석례·불복결정례를 수집하고, 세목_유형.md 형태로 해석례자료/ 폴더에 저장한다.
 *
 * [실행 시점 / 다른 스크립트와의 관계]
 * .github/workflows/update_laws.yml에는 등록돼 있지 않다(자동 실행은 fetch_all.mjs뿐).
 * fetch_all.mjs 등 다른 스크립트가 이 파일을 import하거나 호출하지 않으므로 수동 실행용
 * 보조 스크립트다. 세목 코드(TAX_CODES)로 NTS 서버 측에서 필터링해 조회하는 점이
 * fetch_taxlaw_resume.mjs(세목 필터 없이 전체 수집 후 클라이언트에서 키워드로 재분류)와
 * 다르다. 수집 후 D1에 반영하려면 seed_interp.mjs를 별도로 수동 실행해야 한다.
 *
 * 사용법: node scripts/fetch_taxlaw_interp.mjs
 */

import fs   from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

const DELAY_MS  = 800;
const OUT_DIR   = path.join(BASE_DIR, "해석례자료");
const MANIFEST  = path.join(BASE_DIR, "law_manifest.json");
const NTS_HOST  = "taxlaw.nts.go.kr";

// ── 문서 유형 정의 ──────────────────────────────────────────
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

// 세목 코드 (국세법령정보시스템 ntstTlawClCd)
const TAX_CODES = {
  "법인세": ["303"],
  "부가세": ["304"],
  "소득세": ["302"],
  "징세":   ["301", "315"],
  "재산세": ["308", "309"],
  "조사":   ["301"],
  "개인세": ["305", "306"],
};

// ── 유틸 ────────────────────────────────────────────────────
// NTS 요청 사이 지연 — 비공개 엔드포인트이므로 너무 빠른 연속 호출은 차단/오류로
// 이어질 수 있어 일반적인 사람의 클릭 속도에 가깝게 지연을 둔다.
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mkdirp(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log(msg)  { console.log(`${new Date().toLocaleTimeString("ko-KR")}  ${msg}`); }
// 응답 필드가 HTML 단편(<br>, &nbsp; 등)을 포함하므로 정규식으로 태그 제거 및
// 엔티티 디코딩을 수행해 마크다운에 바로 쓸 수 있는 텍스트로 변환한다.
function stripHtml(s) {
  return (s || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .trim();
}

// ── https 모듈 기반 요청 헬퍼 ────────────────────────────────
// 비공개 AJAX이므로 일반 브라우저처럼 보이도록 User-Agent를 위장하고,
// 서버가 내려주는 세션 쿠키를 받아 이후 요청에 계속 실어 보내야 정상 응답을 받는다.
let _cookies = "";

function httpsGet(urlPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: NTS_HOST, port: 443, path: urlPath, method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Connection": "keep-alive",
        ..._cookies ? { "Cookie": _cookies } : {},
      },
      timeout: 20000,
    };
    const req = https.request(opts, res => {
      // 쿠키 저장 — Set-Cookie 헤더를 누적 병합해 세션을 유지(JSESSIONID 등)
      const newCookies = res.headers["set-cookie"] || [];
      if (newCookies.length) {
        const pairs = newCookies.map(c => c.split(";")[0]);
        const existing = Object.fromEntries((_cookies || "").split("; ").filter(Boolean).map(p => p.split("=")));
        for (const pair of pairs) {
          const [k, v] = pair.split("=");
          existing[k] = v;
        }
        _cookies = Object.entries(existing).map(([k,v]) => `${k}=${v}`).join("; ");
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// POST 요청에는 Referer/Origin/X-Requested-With를 명시해 실제 검색 화면에서
// 보낸 AJAX 호출처럼 보이게 한다(서버가 이 헤더들로 비정상 요청을 걸러낼 수 있음).
function httpsPost(urlPath, formData, referer) {
  const body = new URLSearchParams(formData).toString();
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: NTS_HOST, port: 443, path: urlPath, method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Referer": `https://${NTS_HOST}${referer}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        "Origin": `https://${NTS_HOST}`,
        "Connection": "keep-alive",
        ..._cookies ? { "Cookie": _cookies } : {},
      },
      timeout: 30000,
    };
    const req = https.request(opts, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", d => data += d);
      res.on("end", () => resolve({ status: res.statusCode, contentType: res.headers["content-type"] || "", body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(body);
    req.end();
  });
}

// ── 세션 초기화 ─────────────────────────────────────────────
// 실제 검색 페이지(USEQTA001L.do)에 먼저 GET으로 접속해 서버로부터 세션 쿠키를
// 발급받는다. 이후 /action.do POST 호출이 이 쿠키 없이는 정상 동작하지 않는다.
async function initSession(dcmClCd = "02") {
  try {
    await httpsGet(`/qt/USEQTA001L.do?ntstDcmClCd=${dcmClCd}`);
    log(`세션 초기화 완료: ${_cookies.slice(0, 60)}...`);
  } catch (e) {
    log(`세션 초기화 오류: ${e.message}`);
  }
}

// ── /action.do 호출 ─────────────────────────────────────────
// actionId(ASIPDI002PR01=목록조회, ASIQTB002PR01=상세조회)와 paramData(JSON)를
// 폼인코딩으로 전송하는 NTS 내부 AJAX 공통 호출 래퍼.
async function actionPost(actionId, paramData, referer = "/qt/USEQTA001L.do?ntstDcmClCd=02") {
  await sleep(DELAY_MS); // 매 호출 사이 지연 — 서버 부하 분산 및 차단 회피
  // 최대 3회 재시도 — 세션 만료나 일시적 오류는 재시도로 복구 가능하나 무한 재시도는 배치를 지연시킴
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await httpsPost("/action.do", {
        actionId,
        paramData: JSON.stringify(paramData),
      }, referer);

      // JSON이 아닌 HTML(로그인/에러 페이지)이 오면 세션이 끊긴 것으로 판단,
      // 첫 시도에서만 세션을 재초기화하고 재시도
      if (!res.body || res.body.startsWith("<!")) {
        if (attempt === 0) { await initSession(); await sleep(1000); continue; }
        return null;
      }
      const json = JSON.parse(res.body);
      if (json.status === "SUCCESS") return json.data || json;
      return null;
    } catch (e) {
      log(`  action.do 오류 (${attempt+1}/3): ${e.message}`);
      if (attempt < 2) await sleep(2000);
    }
  }
  return null;
}

// ── 목록 조회 ───────────────────────────────────────────────
// ntstTlawClCdList(세목 코드)로 NTS 서버 측에서 직접 필터링해 조회 — 세목별로
// 정확한 건수를 받을 수 있어 fetch_taxlaw_resume.mjs의 클라이언트 측 재분류보다 정밀하다.
async function fetchList(docType, taxCodes, startCount = 1, viewCount = 50) {
  const referer = `/qt/USEQTA001L.do?ntstDcmClCd=${docType.code}`;
  const data = await actionPost("ASIPDI002PR01", {
    startCount, viewCount,
    schDtBase: "DCM_RGT_DTM", bltnStrtDt: "", bltnEndDt: "",
    collectionName: docType.collection,
    dcmClCdCtl: [`001_${docType.code}`],
    exclVcbCtl: [], icldVcbCtl: [],
    ntstTlawClCdList: taxCodes,
    sortField: "DCM_RGT_DTM/DESC",
  }, referer);

  if (!data) return { items: [], total: 0 };
  const inner = data["ASIPDI002PR01"] || data;
  const items = inner?.body || [];
  const top   = inner?.top?.[0]?.categoryMap?.SUB_ID_CATEGORY || [];
  const total = parseInt(top.find(c => c.name === `001_${docType.code}`)?.count || "0");
  return { items, total };
}

// ── 상세 조회 ───────────────────────────────────────────────
async function fetchDetail(ntstDcmId) {
  const data = await actionPost("ASIQTB002PR01", { dcmDVO: { ntstDcmId } });
  if (!data) return null;
  return (data["ASIQTB002PR01"] || data)?.dcmDVO || null;
}

// ── 아이템 → 정규화 ─────────────────────────────────────────
function extractId(item)   { return item?.dcm?.DOC_ID || item?.dcm?.NTST_DCM_ID || ""; }
function extractGist(item) { return stripHtml(item?.dcm?.GIST_CNTN || item?.dcm?.DCM_NM || ""); }
function extractTax(item)  { return stripHtml(item?.dcm?.NTST_TLAW_CL_NM || ""); }

function normalizeDoc(dvo, typeName) {
  return {
    id:       dvo.ntstDcmId || "",
    title:    stripHtml(dvo.ntstDcmTtl || ""),
    docNo:    stripHtml(dvo.ntstDcmDscmCntn || ""),
    date:     (dvo.ntstDcmRgtDt || "").replace(/(\d{4})(\d{2})(\d{2}).*/, "$1-$2-$3"),
    tax:      stripHtml(dvo.ntstTlawClNm || ""),
    question: stripHtml(dvo.ntstDcmGistCntn || ""),
    answer:   stripHtml(dvo.ntstDcmCntn || ""),
    keyword:  stripHtml(dvo.ntstDcmMatrCntn || ""),
    type:     typeName,
  };
}

function toMd(list, title) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `# ${title}`, "",
    `> **수집 건수:** ${list.length}건`,
    `> **수집일자:** ${today}`,
    `> **출처:** [국세법령정보시스템](https://taxlaw.nts.go.kr)`,
    "", "---", "",
  ];
  list.forEach((p, i) => {
    lines.push(`## ${i+1}. ${p.title || `항목 ${i+1}`}`, "");
    lines.push("| 항목 | 내용 |", "|---|---|");
    if (p.docNo)   lines.push(`| 문서번호 | ${p.docNo} |`);
    if (p.date)    lines.push(`| 등록일   | ${p.date} |`);
    if (p.tax)     lines.push(`| 세목     | ${p.tax} |`);
    if (p.type)    lines.push(`| 유형     | ${p.type} |`);
    if (p.keyword) lines.push(`| 키워드   | ${p.keyword.slice(0, 100)} |`);
    lines.push("");
    if (p.question) lines.push("**[질의요지]**", "", p.question.slice(0, 800), "");
    if (p.answer)   lines.push("**[회신내용]**", "", p.answer.slice(0, 2000), "");
    lines.push("---", "");
  });
  return lines.join("\n");
}

// ── 메인 ────────────────────────────────────────────────────
async function main() {
  log("══════════════════════════════════════════════");
  log("taxlaw.nts.go.kr 세법해석례·불복결정례 수집");
  log("══════════════════════════════════════════════");

  await initSession("02");

  // 연결 테스트
  log("\n[테스트] API 연결 확인...");
  const test = await fetchList(DOC_TYPES[1], [], 1, 3);
  if (!test.items.length) {
    log("⚠️  API 연결 실패. 종료합니다.");
    process.exit(1);
  }
  log(`테스트 성공 — 질의회신 총 ${test.total.toLocaleString()}건 확인`);

  mkdirp(OUT_DIR);
  const manifest = (() => {
    try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); }
    catch { return {}; }
  })();

  let totalSaved = 0;
  const MAX_ITEMS = 80;  // 세목·유형별 최대 수집 건수 — 파일 크기와 전체 수집 시간을 적정 수준으로 제한

  for (const docType of DOC_TYPES) {
    log(`\n\n[${docType.name}] (코드 ${docType.code}) 수집 시작`);
    await initSession(docType.code); // 문서유형(검색 화면)이 바뀔 때마다 세션을 새로 받아 안정성 확보

    for (const [category, taxCodes] of Object.entries(TAX_CODES)) {
      log(`  [${category}] 수집 중...`);
      const collected = [];
      const seenIds   = new Set(); // 1페이지·2페이지 사이 중복 id 방지

      // 1페이지
      const { items, total } = await fetchList(docType, taxCodes, 1, 50);
      log(`    1페이지 ${items.length}건 (전체 ${total}건)`);

      for (const item of items) {
        if (collected.length >= MAX_ITEMS) break;
        const id = extractId(item);
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);

        const dvo = await fetchDetail(id);
        if (!dvo) {
          collected.push({ id, title: extractGist(item).slice(0, 100),
            docNo: "", date: "", tax: extractTax(item),
            question: extractGist(item), answer: "", keyword: "", type: docType.name });
          continue;
        }
        const doc = normalizeDoc(dvo, docType.name);
        if (!doc.question && !doc.answer) continue;
        collected.push(doc);
      }

      // 2페이지 (더 필요한 경우) — 1페이지(50건)만으로 30건도 못 채웠고 전체 건수가
      // 더 있다면 추가로 51번째 항목부터 한 번 더 조회한다(3페이지 이상은 시도하지 않음)
      if (collected.length < 30 && total > 50) {
        const { items: p2 } = await fetchList(docType, taxCodes, 51, 50);
        for (const item of p2) {
          if (collected.length >= MAX_ITEMS) break;
          const id = extractId(item);
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          const dvo = await fetchDetail(id);
          if (!dvo) continue;
          const doc = normalizeDoc(dvo, docType.name);
          if (!doc.question && !doc.answer) continue;
          collected.push(doc);
        }
      }

      if (!collected.length) { log(`    ⚠️  0건`); continue; }

      const filePath = path.join(OUT_DIR, `${category}_${docType.name}.md`);
      fs.writeFileSync(filePath, toMd(collected, `${category} ${docType.name} 모음`), "utf8");
      log(`    저장: ${category}_${docType.name}.md (${collected.length}건)`);

      manifest[`${docType.code}_${category}`] = {
        type: docType.name, count: collected.length,
        last_updated: new Date().toISOString().slice(0, 16).replace("T", " "),
      };
      fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), "utf8");
      totalSaved += collected.length;
    }
  }

  log("\n══════════════════════════════════════════════");
  log(`완료: 총 ${totalSaved}건 저장`);
  log(`저장 위치: ${OUT_DIR}`);
  log("══════════════════════════════════════════════");
  if (totalSaved > 0) log("\n다음: node scripts/seed_interp.mjs");
}

main().catch(e => { console.error(e); process.exit(1); });
