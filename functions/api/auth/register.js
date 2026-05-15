import { hashPassword, signJWT, json } from "../../_lib/auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { name, email, password, org, tax_categories, phone } = await request.json();

    if (!name || !email || !password || !org || !tax_categories?.length)
      return json({ error: "필수 항목을 모두 입력해주세요" }, 400);

    if (password.length < 8)
      return json({ error: "비밀번호는 8자 이상이어야 합니다" }, 400);

    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind(email.toLowerCase()).first();
    if (existing) return json({ error: "이미 사용 중인 이메일입니다" }, 409);

    const hash = await hashPassword(password);
    const trialEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const result = await env.DB.prepare(`
      INSERT INTO users (name, email, password_hash, org, tax_categories, role, status, trial_ends_at)
      VALUES (?, ?, ?, ?, ?, 'user', 'trial', ?)
    `).bind(
      name, email.toLowerCase(), hash, org,
      JSON.stringify(tax_categories), trialEnd
    ).run();

    const token = await signJWT(
      { id: result.meta.last_row_id, email: email.toLowerCase(), role: "user", name, status: "trial" },
      env.JWT_SECRET
    );

    return json({
      token,
      user: {
        id: result.meta.last_row_id, name, email: email.toLowerCase(),
        role: "user", status: "trial", org,
        tax_categories, trial_ends_at: trialEnd,
      },
    }, 201);
  } catch (e) {
    console.error("Register error:", e);
    return json({ error: "서버 오류가 발생했습니다" }, 500);
  }
}
