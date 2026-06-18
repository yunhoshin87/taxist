/**
 * NTS 요약 MD 파일 → D1 시딩 (배치 INSERT, is_summary=1, nts_doc_id 포함)
 *
 * ◆ 목적
 *   국세법령정보시스템(NTS)에서 받아온 "요약본" 해석례 MD 파일(해석례자료/
 *   폴더, 한 파일에 여러 건이 "## N. 제목" 형식으로 들어있음)을 파싱해
 *   각 항목을 documents 테이블의 한 행으로 분리 저장한다. 이 단계에서는
 *   아직 전문을 가져오지 않은 "요약"만 적재하는 것이므로 is_summary=1로
 *   표시한다 — 이후 export_pending.mjs가 이 is_summary=1 문서들을 추출해
 *   전문 보강 작업을 의뢰하고, import_collected.mjs가 전문을 받아와
 *   is_summary=0으로 전환시키는 흐름과 연결된다.
 *
 * ◆ 사용법
 *   node scripts/seed_summary.mjs
 *   node scripts/seed_summary.mjs --dry-run   # DB 변경 없이 파싱/건수만 확인
 *
 * ◆ 필요 환경
 *   --dry-run이 아니면 ~/.wrangler/config/default.toml의 oauth_token으로
 *   Cloudflare D1 REST API를 호출하므로 `npx wrangler login` 선행 필요.
 *
 * ◆ 실행 시점
 *   수동 실행 전용. .github/workflows/update_laws.yml에는 등록되어 있지
 *   않음 (워크플로는 fetch_all.mjs만 호출).
 *
 * ◆ 다른 스크립트와의 관계
 *   입력: 해석례자료/ 폴더의 .md (fetch_taxlaw_interp.mjs류가 생성).
 *   seed_interp.mjs는 MD 파일 전체를 그대로 content로 저장하지만, 이
 *   스크립트는 한 MD 파일 안의 "## N." 섹션을 각각 파싱해 여러 documents
 *   행으로 쪼개 저장한다는 점이 다르다 (대상 폴더가 같아 보여도 데이터
 *   적재 단위/스키마 사용 방식이 다르므로 동시 운영 시 혼란에 주의).
 *   처리 완료 여부는 scripts/../seed_summary_manifest.json(BASE_DIR 기준)에
 *   파일 단위로 기록해, 재실행 시 이미 처리한 파일은 건너뛴다(재시작 가능성 보장).
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");
const MD_DIR    = path.join(BASE_DIR, "해석례자료");
const MANIFEST  = path.join(BASE_DIR, "seed_summary_manifest.json");
const DRY_RUN   = process.argv.includes("--dry-run");

// ── Cloudflare 인증 (wrangler oauth_token) ───────────────────
const ACCOUNT_ID  = "143f2323446f7c53f496c331d3f6ebd2";
const DATABASE_ID = "f257e814-b8ff-4ba3-a45b-55981035b44a";
const QUERY_URL   = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

let TOKEN = "";
// dry-run에서는 토큰을 읽지 않음 — wrangler 로그인이 안 된 환경에서도
// 파싱 결과만 미리 점검할 수 있게 하기 위함.
if (!DRY_RUN) {
  const cfgPath = path.join(process.env.USERPROFILE || process.env.HOME, ".wrangler", "config", "default.toml");
  const cfg     = fs.readFileSync(cfgPath, "utf8");
  const m       = cfg.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) { console.error("wrangler oauth_token 없음. npx wrangler login 먼저 실행"); process.exit(1); }
  TOKEN = m[1];
}

const CONCURRENCY = 10; // 동시 병렬 INSERT 수 — D1 API 호출 처리량과 안정성의 균형점

// 단일 행 INSERT. 파라미터 바인딩(? + params)을 사용해 MD 본문에 포함된
// 인용부호 등으로 인한 SQL 인젝션/문법 오류를 방지한다.
// 주의: 이 INSERT는 OR IGNORE/OR REPLACE가 없는 일반 INSERT이므로, 동일
// 항목을 다시 처리하면 중복 행이 쌓일 수 있다 — 그 대신 manifest 파일로
// "이미 처리한 MD 파일"을 추적해 같은 파일을 재실행하지 않도록 막는다
// (파일 단위 멱등성. 항목 단위 UNIQUE 제약에 의존하지 않음).
async function d1Insert(row) {
  const sql = `INSERT INTO documents (folder_id, name, content, tax_category, is_active, nts_doc_id, is_summary, updated_at)
               VALUES (?, ?, ?, ?, 1, ?, 1, ?)`;
  const res = await fetch(QUERY_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params: row }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(JSON.stringify(json.errors));
  return json.result;
}

// 병렬 실행 헬퍼 (concurrency 제한) — 전체 행을 한꺼번에 Promise.all하면
// D1 API에 과도한 동시 요청이 몰려 rate limit/타임아웃 위험이 있으므로
// CONCURRENCY 단위로 나눠 순차 배치 처리한다.
async function pMap(arr, fn, concurrency) {
  let done = 0;
  const results = [];
  for (let i = 0; i < arr.length; i += concurrency) {
    const chunk = arr.slice(i, i + concurrency);
    const res   = await Promise.allSettled(chunk.map(fn));
    results.push(...res);
    done += chunk.length;
  }
  return results;
}

// ── NTS 세목명 → D1 폴더 ID + tax_category ───────────────────
const TAX_FOLDER_MAP = [
  ["법인세",     { folderId: 30, tax: "법인세" }],
  ["국제조세",   { folderId: 30, tax: "법인세" }],
  ["종합소득세", { folderId: 31, tax: "개인세" }],
  ["양도소득세", { folderId: 31, tax: "개인세" }],
  ["상속증여세", { folderId: 31, tax: "개인세" }],
  ["부가가치세", { folderId: 32, tax: "부가세" }],
  ["종합부동산세",{ folderId: 33, tax: "재산세" }],
  ["원천세",     { folderId: 34, tax: "징세" }],
  ["국세징수법", { folderId: 34, tax: "징세" }],
];

function getFolderInfo(taxName) {
  for (const [key, val] of TAX_FOLDER_MAP) {
    if (taxName && taxName.includes(key)) return val;
  }
  return { folderId: 35, tax: "all" };
}

// ── MD 파일 파싱 ─────────────────────────────────────────────
// 한 MD 파일에 "## N. 제목" 형식으로 여러 해석례 항목이 들어있으므로
// 그 헤딩을 기준으로 섹션을 분리한다(lookahead split). slice(1)은 첫
// "## 1." 앞에 오는 머리말/설명 텍스트(섹션이 아닌 부분)를 제외하기 위함.
function parseMdFile(content) {
  const items  = [];
  const sections = content.split(/(?=^## \d+\.)/m).slice(1);

  for (const section of sections) {
    const titleMatch = section.match(/^## \d+\.\s*(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : "";

    const field = (key) => {
      const re = new RegExp(`\\|\\s*${key}\\s*\\|\\s*(.+?)\\s*\\|`, "m");
      const m  = section.match(re);
      return m ? m[1].trim() : "";
    };

    const ntsId = field("NTS_ID");
    const date  = field("등록일");
    const tax   = field("세목");
    const type  = field("유형");

    const gistMatch = section.match(/\*\*\[요지\]\*\*\s*\n+([\s\S]*?)(?=\n---|\n## |\s*$)/);
    const gist = gistMatch ? gistMatch[1].trim() : "";

    if (!title && !gist) continue;
    items.push({ ntsId, title, date, tax, type, gist });
  }
  return items;
}

function buildContent(item) {
  const lines = [`# ${item.title}`, "", "| 항목 | 내용 |", "|---|---|"];
  if (item.date) lines.push(`| 등록일 | ${item.date} |`);
  if (item.tax)  lines.push(`| 세목   | ${item.tax} |`);
  if (item.type) lines.push(`| 유형   | ${item.type} |`);
  lines.push("");
  if (item.gist) lines.push("**[요지]**", "", item.gist, "");
  return lines.join("\n");
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(MD_DIR)) { console.error(`MD 폴더 없음: ${MD_DIR}`); process.exit(1); }

  const manifest = (() => {
    try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return {}; }
  })();

  const files = fs.readdirSync(MD_DIR).filter(f => f.endsWith(".md")).sort();
  console.log(`MD 파일: ${files.length}개 | CONCURRENCY: ${CONCURRENCY} | ${DRY_RUN ? "[DRY RUN]" : "실제 삽입"}`);

  let totalInserted = 0;
  let filesDone     = 0;

  for (const file of files) {
    // manifest에 done 표시된 파일은 건너뛴다 — 대량 파일을 처리하다 중간에
    // 실패/중단되어도 처음부터 다시 돌릴 필요 없이 이어서 진행할 수 있게
    // 하는 재시작(resume) 로직.
    if (manifest[file]?.done) continue;

    const content = fs.readFileSync(path.join(MD_DIR, file), "utf8");
    const items   = parseMdFile(content);
    if (!items.length) { manifest[file] = { skipped: true }; continue; }

    // 각 레코드를 params 행으로 변환
    const allRows = items.map(item => {
      const { folderId, tax } = getFolderInfo(item.tax);
      return [
        folderId,
        `[${item.type || "해석례"}] ${item.title.slice(0, 120)}`,
        buildContent(item),
        tax,
        item.ntsId || null,
        item.date || new Date().toISOString().slice(0, 10),
      ];
    });

    let fileInserted = 0;
    if (DRY_RUN) {
      fileInserted = allRows.length;
    } else {
      // CONCURRENCY 개씩 병렬 단일 INSERT
      const results = await pMap(allRows, async (row) => {
        await d1Insert(row);
      }, CONCURRENCY);
      fileInserted = results.filter(r => r.status === "fulfilled").length;
      const failed  = results.filter(r => r.status === "rejected").length;
      if (failed > 0) console.error(`  오류 ${failed}건 (${file})`);
    }

    totalInserted += fileInserted;
    filesDone++;
    manifest[file] = { done: true, count: fileInserted };
    // 파일 처리마다 매니페스트를 즉시 저장 — 중간에 프로세스가 죽어도
    // 마지막으로 완료된 파일까지는 기록이 남아 재실행 시 중복 삽입 없이
    // 이어서 진행할 수 있다.
    if (!DRY_RUN) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

    if (filesDone % 10 === 0 || filesDone <= 5) {
      console.log(`  [${filesDone}/${files.length}] ${file}: ${fileInserted}건 (누계 ${totalInserted.toLocaleString()}건)`);
    }
  }

  console.log(`\n완료: ${totalInserted.toLocaleString()}건 삽입`);

  // 개별 INSERT만으로는 FTS5 가상 테이블이 자동 갱신되지 않으므로, 모든
  // 파일 처리가 끝난 뒤 한 번에 rebuild하여 검색 인덱스를 최신화한다.
  if (!DRY_RUN) {
    console.log("FTS5 재인덱싱 중...");
    try {
      // wrangler로 FTS5 rebuild
      const { execSync } = await import("child_process");
      execSync(`npx wrangler d1 execute taxist-db --remote --command="INSERT INTO documents_fts(documents_fts) VALUES('rebuild')"`, { stdio: "inherit" });
    } catch (e) {
      console.error("FTS5 rebuild 실패:", e.message);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
