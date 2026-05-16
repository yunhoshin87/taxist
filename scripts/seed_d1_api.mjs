/**
 * Cloudflare D1 REST API를 통해 MD 파일을 직접 삽입
 * 파라미터 쿼리를 사용하므로 크기·인코딩 문제 없음
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

const ACCOUNT_ID  = "143f2323446f7c53f496c331d3f6ebd2";
const DATABASE_ID = "f257e814-b8ff-4ba3-a45b-55981035b44a";
const API_URL     = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

// wrangler 토큰 읽기
const WRANGLER_CONFIG = path.join(process.env.USERPROFILE || process.env.HOME, ".wrangler", "config", "default.toml");
const configContent   = fs.readFileSync(WRANGLER_CONFIG, "utf8");
const tokenMatch      = configContent.match(/oauth_token\s*=\s*"([^"]+)"/);
if (!tokenMatch) { console.error("wrangler 토큰을 찾을 수 없습니다"); process.exit(1); }
const TOKEN = tokenMatch[1];

const MAX_CONTENT = 50000; // 50KB per document

const FOLDER_MAP = {
  "법령자료/국세기본":      { id: 1,  tax: "all" },
  "법령자료/소득세":        { id: 2,  tax: "개인세" },
  "법령자료/법인세":        { id: 3,  tax: "법인세" },
  "법령자료/부가세":        { id: 4,  tax: "부가세" },
  "법령자료/상속증여세":    { id: 5,  tax: "개인세" },
  "법령자료/종합부동산세":  { id: 6,  tax: "재산세" },
  "법령자료/소비세기타":    { id: 7,  tax: "all" },
  "법령자료/조세특례":      { id: 8,  tax: "all" },
  "법령자료/관세":          { id: 9,  tax: "all" },
  "법령자료/지방세":        { id: 10, tax: "재산세" },
  "법령자료/불복절차":      { id: 11, tax: "all" },
  "법령자료/국제조세":      { id: 12, tax: "법인세" },
  "판례자료":               { id: 13, tax: "all" },
  "법인세자료":             { id: 18, tax: "법인세" },
};
const PREC_TAX = {
  "법인세_판례.md": "법인세",
  "부가세_판례.md": "부가세",
  "소득세_판례.md": "개인세",
  "징세_판례.md":   "징세",
  "재산세_판례.md": "재산세",
  "조세특례_판례.md": "all",
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

async function insertDoc(folderId, name, filePath, content, taxCategory) {
  const truncated = content.slice(0, MAX_CONTENT);
  const res = await d1Query(
    "INSERT OR IGNORE INTO documents (folder_id, name, file_path, content, tax_category, is_active) VALUES (?, ?, ?, ?, ?, 1)",
    [folderId, name, filePath, truncated, taxCategory]
  );
  // FTS5 인덱스 동기화
  const docId = res?.result?.[0]?.meta?.last_row_id;
  if (docId) {
    await d1Query(
      "INSERT OR REPLACE INTO documents_fts(rowid, content) VALUES (?, ?)",
      [docId, truncated]
    ).catch(() => {});
  }
}

async function main() {
  console.log("D1 REST API 시딩 시작...");
  let total = 0;

  // 법령자료 각 폴더
  for (const [relPath, info] of Object.entries(FOLDER_MAP)) {
    if (!relPath.startsWith("법령자료/")) continue;
    const dir = path.join(BASE_DIR, relPath);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), "utf8");
      const name    = file.replace(".md", "");
      process.stdout.write(`  [${relPath}] ${name.slice(0, 30)}... `);
      try {
        await insertDoc(info.id, name, `${relPath}/${file}`, content, info.tax);
        console.log("✓");
        total++;
      } catch (e) {
        console.log(`✗ ${e.message.slice(0, 60)}`);
      }
      await new Promise(r => setTimeout(r, 80)); // rate limit
    }
  }

  // 판례자료
  const precDir = path.join(BASE_DIR, "판례자료");
  if (fs.existsSync(precDir)) {
    const files = fs.readdirSync(precDir).filter(f => f.endsWith(".md"));
    for (const file of files) {
      const content  = fs.readFileSync(path.join(precDir, file), "utf8");
      const taxCat   = PREC_TAX[file] || "all";
      process.stdout.write(`  [판례자료] ${file}... `);
      try {
        await insertDoc(13, file.replace(".md",""), `판례자료/${file}`, content, taxCat);
        console.log("✓");
        total++;
      } catch (e) {
        console.log(`✗ ${e.message.slice(0, 60)}`);
      }
      await new Promise(r => setTimeout(r, 80));
    }
  }

  // 법인세자료 (업로드된 책 자료)
  const lawDir = path.join(BASE_DIR, "법인세자료");
  if (fs.existsSync(lawDir)) {
    for (const sub of fs.readdirSync(lawDir)) {
      const subPath = path.join(lawDir, sub);
      if (!fs.statSync(subPath).isDirectory()) continue;
      for (const file of fs.readdirSync(subPath).filter(f => f.endsWith(".md"))) {
        const content = fs.readFileSync(path.join(subPath, file), "utf8");
        process.stdout.write(`  [법인세자료/${sub}] ${file.slice(0,25)}... `);
        try {
          await insertDoc(18, file.replace(".md",""), `법인세자료/${sub}/${file}`, content, "법인세");
          console.log("✓");
          total++;
        } catch (e) {
          console.log(`✗ ${e.message.slice(0, 60)}`);
        }
        await new Promise(r => setTimeout(r, 80));
      }
    }
  }

  console.log(`\n완료: 총 ${total}건 삽입`);
}

main().catch(e => { console.error(e); process.exit(1); });
