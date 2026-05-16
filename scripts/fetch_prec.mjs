/**
 * 국가법령정보 API - 판례 전용 수집 스크립트
 * 사용법: node scripts/fetch_prec.mjs [API키]
 *         API키 생략 시 환경변수 LAW_API_KEY 사용
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

const _args   = process.argv.slice(2).filter(a => !a.startsWith("--"));
const API_KEY = _args[0] || process.env.LAW_API_KEY || "";
const BASE_URL = "https://www.law.go.kr/DRF";
const DELAY_MS = 400;

const PREC_DIR      = path.join(BASE_DIR, "판례자료");
const MANIFEST_FILE = path.join(BASE_DIR, "law_manifest.json");

// ── 세목별 판례 검색 키워드 ───────────────────────────────────
// 검색 결과가 많을수록 좋은 키워드를 우선으로, 광범위한 것부터 좁은 것 순서
const PREC_QUERIES = {
  "법인세": [
    "법인세", "이월결손금", "부당행위계산부인",
    "법인세법", "사업소득 법인",
  ],
  "부가세": [
    "부가가치세", "세금계산서", "매입세액공제",
    "영세율", "면세",
  ],
  "소득세": [
    "양도소득세", "종합소득세", "근로소득",
    "소득세법", "기타소득",
  ],
  "징세": [
    "체납처분", "압류", "국세징수",
    "공매", "가산세",
  ],
  "재산세": [
    "재산세", "취득세", "종합부동산세",
    "지방세", "등록면허세",
  ],
  "조사": [
    "세무조사", "과세처분", "경정청구",
    "조세불복", "심판청구",
  ],
  "개인세": [
    "상속세", "증여세", "양도소득세",
    "종합소득세", "소득세",
  ],
};

// ── 유틸 ─────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mkdirp(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function fmtDate(raw = "") {
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6)}`;
  return raw;
}
function str(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(x => str(x)).filter(Boolean).join(" ");
  if (typeof v === "object") return Object.values(v).map(x => str(x)).filter(Boolean).join(" ");
  return String(v).trim();
}
function log(msg) {
  console.log(`${new Date().toLocaleTimeString("ko-KR")}  ${msg}`);
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
      if (!res.ok) { log(`  HTTP ${res.status}`); return null; }
      const text = await res.text();
      try { return JSON.parse(text); }
      catch {
        // XML 에러 응답인 경우
        log(`  JSON 파싱 실패 (응답 미리보기): ${text.slice(0, 120)}`);
        return null;
      }
    } catch (e) {
      log(`  요청 실패 (${attempt+1}/3): ${e.message}`);
      await sleep(2000);
    }
  }
  return null;
}

// ── 판례 목록 검색 ───────────────────────────────────────────
async function searchPrec(keyword, maxCount = 100) {
  const results = []; const seen = new Set();
  let page = 1;
  while (results.length < maxCount) {
    await sleep(DELAY_MS);
    const data = await apiGet("lawSearch.do", {
      target:  "prec",
      query:   keyword,
      display: "20",
      page:    String(page),
      sort:    "ddes",   // 최신순
    });

    if (!data) { log(`    API 응답 없음 — 키워드: "${keyword}"`); break; }

    // 응답 구조 디버깅
    const wrap  = data["PrecSearch"] || data["precSearch"] || {};
    const total = parseInt(wrap["totalCnt"] || wrap["totalcount"] || "0", 10);
    let   items = wrap["prec"] || [];
    if (!Array.isArray(items)) items = items ? [items] : [];

    if (page === 1) {
      log(`    "${keyword}" → 전체 ${total}건 (이번 페이지 ${items.length}건)`);
    }

    for (const p of items) {
      const pid = p["판례정보일련번호"] || p["prec_seq"] || JSON.stringify(p).slice(0, 40);
      if (pid && !seen.has(pid)) { seen.add(pid); results.push(p); }
    }

    if (!items.length || page * 20 >= Math.min(total, maxCount)) break;
    page++;
  }
  return results;
}

// ── 판례 상세 조회 (판결요지 등 추가 정보) ────────────────────
async function fetchPrecDetail(seq) {
  await sleep(DELAY_MS);
  return await apiGet("lawService.do", { target: "prec", MST: seq });
}

// ── 판례 → MD 변환 ───────────────────────────────────────────
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
    const 사건명   = str(p["사건명"]   || p["case_nm"]   || "");
    const 사건번호  = str(p["사건번호"] || p["case_no"]   || "");
    const 선고일자  = fmtDate(str(p["선고일자"] || p["judmt_date"] || ""));
    const 법원     = str(p["법원명"]   || p["court_nm"]  || "");
    const 판시사항  = str(p["판시사항"] || p["jdgmn_matter"] || "");
    const 판결요지  = str(p["판결요지"] || p["jdgmn_summary"] || "");
    const 참조조문  = str(p["참조조문"] || p["ref_clause"] || "");
    const 참조판례  = str(p["참조판례"] || p["ref_prec"]   || "");

    lines.push(`## ${i+1}. ${사건명}`, "");
    lines.push(`| 항목 | 내용 |`, `|---|---|`);
    if (사건번호) lines.push(`| 사건번호 | ${사건번호} |`);
    if (선고일자) lines.push(`| 선고일자 | ${선고일자} |`);
    if (법원)    lines.push(`| 법원     | ${법원} |`);
    lines.push("");

    if (판시사항) { lines.push("**[판시사항]**", "", 판시사항, ""); }
    if (판결요지) { lines.push("**[판결요지]**", "", 판결요지, ""); }
    if (참조조문) { lines.push(`**참조조문:** ${참조조문}`, ""); }
    if (참조판례) { lines.push(`**참조판례:** ${참조판례}`, ""); }

    lines.push("---", "");
  });

  return lines.join("\n");
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  if (!API_KEY) {
    console.error("오류: API 키를 입력해주세요.\n사용법: node scripts/fetch_prec.mjs 인증키");
    process.exit(1);
  }

  log("══════════════════════════════════");
  log("TAXIST 판례 수집 시작");
  log(`API KEY: ${API_KEY}`);
  log("══════════════════════════════════");

  // ── API 연결 테스트 ──
  log("\n[사전] API 연결 테스트 중...");
  const testResult = await apiGet("lawSearch.do", { target: "prec", query: "법인세", display: "1", page: "1" });
  if (!testResult) {
    log("API 응답 실패 — API 키나 네트워크를 확인해주세요");
    process.exit(1);
  }
  log(`테스트 응답 키: ${Object.keys(testResult).join(", ")}`);
  const testWrap = testResult["PrecSearch"] || testResult["precSearch"] || {};
  log(`totalCnt: ${testWrap["totalCnt"] || testWrap["totalcount"] || "(키 없음)"}`);
  if (!testWrap["totalCnt"] && !testWrap["totalcount"]) {
    log("경고: 판례 API 응답 구조가 예상과 다릅니다.");
    log(`실제 응답: ${JSON.stringify(testResult).slice(0, 300)}`);
  }

  mkdirp(PREC_DIR);

  const manifest = (() => {
    try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")); }
    catch { return {}; }
  })();

  let totalSaved = 0;

  for (const [category, keywords] of Object.entries(PREC_QUERIES)) {
    log(`\n[${category}] 판례 수집 중...`);

    const all = []; const seen = new Set();
    for (const kw of keywords) {
      const items = await searchPrec(kw, 100);
      for (const p of items) {
        const id = str(p["판례정보일련번호"] || p["사건번호"] || JSON.stringify(p).slice(0,40));
        if (!seen.has(id)) { seen.add(id); all.push(p); }
      }
      if (all.length >= 200) break;
    }

    log(`  → ${category} 총 ${all.length}건 수집`);
    if (!all.length) { log(`  ⚠️  수집 건수 0 — 스킵`); continue; }

    const md = precToMd(all, category);
    const filePath = path.join(PREC_DIR, `${category}_판례.md`);
    fs.writeFileSync(filePath, md, "utf8");
    log(`  저장: ${filePath}`);

    manifest[`prec_${category}`] = {
      count: all.length,
      last_updated: new Date().toISOString().slice(0, 16).replace("T", " "),
    };
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), "utf8");
    totalSaved += all.length;
  }

  log("\n══════════════════════════════════");
  log(`완료: 총 ${totalSaved}건 판례 저장`);
  log(`저장 위치: ${PREC_DIR}`);
  log("══════════════════════════════════");

  if (totalSaved > 0) {
    log("\n다음 단계: D1에 시딩하려면 아래 명령 실행");
    log("  node scripts/seed_d1_api.mjs");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
