// POST /api/auth/register — 회원가입 (가입 즉시 30일 무료체험 시작 + JWT 발급)
import { hashPassword, signJWT, json } from "../../_lib/auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    // email 필드는 실제로는 "아이디"로 쓰인다(이메일 형식 검증 없음 — 임의 문자열 허용).
    // phone은 현재 받기는 하지만 DB에 저장하지 않는다(향후 결제/고객지원 연락용으로 기획만 됨).
    const { name, email, password, org, tax_categories, phone } = await request.json();

    if (!name || !email || !password || !org || !tax_categories?.length)
      return json({ error: "필수 항목을 모두 입력해주세요" }, 400);

    if (email.length < 3)
      return json({ error: "아이디는 3자 이상이어야 합니다" }, 400);

    if (password.length < 8)
      return json({ error: "비밀번호는 8자 이상이어야 합니다" }, 400);

    // 아이디(email) 중복 체크. DB 조회는 소문자로 정규화된 값으로 비교한다
    // (로그인 시에도 동일하게 소문자 변환 후 조회하므로 대소문자 구분 없이 unique).
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind(email.toLowerCase()).first();
    if (existing) return json({ error: "이미 사용 중인 아이디입니다" }, 409);

    const hash = await hashPassword(password);
    // 가입일로부터 30일을 무료체험 기간으로 부여 (기획서의 "1개월 무료" 정책)
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
