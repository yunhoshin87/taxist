// ============================================================================
// /api/chat — 보고서 기반 대화형 질의
//
// AI가 생성한 검토보고서에 대해 추가 질문을 채팅 형태로 주고받는 기능.
// 모든 답변은 등록된 DB 참고자료(법령·판례·해석례)에만 근거하며,
// generateChatReply()의 프롬프트가 중립적 사실 전달만 하도록 강제한다.
// 질문자의 의향 추론·유리한 해석 유도는 절대 금지.
//
// 동작 흐름:
//   1. 새 채팅 메시지 수신 (POST)
//   2. 질문 소유권 + 답변 완료 여부 확인
//   3. 최근 대화 이력 10건 조회 (컨텍스트용)
//   4. 사용자 메시지 DB 저장
//   5. loadDocuments()로 RAG 검색 (새 메시지 기반, apiKey 전달로 쿼리 확장 활성화)
//   6. generateChatReply()로 AI 답변 생성
//   7. AI 답변 DB 저장 → 클라이언트에 반환
//
// 엔드포인트:
//   GET  /api/chat?question_id=X  채팅 이력 조회 (ask.html 재로드 시 복원용)
//   POST /api/chat                새 메시지 전송 + AI 답변 반환 (동기, 수 초 소요)
// ============================================================================
import { getUser, requireAuth, json } from "../_lib/auth.js";
import { loadDocuments } from "../_lib/docs.js";
import { generateChatReply } from "../_lib/gemini.js";

export async function onRequest(context) {
  const { request } = context;
  if (request.method === "GET")  return handleGet(context);
  if (request.method === "POST") return handlePost(context);
  return json({ error: "허용되지 않는 메서드" }, 405);
}

// ── GET /api/chat?question_id=X ───────────────────────────────────────────
// 해당 질문의 채팅 이력 전체를 오름차순(오래된 것 먼저)으로 반환한다.
// ask.html이 과거 질문을 재조회(loadQuestion)할 때 대화 이력을 복원하기 위해 호출된다.
async function handleGet({ request, env }) {
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  const questionId = new URL(request.url).searchParams.get("question_id");
  if (!questionId) return json({ error: "question_id 필요" }, 400);

  // 소유권 확인: 내 질문 또는 관리자만 이력 조회 가능
  const q = await env.DB.prepare("SELECT user_id FROM questions WHERE id = ?")
    .bind(Number(questionId)).first();
  if (!q) return json({ error: "질문을 찾을 수 없습니다" }, 404);
  if (q.user_id !== user.id && user.role !== "admin") return json({ error: "권한 없음" }, 403);

  // created_at ASC: 채팅 UI에서 오래된 메시지가 위에, 최신이 아래에 표시되도록
  const { results } = await env.DB.prepare(
    "SELECT id, role, content, created_at FROM chat_messages WHERE question_id = ? ORDER BY created_at ASC"
  ).bind(Number(questionId)).all();

  return json({ messages: results });
}

// ── POST /api/chat ─────────────────────────────────────────────────────────
// 사용자 메시지를 받아 AI 답변을 생성하고 둘 다 DB에 저장 후 반환한다.
// 생성이 동기적으로 이루어지므로, 클라이언트는 응답이 올 때까지 대기한다
// (questions의 폴링 방식과 달리 채팅은 즉시 응답을 기대하므로 waitUntil을 쓰지 않음).
async function handlePost({ request, env }) {
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  const { question_id, message } = await request.json();
  if (!question_id || !message?.trim()) return json({ error: "question_id와 message 필요" }, 400);

  // 소유권 확인 + 기존 보고서 내용 조회
  // status='done'인 질문에만 채팅 가능 — 아직 답변 생성 중이거나 오류 난 질문에는 불가.
  // COALESCE(content_edited, content): 관리자가 수동 편집한 보고서가 있으면 그것을 우선 사용.
  // 채팅 컨텍스트로 편집본을 전달해야 "관리자가 수정한 내용"을 기반으로 대화가 이어진다.
  const row = await env.DB.prepare(`
    SELECT q.user_id, q.tax_category,
           COALESCE(a.content_edited, a.content) AS report_content
    FROM questions q
    LEFT JOIN answers a ON a.question_id = q.id
    WHERE q.id = ? AND q.status = 'done'
  `).bind(Number(question_id)).first();

  if (!row) return json({ error: "답변이 완성된 질문만 대화를 나눌 수 있습니다" }, 404);
  if (row.user_id !== user.id && user.role !== "admin") return json({ error: "권한 없음" }, 403);

  // 최근 10건만 이력으로 활용 (오래된 이력은 컨텍스트 토큰 절약을 위해 제외).
  // DESC LIMIT 10으로 "가장 최근 10건"을 효율적으로 가져온 뒤,
  // reverse()로 오름차순(시간순)으로 뒤집는다.
  // Gemini 프롬프트에서 대화 흐름은 "오래된 것 → 최신" 순으로 제공되어야
  // 모델이 대화의 맥락을 올바르게 파악할 수 있기 때문이다.
  // (DESC로 바로 Gemini에 전달하면 대화가 거꾸로 읽혀 컨텍스트가 엉킨다.)
  const { results: histDesc } = await env.DB.prepare(
    "SELECT role, content FROM chat_messages WHERE question_id = ? ORDER BY created_at DESC LIMIT 10"
  ).bind(Number(question_id)).all();
  const history = [...histDesc].reverse(); // 시간 오름차순으로 복원

  // 사용자 메시지를 AI 생성 전에 먼저 저장한다.
  // AI 생성이 나중에 실패하더라도 사용자가 무엇을 물었는지는 이력으로 남아야 하고,
  // 관리자가 오류 원인을 파악할 때도 도움이 된다.
  await env.DB.prepare(
    "INSERT INTO chat_messages (question_id, role, content) VALUES (?, 'user', ?)"
  ).bind(Number(question_id), message.trim()).run();

  try {
    // RAG 검색: 새 채팅 메시지를 질문으로 삼아 관련 참고자료를 검색한다.
    // apiKey를 전달해 FTS5 직접 매칭 실패 시 Gemini 쿼리 확장이 동작하게 한다.
    const documents = await loadDocuments(env.DB, row.tax_category, message.trim(), env.GEMINI_API_KEY);

    // AI 답변 생성 (중립 전용 프롬프트 — gemini.js의 generateChatReply 참고)
    // originalReport를 함께 전달해 기존 보고서 컨텍스트를 유지한다.
    // generateChatReply는 { reply, coverageGap } 반환
    const { reply, coverageGap } = await generateChatReply(
      message.trim(), row.tax_category, documents,
      row.report_content || "", history, env.GEMINI_API_KEY
    );

    // AI 답변도 DB에 저장 (이력 복원 + 품질 추적용)
    await env.DB.prepare(
      "INSERT INTO chat_messages (question_id, role, content) VALUES (?, 'assistant', ?)"
    ).bind(Number(question_id), reply).run();

    // sources: 이번 답변 생성에 실제로 사용된 참고문서 이름 목록 (UI의 "출처" 표시용)
    // coverage_gap: 참고자료 부족 여부 (boolean → JSON에서는 true/false)
    //   true  → 클라이언트가 채팅 버블에 경고 스타일("자료 부족") 적용
    //   false → 정상 답변 스타일 적용
    // questions/index.js의 generateAndSave와 달리, 채팅 답변은 DB에 coverage_gap을
    // 별도 컬럼으로 저장하지 않는다 — 채팅 메시지 이력에는 해당 컬럼이 없기 때문이며,
    // 클라이언트가 응답 시점에 실시간으로 표시하는 것으로 충분하다.
    return json({ reply, sources: documents.map(d => ({ id: d.id, name: d.name })), coverage_gap: coverageGap });
  } catch (e) {
    console.error(`[Chat Q${question_id}] 오류:`, e);
    return json({ error: "AI 답변 생성 중 오류가 발생했습니다: " + (e.message || String(e)) }, 500);
  }
}
