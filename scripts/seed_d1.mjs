/**
 * 법령자료·판례자료·법인세자료 MD 파일을 D1에 시딩
 *
 * ◆ 목적
 *   D1 REST API를 호출하지 않고, fetch_*.mjs가 로컬에 생성해 둔 법령자료/
 *   판례자료/법인세자료 폴더의 MD 파일들을 읽어 INSERT SQL 문을 stdout으로
 *   출력하는 "SQL 생성기"다. 실제 D1 적재는 이 출력을 wrangler d1 execute
 *   CLI(--file)에 파이프하거나 파일로 저장해 실행하는 단계에서 일어난다.
 *   즉 seed_d1_api.mjs(REST API 직접 호출)와 달리 이 스크립트 자체는
 *   네트워크 호출을 하지 않으며, wrangler CLI를 거치므로 wrangler가 SQL
 *   문 길이나 파일 크기를 알아서 처리해 줄 수 있다는 장점이 있다.
 *
 * ◆ 사용법
 *   npx wrangler d1 execute taxist-db --file=schema.sql --remote
 *   node scripts/seed_d1.mjs | npx wrangler d1 execute taxist-db --file=- --remote
 *
 * 또는 SQL 파일로 저장 후 실행:
 *   node scripts/seed_d1.mjs > seed_data.sql
 *   npx wrangler d1 execute taxist-db --file=seed_data.sql --remote
 *
 * ◆ 필요 환경
 *   별도 환경변수/토큰 불필요 (이 스크립트는 로컬 파일만 읽고 SQL 텍스트만
 *   출력함). 다만 실제 적재 단계인 wrangler d1 execute --remote 명령은
 *   wrangler 로그인 상태가 필요하다.
 *
 * ◆ 실행 시점
 *   수동 실행 전용. .github/workflows/update_laws.yml에는 등록되어 있지
 *   않음 (워크플로는 fetch_all.mjs만 호출하고 git에 MD 파일만 커밋함 —
 *   D1 시딩은 별도로 사람이 수동 실행해야 함).
 *
 * ◆ 다른 스크립트와의 관계
 *   입력: fetch_law*.mjs / fetch_prec*.mjs 등이 생성한 법령자료/, 판례자료/,
 *   법인세자료/ 폴더의 .md 파일. FOLDER_MAP의 폴더 ID는 schema.sql의 INSERT
 *   순서와 1:1로 맞춰져 있어야 하므로 schema.sql 변경 시 함께 갱신 필요.
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

// SQL 문자열 리터럴 안에 들어갈 텍스트의 단일 인용부호(')를 ''로 escape.
// 이 스크립트는 파라미터 바인딩( ? ) 없이 SQL 문자열을 직접 조립해 출력하므로
// (출력 결과가 wrangler CLI에 넘겨질 평문 SQL 파일이기 때문), MD 본문에 포함된
// 인용부호가 SQL 문법을 깨뜨리거나 인젝션으로 이어지지 않도록 직접 escape한다.
function esc(str) {
  return (str || "").replace(/'/g, "''");
}

// folder_id/INSERT OR IGNORE: 동일한 (file_path 등) 문서를 재실행 시 중복
// 삽입하지 않기 위해 OR IGNORE를 사용 — UNIQUE 제약 위반 시 에러 없이 그
// 행만 건너뛰므로, 이미 시딩된 데이터가 있는 상태에서 다시 돌려도 안전하다.
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
