/**
 * NTS 요약 MD 파일 → D1 시딩 (is_summary=1, nts_doc_id 포함)
 *
 * fetch_all_taxlaw_full.mjs 로 수집한 MD 파일들을 D1에 적재합니다.
 * 이미 시딩된 파일은 MANIFEST 기반으로 건너뜁니다.
 *
 * 사용법:
 *   node scripts/seed_summary.mjs
 *   node scripts/seed_summary.mjs --dry-run   (삽입 없이 파싱만 확인)
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");
const MD_DIR    = path.join(BASE_DIR, "해석례자료");
const MANIFEST  = path.join(BASE_DIR, "seed_summary_manifest.json");
const DRY_RUN   = process.argv.includes("--dry-run");

// ── Cloudflare D1 REST API ────────────────────────────────────
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const CF_API_TOKEN  = process.env.CF_API_TOKEN  || "";
const D1_DB_ID      = process.env.D1_DB_ID      || "";

if (!DRY_RUN && (!CF_ACCOUNT_ID || !CF_API_TOKEN || !D1_DB_ID)) {
  console.error("환경 변수 CF_ACCOUNT_ID, CF_API_TOKEN, D1_DB_ID 필요");
  process.exit(1);
}

async function d1Query(sql, params = []) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DB_ID}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(JSON.stringify(json.errors));
  return json.result?.[0];
}

// ── NTS 세목명 → D1 폴더 ID + tax_category ───────────────────
const TAX_FOLDER_MAP = {
  "법인세":     { folderId: 30, tax: "법인세" },
  "국제조세":   { folderId: 30, tax: "법인세" },
  "종합소득세": { folderId: 31, tax: "개인세" },
  "양도소득세": { folderId: 31, tax: "개인세" },
  "상속증여세": { folderId: 31, tax: "개인세" },
  "부가가치세": { folderId: 32, tax: "부가세" },
  "종합부동산세":{ folderId: 33, tax: "재산세" },
  "원천세":     { folderId: 34, tax: "징세" },
  "국세징수법": { folderId: 34, tax: "징세" },
  "조세특례":   { folderId: 35, tax: "all" },
  "소비세":     { folderId: 35, tax: "all" },
  "국세기본법": { folderId: 35, tax: "all" },
  "기타":       { folderId: 35, tax: "all" },
};

function getFolderInfo(taxName) {
  for (const [key, val] of Object.entries(TAX_FOLDER_MAP)) {
    if (taxName && taxName.includes(key)) return val;
  }
  return { folderId: 35, tax: "all" };
}

// ── MD 파일 파싱 ─────────────────────────────────────────────
function parseMdFile(content) {
  const items = [];
  // "## N. 제목" 단위로 분리
  const sections = content.split(/(?=^## \d+\.)/m).slice(1);

  for (const section of sections) {
    const titleMatch = section.match(/^## \d+\.\s*(.+)/m);
    const title   = titleMatch ? titleMatch[1].trim() : "";

    const getField = (key) => {
      const re = new RegExp(`\\|\\s*${key}\\s*\\|\\s*(.+?)\\s*\\|`, "m");
      const m = section.match(re);
      return m ? m[1].trim() : "";
    };

    const ntsId = getField("NTS_ID");
    const date  = getField("등록일");
    const tax   = getField("세목");
    const type  = getField("유형");

    // 요지: "**[요지]**" 이후 텍스트
    const gistMatch = section.match(/\*\*\[요지\]\*\*\s*\n+([\s\S]*?)(?=\n---|\n## |\s*$)/);
    const gist = gistMatch ? gistMatch[1].trim() : "";

    if (!title && !gist) continue;

    items.push({ ntsId, title, date, tax, type, gist });
  }
  return items;
}

function buildContent(item) {
  const lines = [
    `# ${item.title}`, "",
    "| 항목 | 내용 |", "|---|---|",
  ];
  if (item.date) lines.push(`| 등록일 | ${item.date} |`);
  if (item.tax)  lines.push(`| 세목   | ${item.tax} |`);
  if (item.type) lines.push(`| 유형   | ${item.type} |`);
  lines.push("");
  if (item.gist) lines.push("**[요지]**", "", item.gist, "");
  return lines.join("\n");
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(MD_DIR)) {
    console.error(`MD 디렉터리 없음: ${MD_DIR}`);
    process.exit(1);
  }

  const manifest = (() => {
    try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); }
    catch { return {}; }
  })();

  const files = fs.readdirSync(MD_DIR)
    .filter(f => f.endsWith(".md"))
    .sort();

  console.log(`MD 파일 수: ${files.length}개`);
  if (DRY_RUN) console.log("[DRY RUN 모드 — D1 삽입 없음]");

  let totalInserted = 0;
  let totalSkipped  = 0;
  let filesDone     = 0;

  for (const file of files) {
    if (manifest[file]) { totalSkipped++; continue; }

    const content = fs.readFileSync(path.join(MD_DIR, file), "utf8");
    const items   = parseMdFile(content);

    if (items.length === 0) {
      manifest[file] = { skipped: true, reason: "parse_empty" };
      continue;
    }

    let fileInserted = 0;
    for (const item of items) {
      const { folderId, tax } = getFolderInfo(item.tax);
      const docContent = buildContent(item);
      const docName    = `[${item.type || "해석례"}] ${item.title.slice(0, 120)}`;

      if (!DRY_RUN) {
        try {
          await d1Query(
            `INSERT INTO documents (folder_id, name, content, tax_category, is_active, nts_doc_id, is_summary, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, 1, ?)`,
            [folderId, docName, docContent, tax, item.ntsId || null, item.date || new Date().toISOString().slice(0, 10)]
          );
          fileInserted++;
        } catch (e) {
          console.error(`  삽입 오류 (${item.title.slice(0, 40)}): ${e.message}`);
        }
      } else {
        fileInserted++;
      }
    }

    totalInserted += fileInserted;
    filesDone++;
    manifest[file] = { done: true, count: fileInserted, date: new Date().toISOString().slice(0, 10) };

    if (!DRY_RUN) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

    if (filesDone % 10 === 0 || filesDone <= 5) {
      console.log(`  [${filesDone}/${files.length}] ${file}: ${fileInserted}건 (누계 ${totalInserted.toLocaleString()}건)`);
    }
  }

  console.log(`\n완료: ${totalInserted.toLocaleString()}건 삽입, ${totalSkipped}파일 스킵`);
  if (!DRY_RUN) {
    // FTS5 재인덱싱
    try {
      await d1Query("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')");
      console.log("FTS5 재인덱싱 완료");
    } catch (e) {
      console.log("FTS5 재인덱싱 실패 (수동으로 실행 필요):", e.message);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
