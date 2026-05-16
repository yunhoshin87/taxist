import { getUser, requireAdmin, json } from "../../_lib/auth.js";

export async function onRequest(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const err  = requireAdmin(user);
  if (err) return err;

  const method = request.method;
  if (method === "GET")  return handleGet(context);
  if (method === "PUT")  return handlePut(context);
  if (method === "POST") return handlePost(context);
  return json({ error: "허용되지 않는 메서드" }, 405);
}

// GET /api/admin/folders - 폴더 트리 + 문서 목록
// GET /api/admin/folders?doc_id=X - 문서 내용 단건 조회
async function handleGet({ request, env }) {
  const url   = new URL(request.url);
  const docId = url.searchParams.get("doc_id");

  if (docId) {
    const doc = await env.DB.prepare(
      "SELECT id, name, content, tax_category, is_active, updated_at FROM documents WHERE id = ?"
    ).bind(Number(docId)).first();
    if (!doc) return json({ error: "문서 없음" }, 404);
    return json({ doc });
  }

  const { results: folders } = await env.DB.prepare(
    "SELECT * FROM folders ORDER BY sort_order ASC"
  ).all();

  const { results: docs } = await env.DB.prepare(
    "SELECT id, folder_id, name, file_path, tax_category, is_active, updated_at FROM documents ORDER BY name ASC"
  ).all();

  // 폴더별 문서 그룹화
  const docMap = {};
  docs.forEach(d => {
    if (!docMap[d.folder_id]) docMap[d.folder_id] = [];
    docMap[d.folder_id].push(d);
  });

  const tree = folders.map(f => ({
    ...f,
    documents: docMap[f.id] || [],
  }));

  return json({ folders: tree });
}

// PUT /api/admin/folders - 폴더 활성/비활성 토글
async function handlePut({ request, env }) {
  const { id, is_active } = await request.json();
  if (id === undefined) return json({ error: "id 필요" }, 400);

  await env.DB.prepare("UPDATE folders SET is_active = ? WHERE id = ?")
    .bind(is_active ? 1 : 0, id).run();

  // 폴더 비활성화 시 하위 문서도 비활성화
  if (!is_active) {
    await env.DB.prepare("UPDATE documents SET is_active = 0 WHERE folder_id = ?")
      .bind(id).run();
  }

  return json({ ok: true });
}

// POST /api/admin/folders/document - 문서 활성/비활성 토글
async function handlePost({ request, env }) {
  const url = new URL(request.url);
  const { doc_id, is_active } = await request.json();
  if (!doc_id) return json({ error: "doc_id 필요" }, 400);

  await env.DB.prepare("UPDATE documents SET is_active = ? WHERE id = ?")
    .bind(is_active ? 1 : 0, doc_id).run();

  return json({ ok: true });
}
