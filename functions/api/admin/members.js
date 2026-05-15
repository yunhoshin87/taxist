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
  const url    = new URL(request.url);
  const search = url.searchParams.get("q") || "";
  const status = url.searchParams.get("status") || "";

  let query = `
    SELECT u.id, u.name, u.email, u.org, u.tax_categories,
           u.role, u.status, u.joined_at, u.trial_ends_at, u.last_login_at,
           COUNT(q.id) AS question_count
    FROM users u
    LEFT JOIN questions q ON q.user_id = u.id
    WHERE u.role != 'admin'
  `;
  const binds = [];

  if (search) {
    query += " AND (u.name LIKE ? OR u.email LIKE ? OR u.org LIKE ?)";
    binds.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) {
    query += " AND u.status = ?";
    binds.push(status);
  }
  query += " GROUP BY u.id ORDER BY u.joined_at DESC";

  const { results } = await env.DB.prepare(query).bind(...binds).all();

  return json({
    members: results.map(m => ({
      ...m,
      tax_categories: JSON.parse(m.tax_categories || "[]"),
    })),
  });
}

async function handlePut({ request, env }) {
  const { id, status, trial_ends_at } = await request.json();
  if (!id) return json({ error: "id 필요" }, 400);

  if (status) {
    await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?")
      .bind(status, id).run();
  }
  if (trial_ends_at) {
    await env.DB.prepare("UPDATE users SET trial_ends_at = ?, status = 'trial' WHERE id = ?")
      .bind(trial_ends_at, id).run();
  }

  return json({ ok: true });
}
