/**
 * [여기/소유자 환경 전용] 미완료 해석례 목록 추출 (D1 → pending_docs.jsonl)
 *
 * ◆ 목적
 *   seed_summary.mjs 등으로 D1에 먼저 "요약본"만 적재된 문서(is_summary=1,
 *   즉 아직 전문을 못 가져온 해석례)를 모두 조회해 scripts/pending_docs.jsonl로
 *   내보낸다. "pending"은 "전문 수집 대기 중" 상태를 의미하며, 이 파일을
 *   별도의 다른 AI/작업자에게 넘겨 각 문서의 전문(content)을 채우게 한 뒤,
 *   그 결과물을 import_collected.mjs로 다시 D1에 반영하는 2단계 워크플로의
 *   1단계(추출)에 해당한다.
 *
 * ◆ 사용법
 *   node scripts/export_pending.mjs
 *   (인자 없음. 환경변수도 불필요 — 토큰은 로컬 ~/.wrangler/config/default.toml
 *    에서 읽으므로 사전에 `npx wrangler login`이 되어 있어야 한다.)
 *
 * ◆ 실행 시점
 *   완전히 수동 실행 스크립트. .github/workflows/update_laws.yml은
 *   fetch_all.mjs만 호출하며 이 스크립트는 워크플로에 등록되어 있지 않다.
 *   (grep 결과: .github/ 내 어떤 워크플로에도 export_pending/import_collected/
 *    seed_* 스크립트에 대한 참조가 없음을 확인.)
 *
 * ◆ 다른 스크립트와의 관계
 *   - 입력: D1의 documents 테이블 (fetch_*.mjs가 만든 로컬 MD가 아니라
 *     이미 D1에 적재된 데이터를 대상으로 함)
 *   - 출력: scripts/pending_docs.jsonl → import_collected.mjs의 입력
 *     파일명(collected.jsonl)과는 다르므로, 받은 결과물을 collected.jsonl로
 *     이름 바꿔 저장해야 함을 인지할 것.
 *
 * 각 줄: {"id":123,"name":"...","nts_doc_id":"...","tax_category":"법인세"}
 *
 * 사용법:  node scripts/export_pending.mjs
 */
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR    = path.resolve(__dirname, "..");
const ACCOUNT_ID  = "143f2323446f7c53f496c331d3f6ebd2";
const DATABASE_ID = "f257e814-b8ff-4ba3-a45b-55981035b44a";
const OUT_FILE    = path.join(BASE_DIR, "scripts", "pending_docs.jsonl");
const BATCH       = 1000;

// wrangler CLI가 로그인 시 로컬에 저장해 둔 OAuth 토큰을 그대로 재사용한다.
// 별도의 D1 API 토큰을 환경변수로 발급/관리할 필요 없이, 이미 인증된
// wrangler 세션을 D1 REST API 호출에 그대로 활용하기 위한 트릭이다.
function getToken() {
  const p = path.join(process.env.USERPROFILE || process.env.HOME, ".wrangler", "config", "default.toml");
  const m = fs.readFileSync(p, "utf8").match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("wrangler 토큰 없음. `npx wrangler login` 먼저 실행하세요.");
  return m[1];
}
const TOKEN  = getToken();
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

async function d1Query(sql, params = []) {
  const res  = await fetch(D1_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`D1 오류: ${JSON.stringify(json.errors)}`);
  return json.result?.[0]?.results || [];
}

async function main() {
  const cnt = (await d1Query(
    "SELECT COUNT(*) AS n FROM documents WHERE is_summary = 1 AND is_active = 1"
  ))[0].n;
  console.log(`미완료(전문 없는) 문서: ${cnt.toLocaleString()}건`);

  const out = fs.createWriteStream(OUT_FILE);
  let offset = 0, written = 0;
  // D1 REST API는 한 번에 반환 가능한 결과 행 수/응답 크기에 제한이 있어
  // 전체 문서를 한 번에 SELECT하지 않고 BATCH(1000)건 단위로 페이지네이션한다.
  while (true) {
    const rows = await d1Query(
      `SELECT id, name, nts_doc_id, tax_category
       FROM documents WHERE is_summary = 1 AND is_active = 1
       ORDER BY id ASC LIMIT ? OFFSET ?`,
      [BATCH, offset]
    );
    if (!rows.length) break;
    for (const r of rows) { out.write(JSON.stringify(r) + "\n"); written++; }
    offset += BATCH;
    process.stdout.write(`\r  추출: ${written}/${cnt}`);
    if (rows.length < BATCH) break;
  }
  out.end();
  console.log(`\n완료 → ${OUT_FILE} (${written}건)`);
}
main().catch(e => { console.error("오류:", e.message); process.exit(1); });
