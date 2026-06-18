/**
 * 해석례자료 → Cloudflare D1 시딩 스크립트
 * fetch_taxlaw_interp.mjs 실행 후 이 스크립트를 실행하세요.
 *
 * ◆ 목적
 *   국세법령정보시스템에서 fetch_taxlaw_interp.mjs가 수집해 둔 세법해석례·
 *   불복결정례 MD 파일들(해석례자료/ 폴더, 세목별 접두사로 파일명 구분)을
 *   읽어 D1 documents 테이블에 삽입한다. 세목별 folders 행이 없으면 먼저
 *   생성(ensureFolder)한 뒤 문서를 그 폴더에 연결한다.
 *
 * ◆ 사용법
 *   node scripts/seed_interp.mjs  (인자 없음)
 *
 * ◆ 필요 환경
 *   별도 환경변수 불필요. ~/.wrangler/config/default.toml의 oauth_token으로
 *   Cloudflare D1 REST API를 호출하므로 `npx wrangler login` 선행 필요.
 *
 * ◆ 실행 시점
 *   수동 실행 전용. .github/workflows/update_laws.yml에는 등록되어 있지
 *   않음 (워크플로는 fetch_all.mjs만 호출, D1 시딩은 별도 수동 단계).
 *
 * ◆ 다른 스크립트와의 관계
 *   입력: fetch_taxlaw_interp.mjs가 생성한 해석례자료/ 폴더의 .md 파일
 *   (파일명이 INTERP_FOLDERS의 세목명으로 시작해야 분류됨).
 *   seed_summary.mjs와 달리 이 스크립트는 MD 파일 "전체"를 content로
 *   그대로 저장한다 (seed_summary.mjs는 MD 안의 여러 항목을 파싱해 개별
 *   행으로 분리 저장).
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
// id=19는 이미 "판례-조사" 폴더가 차지하고 있어 충돌하므로 법인세 해석례는
// 27번으로 옮겨 배정했다 (주석에 충돌 사유를 명시해 향후 ID 재배치 시 참고).
const INTERP_FOLDERS = {
  "법인세": { id: 27, tax: "법인세" },   // id=19는 판례-조사로 충돌, 27 사용
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

// 폴더를 명시적 id로 미리 고정 삽입 — 이 스크립트를 여러 번 실행해도
// 같은 id의 폴더가 이미 있으면 OR IGNORE로 건너뛰어 중복 생성을 막는다.
async function ensureFolder(id, name, path_, tax) {
  await d1Query(
    `INSERT OR IGNORE INTO folders (id, name, path, tax_category, is_active, sort_order)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [id, name, path_, tax, id]
  );
}

// INSERT OR IGNORE로 동일 문서 재삽입을 방지(재실행 안전성).
// 파라미터 바인딩을 사용하므로 MD 본문에 인용부호가 있어도 SQL 인젝션/
// 문법 오류 걱정 없이 그대로 넘길 수 있다.
async function insertDoc(folderId, name, filePath, content, taxCategory) {
  const truncated = content.slice(0, MAX_CONTENT);
  const res = await d1Query(
    "INSERT OR IGNORE INTO documents (folder_id, name, file_path, content, tax_category, is_active) VALUES (?, ?, ?, ?, ?, 1)",
    [folderId, name, filePath, truncated, taxCategory]
  );
  // 새로 삽입된 행만 FTS5 검색 인덱스에 동기화 (실패해도 무시 — 부가 기능).
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
