// ============================================================================
// XLSX(.xlsx) → 마크다운 표 변환 — 외부 npm 패키지(xlsx, exceljs 등) 없이 동작
//
// 이 프로젝트는 빌드/번들 단계가 없어(HANDOVER.md 참고) npm 의존성을 설치할 수
// 없으므로, xlsx 파일(ZIP 컨테이너 안의 OOXML)을 직접 파싱한다. 압축 해제는
// Workers 런타임이 제공하는 DecompressionStream('deflate-raw')를 사용한다.
// Gemini를 거치지 않고 셀 값을 그대로 옮기므로 OCR보다 정확하고 API 호출도 없다.
// 레거시 바이너리 형식(.xls)은 구조가 전혀 달라(OLE2/BIFF) 지원하지 않는다.
// ============================================================================

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ── ZIP 컨테이너 파싱 ────────────────────────────────────────────────────
// xlsx는 ZIP 파일이므로 End Of Central Directory(EOCD) → 중앙 디렉터리 →
// 각 엔트리의 로컬 헤더 순으로 따라가 필요한 XML 엔트리만 꺼낸다.
function findEOCD(bytes) {
  const SIG = 0x06054b50;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minLen = 22, maxComment = 65535;
  const start = Math.max(0, bytes.length - minLen - maxComment);
  for (let i = bytes.length - minLen; i >= start; i--) {
    if (view.getUint32(i, true) === SIG) return i;
  }
  throw new Error("ZIP 구조를 찾을 수 없습니다 (xlsx 파일이 손상되었거나 형식이 다릅니다)");
}

function listZipEntries(bytes) {
  const eocdOff = findEOCD(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const totalEntries = view.getUint16(eocdOff + 10, true);
  let cdOffset = view.getUint32(eocdOff + 16, true);

  const dec = new TextDecoder("utf-8");
  const entries = {};
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) throw new Error("ZIP 중앙 디렉터리가 손상되었습니다");
    const method      = view.getUint16(cdOffset + 10, true);
    const compSize    = view.getUint32(cdOffset + 20, true);
    const nameLen     = view.getUint16(cdOffset + 28, true);
    const extraLen    = view.getUint16(cdOffset + 30, true);
    const commentLen  = view.getUint16(cdOffset + 32, true);
    const localOffset = view.getUint32(cdOffset + 42, true);
    const name = dec.decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
    entries[name] = { method, compSize, localOffset };
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipEntry(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const off = entry.localOffset;
  if (view.getUint32(off, true) !== 0x04034b50) throw new Error("ZIP 로컬 헤더가 손상되었습니다");
  const nameLen  = view.getUint16(off + 26, true);
  const extraLen = view.getUint16(off + 28, true);
  const dataStart = off + 30 + nameLen + extraLen;
  const compData = bytes.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return compData;       // STORED: 비압축
  if (entry.method === 8) return inflateRaw(compData); // DEFLATE
  throw new Error(`지원하지 않는 ZIP 압축 방식입니다 (method=${entry.method})`);
}

async function getEntryText(bytes, zipEntries, name) {
  const entry = zipEntries[name];
  if (!entry) return null;
  return new TextDecoder("utf-8").decode(await readZipEntry(bytes, entry));
}

// ── OOXML(스프레드시트 XML) 파싱 ─────────────────────────────────────────
// 정식 XML 파서 없이 정규식으로 처리한다 — 셀/행/공유문자열 구조가 단순하고
// 예측 가능한 패턴이라(생성기마다 속성 순서만 다름) 정규식으로 충분히 안정적이다.
function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const items = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXmlEntities(t[1])).join("");
    items.push(text);
  }
  return items;
}

// 워크북 XML의 <sheet name r:id>와 .rels의 Id→Target 매핑을 합쳐 "시트명 → 워크시트 XML 경로"를 구한다.
function parseWorkbookSheets(workbookXml, relsXml) {
  const relMap = {};
  for (const m of (relsXml || "").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id     = (m[1].match(/Id="([^"]+)"/) || [])[1];
    let target   = (m[1].match(/Target="([^"]+)"/) || [])[1];
    if (!id || !target) continue;
    target = target.replace(/^\//, "");
    relMap[id] = target.startsWith("xl/") ? target : `xl/${target}`;
  }
  const sheets = [];
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name   = decodeXmlEntities((m[1].match(/name="([^"]*)"/) || [])[1] || "");
    const rid    = (m[1].match(/r:id="([^"]+)"/) || [])[1];
    const target = relMap[rid];
    if (target) sheets.push({ name, target });
  }
  return sheets;
}

function colLetterToIndex(letters) {
  let idx = 0;
  for (const ch of letters) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1; // 0-based
}

// 워크시트 XML의 <row><c>를 읽어 2차원 배열(행 x 열)로 만든다.
// 셀 t 속성: s=공유문자열 색인, str=수식 캐시 문자열, b=불린, e=오류, inlineStr=즉석문자열, 그 외(없음)=숫자/원문
function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowM of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellM of rowM[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellM[1];
      const inner = cellM[2] || "";
      const ref  = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      let value = "";
      if (type === "inlineStr") {
        value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXmlEntities(t[1])).join("");
      } else {
        const raw = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || "";
        if (type === "s") value = sharedStrings[Number(raw)] ?? "";
        else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
        else if (type === "e") value = `[오류:${raw}]`;
        else value = decodeXmlEntities(raw); // 'str'(수식 결과) 또는 숫자
      }
      cells.push({ col: ref ? colLetterToIndex(ref) : cells.length, value });
    }
    if (!cells.length) continue;
    const arr = Array(Math.max(...cells.map(c => c.col)) + 1).fill("");
    for (const c of cells) arr[c.col] = c.value;
    rows.push(arr);
  }
  return rows;
}

function rowsToMarkdownTable(rows) {
  if (!rows.length) return "(빈 시트)";
  const colCount = Math.max(...rows.map(r => r.length));
  const pad = (r) => { const a = r.slice(); while (a.length < colCount) a.push(""); return a; };
  const esc = (v) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    "| " + pad(rows[0]).map(esc).join(" | ") + " |",
    "| " + Array(colCount).fill("---").join(" | ") + " |",
  ];
  for (let i = 1; i < rows.length; i++) lines.push("| " + pad(rows[i]).map(esc).join(" | ") + " |");
  return lines.join("\n");
}

/**
 * xlsx 파일(ArrayBuffer)을 시트별 마크다운 표로 변환한다.
 * @returns {Promise<string>} "### 시트명\n\n<마크다운 표>" 형식, 시트별로 구분
 */
export async function xlsxToMarkdown(buffer) {
  const bytes = new Uint8Array(buffer);
  const zipEntries = listZipEntries(bytes);

  const workbookXml = await getEntryText(bytes, zipEntries, "xl/workbook.xml");
  if (!workbookXml) throw new Error("올바른 xlsx 파일이 아닙니다 (워크북 정보를 찾을 수 없음)");
  const relsXml         = await getEntryText(bytes, zipEntries, "xl/_rels/workbook.xml.rels");
  const sharedStringsXml = await getEntryText(bytes, zipEntries, "xl/sharedStrings.xml");
  const sharedStrings   = parseSharedStrings(sharedStringsXml);
  const sheets          = parseWorkbookSheets(workbookXml, relsXml);

  const parts = [];
  for (const sheet of sheets) {
    const sheetXml = await getEntryText(bytes, zipEntries, sheet.target);
    if (!sheetXml) continue;
    const rows = parseSheetRows(sheetXml, sharedStrings);
    parts.push(`### ${sheet.name}\n\n${rowsToMarkdownTable(rows)}`);
  }
  if (!parts.length) throw new Error("시트 데이터를 읽을 수 없습니다");
  return parts.join("\n\n");
}
