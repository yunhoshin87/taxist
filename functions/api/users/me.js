import { getUser, requireAuth, json } from "../../_lib/auth.js";

export async function onRequest(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  if (request.method === "GET")   return handleGet({ env, user });
  if (request.method === "PATCH") return handlePatch({ request, env, user });
  return json({ error: "허용되지 않는 메서드" }, 405);
}

async function handleGet({ env, user }) {
  const row = await env.DB.prepare(`
    SELECT id, name, email, org, tax_categories, role, status,
           joined_at, trial_ends_at, last_login_at
    FROM users WHERE id = ?
  `).bind(user.id).first();

  if (!row) return json({ error: "사용자를 찾을 수 없습니다" }, 404);

  const { results: [{ cnt: questionCount }] } = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM questions WHERE user_id = ?"
  ).bind(user.id).all();

  // 무료 기간 만료 자동 체크
  let status = row.status;
  if (status === "trial" && row.trial_ends_at) {
    if (new Date(row.trial_ends_at) < new Date()) {
      await env.DB.prepare("UPDATE users SET status = 'expired' WHERE id = ?")
        .bind(user.id).run();
      status = "expired";
    }
  }

  return json({
    user: {
      ...row,
      status,
      tax_categories: JSON.parse(row.tax_categories || "[]"),
      question_count: questionCount,
    },
  });
}

async function handlePatch({ request, env, user }) {
  const body = await request.json();
  const { name, org, tax_categories } = body;

  const sets = [];
  const vals = [];

  if (name)           { sets.push("name = ?");           vals.push(name); }
  if (org)            { sets.push("org = ?");             vals.push(org); }
  if (tax_categories) { sets.push("tax_categories = ?");  vals.push(JSON.stringify(tax_categories)); }

  if (!sets.length) return json({ error: "변경할 항목이 없습니다" }, 400);

  vals.push(user.id);
  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals).run();

  return json({ ok: true });
}
