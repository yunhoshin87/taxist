/**
 * [여기/소유자 환경 전용] 미완료 해석례 목록 추출
 *
 * D1에서 아직 전문이 채워지지 않은 문서(is_summary=1)를 모두 뽑아
 * pending_docs.jsonl 파일로 저장한다. 이 파일을 다른 AI에게 전달한다.
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
