/**
 * 국가법령정보 API - 전체 법령 다운로드 & MD 변환
 * Node.js 18+ 내장 fetch 사용 (별도 설치 불필요)
 *
 * 사용법:
 *   node scripts/fetch_all.mjs 인증키            전체 재수집 (모든 법령/판례를 처음부터 다시 받음)
 *   node scripts/fetch_all.mjs --update          증분 업데이트 (law_manifest.json과 비교해 변경분만 수집)
 *   (API 키는 첫 번째 위치 인수 또는 환경변수 LAW_API_KEY로 전달 가능)
 *
 * 실행 시점 / 다른 스크립트와의 관계:
 *   - GitHub Actions 워크플로 .github/workflows/update_laws.yml 가 이 스크립트를 직접 호출하는
 *     "메인" 수집 스크립트다. 매일 0시(KST, cron 15:00 UTC)에 `--update` 모드로 자동 실행되고,
 *     workflow_dispatch로 수동 트리거 시 mode=full을 선택하면 인자 없이(API 키는 env로) 전체 재수집 모드로 실행된다.
 *   - 워크플로는 이 스크립트가 끝난 뒤 법령자료/, 판례자료/, law_manifest.json, update_log.md 변경분을
 *     자동으로 git commit & push 한다.
 *   - 국가법령정보센터(law.go.kr) 공식 Open API만 사용하며, taxlaw.nts.go.kr 비공개 AJAX를 다루는
 *     fetch_all_taxlaw_full.mjs / fetch_incremental.mjs와는 별개의 독립 실행 스크립트다(서로 호출하지 않음).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 잡히지 않는 예외도 출력
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

const IS_UPDATE = process.argv.includes("--update");
// --update 같은 플래그를 제외한 첫 번째 인수를 API 키로 사용
const _args     = process.argv.slice(2).filter(a => !a.startsWith("--"));
const API_KEY   = _args[0] || process.env.LAW_API_KEY || "";
const BASE_URL  = "https://www.law.go.kr/DRF";
// 요청 간 350ms 대기 — 공식 API라도 짧은 간격으로 연속 호출하면 차단/지연될 수 있어 완충 시간을 둔다.
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
// 모든 API 호출 사이의 지연(DELAY_MS) 및 재시도 대기에 공통으로 사용
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

// law_manifest.json: 법령명 → {mst, 시행일자, 공포일자, folder, last_updated} 매핑.
// --update 모드에서 "이전에 수집한 시행일자와 동일하면 스킵"하는 변경분 판별 기준이자
// 인덱스(index.md) 생성에 쓰이는 메타데이터 저장소다. 파일이 없거나 손상되면 빈 객체로 시작(전체 재수집과 동일하게 동작).
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
// 국가법령정보센터 Open API는 JSON 응답을 지원하므로 정규식/HTML 파서 없이 res.json()으로 바로 구조화된
// 데이터를 받는다(별도 파싱 라이브러리 불필요). 최대 3회 재시도: 일시적 네트워크 오류나 타임아웃을 흡수하기 위함이며,
// 429(rate limit) 응답은 횟수 소진과 무관하게 10초를 더 기다린 뒤 같은 attempt를 재사용해 계속 시도한다.
async function apiGet(endpoint, params) {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set("OC",   API_KEY);
  url.searchParams.set("type", "JSON");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 30초 타임아웃: 응답이 없는 요청이 무한정 매달려 전체 수집을 막지 않도록 상한을 둔다.
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
      if (res.status === 429) { log("  Rate limit — 10초 대기..."); await sleep(10000); continue; }
      if (!res.ok) { log(`  HTTP ${res.status}: ${endpoint}`); return null; }
      return await res.json();
    } catch (e) {
      // 네트워크 오류/타임아웃 등 — 2초 대기 후 재시도. 3회 모두 실패하면 null을 반환해 호출 측에서 해당 항목만 스킵.
      log(`  요청 실패 (${attempt+1}/3): ${e.message}`);
      await sleep(2000);
    }
  }
  return null;
}

// ── 법령 목록 수집 ───────────────────────────────────────────
// 검색어(SEARCH_QUERIES) 1건당 페이지네이션으로 전량을 끝까지 순회한다.
// display=100: API가 허용하는 1회 최대 조회 건수에 맞춘 배치 크기(요청 수를 줄여 DELAY_MS 누적 대기시간을 최소화).
// 응답이 단일 객체일 때 배열이 아닌 객체로 오는 API 특성 때문에 매번 Array.isArray로 정규화한다.
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

// API 응답값을 안전하게 문자열로 변환 (리스트·딕셔너리 포함)
// 국가법령정보센터 JSON은 같은 필드가 문맥에 따라 문자열/배열/객체로 들쭉날쭉하게 내려오므로
// 모든 호출부에서 일관되게 다루기 위해 재귀적으로 문자열화하는 헬퍼를 둔다.
function str(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(x => str(x)).filter(Boolean).join("\n").trim();
  if (typeof v === "object") return Object.values(v).map(x => str(x)).filter(Boolean).join(" ").trim();
  return String(v).trim();
}

// 법령 API의 JSON 본문(조문/항/호/목 트리, 부칙)을 사람이 읽기 좋은 마크다운으로 변환.
// JSON으로 이미 구조화되어 있어 별도 HTML/XML 파서가 필요 없고, 트리를 그대로 순회하며
// 제목 레벨(##/###)과 항목 기호(circleNum, 호/목 들여쓰기)로 매핑한다.
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
// 세목(category)별로 여러 키워드(PREC_QUERIES)를 검색하되, 키워드 간 중복 판례가 많으므로
// "판례정보일련번호" 기준 Set으로 중복을 제거한다. 판례는 법령보다 건수가 많아 카테고리당 200건으로 상한을 두어
// (display=20 × 최대 10페이지) 전체 수집 시간과 저장 용량을 통제한다.
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
  console.log("스크립트 시작 — Node:", process.version, "| IS_UPDATE:", IS_UPDATE, "| API_KEY 설정:", !!API_KEY);
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
  // 여러 검색어가 동일 법령을 중복으로 찾아낼 수 있으므로 MST(법령일련번호)를 키로 하는 Map에 모아
  // 자동으로 중복을 제거한다. "현행연혁코드"가 "현행"인 것만 채택해 폐지/개정 이전 버전은 제외한다.
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

    // 업데이트 모드(--update): manifest에 저장된 mst·시행일자가 그대로면 내용 변경이 없다고 보고
    // API 호출/파일쓰기를 건너뛴다. 매일 자동 실행되는 워크플로에서 불필요한 재다운로드를 막아
    // API 호출량과 실행 시간을 줄이는 핵심 최적화다.
    if (IS_UPDATE) {
      const ex = manifest[name] || {};
      if (ex.mst === mst && ex["시행일자"] === fmtDate(시행일자)) continue;
    }

    log(`  [${idx}/${allLaws.size}] ${name}`);
    await sleep(DELAY_MS);
    const detail = await apiGet("lawService.do", { target: "law", MST: mst });
    if (!detail) { log(`    본문 조회 실패: ${name}`); continue; }

    const md      = lawToMd(detail, meta);
    // FOLDER_RULES(법령명 정규식 매칭)로 세목 폴더를 자동 분류해 法령자료/세목명/파일명.md 구조로 저장.
    // safeName으로 OS에서 금지된 파일명 문자를 치환해 저장 실패를 방지한다.
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
    // 법령 1건마다 manifest를 즉시 저장 — 수백 건 수집 도중 네트워크/타임아웃 등으로 중단돼도
    // 이미 처리한 항목의 진행 상황을 잃지 않도록 하기 위함(원자적 체크포인트 역할).
    saveManifest(manifest); // 중간 저장
  }
  log(`→ 법령 저장 완료: ${updated.length}건`);

  // ── 3단계: 판례 수집 ──
  // 판례는 법령처럼 "변경 여부"를 정확히 판별할 기준이 없고 검색 비용도 크므로,
  // --update 모드에서는 마지막 수집일로부터 7일이 지나지 않았으면 통째로 스킵해 매일 실행되는
  // 워크플로가 매번 판례까지 재수집하지 않도록 빈도를 낮춘다.
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
