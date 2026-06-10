/**
 * [여기/소유자 환경 전용] 다른 AI가 수집한 전문을 D1에 반영
 *
 * 입력:  scripts/collected.jsonl  (각 줄 {id, content, nts_doc_id})  — 다른 AI가 만들어 전달
 * 동작:  documents 테이블에 content 채우고 is_summary=0 으로 전환, nts_doc_id 보강
 *        → 마지막에 FTS5 재인덱싱
 *
 * 사용법:
 *   node scripts/import_collected.mjs            # 반영 + FTS rebuild
 *   node scripts/import_collected.mjs --dry-run  # 검증만 (DB 변경 없음)
 *   node scripts/import_collected.mjs --no-fts   # 반영만, FTS rebuild 생략
 */
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR    = path.resolve(__dirname, "..");
const ACCOUNT_ID  = "143f2323446f7c53f496c331d3f6ebd2";
const DATABASE_ID = "f257e814-b8ff-4ba3-a45b-55981035b44a";
const IN_FILE     = path.join(BASE_DIR, "scripts", "collected.jsonl");

const DRY_RUN = process.argv.includes("--dry-run");
const NO_FTS  = process.argv.includes("--no-fts");
const CONCURRENCY = 10;

function getToken() {
  const p = path.join(process.env.USERPROFILE || process.env.HOME, ".wrangler", "config", "default.toml");
  const m = fs.readFileSync(p, "utf8").match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("wrangler 토큰 없음. `npx wrangler login` 먼저 실행하세요.");
  return m[1];
}
const TOKEN  = DRY_RUN ? "" : getToken();
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

async function d1Query(sql, params = []) {
  if (DRY_RUN) return [];
  const res  = await fetch(D1_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`D1 오류: ${JSON.stringify(json.errors)}`);
  return json.result?.[0]?.results || [];
}

function loadRecords() {
  if (!fs.existsSync(IN_FILE)) {
    console.error(`입력 파일 없음: ${IN_FILE}\n다른 AI가 만든 collected.jsonl 을 scripts/ 에 두세요.`);
    process.exit(1);
  }
  const recs = [];
  for (const [i, line] of fs.readFileSync(IN_FILE, "utf8").trim().split("\n").entries()) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { console.warn(`  [건너뜀] ${i + 1}행 JSON 파싱 실패`); continue; }
    if (typeof r.id !== "number" || !r.content || r.content.length < 10) { console.warn(`  [건너뜀] ${i + 1}행 id/content 유효성 미달`); continue; }
    recs.push(r);
  }
  return recs;
}

async function main() {
  const recs = loadRecords();
  console.log(`유효 레코드: ${recs.length}건  (DRY_RUN=${DRY_RUN})`);
  if (!recs.length) return;

  let ok = 0, fail = 0, n = 0;
  for (let i = 0; i < recs.length; i += CONCURRENCY) {
    const chunk = recs.slice(i, i + CONCURRENCY);
    const res = await Promise.allSettled(chunk.map(async r => {
      await d1Query(
        "UPDATE documents SET content = ?, is_summary = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [r.content, r.id]
      );
      if (r.nts_doc_id) {
        await d1Query("UPDATE documents SET nts_doc_id = ? WHERE id = ? AND nts_doc_id IS NULL",
          [String(r.nts_doc_id), r.id]);
      }
    }));
    for (const x of res) { if (x.status === "fulfilled") ok++; else { fail++; console.log("  [실패]", x.reason?.message); } }
    n += chunk.length;
    if (n % 200 === 0 || n === recs.length) process.stdout.write(`\r  반영: ${n}/${recs.length} (성공 ${ok}, 실패 ${fail})`);
  }
  console.log(`\n반영 완료: 성공 ${ok}, 실패 ${fail}`);

  if (!DRY_RUN && !NO_FTS) {
    console.log("FTS5 재인덱싱 중...");
    try {
      execSync(`npx wrangler d1 execute taxist-db --remote --command "INSERT INTO documents_fts(documents_fts) VALUES('rebuild')"`,
        { stdio: "inherit", cwd: BASE_DIR });
      console.log("FTS5 재인덱싱 완료");
    } catch (e) {
      console.log(`FTS5 재인덱싱 실패 — 수동 실행 필요: ${e.message}`);
      console.log(`  npx wrangler d1 execute taxist-db --remote --command "INSERT INTO documents_fts(documents_fts) VALUES('rebuild')"`);
    }
  }
}
main().catch(e => { console.error("치명적 오류:", e.message); process.exit(1); });
