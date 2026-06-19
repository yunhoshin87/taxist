// ============================================================================
// POST /api/ocr — 첨부파일을 마크다운으로 변환
//
// PDF는 Gemini 멀티모달로 읽어 마크다운으로 변환한다 — 별도 OCR 전용 API
// (Document AI 등) 없이 기존 GEMINI_API_KEY로 처리하지만, 답변 생성과 같은
// 할당량 풀을 공유하므로 첨부파일이 많은 질문은 그만큼 API 호출 수가 늘어난다.
// xlsx는 ZIP/XML을 직접 파싱해(functions/_lib/xlsx.js) 셀 값을 그대로 표로
// 옮기므로 Gemini를 거치지 않는다 — 더 정확하고 API 호출도 들지 않는다.
//
// 업로드된 파일은 변환에만 쓰이고 응답 후 버려진다 — 서버 어디에도 원본 파일을
// 저장하지 않으며, 변환된 마크다운 텍스트만 클라이언트로 돌려준다.
// 클라이언트(ask.html)는 이 마크다운을 질문 본문(content)에 합쳐서 보낸다.
// ============================================================================

import { getUser, requireAuth, json } from "../_lib/auth.js";
import { ocrToMarkdown } from "../_lib/gemini.js";
import { xlsxToMarkdown } from "../_lib/xlsx.js";

const MAX_SIZE = 10 * 1024 * 1024; // 10MB — 첨부서류 카드의 안내 문구와 동일
const PDF_MIME_MAP = {
  pdf: "application/pdf", // 이미지 업로드는 지원하지 않음(PDF만 허용)
};

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ error: "허용되지 않는 메서드" }, 405);

  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string")
    return json({ error: "파일이 없습니다" }, 400);

  if (file.size > MAX_SIZE)
    return json({ error: `파일 크기가 10MB를 초과합니다 (${file.name})` }, 400);

  const ext = file.name.split(".").pop().toLowerCase();

  try {
    if (ext === "xlsx") {
      const markdown = await xlsxToMarkdown(await file.arrayBuffer());
      return json({ fileName: file.name, markdown });
    }

    const mime = PDF_MIME_MAP[ext];
    if (!mime) {
      const hint = ext === "xls" ? " (.xls는 지원하지 않습니다 — xlsx로 다시 저장해주세요)" : "";
      return json({ error: `지원하지 않는 파일 형식입니다 (${file.name}). PDF 또는 xlsx 파일만 업로드 가능합니다.${hint}` }, 400);
    }
    const markdown = await ocrToMarkdown(await file.arrayBuffer(), mime, env.GEMINI_API_KEY);
    return json({ fileName: file.name, markdown });
  } catch (e) {
    console.error("[OCR] 처리 실패:", e);
    return json({ error: `파일 처리 중 오류가 발생했습니다: ${e.message}` }, 502);
  }
}
