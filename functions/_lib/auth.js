// JWT + 비밀번호 유틸 (Web Crypto API 기반, Cloudflare Workers 호환)

const ENC = (obj) =>
  btoa(JSON.stringify(obj))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

const DEC = (str) =>
  JSON.parse(atob(str.replace(/-/g, "+").replace(/_/g, "/")));

export async function signJWT(payload, secret, expiresIn = 86400 * 7) {
  payload.exp = Math.floor(Date.now() / 1000) + expiresIn;
  payload.iat = Math.floor(Date.now() / 1000);
  const data = `${ENC({ alg: "HS256", typ: "JWT" })}.${ENC(payload)}`;
  const key  = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${data}.${sigB64}`;
}

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
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
  if (!ok) throw new Error("서명 검증 실패");
  const decoded = DEC(payload);
  if (decoded.exp < Math.floor(Date.now() / 1000)) throw new Error("토큰 만료");
  return decoded;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256
  );
  const hash    = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const saltB64 = btoa(String.fromCharCode(...salt));
  return `${saltB64}:${hash}`;
}

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

export async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return null;
  try {
    return await verifyJWT(token, env.JWT_SECRET);
  } catch {
    return null;
  }
}

export function requireAuth(user) {
  if (!user) return json({ error: "로그인이 필요합니다" }, 401);
  return null;
}

export function requireAdmin(user) {
  if (!user) return json({ error: "로그인이 필요합니다" }, 401);
  if (user.role !== "admin") return json({ error: "관리자 권한이 필요합니다" }, 403);
  return null;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
