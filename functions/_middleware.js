// ============================================================================
// 전역 CORS 미들웨어
//
// Cloudflare Pages Functions의 _middleware.js는 functions/ 디렉토리 트리의
// 모든 요청 전에 자동으로 실행된다(파일 기반 라우팅의 공통 후크). 모든
// API 응답에 CORS 헤더를 일괄 부여하기 위해 여기 한 곳에만 정의한다 —
// 각 API 핸들러(functions/api/**)에서 개별적으로 CORS를 처리할 필요 없음.
// ============================================================================

const CORS = {
  "Access-Control-Allow-Origin":  "*", // 모든 출처 허용 (별도 인증은 JWT로 처리)
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function onRequest(context) {
  // 브라우저가 보내는 CORS preflight 요청은 본문 없이 204로 즉시 응답
  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // 실제 요청은 다음 핸들러(라우트 매칭된 functions/api/*.js)로 넘기고,
  // 그 응답에 CORS 헤더를 덧붙여 반환한다.
  const response = await context.next();
  const newHeaders = new Headers(response.headers);
  Object.entries(CORS).forEach(([k, v]) => newHeaders.set(k, v));
  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}
