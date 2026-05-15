import { verifyPassword, signJWT, json } from "../../_lib/auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { email, password } = await request.json();
    if (!email || !password) return json({ error: "이메일과 비밀번호를 입력해주세요" }, 400);

    const user = await env.DB.prepare(
      "SELECT * FROM users WHERE email = ?"
    ).bind(email.toLowerCase()).first();

    if (!user) return json({ error: "이메일 또는 비밀번호가 올바르지 않습니다" }, 401);

    if (user.status === "suspended") return json({ error: "이용이 정지된 계정입니다" }, 403);

    // 비밀번호 검증 (CHANGE_ME는 초기 관리자 계정용)
    let valid = false;
    if (user.password_hash === "CHANGE_ME" && password === "admin1234") {
      valid = true;
    } else {
      valid = await verifyPassword(password, user.password_hash);
    }

    if (!valid) return json({ error: "이메일 또는 비밀번호가 올바르지 않습니다" }, 401);

    // 무료기간 만료 체크
    let status = user.status;
    if (status === "trial" && user.trial_ends_at) {
      const trialEnd = new Date(user.trial_ends_at);
      if (trialEnd < new Date()) {
        await env.DB.prepare("UPDATE users SET status = 'expired' WHERE id = ?").bind(user.id).run();
        status = "expired";
      }
    }

    // 로그인 시각 갱신
    await env.DB.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(user.id).run();

    const token = await signJWT(
      { id: user.id, email: user.email, role: user.role, name: user.name, status },
      env.JWT_SECRET
    );

    return json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email,
        role: user.role, status, org: user.org,
        tax_categories: JSON.parse(user.tax_categories || "[]"),
      },
    });
  } catch (e) {
    console.error("Login error:", e);
    return json({ error: "서버 오류가 발생했습니다" }, 500);
  }
}
