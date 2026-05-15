/**
 * 법령자료·판례자료·법인세자료 MD 파일을 D1에 시딩
 *
 * 사용법:
 *   npx wrangler d1 execute taxist-db --file=schema.sql --remote
 *   node scripts/seed_d1.mjs | npx wrangler d1 execute taxist-db --file=- --remote
 *
 * 또는 SQL 파일로 저장 후 실행:
 *   node scripts/seed_d1.mjs > seed_data.sql
 *   npx wrangler d1 execute taxist-db --file=seed_data.sql --remote
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

// 폴더 ID 매핑 (schema.sql의 INSERT 순서와 동일)
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
  "판례자료":               { id: 13, tax: "all" },   // 판례 폴더
  "법인세자료":             { id: 18, tax: "법인세" },
};

// 판례 파일 → 세목 매핑
const PREC_TAX = {
  "법인세_판례.md": "법인세",
  "부가세_판례.md": "부가세",
  "소득세_판례.md": "개인세",
  "징세_판례.md":   "징세",
  "재산세_판례.md": "재산세",
  "조세특례_판례.md": "all",
};

function esc(str) {
  return (str || "").replace(/'/g, "''");
}

function sqlInsert(folderId, name, filePath, content, taxCategory) {
  const safeContent = esc(content.slice(0, 50000)); // D1 50KB 제한
  const safeName    = esc(name);
  const safePath    = esc(filePath);
  return `INSERT OR IGNORE INTO documents (folder_id, name, file_path, content, tax_category, is_active) VALUES (${folderId}, '${safeName}', '${safePath}', '${safeContent}', '${taxCategory}', 1);`;
}

const sqls = ["-- TAXIST D1 Document Seed", ""];

function processDir(dirPath, relPath) {
  if (!fs.existsSync(dirPath)) return;

  const folderInfo = FOLDER_MAP[relPath];
  if (!folderInfo) return;

  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    const content = fs.readFileSync(fullPath, "utf8");
    const name    = file.replace(".md", "");

    // 판례 파일은 개별 세목 설정
    let taxCat = folderInfo.tax;
    if (relPath === "판례자료") {
      taxCat = PREC_TAX[file] || "all";
    }

    sqls.push(sqlInsert(folderInfo.id, name, `${relPath}/${file}`, content, taxCat));
  }
}

// 법령자료 각 폴더
for (const [relPath] of Object.entries(FOLDER_MAP)) {
  if (relPath.startsWith("법령자료/")) {
    processDir(path.join(BASE_DIR, relPath), relPath);
  }
}

// 판례자료
processDir(path.join(BASE_DIR, "판례자료"), "판례자료");

// 법인세자료 (기존 업로드 자료)
const lawDir = path.join(BASE_DIR, "법인세자료");
if (fs.existsSync(lawDir)) {
  const subDirs = fs.readdirSync(lawDir);
  for (const sub of subDirs) {
    const subPath = path.join(lawDir, sub);
    if (!fs.statSync(subPath).isDirectory()) continue;
    const files = fs.readdirSync(subPath);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const content = fs.readFileSync(path.join(subPath, file), "utf8");
      sqls.push(sqlInsert(18, file.replace(".md",""), `법인세자료/${sub}/${file}`, content, "법인세"));
    }
  }
}

sqls.push("");
sqls.push("-- Seed 완료");
console.log(sqls.join("\n"));
