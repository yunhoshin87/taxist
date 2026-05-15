/**
 * 국가법령정보 API - 전체 법령 다운로드 & MD 변환
 * Node.js 18+ 내장 fetch 사용 (별도 설치 불필요)
 *
 * 사용법: node scripts/fetch_all.mjs 인증키
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

const API_KEY   = process.argv[2] || process.env.LAW_API_KEY || "";
const IS_UPDATE = process.argv.includes("--update");
const BASE_URL  = "https://www.law.go.kr/DRF";
const DELAY_MS  = 350;

const OUT_DIR       = path.join(BASE_DIR, "법령자료");
const PREC_DIR      = path.join(BASE_DIR, "판례자료");
const MANIFEST_FILE = path.join(BASE_DIR, "law_manifest.json");
const UPDATE_LOG    = path.join(BASE_DIR, "update_log.md");

// ── 수집 대상 검색 쿼리 ──────────────────────────────────────
const SEARCH_QUERIES = [
  "국세기본법", "국세징수법", "조세범 처벌법", "납세자 보호법",
  "소득세법", "법인세법",
  "부가가치세법", "개별소비세법", "주세법", "인지세법", "증권거래세법",
  "상속세 및 증여세법", "종합부동산세법",
  "조세특례제한법", "농어촌특별세법", "교육세법",
  "관세법",
  "지방세기본법", "지방세법", "지방세징수법", "지방세특례제한법",
  "행정심판법", "행정소송법",
  "국제조세조정에 관한 법률",
];

// ── 판례 수집 키워드 ─────────────────────────────────────────
const PREC_QUERIES = {
  "법인세":   ["법인세법", "부당행위계산 이월결손금"],
  "부가세":   ["부가가치세법", "세금계산서 매입세액"],
  "소득세":   ["소득세법", "양도소득세 종합소득"],
  "징세":     ["국세징수법", "체납처분 압류"],
  "재산세":   ["재산세 지방세법"],
  "조세특례": ["조세특례제한법 세액공제"],
};

// ── 폴더 자동 분류 ───────────────────────────────────────────
const FOLDER_RULES = [
  [/국세기본|국세징수|조세범|납세자/,               "국세기본"],
  [/소득세/,                                        "소득세"],
  [/법인세/,                                        "법인세"],
  [/부가가치세|부가세/,                             "부가세"],
  [/상속세|증여세/,                                 "상속증여세"],
  [/종합부동산세/,                                  "종합부동산세"],
  [/개별소비세|주세|인지세|증권거래세|농어촌|교육세/, "소비세기타"],
  [/조세특례/,                                      "조세특례"],
  [/관세/,                                          "관세"],
  [/지방세/,                                        "지방세"],
  [/행정심판|행정소송|감사원/,                      "불복절차"],
  [/국제조세|역외탈세/,                             "국제조세"],
];

function getFolder(name) {
  for (const [re, folder] of FOLDER_RULES) {
    if (re.test(name)) return folder;
  }
  return "기타";
}

// ── 유틸 ────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtDate(raw = "") {
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6)}`;
  return raw;
}

function safeName(s = "") {
  return s.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function mkdirp(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")); }
  catch { return {}; }
}

function saveManifest(m) {
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(m, null, 2), "utf8");
}

function appendLog(entries) {
  if (!entries.length) return;
  const now    = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const header = `\n## ${now}\n\n`;
  const body   = entries.map(e => `- ${e}`).join("\n") + "\n";
  const prev   = fs.existsSync(UPDATE_LOG)
    ? fs.readFileSync(UPDATE_LOG, "utf8")
    : "# TAXIST 법령 업데이트 로그\n";
  fs.writeFileSync(UPDATE_LOG, prev + header + body, "utf8");
}

function log(msg) {
  const t = new Date().toLocaleTimeString("ko-KR");
  console.log(`${t}  ${msg}`);
}

// ── API 호출 ─────────────────────────────────────────────────
async function apiGet(endpoint, params) {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set("OC",   API_KEY);
  url.searchParams.set("type", "JSON");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
      if (res.status === 429) { log("  Rate limit — 10초 대기..."); await sleep(10000); continue; }
      if (!res.ok) { log(`  HTTP ${res.status}: ${endpoint}`); return null; }
      return await res.json();
    } catch (e) {
      log(`  요청 실패 (${attempt+1}/3): ${e.message}`);
      await sleep(2000);
    }
  }
  return null;
}

// ── 법령 목록 수집 ───────────────────────────────────────────
async function searchAllLaws(query) {
  const results = [];
  let page = 1;
  while (true) {
    await sleep(DELAY_MS);
    const data = await apiGet("lawSearch.do", { target: "law", query, display: "100", page: String(page), sort: "efYd" });
    if (!data) break;
    const wrap  = data.LawSearch || {};
    const total = parseInt(wrap.totalCnt || "0", 10);
    let   items = wrap.law || [];
    if (!Array.isArray(items)) items = [items];
    if (!items.length) break;
    results.push(...items);
    if (results.length >= total || page * 100 >= total) break;
    page++;
  }
  return results;
}

// ── 법령 → MD 변환 ───────────────────────────────────────────
function circleNum(n) {
  const c = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
  const i = parseInt(n, 10) - 1;
  return (i >= 0 && i < c.length) ? c[i] : `(${n})`;
}

// API 응답값이 문자열이 아닐 수 있으므로 안전하게 문자열 변환
function str(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).trim();
}

function lawToMd(data, meta) {
  const 법령   = data["법령"] || {};
  const 기본   = 법령["기본정보"] || {};
  const 법령명  = (기본["법령명_한글"] || meta["법령명한글"] || "").trim();
  const today  = new Date().toISOString().slice(0, 10);

  const lines = [
    `# ${법령명}`, "",
    `> **법령번호:** ${기본["법령번호"] || ""}`,
    `> **시행일자:** ${fmtDate(기본["시행일자"] || "")}`,
    `> **공포일자:** ${fmtDate(기본["공포일자"] || "")}`,
    `> **소관부처:** ${기본["소관부처명"] || ""}`,
    `> **수집일자:** ${today}`,
    `> **출처:** [국가법령정보센터](https://www.law.go.kr)`,
    "", "---", "",
  ];

  // 조문
  let 조문목록 = (법령["조문"] || {})["조문단위"] || [];
  if (!Array.isArray(조문목록)) 조문목록 = [조문목록];

  for (const 조 of 조문목록) {
    const 편장절  = str(조["편장절구분"]);
    const 편장절명 = str(조["편장절제목"]);
    const 조번호  = str(조["조문번호"]);
    const 조제목  = str(조["조문제목"]);
    const 조내용  = str(조["조문내용"]);

    if (["편","장","절","관","목"].includes(편장절)) {
      lines.push(`## ${편장절} ${편장절명}`, ""); continue;
    }
    lines.push(`### 제${조번호}조${조제목 ? ` (${조제목})` : ""}`, "");
    if (조내용) lines.push(조내용, "");

    let 항목록 = 조["항"] || [];
    if (!Array.isArray(항목록)) 항목록 = [항목록];
    for (const 항 of 항목록) {
      const 항번호 = str(항["항번호"]);
      const 항내용 = str(항["항내용"]);
      if (항내용) lines.push(`${circleNum(항번호)} ${항내용}`);

      let 호목록 = 항["호"] || [];
      if (!Array.isArray(호목록)) 호목록 = [호목록];
      for (const 호 of 호목록) {
        const 호내용 = str(호["호내용"]);
        if (호내용) lines.push(`  ${str(호["호번호"])}. ${호내용}`);
        let 목목록 = 호["목"] || [];
        if (!Array.isArray(목목록)) 목목록 = [목목록];
        for (const 목 of 목목록) {
          const 목내용 = str(목["목내용"]);
          if (목내용) lines.push(`    ${str(목["목번호"])}) ${목내용}`);
        }
      }
    }
    lines.push("");
  }

  // 부칙
  let 부칙목록 = (법령["부칙"] || {})["부칙단위"] || [];
  if (!Array.isArray(부칙목록)) 부칙목록 = [부칙목록];
  if (부칙목록.length) {
    lines.push("---", "", "## 부칙", "");
    for (const 부 of 부칙목록) {
      const d = fmtDate(str(부["공포일자"]));
      const c = str(부["부칙내용"]);
      if (d) lines.push(`### 부칙 (${d})`, "");
      if (c) lines.push(c, "");
    }
  }
  return lines.join("\n");
}

// ── 판례 수집 ────────────────────────────────────────────────
async function collectPrec(category, keywords) {
  const all = []; const seen = new Set();
  for (const kw of keywords) {
    let page = 1;
    while (all.length < 200) {
      await sleep(DELAY_MS);
      const data  = await apiGet("lawSearch.do", { target: "prec", query: kw, display: "20", page: String(page), sort: "ddes" });
      if (!data) break;
      const wrap  = data["PrecSearch"] || {};
      const total = parseInt(wrap["totalCnt"] || "0", 10);
      let   items = wrap["prec"] || [];
      if (!Array.isArray(items)) items = [items];
      for (const p of items) {
        const pid = p["판례정보일련번호"];
        if (pid && !seen.has(pid)) { seen.add(pid); all.push(p); }
      }
      if (!items.length || page * 20 >= Math.min(total, 200)) break;
      page++;
    }
  }
  return all;
}

function precToMd(list, category) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `# ${category} 관련 판례 모음`, "",
    `> **수집 건수:** ${list.length}건`,
    `> **수집일자:** ${today}`,
    `> **출처:** [국가법령정보센터](https://www.law.go.kr)`,
    "", "---", "",
  ];
  list.forEach((p, i) => {
    lines.push(
      `## ${i+1}. ${p["사건명"] || ""}`, "",
      `| 사건번호 | ${p["사건번호"] || ""} |`,
      `|---|---|`,
      `| 선고일자 | ${fmtDate(p["선고일자"] || "")} |`,
      `| 법원 | ${p["법원명"] || ""} |`, "",
    );
    if (p["판시사항"]) lines.push("**판시사항**", "", str(p["판시사항"]), "");
    if (p["판결요지"]) lines.push("**판결요지**", "", str(p["판결요지"]), "");
    if (p["참조조문"]) lines.push(`**참조조문:** ${str(p["참조조문"])}`, "");
    lines.push("---", "");
  });
  return lines.join("\n");
}

// ── 인덱스 생성 ──────────────────────────────────────────────
function makeIndex(manifest) {
  const now   = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const laws  = Object.entries(manifest).filter(([k]) => !k.startsWith("prec_"));
  const precs = Object.entries(manifest).filter(([k]) =>  k.startsWith("prec_"));

  const byFolder = {};
  for (const [name, info] of laws) {
    const f = info.folder || "기타";
    (byFolder[f] = byFolder[f] || []).push([name, info]);
  }

  const lines = [
    "# TAXIST 법령자료 인덱스", "",
    `> 마지막 업데이트: ${now}`,
    `> 수집 법령: ${laws.length}건 | 판례: ${precs.reduce((a,[,v])=>a+(v.count||0),0)}건`,
    "", "---", "",
  ];
  for (const [folder, items] of Object.entries(byFolder).sort()) {
    lines.push(`## ${folder}`, "", "| 법령명 | 시행일자 | 수집일 |", "|---|---|---|");
    for (const [name, info] of items.sort())
      lines.push(`| ${name} | ${info["시행일자"]||"-"} | ${(info.last_updated||"-").slice(0,10)} |`);
    lines.push("");
  }
  if (precs.length) {
    lines.push("## 판례", "", "| 세목 | 건수 | 수집일 |", "|---|---|---|");
    for (const [key, info] of precs)
      lines.push(`| ${key.replace("prec_","")} | ${info.count||0}건 | ${(info.last_updated||"-").slice(0,10)} |`);
    lines.push("");
  }
  fs.writeFileSync(path.join(OUT_DIR, "index.md"), lines.join("\n"), "utf8");
}

// ── 메인 ────────────────────────────────────────────────────
async function main() {
  if (!API_KEY) {
    console.error("오류: API 키를 입력해주세요.\n사용법: node scripts/fetch_all.mjs 인증키");
    process.exit(1);
  }

  log(`══════════════════════════════════`);
  log(`TAXIST 법령 ${IS_UPDATE ? "업데이트" : "전체 수집"} 시작`);
  log(`══════════════════════════════════`);

  mkdirp(OUT_DIR); mkdirp(PREC_DIR);
  const manifest = loadManifest();
  const updated  = [];

  // ── 1단계: 법령 목록 수집 ──
  log("\n[1/3] 법령 목록 수집 중...");
  const allLaws = new Map(); // MST → meta
  for (const query of SEARCH_QUERIES) {
    const items = await searchAllLaws(query);
    for (const item of items) {
      const mst = item["법령일련번호"];
      if (mst && item["현행연혁코드"] === "현행") allLaws.set(mst, item);
    }
  }
  log(`→ 고유 현행 법령 ${allLaws.size}건 발견`);

  // ── 2단계: 본문 다운로드 & MD 저장 ──
  log("\n[2/3] 법령 본문 다운로드 & MD 변환 중...");
  let idx = 0;
  for (const [mst, meta] of allLaws) {
    idx++;
    const name   = (meta["법령명한글"] || "").trim();
    const 시행일자 = meta["시행일자"] || "";

    // 업데이트 모드: 변경 없으면 스킵
    if (IS_UPDATE) {
      const ex = manifest[name] || {};
      if (ex.mst === mst && ex["시행일자"] === fmtDate(시행일자)) continue;
    }

    log(`  [${idx}/${allLaws.size}] ${name}`);
    await sleep(DELAY_MS);
    const detail = await apiGet("lawService.do", { target: "law", MST: mst });
    if (!detail) { log(`    본문 조회 실패: ${name}`); continue; }

    const md      = lawToMd(detail, meta);
    const folder  = getFolder(name);
    const dir     = path.join(OUT_DIR, folder);
    mkdirp(dir);
    fs.writeFileSync(path.join(dir, `${safeName(name)}.md`), md, "utf8");

    manifest[name] = {
      mst,
      "시행일자":    fmtDate(시행일자),
      "공포일자":    fmtDate(meta["공포일자"] || ""),
      folder,
      last_updated: new Date().toISOString().slice(0, 16).replace("T", " "),
    };
    updated.push(`[법령] ${name}`);
    saveManifest(manifest); // 중간 저장
  }
  log(`→ 법령 저장 완료: ${updated.length}건`);

  // ── 3단계: 판례 수집 ──
  log("\n[3/3] 판례 수집 중...");
  for (const [category, keywords] of Object.entries(PREC_QUERIES)) {
    if (IS_UPDATE) {
      const last = (manifest[`prec_${category}`] || {}).last_updated || "";
      if (last && (Date.now() - new Date(last).getTime()) < 7 * 86400000) {
        log(`  스킵 (7일 미경과): ${category}`); continue;
      }
    }
    log(`  수집 중: ${category}`);
    const list = await collectPrec(category, keywords);
    if (!list.length) continue;
    fs.writeFileSync(path.join(PREC_DIR, `${category}_판례.md`), precToMd(list, category), "utf8");
    manifest[`prec_${category}`] = { count: list.length, last_updated: new Date().toISOString().slice(0, 16).replace("T", " ") };
    updated.push(`[판례] ${category} ${list.length}건`);
    saveManifest(manifest);
    log(`  → ${category} ${list.length}건 저장`);
  }

  // ── 마무리 ──
  saveManifest(manifest);
  makeIndex(manifest);
  appendLog(updated);

  log(`\n══════════════════════════════════`);
  log(`완료: 총 ${updated.length}건 처리`);
  log(`법령자료: ${OUT_DIR}`);
  log(`판례자료: ${PREC_DIR}`);
  log(`══════════════════════════════════`);
}

main().catch(e => { console.error(e); process.exit(1); });
