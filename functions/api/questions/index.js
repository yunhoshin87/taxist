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

// GET /api/questions - 내 질문 목록
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

  return json({ questions: results, total: cnt, page, limit });
}

// POST /api/questions - 질문 등록 + AI 답변 생성
async function handleCreate({ request, env }) {
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  // 무료 기간 만료 체크
  if (user.status === "expired") {
    return json({ error: "무료 이용 기간이 만료되었습니다. 서비스 문의를 통해 연장을 신청해주세요." }, 403);
  }

  const { tax_category, title, content } = await request.json();
  if (!tax_category || !title || !content)
    return json({ error: "세목, 제목, 내용을 모두 입력해주세요" }, 400);

  // 질문 저장
  const qResult = await env.DB.prepare(`
    INSERT INTO questions (user_id, tax_category, title, content, status)
    VALUES (?, ?, ?, ?, 'processing')
  `).bind(user.id, tax_category, title, content).run();

  const questionId = qResult.meta.last_row_id;

  try {
    // 활성 폴더 기반 문서 로드
    const documents = await loadDocuments(env.DB, tax_category);

    // Gemini 답변 생성
    const { content: answerContent, sources } = await generateAnswer(
      content, tax_category, documents, env.GEMINI_API_KEY
    );

    // 답변 저장
    const aResult = await env.DB.prepare(`
      INSERT INTO answers (question_id, content, sources)
      VALUES (?, ?, ?)
    `).bind(questionId, answerContent, JSON.stringify(sources)).run();

    // 질문 상태 완료로 갱신
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
    await env.DB.prepare("UPDATE questions SET status = 'error' WHERE id = ?")
      .bind(questionId).run();
    console.error("Answer generation error:", e);
    return json({ error: "답변 생성 중 오류가 발생했습니다: " + e.message }, 500);
  }
}
