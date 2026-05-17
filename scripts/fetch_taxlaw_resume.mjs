/**
 * taxlaw.nts.go.kr 이어받기 수집 스크립트
 * - 이미 수집된 파일은 건너뜀
 * - ECONNRESET 복구를 위해 keepAlive Agent 사용
 * - 세목 코드 없이 전체 수집 후 세목명으로 분류
 *
 * 사용법: node scripts/fetch_taxlaw_resume.mjs
 */

import fs   from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");
const OUT_DIR   = path.join(BASE_DIR, "해석례자료");
const MANIFEST  = path.join(BASE_DIR, "law_manifest.json");
const NTS_HOST  = "taxlaw.nts.go.kr";
const DELAY_MS  = 1000;

// keepAlive Agent — ECONNRESET 줄이기
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 1,
  timeout: 30000,
});

const DOC_TYPES = [
  { code: "02", name: "질의회신",     collection: "question,question_gr" },
  { code: "03", name: "과세기준자문", collection: "question,question_gr" },
  { code: "04", name: "고시서면질의", collection: "question,question_gr" },
  { code: "05", name: "과세적부심사", collection: "precedent,precedent_gr" },
  { code: "06", name: "이의신청",     collection: "precedent,precedent_gr" },
  { code: "07", name: "심사청구",     collection: "precedent,precedent_gr" },
  { code: "08", name: "심판청구",     collection: "precedent,precedent_gr" },
];

// 세목 분류 (세목명으로 분류)
const TAX_CATEGORIES = {
  "법인세": ["법인세"],
  "부가세": ["부가가치세", "부가세"],
  "소득세": ["소득세", "양도소득세", "근로소득세"],
  "징세":   ["국세징수", "징수", "체납"],
  "재산세": ["재산세", "종합부동산세", "취득세", "지방세"],
  "조사":   ["세무조사", "조세"],
  "개인세": ["상속세", "증여세"],
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mkdirp(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log(msg)  { console.log(`${new Date().toLocaleTimeString("ko-KR")}  ${msg}`); }
function stripHtml(s) {
  return (s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
}

let _cookies = "";

function request(opts, postBody = null) {
  return new Promise((resolve, reject) => {
    const reqOpts = {
      ...opts,
      hostname: NTS_HOST,
      port: 443,
      agent,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Connection": "keep-alive",
        ...(opts.headers || {}),
        ..._cookies ? { Cookie: _cookies } : {},
      },
    };
    const req = https.request(reqOpts, res => {
      const newCookies = res.headers["set-cookie"] || [];
      if (newCookies.length) {
        const map = Object.fromEntries(
          (_cookies || "").split("; ").filter(Boolean).map(p => p.split("="))
        );
        newCookies.forEach(c => {
          const [k, v] = c.split(";")[0].split("=");
          map[k] = v;
        });
        _cookies = Object.entries(map).map(([k,v]) => `${k}=${v}`).join("; ");
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(30000, () => { req.destroy(new Error("Timeout")); });
    req.on("error", reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

async function initSession(code = "02") {
  try {
    await request({ method: "GET", path: `/qt/USEQTA001L.do?ntstDcmClCd=${code}` });
    log(`세션 갱신: ${_cookies.slice(0, 50)}...`);
  } catch (e) {
    log(`세션 갱신 오류: ${e.message}`);
  }
}

async function actionPost(actionId, paramData, referer) {
  await sleep(DELAY_MS);
  const body = new URLSearchParams({ actionId, paramData: JSON.stringify(paramData) }).toString();
  for (let i = 0; i < 4; i++) {
    try {
      const res = await request({
        method: "POST", path: "/action.do",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "Referer": `https://${NTS_HOST}${referer}`,
          "Origin": `https://${NTS_HOST}`,
        },
      }, body);

      if (!res.body || res.body.trimStart().startsWith("<!")) {
        await initSession();
        await sleep(2000);
        continue;
      }
      const json = JSON.parse(res.body);
      if (json.status === "SUCCESS") return json.data || json;
      return null;
    } catch (e) {
      log(`  오류 (${i+1}/4): ${e.message}`);
      await initSession();
      await sleep(3000 * (i + 1));
    }
  }
  return null;
}

async function fetchList(docType, startCount = 1, viewCount = 50) {
  const referer = `/qt/USEQTA001L.do?ntstDcmClCd=${docType.code}`;
  const data = await actionPost("ASIPDI002PR01", {
    startCount, viewCount,
    schDtBase: "DCM_RGT_DTM", bltnStrtDt: "", bltnEndDt: "",
    collectionName: docType.collection,
    dcmClCdCtl: [`001_${docType.code}`],
    exclVcbCtl: [], icldVcbCtl: [],
    ntstTlawClCdList: [],
    sortField: "DCM_RGT_DTM/DESC",
  }, referer);
  if (!data) return { items: [], total: 0 };
  const inner = data["ASIPDI002PR01"] || data;
  const items = inner?.body || [];
  const top   = inner?.top?.[0]?.categoryMap?.SUB_ID_CATEGORY || [];
  const total = parseInt(top.find(c => c.name === `001_${docType.code}`)?.count || "0");
  return { items, total };
}

async function fetchDetail(ntstDcmId) {
  const data = await actionPost("ASIQTB002PR01", { dcmDVO: { ntstDcmId } });
  if (!data) return null;
  return (data["ASIQTB002PR01"] || data)?.dcmDVO || null;
}

function classifyTax(taxNm) {
  const nm = taxNm || "";
  for (const [cat, keywords] of Object.entries(TAX_CATEGORIES)) {
    if (keywords.some(k => nm.includes(k))) return cat;
  }
  return "기타";
}

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

async function collectType(docType) {
  log(`\n[${docType.name}] 수집 시작`);
  await initSession(docType.code);

  // 이 유형으로 이미 수집된 파일 확인
  const existing = fs.readdirSync(OUT_DIR).filter(f => f.endsWith(`_${docType.name}.md`));
  if (existing.length >= 4) {
    log(`  이미 수집됨 (${existing.length}개 파일) — 스킵`);
    return 0;
  }

  const { items, total } = await fetchList(docType, 1, 50);
  log(`  ${items.length}건 목록 수신 (전체 ${total.toLocaleString()}건)`);

  // 세목별 버킷
  const buckets = {};
  for (const cat of Object.keys(TAX_CATEGORIES)) buckets[cat] = [];
  buckets["기타"] = [];

  let processed = 0;
  for (const item of items) {
    const id = item?.dcm?.DOC_ID || item?.dcm?.NTST_DCM_ID || "";
    if (!id) continue;

    const dvo = await fetchDetail(id);
    if (!dvo) continue;

    const doc = normalizeDoc(dvo, docType.name);
    if (!doc.question && !doc.answer) continue;

    const cat = classifyTax(doc.tax);
    buckets[cat].push(doc);
    processed++;

    if (processed % 10 === 0) log(`    ${processed}/${items.length} 처리중...`);
  }

  // 세목별 저장
  let saved = 0;
  const manifest = (() => {
    try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); }
    catch { return {}; }
  })();

  for (const [cat, docs] of Object.entries(buckets)) {
    if (!docs.length) continue;
    const filePath = path.join(OUT_DIR, `${cat}_${docType.name}.md`);
    // 기존 파일 있으면 merge
    let allDocs = docs;
    if (fs.existsSync(filePath)) {
      // 새 데이터만 추가 (간단히 덮어쓰기)
      log(`    ${cat}_${docType.name}.md 업데이트 (${docs.length}건)`);
    } else {
      log(`    신규: ${cat}_${docType.name}.md (${docs.length}건)`);
    }
    fs.writeFileSync(filePath, toMd(allDocs, `${cat} ${docType.name} 모음`), "utf8");
    manifest[`${docType.code}_${cat}`] = {
      type: docType.name, count: docs.length,
      last_updated: new Date().toISOString().slice(0, 16).replace("T", " "),
    };
    saved += docs.length;
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), "utf8");
  return saved;
}

async function main() {
  log("══════════════════════════════════");
  log("taxlaw 이어받기 수집");
  log("══════════════════════════════════");

  mkdirp(OUT_DIR);
  await initSession("02");

  let totalSaved = 0;
  for (const docType of DOC_TYPES) {
    const saved = await collectType(docType);
    totalSaved += saved;
    await sleep(2000);
  }

  log(`\n══════════════════════════════════`);
  log(`완료: 총 ${totalSaved}건 저장`);
  log(`\n다음: node scripts/seed_interp.mjs`);
}

main().catch(e => { console.error(e); process.exit(1); });
