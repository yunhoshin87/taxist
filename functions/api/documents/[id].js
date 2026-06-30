// ============================================================================
// GET /api/documents/:id — 참고자료(법령·판례·해석례) 원문 조회
//
// 답변 화면의 "[자료 N]" 인용이나 출처 목록을 클릭했을 때, taxlaw.nts.go.kr이
// 비공개 AJAX(세션 쿠키 + action.do POST)로만 상세를 제공해 외부 딥링크가
// 불가능하므로, DB에 이미 저장된 문서 원문을 자체 모달로 보여주기 위한 엔드포인트.
//
// 인증 불필요: 공유 링크(share.html, 비로그인)에서도 출처 원문을 볼 수 있어야 하고,
// 문서 내용 자체가 법령/판례/해석례 등 공개 정보이므로 별도 권한 검사가 필요 없다.
// ============================================================================
import { json } from "../../_lib/auth.js";

export async function onRequestGet({ env, params }) {
  const id = Number(params.id);
  if (!id) return json({ error: "잘못된 문서 ID" }, 400);

  const doc = await env.DB.prepare(`
    SELECT d.id, d.name, d.content, d.tax_category, f.name AS folder_name
    FROM documents d
    JOIN folders f ON d.folder_id = f.id
    WHERE d.id = ? AND d.is_active = 1 AND f.is_active = 1
  `).bind(id).first();

  if (!doc) return json({ error: "문서를 찾을 수 없습니다" }, 404);

  return json({ document: doc });
}
