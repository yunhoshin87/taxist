/**
 * NTS 요약 MD 파일 → D1 시딩 (배치 INSERT, is_summary=1, nts_doc_id 포함)
 *
 * 사용법:
 *   node scripts/seed_summary.mjs
 *   node scripts/seed_summary.mjs --dry-run
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
if (!DRY_RUN) {
  const cfgPath = path.join(process.env.USERPROFILE || process.env.HOME, ".wrangler", "config", "default.toml");
  const cfg     = fs.readFileSync(cfgPath, "utf8");
  const m       = cfg.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) { console.error("wrangler oauth_token 없음. npx wrangler login 먼저 실행"); process.exit(1); }
  TOKEN = m[1];
}

const CONCURRENCY = 10; // 동시 병렬 INSERT 수

// 단일 행 INSERT
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

// 병렬 실행 헬퍼 (concurrency 제한)
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
    if (!DRY_RUN) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

    if (filesDone % 10 === 0 || filesDone <= 5) {
      console.log(`  [${filesDone}/${files.length}] ${file}: ${fileInserted}건 (누계 ${totalInserted.toLocaleString()}건)`);
    }
  }

  console.log(`\n완료: ${totalInserted.toLocaleString()}건 삽입`);

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
