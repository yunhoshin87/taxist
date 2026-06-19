// ============================================================================
// GET /api/share?token=X — 공유 링크를 통한 보고서 공개 조회 (인증 불필요)
//
// 사용자가 answer에서 "공유" 버튼을 누르면 /api/answers/:id (POST)가 호출되어
// answers.share_token 컬럼에 UUID 토큰이 저장된다. 이 토큰을 쿼리 파라미터로
// 받아 누구나(비로그인) 해당 보고서를 열람할 수 있게 하는 공개 엔드포인트.
//
// 보안 고려사항:
//   - 토큰은 암호학적으로 무작위(crypto.randomUUID)이므로 열거(enumeration)가 사실상 불가
//   - 공유 취소 기능은 현재 없음 — 취소가 필요하면 DB에서 share_token을 NULL로 갱신해야 함
//   - 공개 열람이므로 인증 헤더 없이도 동작하고, _middleware.js의 CORS도 통과됨
// ============================================================================
import { json } from "../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  // URL 쿼리에서 토큰 추출 (?token=abc123...)
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return json({ error: "token 필요" }, 400);

  // answers + questions 조인: 토큰으로 답변을 찾고, 세목/제목 등 메타정보도 함께 조회
  // share_token은 UNIQUE 인덱스라 1건만 반환됨
  const row = await env.DB.prepare(`
    SELECT a.id, a.content, a.content_edited, a.sources, a.created_at,
           q.tax_category, q.title
    FROM answers a
    JOIN questions q ON a.question_id = q.id
    WHERE a.share_token = ?
  `).bind(token).first();

  // 토큰이 DB에 없거나(오타/삭제된 공유) 매칭 안 되면 404
  if (!row) return json({ error: "공유 링크를 찾을 수 없거나 만료됐습니다" }, 404);

  return json({
    tax_category: row.tax_category,
    title:        row.title,
    // 사용자가 편집한 버전(content_edited)이 있으면 그것을, 없으면 원본 AI 답변(content)을 반환
    content:      row.content_edited ?? row.content,
    sources:      JSON.parse(row.sources || "[]"),
    created_at:   row.created_at,
  });
}
