/**
 * 판례 폴더 생성 + 문서 시딩 (wrangler OAuth 토큰 자동 사용)
 *
 * 사전 조건: npx wrangler login 완료 상태
 * 사용법: node scripts/seed_prec.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

const ACCOUNT_ID  = "143f2323446f7c53f496c331d3f6ebd2";
const DATABASE_ID = "f257e814-b8ff-4ba3-a45b-55981035b44a";
const API_URL     = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

const PREC_DIR = path.join(BASE_DIR, "판례자료");

// ── wrangler 토큰 읽기 ──────────────────────────────────────
function readWranglerToken() {
  const candidates = [
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".wrangler", "config", "default.toml"),
    path.join(process.env.HOME || "", ".wrangler", "config", "default.toml"),
  ];
  for (const p of candidates) {
    try {
      const content = fs.readFileSync(p, "utf8");
      const match   = content.match(/oauth_token\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {}
  }
  return null;
}

const TOKEN = readWranglerToken();
if (!TOKEN) {
  console.error("wrangler 토큰을 찾을 수 없습니다.\n먼저 'npx wrangler login' 을 실행하세요.");
  process.exit(1);
}

// ── D1 API ──────────────────────────────────────────────────
async function d1(sql, params = []) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!data.success) {
    const msg = JSON.stringify(data.errors);
    if (msg.includes("10000") || msg.includes("Authentication")) {
      console.error("\n❌ 인증 오류 — wrangler 토큰이 만료됐습니다.");
      console.error("   터미널에서 '! npx wrangler login' 을 실행 후 다시 시도하세요.\n");
      process.exit(1);
    }
    throw new Error(msg);
  }
  return data.result?.[0];
}

function log(msg) { console.log(`${new Date().toLocaleTimeString("ko-KR")}  ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 판례 파일 → 세목 매핑 ────────────────────────────────────
const FILE_TAX = {
  "법인세_판례.md": "법인세",
  "부가세_판례.md": "부가세",
  "소득세_판례.md": "개인세",
  "징세_판례.md":   "징세",
  "재산세_판례.md": "재산세",
  "조사_판례.md":   "조사",
  "개인세_판례.md": "개인세",
};

// 판례 폴더명 → 세목 매핑 (DB의 folders 테이블 기준)
const FOLDER_DEF = [
  { name: "판례-법인세", tax: "법인세", files: ["법인세_판례.md"] },
  { name: "판례-부가세", tax: "부가세", files: ["부가세_판례.md"] },
  { name: "판례-소득세", tax: "개인세", files: ["소득세_판례.md", "개인세_판례.md"] },
  { name: "판례-징세",   tax: "징세",   files: ["징세_판례.md"] },
  { name: "판례-재산세", tax: "재산세", files: ["재산세_판례.md"] },
  { name: "판례-조사",   tax: "조사",   files: ["조사_판례.md"] },
];

async function main() {
  log("════════════════════════════════");
  log("판례 폴더 & 문서 D1 시딩 시작");
  log("════════════════════════════════");

  // ── 1. 현재 folders 테이블 조회 ──
  log("\n[1/3] 기존 폴더 목록 조회 중...");
  const { results: existingFolders } = await d1("SELECT id, name FROM folders");
  const folderByName = Object.fromEntries(existingFolders.map(f => [f.name, f.id]));
  log(`  현재 폴더 수: ${existingFolders.length}개`);
  existingFolders.forEach(f => log(`    id=${f.id}  ${f.name}`));

  // ── 2. 판례 폴더 없으면 INSERT ──
  log("\n[2/3] 판례 폴더 생성 (없는 것만)...");
  const maxSortOrder = existingFolders.length;

  for (let i = 0; i < FOLDER_DEF.length; i++) {
    const def = FOLDER_DEF[i];
    if (folderByName[def.name]) {
      log(`  이미 있음: ${def.name} (id=${folderByName[def.name]})`);
      continue;
    }
    const sortOrder = maxSortOrder + i + 1;
    await d1(
      "INSERT INTO folders (name, path, tax_category, is_active, sort_order) VALUES (?, ?, ?, 1, ?)",
      [def.name, "판례자료", def.tax, sortOrder]
    );
    log(`  생성: ${def.name} (sort_order=${sortOrder})`);
    await sleep(100);
  }

  // 폴더 목록 재조회 (ID 확보)
  const { results: updatedFolders } = await d1("SELECT id, name FROM folders");
  const folderIdByName = Object.fromEntries(updatedFolders.map(f => [f.name, f.id]));
  log(`\n  폴더 확정:`);
  FOLDER_DEF.forEach(def => {
    log(`    ${def.name} → id=${folderIdByName[def.name]}`);
  });

  // ── 3. 판례 문서 시딩 ──
  log("\n[3/3] 판례 문서 D1 시딩 중...");
  const MAX_CONTENT = 40000;
  let totalInserted = 0;

  for (const def of FOLDER_DEF) {
    const folderId = folderIdByName[def.name];
    if (!folderId) { log(`  ⚠️  폴더 ID 없음: ${def.name}`); continue; }

    for (const fileName of def.files) {
      const filePath = path.join(PREC_DIR, fileName);
      if (!fs.existsSync(filePath)) {
        log(`  파일 없음: ${fileName} — fetch_prec.mjs 먼저 실행하세요`);
        continue;
      }

      const content = fs.readFileSync(filePath, "utf8");
      const docName = fileName.replace(".md", "");

      // 이미 있으면 스킵
      const { results: existing } = await d1(
        "SELECT id FROM documents WHERE folder_id = ? AND name = ?",
        [folderId, docName]
      );
      if (existing.length > 0) {
        log(`  이미 있음: ${docName}`);
        continue;
      }

      const truncated = content.slice(0, MAX_CONTENT);
      process.stdout.write(`  [${def.name}] ${docName}... `);
      try {
        await d1(
          "INSERT INTO documents (folder_id, name, file_path, content, tax_category, is_active) VALUES (?, ?, ?, ?, ?, 1)",
          [folderId, docName, `판례자료/${fileName}`, truncated, def.tax]
        );
        console.log("✓");
        totalInserted++;
      } catch (e) {
        console.log(`✗ ${e.message.slice(0, 80)}`);
      }
      await sleep(150);
    }
  }

  log("\n════════════════════════════════");
  log(`완료: ${totalInserted}개 문서 삽입`);
  log("관리자 페이지에서 판례 폴더를 확인하세요");
  log("════════════════════════════════");
}

main().catch(e => { console.error(e); process.exit(1); });
