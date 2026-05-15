import { getUser, requireAuth, json } from "../../_lib/auth.js";

export async function onRequestGet(context) {
  const { params, request, env } = context;
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  const { id } = params;

  const question = await env.DB.prepare(
    "SELECT * FROM questions WHERE id = ?"
  ).bind(id).first();

  if (!question) return json({ error: "질문을 찾을 수 없습니다" }, 404);

  // 본인 질문 또는 관리자만 조회 가능
  if (question.user_id !== user.id && user.role !== "admin")
    return json({ error: "접근 권한이 없습니다" }, 403);

  const answer = await env.DB.prepare(
    "SELECT * FROM answers WHERE question_id = ?"
  ).bind(id).first();

  return json({
    question,
    answer: answer
      ? { ...answer, sources: JSON.parse(answer.sources || "[]") }
      : null,
  });
}
