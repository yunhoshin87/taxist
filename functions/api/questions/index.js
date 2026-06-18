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
import { generateAnswer } from "../../_lib/gemini.js";

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;

  if (method === "GET") return handleList(context);
  if (method === "POST") return handleCreate(context);
  return json({ error: "허용되지 않는 메서드" }, 405);
}

// GET /api/questions - 내 질문 목록 (페이지네이션, 20건씩)
async function handleList({ request, env }) {
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  const page  = parseInt(new URL(request.url).searchParams.get("page") || "1");
  const limit = 20;
  const offset = (page - 1) * limit;

  const { results } = await env.DB.prepare(`
    SELECT q.id, q.tax_category, q.title, q.status, q.created_at,
           a.id AS answer_id
    FROM questions q
    LEFT JOIN answers a ON a.question_id = q.id
    WHERE q.user_id = ?
    ORDER BY q.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(user.id, limit, offset).all();

  const { results: [{ cnt }] } = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM questions WHERE user_id = ?"
  ).bind(user.id).all();

  const TRIAL_LIMIT = 5;
  // 무료체험 회원에게만 "남은 질문 수"를 내려준다 (결제/만료 회원은 의미 없는 값이라 null)
  const trialRemaining = user.status === "trial"
    ? Math.max(0, TRIAL_LIMIT - Number(cnt))
    : null;

  return json({ questions: results, total: cnt, page, limit, trial_remaining: trialRemaining, trial_limit: TRIAL_LIMIT });
}

// POST /api/questions - 질문 등록 + AI 답변 생성 (동기 처리 — 응답이 올 때까지 대기)
async function handleCreate({ request, env }) {
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  // 무료기간 만료 후 결제하지 않은 회원은 질문 등록 자체를 막는다.
  // (만료 여부 자체는 login.js/auth 흐름에서 JWT 발급 시 이미 확정된 status를 그대로 신뢰)
  if (user.status === "expired") {
    return json({ error: "무료 이용 기간이 만료되었습니다. 이용권을 구매하면 계속 사용할 수 있습니다.", code: "EXPIRED" }, 403);
  }

  // 무료 체험 회원은 누적 질문 수가 TRIAL_LIMIT(5건)을 넘으면 더 이상 질문할 수 없다.
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

  const { tax_category, title, content } = await request.json();
  if (!tax_category || !title || !content)
    return json({ error: "세목, 제목, 내용을 모두 입력해주세요" }, 400);

  // 질문을 먼저 'processing' 상태로 저장한다 — Gemini 호출이 실패해도
  // 질문 자체는 남겨서 사용자가 무엇을 물었는지, 어떤 오류가 났는지 추적 가능하게 함.
  const qResult = await env.DB.prepare(`
    INSERT INTO questions (user_id, tax_category, title, content, status)
    VALUES (?, ?, ?, ?, 'processing')
  `).bind(user.id, tax_category, title, content).run();

  const questionId = qResult.meta.last_row_id;

  try {
    // 1) RAG 검색: 질문 키워드로 관련 법령/판례/해석례/관리자자료를 찾는다 (FTS5 기반)
    const documents = await loadDocuments(env.DB, tax_category, content);

    // 2) 생성: 검색된 문서 + 질문을 Gemini에 전달해 답변 마크다운을 만든다
    const { content: answerContent, sources } = await generateAnswer(
      content, tax_category, documents, env.GEMINI_API_KEY
    );

    // 답변 저장 (sources는 어떤 자료를 근거로 답변했는지 추적용 — JSON 배열을 문자열로 저장)
    const aResult = await env.DB.prepare(`
      INSERT INTO answers (question_id, content, sources)
      VALUES (?, ?, ?)
    `).bind(questionId, answerContent, JSON.stringify(sources)).run();

    // 질문 상태를 완료로 갱신 (프론트는 status로 진행 단계를 표시한다)
    await env.DB.prepare("UPDATE questions SET status = 'done' WHERE id = ?")
      .bind(questionId).run();

    return json({
      question: { id: questionId, tax_category, title, content, status: "done" },
      answer: {
        id: aResult.meta.last_row_id,
        content: answerContent,
        sources,
      },
    }, 201);
  } catch (e) {
    // Gemini 호출 실패(과부하/할당량/네트워크 등) 시 질문 상태를 'error'로 남기고,
    // 오류 메시지 자체를 answers 테이블에 기록해 관리자페이지에서 원인을 확인할 수 있게 한다.
    await env.DB.prepare("UPDATE questions SET status = 'error' WHERE id = ?")
      .bind(questionId).run();
    const errMsg = `[ERROR] ${e.name || 'Error'}: ${e.message || String(e)}`;
    await env.DB.prepare("INSERT INTO answers (question_id, content, sources) VALUES (?, ?, '[]')")
      .bind(questionId, errMsg).run().catch(() => {}); // 이 기록 자체가 실패해도 응답은 정상 반환
    console.error("Answer generation error:", e);
    return json({ error: "답변 생성 중 오류가 발생했습니다: " + e.message }, 500);
  }
}
