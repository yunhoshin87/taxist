// ============================================================================
// Google Document AI 연동 — 첨부파일을 마크다운 텍스트로 변환
//
// 서비스 계정(GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY)으로 RS256 JWT를 직접
// 서명해 OAuth2 액세스 토큰을 받아온다 (Workers 런타임엔 google-auth-library 같은
// Node 전용 패키지를 쓸 수 없어, auth.js의 Web Crypto 직접 구현 방식을 그대로 따름).
// 원본 파일은 어디에도 저장하지 않고, Document AI 응답에서 텍스트/표만 추출해
// 마크다운 문자열로 변환한 뒤 그 결과만 호출부(ocr.js)로 돌려준다.
// ============================================================================

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function b64url(bytes) {
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// 서비스 계정 키로 RS256 JWT를 서명해 Google OAuth2 토큰 엔드포인트에서
// Document AI 호출용 액세스 토큰을 발급받는다.
async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = `${enc(header)}.${enc(payload)}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth2 토큰 발급 실패: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// Document AI processDocument 응답(document.pages[].tables, document.text)을
// 표는 마크다운 표로, 나머지는 줄글로 직렬화한다.
function documentToMarkdown(doc) {
  const text = doc.text || "";
  if (!doc.pages?.length) return text.trim();

  // 텍스트 범위 추출: Document AI의 textAnchor는 전체 text 문자열의 byte offset을 가리킨다.
  const slice = (textAnchor) => {
    if (!textAnchor?.textSegments?.length) return "";
    return textAnchor.textSegments
      .map(seg => text.slice(Number(seg.startIndex || 0), Number(seg.endIndex)))
      .join("");
  };

  const parts = [];
  for (const page of doc.pages) {
    if (page.tables?.length) {
      for (const table of page.tables) {
        const rowToMd = (row) =>
          "| " + row.cells.map(c => slice(c.layout?.textAnchor).replace(/\s+/g, " ").trim()).join(" | ") + " |";
        const headerRows = (table.headerRows || []).map(rowToMd);
        const bodyRows    = (table.bodyRows || []).map(rowToMd);
        if (headerRows.length) {
          const colCount = table.headerRows[0].cells.length;
          parts.push(headerRows.join("\n"));
          parts.push("| " + Array(colCount).fill("---").join(" | ") + " |");
        }
        parts.push(...bodyRows);
        parts.push("");
      }
    } else if (page.paragraphs?.length) {
      for (const p of page.paragraphs) parts.push(slice(p.layout?.textAnchor).trim());
      parts.push("");
    }
  }
  const md = parts.join("\n").trim();
  return md || text.trim();
}

/**
 * 파일(ArrayBuffer)을 Google Document AI로 OCR 처리해 마크다운 텍스트로 변환한다.
 * 원본 바이트는 요청 처리 후 어디에도 저장하지 않는다.
 * @returns {Promise<string>} 마크다운 텍스트
 */
export async function ocrToMarkdown(env, fileBuffer, mimeType) {
  const accessToken = await getAccessToken(env);
  const location    = env.DOCAI_LOCATION || "us";
  const url = `https://${location}-documentai.googleapis.com/v1/projects/${env.GOOGLE_PROJECT_ID}/locations/${location}/processors/${env.DOCAI_PROCESSOR_ID}:process`;

  // 청크 단위로 변환: String.fromCharCode(...bytes)를 10MB 전체에 한 번에 적용하면
  // 인자 개수 제한에 걸릴 수 있어 8KB씩 나눠 처리한다.
  const bytes = new Uint8Array(fileBuffer);
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const base64Content = btoa(bin);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      rawDocument: { content: base64Content, mimeType },
    }),
  });

  if (!res.ok) throw new Error(`Document AI 처리 실패 (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return documentToMarkdown(data.document || {});
}
