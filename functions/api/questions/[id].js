// GET /api/questions/:id — 질문 1건 + 연결된 답변 상세 조회
// 파일명 [id].js는 Cloudflare Pages Functions의 동적 라우팅 문법으로,
// URL의 :id 세그먼트가 context.params.id로 전달된다.
import { getUser, requireAuth, json } from "../../_lib/auth.js";

export async function onRequestGet(context) {
  const { params, request, env } = context;
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  const { id } = params;

  const question = await env.DB.prepare(
    "SELECT * FROM questions WHERE id = ?"
  ).bind(id).first();

  if (!question) return json({ error: "질문을 찾을 수 없습니다" }, 404);

  // 소유권 검사: 본인이 작성한 질문이거나 관리자만 조회 가능 (다른 회원의
  // 질문 ID를 URL에 넣어 조회하는 것을 방지)
  if (question.user_id !== user.id && user.role !== "admin")
    return json({ error: "접근 권한이 없습니다" }, 403);

  const answer = await env.DB.prepare(
    "SELECT * FROM answers WHERE question_id = ?"
  ).bind(id).first();

  return json({
    question,
    // sources는 DB에 JSON 문자열로 저장돼 있어 응답 시 배열로 풀어준다
    answer: answer
      ? { ...answer, sources: JSON.parse(answer.sources || "[]") }
      : null,
  });
}
