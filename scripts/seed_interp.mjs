/**
 * 해석례자료 → Cloudflare D1 시딩 스크립트
 * fetch_taxlaw_interp.mjs 실행 후 이 스크립트를 실행하세요.
 *
 * 사용법: node scripts/seed_interp.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

const ACCOUNT_ID  = "143f2323446f7c53f496c331d3f6ebd2";
const DATABASE_ID = "f257e814-b8ff-4ba3-a45b-55981035b44a";
const API_URL     = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

const WRANGLER_CONFIG = path.join(process.env.USERPROFILE || process.env.HOME, ".wrangler", "config", "default.toml");
const configContent   = fs.readFileSync(WRANGLER_CONFIG, "utf8");
const tokenMatch      = configContent.match(/oauth_token\s*=\s*"([^"]+)"/);
if (!tokenMatch) { console.error("wrangler 토큰 없음"); process.exit(1); }
const TOKEN = tokenMatch[1];

const MAX_CONTENT = 50000;

// 해석례 폴더 ID 매핑 (schema.sql id=19부터 시작)
const INTERP_FOLDERS = {
  "법인세": { id: 19, tax: "법인세" },
  "부가세": { id: 20, tax: "부가세" },
  "소득세": { id: 21, tax: "개인세" },
  "징세":   { id: 22, tax: "징세" },
  "재산세": { id: 23, tax: "재산세" },
  "조사":   { id: 24, tax: "조사" },
  "개인세": { id: 25, tax: "개인세" },
  "기타":   { id: 26, tax: "all" },
};

async function d1Query(sql, params = []) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(JSON.stringify(data.errors));
  return data;
}

async function ensureFolder(id, name, path_, tax) {
  await d1Query(
    `INSERT OR IGNORE INTO folders (id, name, path, tax_category, is_active, sort_order)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [id, name, path_, tax, id]
  );
}

async function insertDoc(folderId, name, filePath, content, taxCategory) {
  const truncated = content.slice(0, MAX_CONTENT);
  const res = await d1Query(
    "INSERT OR IGNORE INTO documents (folder_id, name, file_path, content, tax_category, is_active) VALUES (?, ?, ?, ?, ?, 1)",
    [folderId, name, filePath, truncated, taxCategory]
  );
  const docId = res?.result?.[0]?.meta?.last_row_id;
  if (docId) {
    await d1Query(
      "INSERT OR REPLACE INTO documents_fts(rowid, content) VALUES (?, ?)",
      [docId, truncated]
    ).catch(() => {});
  }
}

async function main() {
  console.log("해석례·불복결정례 D1 시딩 시작...");
  const interpDir = path.join(BASE_DIR, "해석례자료");

  if (!fs.existsSync(interpDir)) {
    console.error("해석례자료 폴더가 없습니다. 먼저 fetch_taxlaw_interp.mjs를 실행하세요.");
    process.exit(1);
  }

  let total = 0;

  for (const [category, info] of Object.entries(INTERP_FOLDERS)) {
    // 폴더 생성 보장
    await ensureFolder(
      info.id,
      `해석례-${category}`,
      `해석례자료/${category}`,
      info.tax
    );

    // 해당 세목 파일 목록
    const files = fs.readdirSync(interpDir)
      .filter(f => f.startsWith(category) && f.endsWith(".md"));

    for (const file of files) {
      const content = fs.readFileSync(path.join(interpDir, file), "utf8");
      const name    = file.replace(".md", "");
      process.stdout.write(`  [${category}] ${name.slice(0, 30)}... `);
      try {
        await insertDoc(info.id, name, `해석례자료/${file}`, content, info.tax);
        console.log("✓");
        total++;
      } catch (e) {
        console.log(`✗ ${e.message.slice(0, 60)}`);
      }
      await new Promise(r => setTimeout(r, 80));
    }
  }

  console.log(`\n완료: 총 ${total}건 삽입`);
  if (total === 0) {
    console.log("해석례자료 폴더에 파일이 없습니다.");
    console.log("먼저 node scripts/fetch_taxlaw_interp.mjs [API_KEY] 를 실행하세요.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
