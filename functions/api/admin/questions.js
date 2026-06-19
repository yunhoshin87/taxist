// /api/admin/questions — 관리자용 전체 질문/답변 목록 조회(GET, 세목·상태
// 필터 + 페이지네이션) 및 질문 상태 강제 변경(PUT) — 품질 검토·재답변 표시용
import { getUser, requireAdmin, json } from "../../_lib/auth.js";

export async function onRequest(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const err  = requireAdmin(user);
  if (err) return err;

  if (request.method === "GET") return handleGet(context);
  if (request.method === "PUT") return handlePut(context);
  return json({ error: "허용되지 않는 메서드" }, 405);
}

async function handleGet({ request, env }) {
  const url      = new URL(request.url);
  const category = url.searchParams.get("category") || "";
  const status   = url.searchParams.get("status") || "";
  const page     = parseInt(url.searchParams.get("page") || "1");
  const limit    = 20;
  const offset   = (page - 1) * limit;

  let query = `
    SELECT q.id, q.tax_category, q.title, q.status, q.created_at,
           u.name AS user_name, u.org,
           a.id AS answer_id,
           a.created_at AS answered_at
    FROM questions q
    JOIN users u ON u.id = q.user_id
    LEFT JOIN answers a ON a.question_id = q.id
    WHERE 1=1
  `;
  const binds = [];

  if (category) { query += " AND q.tax_category = ?"; binds.push(category); }
  if (status)   { query += " AND q.status = ?";       binds.push(status); }

  query += " ORDER BY q.created_at DESC LIMIT ? OFFSET ?";
  binds.push(limit, offset);

  const { results } = await env.DB.prepare(query).bind(...binds).all();

  return json({ questions: results, page, limit });
}

async function handlePut({ request, env }) {
  const { id, status } = await request.json();
  if (!id || !status) return json({ error: "id, status 필요" }, 400);

  await env.DB.prepare("UPDATE questions SET status = ? WHERE id = ?")
    .bind(status, id).run();

  return json({ ok: true });
}
