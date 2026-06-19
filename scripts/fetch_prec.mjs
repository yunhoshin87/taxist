/**
 * 국가법령정보 API - 판례 전용 수집 스크립트
 *
 * [목적]
 * 국가법령정보센터 공개 API(law.go.kr/DRF)에서 세목별 키워드로 판례(대법원 판결,
 * 조세심판원·감사원·이의신청·과세적부심사 결정례)를 검색·상세조회해 세목별 마크다운
 * 파일(판례자료/{세목}_판례.md)로 저장하는 1차 수집 스크립트.
 *
 * [실행 시점 / 다른 스크립트와의 관계]
 * .github/workflows/update_laws.yml 워크플로에는 등록되어 있지 않다(자동 실행되는
 * 것은 fetch_all.mjs뿐). fetch_all.mjs 등 다른 어떤 스크립트도 이 파일을 import하거나
 * 호출하지 않으므로, 운영자가 판례만 별도로 다시 수집하고 싶을 때 수동으로 실행하는
 * 보조 스크립트로 보인다. 수집 후 D1에 반영하려면 seed_prec.mjs(또는 seed_d1_api.mjs)를
 * 별도로 수동 실행해야 한다(이 스크립트는 D1을 직접 건드리지 않음).
 *
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

// ── 세목별 판례·결정례 검색 키워드 ─────────────────────────
// 대법원 판결 + 조세심판원·감사원·이의신청·과세적부심사 결정례 모두 수집
// law.go.kr API는 세목 코드로 직접 필터링하는 기능이 없어, 세목별로 대표
// 키워드를 미리 정의해두고 키워드 검색을 여러 번 반복해 세목별 판례군을 모은다.
const PREC_QUERIES = {
  "법인세": [
    "법인세", "이월결손금", "부당행위계산부인",
    "법인세법", "사업소득 법인",
    "법인세 심판청구", "법인세 이의신청", "법인세 과세적부",
  ],
  "부가세": [
    "부가가치세", "세금계산서", "매입세액공제",
    "영세율", "면세",
    "부가가치세 심판청구", "부가가치세 이의신청",
  ],
  "소득세": [
    "양도소득세", "종합소득세", "근로소득",
    "소득세법", "기타소득",
    "양도소득세 심판청구", "소득세 이의신청",
  ],
  "징세": [
    "체납처분", "압류", "국세징수",
    "공매", "가산세",
    "체납 심판청구", "국세징수 이의신청", "체납처분 과세적부",
  ],
  "재산세": [
    "재산세", "취득세", "종합부동산세",
    "지방세", "등록면허세",
    "재산세 심판청구", "취득세 이의신청",
  ],
  "조사": [
    "세무조사", "과세처분", "경정청구",
    "조세불복", "심판청구",
    "과세적부심사", "세무조사 이의신청", "심사청구",
  ],
  "개인세": [
    "상속세", "증여세", "양도소득세",
    "종합소득세", "소득세",
    "상속세 심판청구", "증여세 이의신청", "상속세 과세적부",
  ],
};

// ── 유틸 ─────────────────────────────────────────────────────
// 요청 사이 지연 — law.go.kr API에 짧은 시간에 과도한 요청을 보내지 않기 위함
// (429 Rate limit 응답을 받으면 apiGet에서 추가로 더 길게 대기한다)
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
// 최대 3회 재시도: 일시적 네트워크 오류나 429(rate limit)는 재시도로 복구 가능하지만
// 무한 재시도는 배치 전체를 지연시키므로 상한을 둔다.
async function apiGet(endpoint, params) {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set("OC",   API_KEY);
  url.searchParams.set("type", "JSON"); // JSON 응답을 요청 (API는 XML도 지원하나 파싱 편의상 JSON 사용)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
      if (res.status === 429) { log("  Rate limit — 10초 대기..."); await sleep(10000); continue; } // rate limit 시 일반 재시도보다 더 길게 대기
      if (!res.ok) { log(`  HTTP ${res.status}`); return null; }
      const text = await res.text();
      try { return JSON.parse(text); }
      catch {
        // XML 에러 응답인 경우 (API가 오류 시 JSON 대신 XML을 반환하는 경우가 있음)
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

// ── 판례 목록 검색 ──────────────────────────────────────────
// 반환: [{ 판례일련번호, 사건명, 사건번호, 선고일자, 법원명, 데이터출처명 }, ...]
// 페이지(20건씩)를 돌며 maxCount에 도달하거나 더 이상 결과가 없을 때까지 수집.
// 판례일련번호로 중복을 걸러내(seen Set) 같은 판례가 여러 키워드에 걸려도 한 번만 보관.
async function searchPrec(keyword, maxCount = 50) {
  const results = []; const seen = new Set();
  let page = 1;
  while (results.length < maxCount) {
    await sleep(DELAY_MS); // 페이지 요청 사이 지연 — API 서버 부하 분산
    const data = await apiGet("lawSearch.do", {
      target:  "prec",
      query:   keyword,
      display: "20",
      page:    String(page),
      sort:    "ddes",
    });
    if (!data) break;
    const wrap  = data["PrecSearch"] || data["precSearch"] || {};
    const total = parseInt(wrap["totalCnt"] || "0", 10);
    let   items = wrap["prec"] || [];
    if (!Array.isArray(items)) items = items ? [items] : [];
    if (page === 1) log(`    "${keyword}" → 전체 ${total}건`);
    for (const p of items) {
      const pid = str(p["판례일련번호"]);   // ← 검색결과 필드명
      if (pid && !seen.has(pid)) { seen.add(pid); results.push(p); }
    }
    if (!items.length || results.length >= maxCount || page * 20 >= Math.min(total, maxCount)) break;
    page++;
  }
  return results;
}

// ── 판례 상세 조회 (대법원 판례만 가능) ──────────────────────
// law.go.kr 상세조회 API는 대법원 판례만 지원하므로, 조세심판원 결정 등
// 다른 출처는 상세조회가 실패(p["사건번호"] 없음)하며 호출부에서 기본 검색결과로 대체한다.
async function fetchPrecDetail(precId) {
  await sleep(DELAY_MS); // 상세조회 요청 사이 지연
  const data = await apiGet("lawService.do", { target: "prec", ID: precId }); // ← ID 파라미터
  if (!data) return null;
  const p = data["PrecService"] || data;
  if (typeof p === "string" || !p["사건번호"]) return null; // "일치하는 판례 없음" 처리
  return p;
}

// ── 판례 → MD 변환 ───────────────────────────────────────────
// HTML 태그가 섞인 응답 필드(판시사항/판결요지 등)는 <br>를 줄바꿈으로,
// 나머지 태그는 제거해 마크다운에 그대로 삽입 가능한 텍스트로 정리한다.
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
    const 사건명  = str(p["사건명"]  || p["case_nm"]  || "");
    const 사건번호 = str(p["사건번호"] || p["case_no"]  || "");
    const 선고일자 = fmtDate(str(p["선고일자"] || ""));
    const 법원    = str(p["법원명"]  || p["court_nm"] || "");
    const 출처    = str(p["데이터출처명"] || "");
    const 판시사항 = str(p["판시사항"] || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
    const 판결요지 = str(p["판결요지"] || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
    const 참조조문 = str(p["참조조문"] || "").replace(/<[^>]+>/g, "");
    const 참조판례 = str(p["참조판례"] || "").replace(/<[^>]+>/g, "");
    const 전문    = str(p["판례내용"] || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");

    lines.push(`## ${i+1}. ${사건명}`, "");
    lines.push(`| 항목 | 내용 |`, `|---|---|`);
    if (사건번호) lines.push(`| 사건번호 | ${사건번호} |`);
    if (선고일자) lines.push(`| 선고일자 | ${선고일자} |`);
    if (법원)    lines.push(`| 법원     | ${법원} |`);
    lines.push("");

    if (판시사항) lines.push("**[판시사항]**", "", 판시사항, "");
    if (판결요지) lines.push("**[판결요지]**", "", 판결요지, "");
    if (!판시사항 && !판결요지 && 전문) {
      // 판시사항/판결요지 없으면 전문 앞부분
      lines.push("**[판례내용]**", "", 전문.slice(0, 2000), "");
    }
    if (참조조문) lines.push(`**참조조문:** ${참조조문}`, "");
    if (참조판례) lines.push(`**참조판례:** ${참조판례}`, "");

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

    // 1단계: 키워드 검색 (기본 정보 수집)
    const itemMap = new Map(); // 판례일련번호 → 검색결과 객체 (중복 제거용)
    for (const kw of keywords) {
      const items = await searchPrec(kw, 50);
      for (const p of items) {
        const pid = str(p["판례일련번호"]);
        if (pid && !itemMap.has(pid)) itemMap.set(pid, p);
      }
      if (itemMap.size >= 100) break; // 세목당 최대 100건으로 제한 — 과도한 API 호출/파일 크기 방지
    }
    log(`  → 검색결과 ${itemMap.size}건, 상세 조회 시작...`);

    // 2단계: 모든 판례·결정례 상세 조회 시도 (대법원·조세심판원·감사원·이의신청·과세적부 포함)
    const all = [];
    let detailOk = 0, detailFail = 0;
    for (const [pid, basic] of itemMap) {
      const detail = await fetchPrecDetail(pid);
      if (detail) {
        all.push(detail);
        detailOk++;
      } else {
        // 상세 조회 실패 시 기본 정보 사용 (조세심판원 결정 등)
        all.push(basic);
        detailFail++;
      }
      if (all.length % 20 === 0) log(`    ${all.length}/${itemMap.size}건 처리중...`);
    }
    const sources = [...new Set(all.map(p => str(p["데이터출처명"] || p["법원명"] || "기타")))];
    log(`  → 상세조회 성공 ${detailOk}건, 기본정보 ${detailFail}건 | 출처: ${sources.join(", ")}`);

    log(`  → ${category} 상세 ${all.length}건 완료`);
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
