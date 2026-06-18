// POST /api/auth/login — 이메일/비밀번호 로그인 → JWT 발급
import { verifyPassword, signJWT, json } from "../../_lib/auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { email, password } = await request.json();
    if (!email || !password) return json({ error: "이메일과 비밀번호를 입력해주세요" }, 400);

    // 이메일은 가입 시 항상 소문자로 저장되므로 조회도 소문자로 통일
    const user = await env.DB.prepare(
      "SELECT * FROM users WHERE email = ?"
    ).bind(email.toLowerCase()).first();

    // 존재하지 않는 계정과 비밀번호 오류를 같은 메시지로 응답해
    // 가입 여부(계정 존재 여부)가 외부에 노출되지 않도록 한다
    if (!user) return json({ error: "이메일 또는 비밀번호가 올바르지 않습니다" }, 401);

    if (user.status === "suspended") return json({ error: "이용이 정지된 계정입니다" }, 403);

    // 비밀번호 검증. password_hash가 "CHANGE_ME"인 것은 초기 시딩된 관리자
    // 계정으로, 최초 1회 기본 비밀번호(admin1234)로만 로그인 가능하다.
    // (실제 운영 시에는 로그인 후 반드시 비밀번호를 변경해야 함 — 현재는
    //  비밀번호 변경 UI가 별도로 없으므로 DB에서 직접 hashPassword()로 갱신 필요)
    let valid = false;
    if (user.password_hash === "CHANGE_ME" && password === "admin1234") {
      valid = true;
    } else {
      valid = await verifyPassword(password, user.password_hash);
    }

    if (!valid) return json({ error: "이메일 또는 비밀번호가 올바르지 않습니다" }, 401);

    // 무료기간(trial_ends_at) 만료 여부를 로그인 시점에 확인해 즉시 DB에 반영.
    // (questions/index.js의 트라이얼 체크와 함께, 만료 처리가 누락되지 않도록
    //  로그인할 때마다 한 번 더 검증하는 구조)
    let status = user.status;
    if (status === "trial" && user.trial_ends_at) {
      const trialEnd = new Date(user.trial_ends_at);
      if (trialEnd < new Date()) {
        await env.DB.prepare("UPDATE users SET status = 'expired' WHERE id = ?").bind(user.id).run();
        status = "expired";
      }
    }

    // 최근 로그인 시각 갱신 (관리자페이지 회원 목록에 표시됨)
    await env.DB.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(user.id).run();

    // JWT payload에 role/status를 함께 담아, 매 요청마다 DB 조회 없이
    // getUser()만으로 권한·이용상태 판단이 가능하게 한다(단, 토큰 발급 시점의
    // 값이 고정되므로 토큰 만료 전까지는 상태 변경이 즉시 반영되지 않을 수 있음 —
    // 토큰 수명은 signJWT 기본값인 7일).
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
    return json({ error: "서버 오류가 발생했습니다", detail: e?.message || String(e) }, 500);
  }
}
