// ============================================================================
// /api/questions — 질문 등록(+AI 답변 생성) 및 내 질문 목록 조회
//
// POST 핸들러(handleCreate)가 이 서비스의 핵심 파이프라인이다:
//   질문 저장 → loadDocuments(RAG 검색) → generateAnswer(Gemini 호출) →
//   답변 저장 → 질문 상태 갱신. 무료체험(trial) 회원은 질문 5건 제한이 있고,
//   만료(expired) 회원은 질문 등록 자체가 막힌다.
// ============================================================================

import { getUser, requireAuth, json } from "../../_lib/auth.js";
import { loadDocuments } from "../../_lib/docs.js";
import { generateAnswer, generateQuickAnswer } from "../../_lib/gemini.js";

export async function onRequest(context) {
  const { request } = context;
  const method = request.method;

  if (method === "GET") return handleList(context);
  if (method === "POST") return handleCreate(context); // context 전체 전달 (waitUntil 사용)
  return json({ error: "허용되지 않는 메서드" }, 405);
}

// GET /api/questions - 내 질문 목록 (페이지네이션, 20건씩)
async function handleList({ request, env }) {
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  const url    = new URL(request.url);
  const page   = parseInt(url.searchParams.get("page") || "1");
  const search = (url.searchParams.get("search") || "").trim();
  const limit  = 20;
  const offset = (page - 1) * limit;

  let results, cnt;
  if (search) {
    const like = `%${search}%`;
    ({ results } = await env.DB.prepare(`
      SELECT q.id, q.tax_category, q.title, q.status, q.created_at, q.question_type,
             a.id AS answer_id
      FROM questions q
      LEFT JOIN answers a ON a.question_id = q.id
      WHERE q.user_id = ? AND (q.title LIKE ? OR q.content LIKE ?)
      ORDER BY q.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(user.id, like, like, limit, offset).all());
    ({ results: [{ cnt }] } = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM questions WHERE user_id = ? AND (title LIKE ? OR content LIKE ?)"
    ).bind(user.id, like, like).all());
  } else {
    ({ results } = await env.DB.prepare(`
      SELECT q.id, q.tax_category, q.title, q.status, q.created_at, q.question_type,
             a.id AS answer_id
      FROM questions q
      LEFT JOIN answers a ON a.question_id = q.id
      WHERE q.user_id = ?
      ORDER BY q.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(user.id, limit, offset).all());
    ({ results: [{ cnt }] } = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM questions WHERE user_id = ?"
    ).bind(user.id).all());
  }

  const TRIAL_LIMIT = 5;
  // 무료체험 회원에게만 "남은 질문 수"를 내려준다 (결제/만료 회원은 의미 없는 값이라 null)
  const trialRemaining = user.status === "trial"
    ? Math.max(0, TRIAL_LIMIT - Number(cnt))
    : null;

  return json({ questions: results, total: cnt, page, limit, trial_remaining: trialRemaining, trial_limit: TRIAL_LIMIT });
}

// POST /api/questions - 질문 등록 후 즉시 202 반환, AI 생성은 백그라운드(waitUntil)로 처리
// 프론트엔드는 GET /api/questions/:id 를 폴링해서 status가 'done'/'error'가 될 때까지 대기한다.
async function handleCreate(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  if (user.status === "expired") {
    return json({ error: "무료 이용 기간이 만료되었습니다. 이용권을 구매하면 계속 사용할 수 있습니다.", code: "EXPIRED" }, 403);
  }

  if (user.status === "trial") {
    const { results: [{ cnt }] } = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM questions WHERE user_id = ?"
    ).bind(user.id).all();
    if (cnt >= TRIAL_LIMIT) {
      return json({
        error: `무료 체험 중에는 최대 ${TRIAL_LIMIT}건의 질문만 가능합니다. 이용권을 구매하면 제한 없이 사용할 수 있습니다.`,
        code: "TRIAL_LIMIT",
        used: cnt,
        limit: TRIAL_LIMIT,
      }, 403);
    }
  }

  const { tax_category, title, content, question_type } = await request.json();
  if (!tax_category || !title || !content)
    return json({ error: "세목, 제목, 내용을 모두 입력해주세요" }, 400);

  const qType = (question_type === 'quick') ? 'quick' : 'full';

  const qResult = await env.DB.prepare(`
    INSERT INTO questions (user_id, tax_category, title, content, status, question_type)
    VALUES (?, ?, ?, ?, 'processing', ?)
  `).bind(user.id, tax_category, title, content, qType).run();

  const questionId = qResult.meta.last_row_id;

  // Cloudflare Pages Functions의 waitUntil 패턴:
  // context.waitUntil()에 Promise를 넘기면 HTTP 응답을 클라이언트에 먼저 반환한 뒤,
  // 그 Promise가 완료될 때까지 워커가 살아있는 상태를 유지한다.
  // 이 덕분에 AI 생성(수~수십 초 소요)을 기다리지 않고 202 Accepted를 즉시 응답할 수 있다.
  // 프론트엔드는 GET /api/questions/:id 를 폴링해 status='done'/'error'를 감지한다.
  context.waitUntil(generateAndSave(questionId, env, tax_category, content, qType));

  return json({
    question: { id: questionId, tax_category, title, content, status: "processing", question_type: qType },
  }, 202);
}

// 백그라운드 AI 생성 + 저장 (context.waitUntil에서 호출됨)
// handleCreate가 202를 반환한 이후에도 이 함수는 계속 실행된다.
// 실패 시에도 questions.status를 반드시 'error'로 갱신해 프론트가 폴링을 멈출 수 있게 한다.
async function generateAndSave(questionId, env, tax_category, content, questionType = 'full') {
  try {
    // RAG 검색: 질문과 관련된 법령·판례·해석례 문서를 DB에서 가져온다.
    // apiKey를 전달해 FTS 직접 매칭 실패 시 Gemini 쿼리 확장이 동작하게 한다.
    const documents = await loadDocuments(env.DB, tax_category, content, env.GEMINI_API_KEY);

    let answerContent, sources, coverageGap = false;
    if (questionType === 'quick') {
      // ── 간단 질의 경로 ──────────────────────────────────────────────
      // generateQuickAnswer는 { text, coverageGap } 구조를 반환한다.
      // coverageGap: Gemini가 [자료부족] 태그를 출력했는지 여부.
      //   true  → answers.coverage_gap = 1 로 저장
      //           프론트엔드는 이 플래그를 보고 경고 배너("자료가 부족합니다") 표시
      //   false → answers.coverage_gap = 0 (기본값, 정상 답변)
      // sources는 반환값에 포함되지 않으므로 documents에서 직접 추출한다.
      const result = await generateQuickAnswer(content, tax_category, documents, env.GEMINI_API_KEY);
      answerContent = result.text;
      sources       = documents.map(d => d.name); // 사용된 문서 이름 목록
      coverageGap   = result.coverageGap;
    } else {
      // ── 일반(전체 보고서) 질의 경로 ────────────────────────────────
      // generateAnswer는 { content, sources } 반환 — coverageGap은 항상 false
      // (보고서 형식에서는 자료 부족을 "추가 확인 필요사항" 섹션으로 표현하기 때문)
      const result = await generateAnswer(content, tax_category, documents, env.GEMINI_API_KEY);
      answerContent = result.content;
      sources       = result.sources;
      // coverageGap은 초기값 false를 그대로 유지
    }

    // answers 테이블에 저장: coverage_gap은 SQLite INTEGER(0/1)으로 저장한다.
    // sources는 문서 이름 배열을 JSON 문자열로 직렬화해 저장 (추후 "출처 보기" 기능용).
    const aResult = await env.DB.prepare(
      "INSERT INTO answers (question_id, content, sources, coverage_gap) VALUES (?, ?, ?, ?)"
    ).bind(questionId, answerContent, JSON.stringify(sources), coverageGap ? 1 : 0).run();

    // 폴링 중인 프론트엔드에 "완료"를 알리기 위해 status를 'done'으로 갱신
    await env.DB.prepare("UPDATE questions SET status = 'done' WHERE id = ?")
      .bind(questionId).run();

    console.log(`[Q${questionId}] 답변 생성 완료 (answer_id=${aResult.meta.last_row_id})`);
  } catch (e) {
    // 오류 발생 시 status를 'error'로 갱신해 프론트가 무한 폴링하지 않도록 한다.
    // 오류 내용은 answers 테이블에 텍스트로 저장해 관리자가 원인을 파악할 수 있게 한다.
    await env.DB.prepare("UPDATE questions SET status = 'error' WHERE id = ?")
      .bind(questionId).run();
    const errMsg = `[ERROR] ${e.name || 'Error'}: ${e.message || String(e)}`;
    await env.DB.prepare("INSERT INTO answers (question_id, content, sources) VALUES (?, ?, '[]')")
      .bind(questionId, errMsg).run().catch(() => {});
    console.error(`[Q${questionId}] 답변 생성 오류:`, e);
  }
}
