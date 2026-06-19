// ============================================================================
// /api/templates — 질문 템플릿 CRUD (로그인 필수)
//
// 세무공무원이 자주 사용하는 질문 패턴을 저장·불러오기하는 기능.
// 예: "부당행위계산 부인 검토 요청 형식", "가산세 감면 요청 형식" 등을
//     이름 붙여 저장해두고, 질의 작성 시 불러와 내용에 자동 삽입한다.
//
// 저장 위치: D1 question_templates 테이블 (user_id 기준으로 격리)
// 최대 저장 용량: 이름 60자, 내용 10,000자 (handlePost에서 slice로 강제 적용)
//
// 엔드포인트:
//   GET    /api/templates       내 템플릿 목록 (최신순)
//   POST   /api/templates       새 템플릿 저장 { name, content }
//   DELETE /api/templates?id=X  템플릿 삭제 (소유자만 가능)
// ============================================================================
import { getUser, requireAuth, json } from "../_lib/auth.js";

export async function onRequest(context) {
  const { request } = context;
  if (request.method === "GET")    return handleGet(context);
  if (request.method === "POST")   return handlePost(context);
  if (request.method === "DELETE") return handleDelete(context);
  return json({ error: "허용되지 않는 메서드" }, 405);
}

// GET /api/templates — 내 템플릿 목록 반환
// 최신 저장 순서(created_at DESC)로 반환해, UI에서 최근 저장된 것이 위에 보이도록 한다.
async function handleGet({ request, env }) {
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  const { results } = await env.DB.prepare(
    "SELECT id, name, content, created_at FROM question_templates WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(user.id).all();

  return json({ templates: results });
}

// POST /api/templates — 새 템플릿 저장 { name, content }
// 빈 이름/내용은 저장 거부. 이름 60자·내용 10,000자 상한은 DB 용량 보호 목적.
async function handlePost({ request, env }) {
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  const { name, content } = await request.json();
  if (!name?.trim() || !content?.trim()) return json({ error: "name과 content 필요" }, 400);

  const result = await env.DB.prepare(
    "INSERT INTO question_templates (user_id, name, content) VALUES (?, ?, ?)"
  ).bind(user.id, name.trim().slice(0, 60), content.slice(0, 10000)).run();

  // last_row_id: 방금 삽입된 행의 id — 클라이언트가 저장 직후 즉시 목록을 갱신할 때 사용
  return json({ ok: true, id: result.meta.last_row_id });
}

// DELETE /api/templates?id=X — 템플릿 삭제
// 소유권 확인 후 삭제한다. 관리자(role='admin')는 다른 사람의 템플릿도 삭제 가능.
// 존재하지 않는 id이면 404를 반환해 클라이언트가 이미 삭제된 항목을 다시 삭제하려는 경우를 처리한다.
async function handleDelete({ request, env }) {
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return json({ error: "id 필요" }, 400);

  // 먼저 소유권을 확인하고 없으면 404 (DELETE 전 조회)
  const tmpl = await env.DB.prepare(
    "SELECT user_id FROM question_templates WHERE id = ?"
  ).bind(Number(id)).first();
  if (!tmpl) return json({ error: "템플릿을 찾을 수 없습니다" }, 404);

  // 본인 것이 아니고 관리자도 아니면 403 거부
  if (tmpl.user_id !== user.id && user.role !== "admin") return json({ error: "권한 없음" }, 403);

  await env.DB.prepare("DELETE FROM question_templates WHERE id = ?").bind(Number(id)).run();
  return json({ ok: true });
}
