/**
 * Cloudflare D1 REST API를 통해 MD 파일을 직접 삽입
 * 파라미터 쿼리를 사용하므로 크기·인코딩 문제 없음
 *
 * ◆ 목적
 *   seed_d1.mjs(SQL 텍스트 생성 + wrangler CLI 적재)와 달리, 이 스크립트는
 *   Cloudflare D1 REST API(query 엔드포인트)를 fetch로 직접 호출해 문서를
 *   삽입한다. SQL을 문자열로 조립하지 않고 파라미터 바인딩( ? + params 배열)을
 *   사용하므로 esc()류의 수동 escape 처리 없이도 SQL 인젝션/인용부호 깨짐
 *   문제가 발생하지 않는다. 또한 삽입 직후 documents_fts(FTS5)에도 같은
 *   내용을 동기화해 검색 인덱스를 즉시 최신 상태로 유지한다.
 *
 * ◆ 사용법
 *   node scripts/seed_d1_api.mjs
 *   (인자 없음)
 *
 * ◆ 필요 환경
 *   별도 환경변수 불필요. ~/.wrangler/config/default.toml의 oauth_token을
 *   읽어 Cloudflare API 인증에 사용하므로 사전에 `npx wrangler login` 필요.
 *   ACCOUNT_ID/DATABASE_ID는 코드 내 하드코딩(taxist-db D1 인스턴스 고정).
 *
 * ◆ 실행 시점
 *   수동 실행 전용. .github/workflows/update_laws.yml에는 등록되어 있지
 *   않음 (워크플로는 fetch_all.mjs만 호출).
 *
 * ◆ 다른 스크립트와의 관계
 *   입력: fetch_law*.mjs/fetch_prec*.mjs가 생성한 법령자료/, 판례자료/,
 *   법인세자료/ 폴더의 .md 파일 (seed_d1.mjs와 동일한 FOLDER_MAP/대상).
 *   seed_d1.mjs와 기능은 거의 동일하지만 적재 방식이 다르므로 둘 중 하나만
 *   사용하면 된다 — 둘 다 실행하면 INSERT OR IGNORE 덕에 중복 삽입은 막히지만
 *   불필요한 API 호출이 발생한다.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

const ACCOUNT_ID  = "143f2323446f7c53f496c331d3f6ebd2";
const DATABASE_ID = "f257e814-b8ff-4ba3-a45b-55981035b44a";
const API_URL     = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

// wrangler 토큰 읽기 — 로그인된 wrangler 세션의 OAuth 토큰을 재사용해
// 별도의 D1 API 토큰 발급/관리 없이 Cloudflare API를 호출한다.
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

// INSERT OR IGNORE: file_path 등에 걸린 UNIQUE 제약을 이용해 이미 적재된
// 문서를 재실행 시 건너뛴다 — 동일 스크립트를 여러 번 돌려도 중복 행이
// 쌓이지 않도록 하는 안전장치.
async function insertDoc(folderId, name, filePath, content, taxCategory) {
  const truncated = content.slice(0, MAX_CONTENT);
  const res = await d1Query(
    "INSERT OR IGNORE INTO documents (folder_id, name, file_path, content, tax_category, is_active) VALUES (?, ?, ?, ?, ?, 1)",
    [folderId, name, filePath, truncated, taxCategory]
  );
  // FTS5 인덱스 동기화 — documents에 새로 들어간 행(last_row_id)이 있을 때만
  // documents_fts에도 같은 rowid로 content를 반영해 검색이 즉시 가능하게 한다.
  // INSERT OR IGNORE로 건너뛴 경우(docId 없음)는 동기화할 필요가 없다.
  // FTS5 동기화 실패는 본 삽입 성공 여부에 영향이 없도록 catch로 무시한다.
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
      await new Promise(r => setTimeout(r, 80)); // rate limit — Cloudflare API 호출 제한 회피용 지연
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
