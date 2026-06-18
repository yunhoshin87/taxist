// ============================================================================
// 인증 유틸리티 — JWT 발급/검증 + 비밀번호 해싱
//
// Cloudflare Workers/Pages Functions 런타임은 Node.js의 crypto, jsonwebtoken,
// bcrypt 같은 패키지를 쓸 수 없으므로(Web 표준 런타임), 브라우저와 동일한
// Web Crypto API(crypto.subtle)만으로 JWT 서명/검증과 비밀번호 해싱을 직접
// 구현했다. 외부 라이브러리 의존성 없이 동작하는 것이 핵심 제약.
// ============================================================================

// ── Base64url 인코딩/디코딩 ──────────────────────────────────────────────
// JWT는 Base64url(표준 Base64에서 +,/,= 를 -,_, 제거로 바꾼 것)을 사용한다.
// btoa/atob는 "바이너리 문자열"만 다루므로, 한글이 포함된 JSON(payload에
// 사용자 이름 등)을 그대로 넘기면 깨진다. 그래서 TextEncoder로 UTF-8 바이트
// 배열로 변환한 뒤 문자 코드 단위로 옮겨 btoa에 넣는 과정이 필요하다.

// 객체 → JSON → UTF-8 바이트 → Base64url 문자열
const ENC = (obj) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b)); // 바이트를 1:1 문자로 매핑(btoa 입력용)
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

// Base64url 문자열 → UTF-8 바이트 → JSON → 객체 (ENC의 역연산)
const DEC = (str) => {
  const bin  = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};

/**
 * JWT(HS256) 발급
 * @param {object} payload  토큰에 담을 데이터(예: { id, email, role }). exp/iat는 이 함수가 자동으로 채운다.
 * @param {string} secret   서명용 비밀키 (env.JWT_SECRET)
 * @param {number} expiresIn 만료까지 남은 시간(초). 기본 7일.
 * @returns {Promise<string>} "header.payload.signature" 형태의 JWT 문자열
 */
export async function signJWT(payload, secret, expiresIn = 86400 * 7) {
  payload.exp = Math.floor(Date.now() / 1000) + expiresIn; // 만료 시각(unix seconds)
  payload.iat = Math.floor(Date.now() / 1000); // 발급 시각

  // JWT 표준 구조: base64url(header) + "." + base64url(payload)
  const data = `${ENC({ alg: "HS256", typ: "JWT" })}.${ENC(payload)}`;

  // HMAC-SHA256 서명을 위해 secret을 CryptoKey로 가져온다
  const key  = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));

  // 서명(ArrayBuffer)도 Base64url로 인코딩해 토큰 끝에 붙인다
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${data}.${sigB64}`;
}

/**
 * JWT 검증 — 서명 무결성과 만료 시각을 확인하고, 유효하면 payload를 반환한다.
 * 서명이 틀렸거나(위조/변조) 만료됐으면 예외를 던진다. (호출부는 try/catch로 처리)
 */
export async function verifyJWT(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("잘못된 토큰");
  const [header, payload, sig] = parts;
  const data = `${header}.${payload}`;

  const key  = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const sigBytes = Uint8Array.from(
    atob(sig.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)
  );

  // 서명이 secret으로 재계산한 값과 일치하는지 확인 (위조 토큰 차단)
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
  if (!ok) throw new Error("서명 검증 실패");

  const decoded = DEC(payload);
  // exp(만료 시각)가 현재 시각보다 과거면 만료된 토큰
  if (decoded.exp < Math.floor(Date.now() / 1000)) throw new Error("토큰 만료");
  return decoded;
}

/**
 * 비밀번호 해싱 (PBKDF2-SHA256, 100,000 iterations)
 * salt는 매번 랜덤 생성하여 "salt:hash" 형태의 문자열로 DB에 저장한다.
 * bcrypt 대신 PBKDF2를 쓰는 이유: Web Crypto API(crypto.subtle)가 표준으로
 * 지원하는 알고리즘만 Workers 런타임에서 사용 가능하기 때문.
 */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16)); // 16바이트 랜덤 salt
  const key  = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256
  );
  const hash    = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const saltB64 = btoa(String.fromCharCode(...salt));
  return `${saltB64}:${hash}`; // DB의 password_hash 컬럼에 저장되는 형식
}

/**
 * 비밀번호 검증 — 로그인 시 입력한 평문 비밀번호를 저장된 "salt:hash"와 비교한다.
 * 저장된 salt를 재사용해 동일한 PBKDF2 연산을 수행한 뒤 결과 해시가 같은지 확인.
 */
export async function verifyPassword(password, stored) {
  const [saltB64, hash] = stored.split(":");
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const key  = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits))) === hash;
}

/**
 * 요청의 Authorization 헤더("Bearer <token>")에서 사용자 정보를 추출한다.
 * 토큰이 없거나 유효하지 않으면(만료/위조) null을 반환한다 — 401을 던지지 않고
 * 호출부(requireAuth/requireAdmin)가 정책을 결정하도록 분리되어 있다.
 */
export async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return null;
  try {
    return await verifyJWT(token, env.JWT_SECRET);
  } catch {
    return null; // 만료/위조/형식오류 등 사유 불문 비로그인으로 취급
  }
}

/** 로그인 필수 가드. 비로그인이면 401 Response를, 통과하면 null을 반환한다.
 *  API 핸들러에서 `const err = requireAuth(user); if (err) return err;` 형태로 사용. */
export function requireAuth(user) {
  if (!user) return json({ error: "로그인이 필요합니다" }, 401);
  return null;
}

/** 관리자 권한 필수 가드. 비로그인이면 401, 일반 회원이면 403을 반환한다. */
export function requireAdmin(user) {
  if (!user) return json({ error: "로그인이 필요합니다" }, 401);
  if (user.role !== "admin") return json({ error: "관리자 권한이 필요합니다" }, 403);
  return null;
}

/** JSON 응답 헬퍼 — 모든 API 핸들러가 공통으로 사용하는 Response 생성 함수. */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
