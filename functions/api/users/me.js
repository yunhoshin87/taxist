// /api/users/me — 내 프로필 조회(GET) 및 수정(PATCH) — 마이페이지에서 사용
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

  // 마이페이지 조회 시에도 만료 여부를 다시 체크해 status를 최신화한다
  // (login.js와 동일한 로직 — 토큰에 박힌 status가 만료 후에도 한동안
  //  유효할 수 있어, 실시간 조회 API에서는 DB 기준으로 다시 계산해준다)
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

  // 전달된 필드만 동적으로 UPDATE 절을 구성한다 (부분 업데이트 지원).
  // 값이 비어있으면( "" / undefined ) 해당 필드는 변경하지 않고 건너뜀.
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
