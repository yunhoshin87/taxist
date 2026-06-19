// /api/answers/:id — 답변 조회(GET), 편집 저장(PATCH), 공유 토큰 발급(POST)
import { getUser, requireAuth, json } from "../../_lib/auth.js";

export async function onRequest(context) {
  const { request, env, params } = context;
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  if (request.method === "GET")   return handleGet({ env, user, params });
  if (request.method === "PATCH") return handlePatch({ request, env, user, params });
  if (request.method === "POST")  return handleShare({ env, user, params }); // 공유 토큰 발급
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

// PATCH /api/answers/:id  — 편집 내용 저장 (원본 content는 변경하지 않음)
async function handlePatch({ request, env, user, params }) {
  const answer = await env.DB.prepare(
    "SELECT a.id, q.user_id FROM answers a JOIN questions q ON a.question_id = q.id WHERE a.id = ?"
  ).bind(params.id).first();

  if (!answer) return json({ error: "답변을 찾을 수 없습니다" }, 404);
  if (answer.user_id !== user.id && user.role !== "admin")
    return json({ error: "접근 권한이 없습니다" }, 403);

  const body = await request.json();
  const fields = [], vals = [];

  if (body.content_edited !== undefined) {
    fields.push("content_edited = ?"); vals.push(body.content_edited);
  }
  if (body.rating !== undefined && [1, -1].includes(Number(body.rating))) {
    fields.push("rating = ?"); vals.push(Number(body.rating));
  }

  if (!fields.length) return json({ error: "수정할 필드가 없습니다" }, 400);

  fields.push("updated_at = CURRENT_TIMESTAMP");
  await env.DB.prepare(
    `UPDATE answers SET ${fields.join(", ")} WHERE id = ?`
  ).bind(...vals, params.id).run();

  return json({ ok: true, updated_at: new Date().toISOString() });
}

// POST /api/answers/:id — 공유 토큰 발급 (없으면 생성, 있으면 기존 반환)
async function handleShare({ env, user, params }) {
  const answer = await env.DB.prepare(
    "SELECT a.id, a.share_token, q.user_id FROM answers a JOIN questions q ON a.question_id = q.id WHERE a.id = ?"
  ).bind(params.id).first();

  if (!answer) return json({ error: "답변을 찾을 수 없습니다" }, 404);
  if (answer.user_id !== user.id && user.role !== "admin")
    return json({ error: "접근 권한이 없습니다" }, 403);

  let token = answer.share_token;
  if (!token) {
    token = crypto.randomUUID().replace(/-/g, "");
    await env.DB.prepare("UPDATE answers SET share_token = ? WHERE id = ?")
      .bind(token, params.id).run();
  }

  return json({ token, share_url: `/share?token=${token}` });
}
