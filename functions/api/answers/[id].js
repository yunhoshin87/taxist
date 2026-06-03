import { getUser, requireAuth, json } from "../../_lib/auth.js";

export async function onRequest(context) {
  const { request, env, params } = context;
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  if (request.method === "PATCH") return handlePatch({ request, env, user, params });
  if (request.method === "GET")   return handleGet({ env, user, params });
  return json({ error: "허용되지 않는 메서드" }, 405);
}

// GET /api/answers/:id
async function handleGet({ env, user, params }) {
  const answer = await env.DB.prepare(
    "SELECT a.*, q.user_id, q.tax_category FROM answers a JOIN questions q ON a.question_id = q.id WHERE a.id = ?"
  ).bind(params.id).first();

  if (!answer) return json({ error: "답변을 찾을 수 없습니다" }, 404);
  if (answer.user_id !== user.id && user.role !== "admin")
    return json({ error: "접근 권한이 없습니다" }, 403);

  return json({
    answer: {
      ...answer,
      sources: JSON.parse(answer.sources || "[]"),
      // 편집본이 있으면 편집본을, 없으면 원본을 display_content로 제공
      display_content: answer.content_edited ?? answer.content,
    },
  });
}

// PATCH /api/answers/:id  — 편집 내용 저장
async function handlePatch({ request, env, user, params }) {
  const answer = await env.DB.prepare(
    "SELECT a.id, q.user_id FROM answers a JOIN questions q ON a.question_id = q.id WHERE a.id = ?"
  ).bind(params.id).first();

  if (!answer) return json({ error: "답변을 찾을 수 없습니다" }, 404);
  if (answer.user_id !== user.id && user.role !== "admin")
    return json({ error: "접근 권한이 없습니다" }, 403);

  const { content_edited } = await request.json();
  if (content_edited === undefined) return json({ error: "content_edited 필요" }, 400);

  await env.DB.prepare(
    "UPDATE answers SET content_edited = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(content_edited, params.id).run();

  return json({ ok: true, updated_at: new Date().toISOString() });
}
