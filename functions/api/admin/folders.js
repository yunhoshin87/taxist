// ============================================================================
// /api/admin/folders — 관리자 자료 폴더/문서 관리 (관리자 전용)
//
// 폴더트리 조회/문서내용 조회(GET), 폴더 활성토글(PUT), 문서 활성토글(POST),
// 새 문서 업로드(PATCH) 4가지 동작을 메서드로 구분해 하나의 엔드포인트에서
// 처리한다. loadDocuments()(functions/_lib/docs.js)가 답변 생성 시 조회하는
// documents/folders 테이블을 직접 다루는 곳이라, 여기서 비활성화한 자료는
// 답변에 더 이상 인용되지 않는다.
// ============================================================================
import { getUser, requireAdmin, json } from "../../_lib/auth.js";

export async function onRequest(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const err  = requireAdmin(user);
  if (err) return err;

  const method = request.method;
  if (method === "GET")   return handleGet(context);
  if (method === "PUT")   return handlePut(context);
  if (method === "POST")  return handlePost(context);
  if (method === "PATCH") return handlePatch(context);
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

  // 폴더를 비활성화하면 그 안의 문서를 답변 검색에서 완전히 제외하기 위해
  // 하위 문서도 함께 is_active=0으로 내린다 (폴더만 꺼도 문서가 여전히
  // 검색되는 것을 방지)
  if (!is_active) {
    await env.DB.prepare("UPDATE documents SET is_active = 0 WHERE folder_id = ?")
      .bind(id).run();
  }

  return json({ ok: true });
}

// POST /api/admin/folders - 문서 활성/비활성 토글
async function handlePost({ request, env }) {
  const { doc_id, is_active } = await request.json();
  if (!doc_id) return json({ error: "doc_id 필요" }, 400);

  await env.DB.prepare("UPDATE documents SET is_active = ? WHERE id = ?")
    .bind(is_active ? 1 : 0, doc_id).run();

  return json({ ok: true });
}

// PATCH /api/admin/folders - 새 문서 업로드 (엑셀/텍스트 → D1 저장)
async function handlePatch({ request, env }) {
  const { folder_id, name, content, tax_category } = await request.json();
  if (!folder_id || !name || !content) return json({ error: "folder_id, name, content 필요" }, 400);

  // 문서 본문은 500,000자(약 D1 안전 한도)로 잘라 저장한다 — 그 이상은
  // 컬럼 크기 문제보다 답변 생성 시 어차피 다 쓰지 못하므로 의미가 없음.
  const result = await env.DB.prepare(
    `INSERT INTO documents (folder_id, name, content, tax_category, is_active, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'))`
  ).bind(folder_id, name, content.slice(0, 500000), tax_category || 'all').run();

  const docId = result.meta.last_row_id;

  // documents 테이블에 넣은 rowid(docId)를 그대로 FTS5 가상테이블의 rowid로
  // 사용해 1:1 매칭시킨다 (loadDocuments의 FTS5 검색이 이 매핑에 의존).
  // FTS5 테이블 스키마가 (name, content) 컬럼을 가진 버전과, content
  // 단일 컬럼만 가진 구버전 마이그레이션이 혼재할 수 있어 1차 시도가
  // 실패하면 콜백 형태로 재시도한다.
  try {
    await env.DB.prepare(
      `INSERT INTO documents_fts(rowid, name, content) VALUES (?, ?, ?)`
    ).bind(docId, name, content.slice(0, 500000)).run();
  } catch {
    try {
      await env.DB.prepare(
        `INSERT INTO documents_fts(rowid, content) VALUES (?, ?)`
      ).bind(docId, (name + ' ' + content).slice(0, 500000)).run();
    } catch (e2) {
      // FTS 색인이 실패해도 문서 자체는 이미 저장됐으므로 업로드는 성공 처리.
      // (이 문서는 FTS 검색에는 안 잡히지만 세목 폴백 검색에는 여전히 노출됨)
      console.error('FTS5 insert failed:', e2?.message);
    }
  }

  return json({ ok: true, id: docId });
}
