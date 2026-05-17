/**
 * 국세청 세법해석례 수집 스크립트
 * - 출처: 국세법령정보시스템 (taxlaw.nts.go.kr) OpenAPI
 * - 수집 대상:
 *   1) 세법해석례 (조문별·주제별) - 서면 회신, 기재부 예규
 *   2) 불복 결정례 - 과세적부심사, 이의신청, 심사청구, 심판청구
 *
 * 사용법:
 *   node scripts/fetch_taxlaw_interp.mjs [NTS_API_KEY]
 *
 * API 키 발급:
 *   https://www.data.go.kr → "국세청 세법해석례" 검색 후 활용신청
 *   또는 taxlaw.nts.go.kr 에서 직접 OpenAPI 신청
 *
 * ※ API_KEY 없이 실행하면 taxlaw.nts.go.kr 웹 파싱 모드로 동작 (속도 느림)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

const _args   = process.argv.slice(2).filter(a => !a.startsWith("--"));
const API_KEY = _args[0] || process.env.NTS_API_KEY || "";
const DELAY_MS = 500;

const OUT_DIR       = path.join(BASE_DIR, "해석례자료");
const MANIFEST_FILE = path.join(BASE_DIR, "law_manifest.json");

// ── 공공데이터포털 NTS 세법해석례 API ──────────────────────────
// 서비스 URL: https://apis.data.go.kr/1160100/service/GetFseIntprCaseService
const DATA_GO_BASE = "https://apis.data.go.kr/1160100/service/GetFseIntprCaseService";

// ── taxlaw.nts.go.kr 직접 API ──────────────────────────────────
// 목록 조회: GET /qt/USEQTA001L.do?sLawNm=&sType=&pageIndex=1
// 상세 조회: GET /qt/USEQTA002P.do?ntstDcmId=XXXX
const NTS_BASE = "https://taxlaw.nts.go.kr";

// ── 불복 결정례 유형 ───────────────────────────────────────────
// 조세심판원: https://www.tt.go.kr/opendata
const TT_BASE = "https://www.tt.go.kr";

// ── 세목별 수집 쿼리 ─────────────────────────────────────────
const INTERP_QUERIES = {
  "법인세":  ["법인세", "이월결손금", "부당행위계산", "법인"],
  "부가세":  ["부가가치세", "세금계산서", "매입세액", "영세율"],
  "소득세":  ["양도소득", "종합소득", "근로소득", "소득세"],
  "징세":    ["체납처분", "가산세", "국세징수", "압류"],
  "재산세":  ["재산세", "취득세", "종합부동산세"],
  "조사":    ["세무조사", "경정청구", "과세처분", "조세불복"],
  "개인세":  ["상속세", "증여세", "양도소득"],
};

// ── 불복 결정례 수집 유형 ────────────────────────────────────
const APPEAL_TYPES = [
  { code: "001", name: "과세적부심사" },
  { code: "002", name: "이의신청" },
  { code: "003", name: "심사청구" },
  { code: "004", name: "심판청구" },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mkdirp(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function log(msg) { console.log(`${new Date().toLocaleTimeString("ko-KR")}  ${msg}`); }
function str(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(x => str(x)).filter(Boolean).join(" ");
  if (typeof v === "object") return Object.values(v).map(x => str(x)).filter(Boolean).join(" ");
  return String(v).trim();
}

// ── 공공데이터포털 API 호출 ──────────────────────────────────
async function fetchDataGo(serviceId, params) {
  const url = new URL(`${DATA_GO_BASE}/${serviceId}`);
  url.searchParams.set("serviceKey", API_KEY);
  url.searchParams.set("pageNo", params.pageNo || "1");
  url.searchParams.set("numOfRows", params.numOfRows || "20");
  url.searchParams.set("resultType", "json");
  for (const [k, v] of Object.entries(params)) {
    if (!["pageNo", "numOfRows"].includes(k)) url.searchParams.set(k, v);
  }

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.response?.body || null;
  } catch (e) {
    log(`  API 오류: ${e.message}`);
    return null;
  }
}

// ── taxlaw.nts.go.kr 세법해석례 목록 조회 ─────────────────────
async function fetchNtsList(keyword, pageIndex = 1) {
  const url = new URL(`${NTS_BASE}/qt/USEQTA001L.do`);
  url.searchParams.set("sIntprTpCd", "");     // 해석 유형 전체
  url.searchParams.set("sKey", keyword);
  url.searchParams.set("pageIndex", String(pageIndex));

  try {
    await sleep(DELAY_MS);
    const res = await fetch(url.toString(), {
      headers: {
        "Accept": "application/json, text/html",
        "User-Agent": "Mozilla/5.0 (compatible; TAXIST-Bot/1.0)",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    // JSON 응답이면 파싱
    try { return JSON.parse(text); } catch { return null; }
  } catch (e) {
    log(`  NTS 목록 조회 오류: ${e.message}`);
    return null;
  }
}

// ── taxlaw.nts.go.kr 세법해석례 상세 조회 ────────────────────
async function fetchNtsDetail(ntstDcmId) {
  const url = `${NTS_BASE}/qt/USEQTA002P.do?ntstDcmId=${ntstDcmId}`;
  try {
    await sleep(DELAY_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TAXIST-Bot/1.0)" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseNtsDetail(html, ntstDcmId);
  } catch (e) {
    log(`  NTS 상세 조회 오류: ${e.message}`);
    return null;
  }
}

// ── HTML에서 세법해석례 정보 추출 ─────────────────────────────
function parseNtsDetail(html, id) {
  const stripTags = s => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();

  const titleMatch = html.match(/<th[^>]*>제\s*목<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i)
                  || html.match(/<title>(.*?)<\/title>/i);
  const docNoMatch = html.match(/문서번호[^<]*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  const dateMatch  = html.match(/회\s*신\s*일[^<]*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  const taxMatch   = html.match(/세\s*목[^<]*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  const qMatch     = html.match(/질의내용[^<]*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i)
                  || html.match(/질\s*의[^<]*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  const aMatch     = html.match(/회신내용[^<]*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i)
                  || html.match(/회\s*신[^<]*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);

  const title  = titleMatch ? stripTags(titleMatch[1]) : `세법해석례 ${id}`;
  const docNo  = docNoMatch ? stripTags(docNoMatch[1]) : "";
  const date   = dateMatch  ? stripTags(dateMatch[1])  : "";
  const tax    = taxMatch   ? stripTags(taxMatch[1])   : "";
  const q      = qMatch     ? stripTags(qMatch[1])     : "";
  const a      = aMatch     ? stripTags(aMatch[1])     : "";

  if (!a && !q) return null;

  return { id, title, docNo, date, tax, question: q, answer: a };
}

// ── 세법해석례 → MD 변환 ────────────────────────────────────
function interpToMd(list, category) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `# ${category} 세법해석례 모음`, "",
    `> **수집 건수:** ${list.length}건`,
    `> **수집일자:** ${today}`,
    `> **출처:** [국세법령정보시스템](https://taxlaw.nts.go.kr)`,
    "", "---", "",
  ];

  list.forEach((p, i) => {
    lines.push(`## ${i+1}. ${p.title || `해석례 ${p.id}`}`, "");
    lines.push(`| 항목 | 내용 |`, `|---|---|`);
    if (p.docNo)  lines.push(`| 문서번호 | ${p.docNo} |`);
    if (p.date)   lines.push(`| 회신일   | ${p.date} |`);
    if (p.tax)    lines.push(`| 세목     | ${p.tax} |`);
    lines.push("");
    if (p.question) lines.push("**[질의요지]**", "", p.question.slice(0, 1000), "");
    if (p.answer)   lines.push("**[회신내용]**", "", p.answer.slice(0, 2000), "");
    lines.push("---", "");
  });

  return lines.join("\n");
}

// ── 불복 결정례 → MD 변환 ────────────────────────────────────
function appealToMd(list, typeName, category) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `# ${category} ${typeName} 결정례 모음`, "",
    `> **수집 건수:** ${list.length}건`,
    `> **수집일자:** ${today}`,
    "", "---", "",
  ];

  list.forEach((p, i) => {
    const title = str(p["사건명"] || p["제목"] || `${typeName} ${i+1}`);
    const no    = str(p["결정번호"] || p["사건번호"] || "");
    const date  = str(p["결정일자"] || p["선고일자"] || "");
    const body  = str(p["결정요지"] || p["주문"] || p["내용"] || "");

    lines.push(`## ${i+1}. ${title}`, "");
    lines.push(`| 항목 | 내용 |`, `|---|---|`);
    if (no)   lines.push(`| 결정번호 | ${no} |`);
    if (date) lines.push(`| 결정일자 | ${date} |`);
    lines.push(`| 유형 | ${typeName} |`);
    lines.push("");
    if (body) lines.push("**[결정요지]**", "", body.slice(0, 2000), "");
    lines.push("---", "");
  });

  return lines.join("\n");
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  log("══════════════════════════════════");
  log("TAXIST 세법해석례·불복결정례 수집 시작");
  if (API_KEY) {
    log(`API KEY: ${API_KEY.slice(0, 8)}...`);
  } else {
    log("⚠️  API 키 없음 — taxlaw.nts.go.kr 직접 조회 모드");
    log("   공공데이터포털 API 키 발급 후 재실행을 권장합니다");
    log("   발급: https://www.data.go.kr → 국세청 세법해석례 검색");
  }
  log("══════════════════════════════════");

  mkdirp(OUT_DIR);
  const manifest = (() => {
    try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")); }
    catch { return {}; }
  })();

  let totalSaved = 0;

  // ── 세법해석례 수집 ──────────────────────────────────────
  log("\n[세법해석례] 수집 시작...");
  for (const [category, keywords] of Object.entries(INTERP_QUERIES)) {
    log(`\n  [${category}] 세법해석례 수집 중...`);
    const collected = [];
    const seenIds = new Set();

    for (const kw of keywords) {
      // 공공데이터포털 API 사용 가능한 경우
      if (API_KEY) {
        const body = await fetchDataGo("getFseIntprCase", {
          numOfRows: "30",
          srchType: "1",   // 1: 제목+내용
          srchWrd: kw,
          taxTpCd: "",     // 세목 코드 (빈값=전체)
        });
        if (body?.items?.item) {
          const items = Array.isArray(body.items.item) ? body.items.item : [body.items.item];
          for (const item of items) {
            const id = str(item["ntstDcmId"] || item["dcmId"] || "");
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              collected.push({
                id, title: str(item["dcmNm"] || item["ttl"] || ""),
                docNo: str(item["ntstDcmNo"] || ""),
                date:  str(item["rsltDt"] || item["replyDt"] || ""),
                tax:   str(item["taxTpNm"] || ""),
                question: str(item["qtCn"] || ""),
                answer:   str(item["rsCn"] || item["rsltCn"] || ""),
              });
            }
          }
          log(`    "${kw}" → ${items.length}건`);
        } else {
          log(`    "${kw}" → 결과 없음 (API 키 또는 서비스ID 확인 필요)`);
        }
      } else {
        // API 키 없을 때: taxlaw.nts.go.kr 직접 조회
        const listData = await fetchNtsList(kw, 1);
        if (listData && listData.list) {
          for (const item of listData.list.slice(0, 10)) {
            const id = str(item["ntstDcmId"] || "");
            if (!id || seenIds.has(id)) continue;
            seenIds.add(id);
            const detail = await fetchNtsDetail(id);
            if (detail) collected.push(detail);
          }
        }
      }
      await sleep(DELAY_MS);
      if (collected.length >= 50) break;
    }

    if (!collected.length) {
      log(`  ⚠️  ${category} 세법해석례 0건 — 스킵`);
      continue;
    }

    const md = interpToMd(collected, category);
    const filePath = path.join(OUT_DIR, `${category}_해석례.md`);
    fs.writeFileSync(filePath, md, "utf8");
    log(`  저장: ${filePath} (${collected.length}건)`);

    manifest[`interp_${category}`] = {
      count: collected.length,
      last_updated: new Date().toISOString().slice(0, 16).replace("T", " "),
    };
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), "utf8");
    totalSaved += collected.length;
  }

  // ── 불복 결정례 수집 ─────────────────────────────────────
  log("\n[불복 결정례] 수집 시작...");
  log("  (과세적부심사, 이의신청, 심사청구, 심판청구)");

  for (const [category, keywords] of Object.entries(INTERP_QUERIES)) {
    for (const appealType of APPEAL_TYPES) {
      log(`\n  [${category}/${appealType.name}] 수집 중...`);
      const collected = [];
      const seenIds = new Set();

      for (const kw of keywords.slice(0, 2)) {
        if (API_KEY) {
          // 공공데이터포털 불복 결정례 API (서비스ID는 발급 후 확인 필요)
          const body = await fetchDataGo("getFseIntprCase", {
            numOfRows: "20",
            srchType: "1",
            srchWrd: kw,
            intprTpCd: appealType.code,  // 과세적부:001, 이의신청:002, 심사청구:003, 심판청구:004
          });
          if (body?.items?.item) {
            const items = Array.isArray(body.items.item) ? body.items.item : [body.items.item];
            for (const item of items) {
              const id = str(item["ntstDcmId"] || "");
              if (id && !seenIds.has(id)) {
                seenIds.add(id);
                collected.push({
                  사건명:   str(item["dcmNm"] || ""),
                  결정번호: str(item["ntstDcmNo"] || ""),
                  결정일자: str(item["rsltDt"] || ""),
                  결정요지: str(item["rsltCn"] || item["rsCn"] || ""),
                });
              }
            }
          }
        }
        await sleep(DELAY_MS);
        if (collected.length >= 20) break;
      }

      if (!collected.length) {
        log(`    ${appealType.name} 0건 — 스킵 (API 키 필요 또는 데이터 없음)`);
        continue;
      }

      const md = appealToMd(collected, appealType.name, category);
      const filePath = path.join(OUT_DIR, `${category}_${appealType.name}.md`);
      fs.writeFileSync(filePath, md, "utf8");
      log(`  저장: ${filePath} (${collected.length}건)`);

      manifest[`appeal_${category}_${appealType.code}`] = {
        type: appealType.name,
        count: collected.length,
        last_updated: new Date().toISOString().slice(0, 16).replace("T", " "),
      };
      fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), "utf8");
      totalSaved += collected.length;
    }
  }

  log("\n══════════════════════════════════");
  log(`완료: 총 ${totalSaved}건 저장`);
  log(`저장 위치: ${OUT_DIR}`);
  log("══════════════════════════════════");

  if (totalSaved > 0) {
    log("\n다음 단계: D1에 시딩하려면");
    log("  node scripts/seed_interp.mjs");
  } else {
    log("\n⚠️  수집 결과가 없습니다.");
    log("   NTS_API_KEY 환경변수 또는 첫 번째 인수로 API 키를 전달하세요.");
    log("   발급: https://www.data.go.kr → '국세청 세법해석례' 검색 후 활용신청");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
