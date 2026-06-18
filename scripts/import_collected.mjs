/**
 * [여기/소유자 환경 전용] 다른 AI가 수집한 전문을 D1에 반영
 *
 * ◆ 목적 / 다른 스크립트와의 관계
 *   export_pending.mjs로 뽑아낸 pending_docs.jsonl(전문 없는 문서 목록)을
 *   다른 작업자/AI에게 넘겨 전문을 채우게 한 결과물이 scripts/collected.jsonl
 *   이며, 이 스크립트는 그 결과물을 다시 D1에 반영하는 2단계 워크플로의
 *   마지막 단계다. "collected" = "(전문이) 수집된" 상태를 의미. 반영 후에는
 *   해당 문서가 더 이상 요약 상태가 아니므로 is_summary를 0으로 전환한다.
 *
 * 입력:  scripts/collected.jsonl  (각 줄 {id, content, nts_doc_id})  — 다른 AI가 만들어 전달
 * 동작:  documents 테이블에 content 채우고 is_summary=0 으로 전환, nts_doc_id 보강
 *        → 마지막에 FTS5 재인덱싱
 *
 * ◆ 사용법
 *   node scripts/import_collected.mjs            # 반영 + FTS rebuild
 *   node scripts/import_collected.mjs --dry-run  # 검증만 (DB 변경 없음)
 *   node scripts/import_collected.mjs --no-fts   # 반영만, FTS rebuild 생략
 *
 * ◆ 필요 환경
 *   별도 환경변수 불필요. ~/.wrangler/config/default.toml의 OAuth 토큰을
 *   사용하므로 사전에 `npx wrangler login` 필요 (단, --dry-run 모드는
 *   토큰을 읽지 않고 네트워크 호출도 하지 않음 — 아래 TOKEN/d1Query 참고).
 *
 * ◆ 실행 시점
 *   수동 실행 전용. .github/workflows/update_laws.yml에는 등록되어 있지
 *   않음 (grep으로 확인 — 워크플로는 fetch_all.mjs만 호출).
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

// wrangler가 로그인 시 저장한 OAuth 토큰을 재사용 — 별도 API 토큰 발급/관리 불필요.
function getToken() {
  const p = path.join(process.env.USERPROFILE || process.env.HOME, ".wrangler", "config", "default.toml");
  const m = fs.readFileSync(p, "utf8").match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("wrangler 토큰 없음. `npx wrangler login` 먼저 실행하세요.");
  return m[1];
}
// --dry-run에서는 토큰조차 읽지 않는다 — 검증만 하는 모드이므로 wrangler
// 로그인이 안 된 환경에서도 입력 파일 유효성만 미리 확인할 수 있게 한다.
const TOKEN  = DRY_RUN ? "" : getToken();
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

async function d1Query(sql, params = []) {
  // dry-run 모드에서는 실제 네트워크 호출/DB 변경을 절대 하지 않고 빈 결과만 반환.
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
    // 한 줄이 깨져 있어도(JSON 파싱 실패) 전체 작업을 중단하지 않고 해당 줄만
    // 건너뛴다 — 다른 AI가 만든 외부 입력 파일이라 형식 오류 가능성을 가정.
    let r; try { r = JSON.parse(line); } catch { console.warn(`  [건너뜀] ${i + 1}행 JSON 파싱 실패`); continue; }
    // id/content 최소 유효성 검사 — 빈 내용이나 너무 짧은 내용(10자 미만)을
    // 전문으로 잘못 반영해 기존 요약을 덮어쓰는 사고를 막기 위한 안전장치.
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
  // CONCURRENCY(10)개씩 묶어 Promise.allSettled로 병렬 처리 — D1 REST API
  // 호출은 네트워크 왕복이 느려 순차 처리하면 대량 레코드 반영에 시간이
  // 오래 걸리므로, 일부 동시성으로 처리량을 높이면서도 한쪽 실패가 전체를
  // 막지 않도록(allSettled) 안전하게 처리한다.
  for (let i = 0; i < recs.length; i += CONCURRENCY) {
    const chunk = recs.slice(i, i + CONCURRENCY);
    const res = await Promise.allSettled(chunk.map(async r => {
      // content/is_summary 갱신과 nts_doc_id 보강을 별도 UPDATE로 분리한 이유:
      // nts_doc_id는 "이미 NULL인 경우에만" 채워야 하므로(기존 값을 덮어쓰지
      // 않기 위해 WHERE nts_doc_id IS NULL 조건 추가) 단일 UPDATE로 합칠 수 없다.
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

  // content가 새로 채워진 문서들은 FTS5 가상 테이블에 반영되어 있지 않으므로
  // (개별 INSERT/UPDATE만으로는 FTS5 인덱스가 자동 동기화되지 않음) 전체
  // rebuild를 한 번 돌려 검색 인덱스를 최신 상태로 맞춘다. --no-fts로 생략 가능.
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
