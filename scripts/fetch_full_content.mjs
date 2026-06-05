/**
 * NTS 해석례 전문 일괄 수집 스크립트
 *
 * - Phase 1: nts_doc_id 있는 문서 → NTS API 직접 전문 조회 (9,055건)
 * - Phase 2: nts_doc_id 없는 문서 → 제목 키워드 검색 → ID 확보 → 전문 조회 (13,086건)
 * - 체크포인트 저장 → 중단 후 재시작 가능
 * - 완료 후 FTS5 재인덱싱
 *
 * 사용법:
 *   node scripts/fetch_full_content.mjs           # 전체 실행
 *   node scripts/fetch_full_content.mjs --dry-run # 수집만, DB 저장 안 함
 *   node scripts/fetch_full_content.mjs --phase1  # Phase 1만
 *   node scripts/fetch_full_content.mjs --phase2  # Phase 2만
 *   node scripts/fetch_full_content.mjs --reset   # 체크포인트 초기화 후 재시작
 */

import fs    from "fs";
import path  from "path";
import https from "https";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR  = path.resolve(__dirname, "..");

// ── 설정 ────────────────────────────────────────────────────────
const ACCOUNT_ID  = "143f2323446f7c53f496c331d3f6ebd2";
const DATABASE_ID = "f257e814-b8ff-4ba3-a45b-55981035b44a";
const NTS_HOST    = "taxlaw.nts.go.kr";

const CONCURRENCY  = 5;    // 동시 요청 수 (NTS 서버 부하 고려)
const DELAY_MS     = 1000; // 요청 간 딜레이 (ms)
const BATCH_SIZE   = 500;  // D1 조회 배치 크기
const CHECKPOINT   = path.join(BASE_DIR, "scripts", "full_content_checkpoint.json");
const LOG_FILE     = path.join(BASE_DIR, "scripts", "full_content.log");

const DRY_RUN  = process.argv.includes("--dry-run");
const PHASE1   = process.argv.includes("--phase1");
const PHASE2   = process.argv.includes("--phase2");
const DO_RESET = process.argv.includes("--reset");
const ONLY_PHASE1 = PHASE1 && !PHASE2;
const ONLY_PHASE2 = PHASE2 && !PHASE1;

// ── 인증 토큰 ────────────────────────────────────────────────────
function getToken() {
  const paths = [
    path.join(process.env.USERPROFILE || process.env.HOME, ".wrangler", "config", "default.toml"),
    path.join(process.env.HOME || "", ".wrangler", "config", "default.toml"),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      const cfg = fs.readFileSync(p, "utf8");
      const m = cfg.match(/oauth_token\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
  }
  throw new Error("wrangler 인증 토큰 없음. `npx wrangler login` 먼저 실행하세요.");
}
const TOKEN = DRY_RUN ? "" : getToken();
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

// ── 로그 ────────────────────────────────────────────────────────
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
function log(msg) {
  const line = `${new Date().toLocaleString("ko-KR")}  ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

// ── 체크포인트 ──────────────────────────────────────────────────
function loadCheckpoint() {
  if (DO_RESET && fs.existsSync(CHECKPOINT)) {
    fs.unlinkSync(CHECKPOINT);
    log("체크포인트 초기화");
  }
  try { return JSON.parse(fs.readFileSync(CHECKPOINT, "utf8")); }
  catch { return { phase1_done_ids: [], phase2_done_ids: [], phase2_skip_ids: [], stats: {} }; }
}
function saveCheckpoint(cp) {
  fs.writeFileSync(CHECKPOINT, JSON.stringify(cp, null, 2));
}

// ── D1 API ──────────────────────────────────────────────────────
async function d1Query(sql, params = []) {
  if (DRY_RUN) return { results: [] };
  const res = await fetch(D1_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`D1 오류: ${JSON.stringify(json.errors)}`);
  return json.result?.[0] || { results: [] };
}

async function d1Update(docId, content) {
  if (DRY_RUN) return;
  await d1Query(
    "UPDATE documents SET content = ?, is_summary = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [content, docId]
  );
}

// ── D1에서 요약 문서 조회 ────────────────────────────────────────
async function getSummaryDocs(hasNtsId, offset = 0, limit = BATCH_SIZE) {
  const condition = hasNtsId
    ? "is_summary = 1 AND nts_doc_id IS NOT NULL"
    : "is_summary = 1 AND nts_doc_id IS NULL";
  const res = await d1Query(
    `SELECT id, name, nts_doc_id, tax_category, folder_id
     FROM documents WHERE ${condition} AND is_active = 1
     ORDER BY id ASC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return res.results || [];
}

async function getTotalSummaryCount(hasNtsId) {
  const condition = hasNtsId
    ? "is_summary = 1 AND nts_doc_id IS NOT NULL"
    : "is_summary = 1 AND nts_doc_id IS NULL";
  const res = await d1Query(`SELECT COUNT(*) as cnt FROM documents WHERE ${condition} AND is_active = 1`);
  return res.results?.[0]?.cnt || 0;
}

// ── NTS HTTP 헬퍼 ────────────────────────────────────────────────
let _cookies = "";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120",
      "Accept-Language": "ko-KR,ko;q=0.9",
      "Connection": "keep-alive",
      ...(_cookies ? { Cookie: _cookies } : {}),
    };
    if (method === "POST" && body) {
      headers["Content-Type"]   = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(body);
      headers["X-Requested-With"] = "XMLHttpRequest";
      headers["Accept"] = "application/json, */*; q=0.01";
      headers["Origin"]  = `https://${NTS_HOST}`;
      headers["Referer"] = `https://${NTS_HOST}/qt/USEQTA001L.do?ntstDcmClCd=02`;
    }
    const opts = { hostname: NTS_HOST, port: 443, path: urlPath, method, headers, timeout: 25000 };
    const req = https.request(opts, res => {
      const setCookies = res.headers["set-cookie"] || [];
      if (setCookies.length) {
        const map = Object.fromEntries((_cookies || "").split("; ").filter(Boolean).map(p => p.split("=")));
        for (const c of setCookies) { const [k, v] = c.split(";")[0].split("="); map[k] = v; }
        _cookies = Object.entries(map).map(([k,v]) => `${k}=${v}`).join("; ");
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", d => data += d);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("NTS 요청 타임아웃")); });
    if (body) req.write(body);
    req.end();
  });
}

async function ntsSession() {
  try {
    await httpsRequest("GET", "/qt/USEQTA001L.do?ntstDcmClCd=02");
  } catch (e) { log(`세션 초기화 실패: ${e.message}`); }
}

async function ntsAction(actionId, paramData) {
  await sleep(DELAY_MS);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const body = new URLSearchParams({
        actionId,
        paramData: JSON.stringify(paramData),
      }).toString();
      const res = await httpsRequest("POST", "/action.do", body);
      if (!res.body || res.body.trimStart().startsWith("<!")) {
        await ntsSession();
        await sleep(1500);
        continue;
      }
      const json = JSON.parse(res.body);
      if (json.status === "SUCCESS") return json.data || json;
      return null;
    } catch (e) {
      if (attempt < 2) await sleep(2000);
    }
  }
  return null;
}

// ── NTS 전문 조회 ────────────────────────────────────────────────
function stripHtml(s) {
  return (s || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\r\n/g, "\n").trim();
}

function buildFullContent(dvo) {
  const title   = stripHtml(dvo.ntstDcmTtl || "");
  const docNo   = stripHtml(dvo.ntstDcmDscmCntn || "");
  const date    = (dvo.ntstDcmRgtDt || "").replace(/(\d{4})(\d{2})(\d{2}).*/, "$1-$2-$3");
  const tax     = stripHtml(dvo.ntstTlawClNm || "");
  const gist    = stripHtml(dvo.ntstDcmGistCntn || "");
  const answer  = stripHtml(dvo.ntstDcmCntn || "");
  const keyword = stripHtml(dvo.ntstDcmMatrCntn || "");

  if (!gist && !answer) return null; // 유효 내용 없음

  const lines = [`# ${title || "해석례"}`, ""];
  lines.push("| 항목 | 내용 |", "|---|---|");
  if (docNo)   lines.push(`| 문서번호 | ${docNo} |`);
  if (date)    lines.push(`| 등록일   | ${date} |`);
  if (tax)     lines.push(`| 세목     | ${tax} |`);
  if (keyword) lines.push(`| 키워드   | ${keyword.slice(0, 200)} |`);
  lines.push("");
  if (gist)   lines.push("## 질의요지", "", gist, "");
  if (answer) lines.push("## 회신", "", answer, "");

  return lines.join("\n");
}

async function fetchDetailById(ntstDcmId) {
  const data = await ntsAction("ASIQTB002PR01", { dcmDVO: { ntstDcmId } });
  if (!data) return null;
  const dvo = (data["ASIQTB002PR01"] || data)?.dcmDVO;
  if (!dvo) return null;
  return buildFullContent(dvo);
}

// ── NTS 제목 검색으로 ID 확보 ────────────────────────────────────
function extractKeyword(name) {
  // 문서명에서 접두사 제거 후 핵심 키워드 추출
  const clean = name
    .replace(/^\[(질의회신|사전답변|과세기준자문|고시서면질의|과세적부심사|이의신청|심사청구|심판청구)\]\s*/, "")
    .replace(/「[^」]+」/g, "") // 법령명 제거
    .replace(/제\d+조[^,。]+/g, "")
    .trim();
  // 핵심 명사 구 추출 (15자 이내)
  return clean.slice(0, 30);
}

async function searchNtsId(name) {
  const keyword = extractKeyword(name);
  if (!keyword || keyword.length < 4) return null;

  for (const docTypeCode of ["02", "01", "03", "04"]) { // 질의회신, 사전답변, 과세기준자문, 고시서면질의
    const data = await ntsAction("ASIPDI002PR01", {
      startCount: 1, viewCount: 5,
      schDtBase: "DCM_RGT_DTM", bltnStrtDt: "", bltnEndDt: "",
      collectionName: "question,question_gr",
      dcmClCdCtl: [`001_${docTypeCode}`],
      exclVcbCtl: [], icldVcbCtl: [keyword],
      ntstTlawClCdList: [],
      sortField: "SCORE/DESC",
    });

    if (!data) continue;
    const inner = data["ASIPDI002PR01"] || data;
    const items = inner?.body || [];
    if (!items.length) continue;

    // 첫 번째 결과로 상세 조회
    const firstId = items[0]?.dcm?.DOC_ID || items[0]?.dcm?.NTST_DCM_ID;
    if (firstId) return firstId;
  }

  // 불복결정례도 시도
  for (const docTypeCode of ["05", "06", "07", "08"]) {
    const data = await ntsAction("ASIPDI002PR01", {
      startCount: 1, viewCount: 5,
      schDtBase: "DCM_RGT_DTM", bltnStrtDt: "", bltnEndDt: "",
      collectionName: "precedent,precedent_gr",
      dcmClCdCtl: [`001_${docTypeCode}`],
      exclVcbCtl: [], icldVcbCtl: [keyword],
      ntstTlawClCdList: [],
      sortField: "SCORE/DESC",
    });
    if (!data) continue;
    const inner = data["ASIPDI002PR01"] || data;
    const items = inner?.body || [];
    const firstId = items[0]?.dcm?.DOC_ID || items[0]?.dcm?.NTST_DCM_ID;
    if (firstId) return firstId;
  }

  return null;
}

// ── 병렬 처리 헬퍼 ──────────────────────────────────────────────
async function pMap(arr, fn, concurrency) {
  const results = [];
  for (let i = 0; i < arr.length; i += concurrency) {
    const chunk = arr.slice(i, i + concurrency);
    const res = await Promise.allSettled(chunk.map(fn));
    results.push(...res);
  }
  return results;
}

// ── Phase 1: nts_doc_id 있는 문서 전문 수집 ─────────────────────
async function runPhase1(cp) {
  const total = await getTotalSummaryCount(true);
  const doneSet = new Set(cp.phase1_done_ids);
  log(`\n[Phase 1] nts_doc_id 있는 문서: ${total.toLocaleString()}건 (이미 완료: ${doneSet.size}건)`);

  let processed = 0, success = 0, fail = 0;
  let offset = 0;

  while (true) {
    const docs = await getSummaryDocs(true, offset, BATCH_SIZE);
    if (!docs.length) break;

    const pending = docs.filter(d => !doneSet.has(d.id));
    log(`  배치 offset=${offset}: ${docs.length}건 조회, ${pending.length}건 미완료`);

    await pMap(pending, async (doc) => {
      try {
        const content = await fetchDetailById(doc.nts_doc_id);
        if (content) {
          await d1Update(doc.id, content);
          doneSet.add(doc.id);
          cp.phase1_done_ids = [...doneSet];
          success++;
        } else {
          fail++;
          log(`  [P1 실패] id=${doc.id} nts_id=${doc.nts_doc_id} (내용 없음)`);
        }
      } catch (e) {
        fail++;
        log(`  [P1 오류] id=${doc.id}: ${e.message}`);
      }
      processed++;
      if (processed % 50 === 0) {
        log(`  진행: ${processed}/${pending.length} (성공 ${success}, 실패 ${fail})`);
        saveCheckpoint(cp);
      }
    }, CONCURRENCY);

    saveCheckpoint(cp);
    offset += BATCH_SIZE;

    if (docs.length < BATCH_SIZE) break;
  }

  log(`[Phase 1 완료] 성공: ${success}건, 실패: ${fail}건`);
  cp.stats.phase1 = { success, fail, total };
  saveCheckpoint(cp);
  return { success, fail };
}

// ── Phase 2: nts_doc_id 없는 문서 → 검색 → 전문 수집 ────────────
async function runPhase2(cp) {
  const total = await getTotalSummaryCount(false);
  const doneSet = new Set(cp.phase2_done_ids);
  const skipSet = new Set(cp.phase2_skip_ids);
  log(`\n[Phase 2] nts_doc_id 없는 문서: ${total.toLocaleString()}건 (완료: ${doneSet.size}, 스킵: ${skipSet.size})`);

  let processed = 0, success = 0, fail = 0, skipped = 0;
  let offset = 0;

  while (true) {
    const docs = await getSummaryDocs(false, offset, BATCH_SIZE);
    if (!docs.length) break;

    const pending = docs.filter(d => !doneSet.has(d.id) && !skipSet.has(d.id));
    log(`  배치 offset=${offset}: ${docs.length}건 조회, ${pending.length}건 미완료`);

    // Phase 2는 검색이 필요하므로 순차 처리 (NTS 검색 부하 고려)
    for (const doc of pending) {
      try {
        // 제목으로 NTS 검색해 ID 확보
        const ntsId = await searchNtsId(doc.name);

        if (!ntsId) {
          // 검색 실패 → 스킵 처리
          skipSet.add(doc.id);
          cp.phase2_skip_ids = [...skipSet];
          skipped++;
          if (skipped % 100 === 0) log(`  검색 실패 누계: ${skipped}건`);
          continue;
        }

        // ID로 전문 조회
        const content = await fetchDetailById(ntsId);
        if (content) {
          await d1Update(doc.id, content);
          // nts_doc_id도 함께 저장
          if (!DRY_RUN) {
            await d1Query(
              "UPDATE documents SET nts_doc_id = ? WHERE id = ?",
              [ntsId, doc.id]
            );
          }
          doneSet.add(doc.id);
          cp.phase2_done_ids = [...doneSet];
          success++;
        } else {
          skipSet.add(doc.id);
          cp.phase2_skip_ids = [...skipSet];
          fail++;
        }
      } catch (e) {
        fail++;
        log(`  [P2 오류] id=${doc.id}: ${e.message}`);
      }

      processed++;
      if (processed % 100 === 0) {
        log(`  진행: ${processed} (성공 ${success}, 실패/스킵 ${fail + skipped})`);
        saveCheckpoint(cp);
      }
    }

    saveCheckpoint(cp);
    offset += BATCH_SIZE;
    if (docs.length < BATCH_SIZE) break;
  }

  log(`[Phase 2 완료] 성공: ${success}건, 검색실패: ${skipped}건, 오류: ${fail}건`);
  cp.stats.phase2 = { success, fail, skipped, total };
  saveCheckpoint(cp);
  return { success, fail, skipped };
}

// ── FTS5 재인덱싱 ───────────────────────────────────────────────
async function rebuildFts() {
  log("\nFTS5 전체 재인덱싱 중...");
  try {
    execSync(
      `npx wrangler d1 execute taxist-db --remote --command "INSERT INTO documents_fts(documents_fts) VALUES('rebuild')"`,
      { stdio: "inherit", cwd: BASE_DIR }
    );
    log("FTS5 재인덱싱 완료");
  } catch (e) {
    log(`FTS5 재인덱싱 실패 (수동 실행 필요): ${e.message}`);
    log('  npx wrangler d1 execute taxist-db --remote --command "INSERT INTO documents_fts(documents_fts) VALUES(\'rebuild\')"');
  }
}

// ── 메인 ────────────────────────────────────────────────────────
async function main() {
  log("========================================");
  log("TAXIST 해석례 전문 일괄 수집 시작");
  log(`설정: CONCURRENCY=${CONCURRENCY}, DELAY=${DELAY_MS}ms, DRY_RUN=${DRY_RUN}`);
  log("========================================");

  if (!DRY_RUN) {
    log("NTS 세션 초기화...");
    await ntsSession();
  }

  const cp = loadCheckpoint();

  const startTime = Date.now();

  if (!ONLY_PHASE2) await runPhase1(cp);
  if (!ONLY_PHASE1) await runPhase2(cp);

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  log(`\n총 소요 시간: ${elapsed}분`);

  if (!DRY_RUN) await rebuildFts();

  log("\n[최종 결과]");
  log(JSON.stringify(cp.stats, null, 2));
  log("체크포인트: " + CHECKPOINT);
  log("로그: " + LOG_FILE);
}

main().catch(e => { log(`치명적 오류: ${e.message}`); process.exit(1); });
