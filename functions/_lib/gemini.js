// ============================================================================
// Gemini 답변 생성 (RAG의 "Generation" 단계)
//
// docs.js의 loadDocuments()가 골라온 참고 문서 + 질문을 하나의 프롬프트로
// 합쳐 Gemini 2.5 Flash에 전달하고, 국세청 질의회신 양식의 마크다운 답변을
// 받아온다. 프롬프트 내 "[중요 — 판례·결정례 인용 규칙]" 부분은 AI가
// 참고자료에 없는 판례를 임의로 지어내거나(허위 사건번호) 모호한
// placeholder("(사건번호 미확인)" 등)를 출력하지 않도록 명시적으로 금지한다.
// ============================================================================

const MODEL   = "gemini-2.5-flash";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// 503(서버 과부하)/429(할당량 초과) 시 재시도 설정
const MAX_RETRIES  = 4;          // 최대 4회 재시도 (최초 시도 포함 총 5번)
const RETRY_DELAY  = 5000;       // 재시도 간격 5초 (고정 — 지수 백오프 아님)

/**
 * Gemini generateContent API 호출 (재시도 포함).
 * @param {string} prompt  전체 프롬프트(시스템 지침 + 참고자료 + 질문 + 답변 템플릿)
 * @param {string} apiKey  env.GEMINI_API_KEY
 * @returns {Promise<string>} 생성된 답변 텍스트(마크다운)
 */
async function callGemini(prompt, apiKey) {
  const url = `${BASE_URL}/${MODEL}:generateContent?key=${apiKey}`;

  // attempt=0이 최초 시도. attempt=1~MAX_RETRIES가 재시도.
  // 즉 총 시도 횟수 = MAX_RETRIES + 1 = 5회.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // 최초 시도가 아닌 경우에만 대기 — attempt=0은 즉시 호출
      console.log(`[Gemini] ${attempt}차 재시도 중... (${RETRY_DELAY / 1000}초 대기 후)`);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 16384,
          temperature: 0.15,                       // 낮은 값 → 일관되고 보수적인 답변(창의성보다 정확성 우선)
          topP: 0.85,
          thinkingConfig: { thinkingBudget: 0 },   // 추론 토큰 0 → 16384 토큰 전부를 실제 답변 출력에 사용
        },
        // BLOCK_NONE: 세무/법률 쟁점(탈세, 처벌 등) 논의가 안전 필터에 의해
        // 차단되지 않도록 위험 콘텐츠 필터를 완화 (세무행정 업무 특성상 필요)
        safetySettings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }],
      }),
    });

    // ── 성공(2xx) ──────────────────────────────────────────────────────
    // Gemini 응답 구조: data.candidates[0].content.parts = [{text: "..."}]
    // 스트리밍이 아닌 단일 응답이지만 parts가 배열이므로 전부 join한다.
    if (resp.ok) {
      const data = await resp.json();
      const cand = data.candidates?.[0];
      const text = cand?.content?.parts?.map(p => p.text).filter(Boolean).join("");
      if (!text) throw new Error("Gemini 응답이 비어있습니다");
      if (cand?.finishReason === "MAX_TOKENS") {
        // 토큰 한도에 도달해 답변이 중간에 잘렸을 가능성 — 호출 실패는 아니므로
        // 텍스트는 그대로 반환하되 운영 로그로 남겨 추적 가능하게 한다.
        console.warn(`[Gemini] 응답이 출력 토큰 한도(MAX_TOKENS)에 도달해 잘렸을 수 있습니다 (길이 ${text.length}자)`);
      }
      if (attempt > 0) console.log(`[Gemini] ${attempt}차 재시도에서 성공`);
      return text;
    }

    // ── 503 서버 과부하 ────────────────────────────────────────────────
    // 모델 인스턴스가 단기적으로 포화 상태인 경우. 보통 수 초 내 해소되므로
    // 고정 대기 후 재시도하는 방식이 지수 백오프보다 실용적으로 빠르다.
    if (resp.status === 503) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[Gemini] 503 과부하 (${attempt + 1}/${MAX_RETRIES + 1}회 시도), ${RETRY_DELAY / 1000}초 후 재시도`);
        continue;
      }
      throw new Error("서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요.");
    }

    // ── 429 할당량 초과 ────────────────────────────────────────────────
    // 분당/일일 API 호출 한도 초과. 재시도 간 5초 대기로 분당 한도는 회복될
    // 수 있지만, 일일 한도가 소진된 경우는 재시도해도 같은 429가 반복된다.
    // MAX_RETRIES까지 모두 소진하면 사용자에게 명확한 오류 메시지를 반환한다.
    if (resp.status === 429) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[Gemini] 429 할당량 초과, ${RETRY_DELAY / 1000}초 후 재시도`);
        continue;
      }
      throw new Error("API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.");
    }

    // ── 그 외 오류 (400/401/403/500 등) ───────────────────────────────
    // 프롬프트 형식 오류(400), 인증 실패(401), 내부 서버 오류(500) 등은
    // 재시도해도 동일한 오류가 발생하므로 즉시 throw해 불필요한 대기를 방지한다.
    const body = await resp.text();
    throw new Error(`Gemini API 오류 (${resp.status}): ${body}`);
  }
}

/**
 * 질문 + 참고문서로 답변(국세청 질의회신 양식 마크다운)을 생성한다.
 * @param {string} question      질문 원문
 * @param {string} taxCategory   질문 세목
 * @param {Array<{name:string, content:string}>} documents  loadDocuments()의 반환값
 * @param {string} apiKey        env.GEMINI_API_KEY
 * @returns {Promise<{content: string, sources: string[]}>}
 */
export async function generateAnswer(question, taxCategory, documents, apiKey) {
  // 문서마다 [자료 N: 이름] 헤더를 붙여 프롬프트에서 서로 구분되게 한다.
  // 문서당 8000자로 한 번 더 잘라내는 안전장치(docs.js에서 이미 압축했지만 이중 방어).
  // generateQuickAnswer와 달리 이 함수는 전체 보고서 형식(질의요지/회신/판례 등)이므로
  // 토큰 소비가 크기 때문에 8000자로 더 넉넉하게 허용한다.
  const docText = documents.length
    ? documents.map((d, i) => `[자료 ${i + 1}: ${d.name}]\n${d.content.slice(0, 8000)}`).join("\n\n---\n\n")
    : "※ 현재 활성화된 참고 자료가 없습니다.";

  // ── 프롬프트 본문 ──
  // 구조: (1) 역할/원칙 지시 → (2) 판례 인용 규칙(허위정보 방지) → (3) 실제
  // 참고자료/질문 삽입 → (4) 답변 출력 형식(마크다운 템플릿, 모델이 그대로
  // 채워 넣도록 빈 괄호 placeholder로 구성).
  //
  // 이 함수는 [자료충분]/[자료부족] 태그를 사용하지 않는다 — 보고서 형식에서는
  // 부족한 자료를 "추가 확인 필요사항" 섹션으로 처리하므로 별도 태그가 불필요하다.
  // coverageGap 처리는 generateQuickAnswer / generateChatReply에서만 이루어진다.
  //
  // 참고자료가 전혀 없을 때 조기 반환: 자료 없이 생성하면 모든 내용이 할루시네이션이므로 금지
  if (!documents.length) {
    return {
      content: `## 질의요지\n\n${question.slice(0, 200)}...\n\n## 회신\n\n현재 해당 질의와 관련된 참고자료(법령·판례·해석례)를 DB에서 찾을 수 없어 AI 답변을 생성할 수 없습니다.\n\n**추천 대안:**\n- 질문의 핵심 세목 용어를 구체화하여 다시 질의하시면 더 넓은 범위로 재검색합니다\n- 국가법령정보센터(law.go.kr) 및 국세법령정보시스템(taxlaw.nts.go.kr)을 직접 참조하세요\n- 관리자에게 관련 자료 등록을 요청하세요\n\n---\n※ 본 시스템은 등록된 참고자료에 근거한 답변만 제공합니다. 참고자료 없이 답변을 생성하지 않습니다.`,
      sources: [],
    };
  }

  const prompt = `당신은 세무행정 전문가 AI입니다. 세무공무원의 질의에 대해 국세청 세법해석례 양식(질의회신 형식)으로 회신을 작성합니다.

【핵심 원칙 — 참고자료 외 내용 생성 절대 금지】
이 답변은 아래 "=== 참고 자료 ===" 섹션에 실제로 수록된 내용만을 근거로 작성합니다.
참고 자료에 없는 내용(법령 조문·판례·해석례·사실·수치·날짜 등)을 AI가 스스로 생성하거나
그럴듯하게 추론하는 것은 허위 정보 생성으로 엄격히 금지됩니다.

[작성 원칙]
1. 법령 조문 인용 규칙
   - 참고 자료에 조문 전문이 수록된 경우에만 조문 내용을 인용·해설하세요
   - 참고 자료에 조문 번호만 언급되고 전문이 없는 경우: 조문 번호만 표기하고 "조문 전문은 국가법령정보센터(law.go.kr)에서 직접 확인하세요" 라고 안내하세요
   - 참고 자료에 전혀 등장하지 않는 법령·조문은 언급 자체를 금지합니다
   - AI 학습 데이터에 있는 법령 지식을 참고 자료 없이 서술하는 것은 금지입니다

2. 판례·결정례·세법해석례 인용 규칙
   - 참고 자료([자료 N])에 실제로 등장하는 것만 인용하세요
   - 참고 자료에 없는 판례·결정례는 절대 인용하지 마세요. 사건번호가 없다고 내용만 일반론으로 서술하는 것도 금지합니다
   - 참고 자료에 등장하는 사건번호·문서번호·결정번호는 그대로 인용 (대법원 XXXX두XXXXX, 서면-XXXX-XXXX, 조심 XXXX 등)
   - 날짜는 참고 자료에 적힌 항목명을 그대로 사용하세요 (자료에 "등록일"로 표기되어 있으면 "결정일"이 아니라 "등록일"이라고 쓰세요)
   - 그럴듯해 보이는 번호나 날짜를 임의로 만드는 것은 허위 정보 생성으로 엄격히 금지됩니다
   - 참고 자료에 판례·결정례가 전혀 없으면 "다. 판례 및 결정례" 항목 전체를 생략하세요

3. 일반 원칙
   - 참고 자료에서 찾을 수 있는 판례·결정례를 최대한 인용하되, 3건 미만이면 찾은 만큼만 인용하세요
   - 복수의 해석이 가능한 경우 각 해석의 근거와 결론을 모두 서술하세요
   - 단정적 결론보다 "~로 해석됩니다", "~에 해당할 수 있습니다" 등 신중한 표현을 사용하세요
   - 참고 자료로 답변하기 어려운 부분은 "추가 확인 필요사항"에 명시하세요

=== 참고 자료 ===
${docText}

=== 질의 세목 ===
${taxCategory}

=== 질의 내용 ===
${question}

=== 회신 ===

## 질의요지

(핵심 쟁점을 2~3문장으로 명확히 정리하세요. 어떤 사실관계에서 어떤 세무 쟁점이 발생하는지 서술하세요.)

## 회신

### 가. 검토 의견 (결론)

(참고 자료(법령·판례·결정례·해석례)만을 근거로 본 사안에 가장 타당한 결론을 먼저 제시하세요. 근거가 되는 법령 조문·판례·해석례는 뒤의 "나. 적용 법령", "다. 판례 및 결정례"에서 상세히 인용하므로, 여기서는 결론과 그 핵심 이유를 명확히 서술하세요. 참고 자료에 없는 내용은 추론하거나 서술하지 마세요.)

(복수 해석이 가능한 경우에만 아래 형식 사용:)

**[해석 1] (제목)**
> 근거: (참고 자료의 법령 조문 또는 판례 번호)
(해석 내용 및 타당성 설명)

**[해석 2] (제목)**
> 근거: (참고 자료의 법령 조문 또는 판례 번호)
(해석 내용 및 타당성 설명)

### 나. 적용 법령

(참고 자료에 실제로 수록된 법령 조문만 인용하세요. 조문 전문이 자료에 있으면 내용을 인용·해설하고, 조문 번호만 있고 전문이 없으면 번호만 표기 후 "국가법령정보센터에서 직접 확인하세요"라고 안내하세요. 참고 자료에 없는 법령은 언급하지 마세요.)

**[주요 조문]** (참고 자료에 수록된 것만)
- 「(법령명)」 제(N)조 제(N)항: (참고 자료에 있는 조문 내용 — 없으면 "조문 전문은 국가법령정보센터에서 직접 확인하세요")

**[조문 해설]** (참고 자료에 조문 내용이 있는 경우에만 작성)
(조문의 입법 취지 및 본 사안에의 적용 범위를 참고 자료 기반으로 설명하세요.)

### 다. 판례 및 결정례

(참고 자료에 실제로 있는 판례·결정례만 인용하세요. 자료에 없으면 이 항목 전체를 생략하세요.)

**[법원 판결]** (자료에 있을 때만)
- (사건번호), (선고일 — 자료의 날짜 항목명 그대로 표기), (법원명): (판시사항·판결요지 핵심)

**[심판·불복 결정례]** (자료에 있을 때만)
- (결정번호 또는 문서번호), (자료의 날짜 항목명 그대로 — 예: 등록일/결정일), (결정기관): (결정요지)

**[세법해석례]** (자료에 있을 때만)
- (문서번호 또는 서면-XXXX-세목-XXXX, 자료의 날짜 항목명 그대로): (해석요지)

**[시사점]** (인용 자료가 있을 때만)
(위 판례·결정례가 본 사안에 주는 시사점을 서술하세요.)

## 추가 확인 필요사항

(참고 자료만으로 판단하기 어려운 사항, 추가로 확인해야 할 사실관계나 서류를 구체적으로 열거하세요.)
- (확인 사항 1)
- (확인 사항 2)

---
※ 본 회신은 AI가 등록된 참고자료(법령·판례·해석례)에 근거하여 생성한 참고용 검토 의견입니다. 참고자료에 수록되지 않은 내용은 답변에 포함되지 않았습니다. 구체적 사실관계에 따라 결론이 달라질 수 있으며, 최종 법적 판단의 책임은 담당자에게 있습니다.`;

  const text = await callGemini(prompt, apiKey);

  // sources: 답변 생성에 사용된 참고문서 목록 (questions/answers 테이블에
  // 함께 저장되어, 추후 "이 답변이 어떤 자료를 근거로 했는지" 추적 가능하게 한다)
  // id를 함께 저장해 클라이언트가 /api/documents/:id로 원문을 조회할 수 있게 한다.
  const sources = documents.map(d => ({ id: d.id, name: d.name }));
  return { content: text, sources };
}

/**
 * 보고서 기반 대화형 추가 질의에 대한 AI 답변을 생성한다.
 * 질문자의 의향 추론·유리한 해석 유도를 금지하고, 오직 중립적 사실만 전달하는
 * 별도 프롬프트를 사용한다. 참고자료가 없으면 즉시 "자료 없음" 메시지를 반환한다.
 *
 * @param {string} chatMessage   사용자의 추가 질문 원문
 * @param {string} taxCategory   세목
 * @param {Array}  documents     loadDocuments() 반환값
 * @param {string} originalReport 기존 AI 검토 보고서 원문 (컨텍스트용)
 * @param {Array}  chatHistory   이전 대화 이력 [{role, content}, ...]
 * @param {string} apiKey        env.GEMINI_API_KEY
 * @returns {Promise<string>} 생성된 답변 텍스트
 */
/**
 * 간단 질의 — 보고서 형식 없이 DB 자료에만 근거한 직접 답변 생성.
 * 구조화된 섹션 없이 3~7문장 내외의 핵심 답변만 반환한다.
 */
/**
 * 간단 질의 답변 생성 (보고서 형식 없이 핵심만 3~7문장 반환).
 *
 * generateAnswer()와 달리 마크다운 섹션(## 질의요지, ## 회신 등) 없이
 * 간결한 문장으로 핵심 답변만 생성한다. 답변 품질의 트레이드오프로서
 * 빠른 응답을 기대하는 "간단 질의" 경로에서 사용된다.
 *
 * 자료 충족 판정 태그 시스템:
 *   Gemini에게 답변 첫 줄에 [자료충분] 또는 [자료부족] 태그를 출력하도록 지시한다.
 *   - [자료충분]: DB 참고자료에서 직접 답변 가능한 내용이 확인됨
 *   - [자료부족]: 참고자료가 질문을 충분히 다루지 않아 완전한 답변 불가
 *   이 태그는 본문에서 제거한 뒤 coverageGap(boolean)으로 변환해 반환한다.
 *   프론트엔드는 coverageGap=true 시 경고 배너를 표시해 사용자에게
 *   "이 답변은 자료가 부족한 상황에서 생성됐음"을 알린다.
 *
 * @returns {{ text: string, coverageGap: boolean }}
 *   coverageGap=true: 참고자료만으로 답변 불가 → 프론트에서 경고 배너 표시
 */
export async function generateQuickAnswer(question, taxCategory, documents, apiKey) {
  // 참고자료가 아예 없는 경우 — 생성 없이 안내 메시지 반환.
  // Gemini 호출 자체를 스킵해 토큰 낭비 없이 즉시 coverageGap=true를 돌려준다.
  if (!documents.length) {
    return {
      text: `현재 해당 질의와 관련된 참고자료를 DB에서 찾을 수 없습니다.\n\n질문의 핵심 세무 용어를 구체화하여 다시 시도해보세요. 예: 법령 조문명, 판례 유형, 구체적 거래 형태 등.\n국가법령정보센터(law.go.kr) 또는 국세법령정보시스템(taxlaw.nts.go.kr)을 직접 참조하세요.`,
      coverageGap: true,
    };
  }

  // 문서당 6000자 — generateAnswer(8000자)보다 짧게 잘라 간단 답변의 빠른 생성을 유지한다.
  const docText = documents
    .map((d, i) => `[자료 ${i + 1}: ${d.name}]\n${d.content.slice(0, 6000)}`)
    .join("\n\n---\n\n");

  const prompt = `당신은 세무법령 전문가 AI입니다. 세무공무원의 간단한 질의에 대해 핵심만 직접 답변합니다.

【답변 원칙】
1. 아래 참고자료에 수록된 내용만 근거로 합니다
2. 참고자료에 없는 내용은 생성하거나 추론하지 않습니다
3. 보고서 형식(## 섹션 등) 없이 핵심을 명확하게 서술합니다
4. 법령명·판례번호는 참고자료에 있는 것만 인용합니다

【자료 충족 판정 — 필수】
답변 맨 첫 줄에 아래 둘 중 하나를 반드시 단독으로 적으세요 (다른 텍스트 없이):
  [자료충분] — 위 참고자료에서 이 질의에 직접 답변할 수 있는 내용이 확인됨
  [자료부족] — 참고자료가 이 질의를 충분히 다루지 않아 완전한 답변이 불가능함

[자료부족]인 경우에도 참고자료에 있는 부분적 내용은 답변하되,
답변 마지막에 "※ 이 질의의 핵심 내용은 현재 등록된 참고자료에서 확인되지 않습니다.
국세법령정보시스템(taxlaw.nts.go.kr) 또는 국가법령정보센터(law.go.kr)에서 직접 확인하세요." 를 추가하세요.

=== 참고 자료 ===
${docText}

=== 질의 (세목: ${taxCategory}) ===
${question}

=== 답변 지침 ===
- 첫 줄: [자료충분] 또는 [자료부족] 태그만 (위 판정 기준 참고)
- 핵심을 3~7문장으로 간결하게 서술하세요
- 구체적인 법령명·조문번호·판례번호(참고자료에 있는 것)를 명시하세요
- 여러 해석이 가능하면 각각 한 문장씩 병렬 서술하세요
- "## 질의요지", "## 회신" 등 보고서 헤더를 쓰지 마세요

=== 답변 ===`;

  const raw = await callGemini(prompt, apiKey);

  // ── [자료충분]/[자료부족] 태그 파싱 ──────────────────────────────────
  // Gemini는 답변 맨 첫 줄에 태그 하나만 출력하도록 프롬프트로 강제되어 있다.
  // 태그가 있으면 → 제거하고 나머지 줄을 본문으로 사용
  // 태그가 없으면 → Gemini가 지시를 무시한 경우이므로 raw를 그대로 본문으로 사용
  //               (coverageGap은 false — 자료 충족으로 보수적으로 판정)
  const lines      = raw.trim().split('\n');
  const firstLine  = lines[0].trim();
  const isGap      = firstLine.includes('자료부족');
  const isCovered  = firstLine.includes('자료충분');
  const text = (isGap || isCovered) ? lines.slice(1).join('\n').trim() : raw.trim();

  return { text, coverageGap: isGap };
}

/**
 * 보고서 기반 대화형 추가 질의 답변 생성.
 *
 * 기존 보고서(originalReport)와 이전 대화 이력(chatHistory)을 함께 프롬프트에
 * 포함해 연속된 대화 컨텍스트를 유지한다. generateQuickAnswer와 동일한
 * [자료충분]/[자료부족] 태그 시스템을 사용하며, 추가로 "중립 전용" 프롬프트를
 * 적용해 질문자 유리한 해석 유도를 방지한다.
 *
 * 태그 파싱 방식은 generateQuickAnswer와 동일:
 *   첫 줄 태그 확인 → coverageGap 판정 → 태그 제거 후 reply 텍스트 반환
 *
 * @returns {{ reply: string, coverageGap: boolean }}
 *   coverageGap=true: 참고자료 부족 → 클라이언트가 채팅 버블에 경고 스타일 적용
 */
export async function generateChatReply(chatMessage, taxCategory, documents, originalReport, chatHistory, apiKey) {
  // 참고자료가 없으면 Gemini 호출 없이 즉시 coverageGap=true 반환
  if (!documents.length) {
    return {
      reply: "현재 해당 질문에 대한 등록된 참고자료가 없어 답변을 드리기 어렵습니다.\n관리자에게 관련 법령·판례·해석례 자료 등록을 요청하시거나, 국가법령정보센터(law.go.kr) 및 국세법령정보시스템(taxlaw.nts.go.kr)을 직접 참조하세요.",
      coverageGap: true,
    };
  }

  const docText = documents
    .map((d, i) => `[자료 ${i + 1}: ${d.name}]\n${d.content.slice(0, 5000)}`)
    .join("\n\n---\n\n");

  const reportSnippet = originalReport
    ? originalReport.slice(0, 2500) + (originalReport.length > 2500 ? "\n...(이하 생략)" : "")
    : "(보고서 없음)";

  const historyText = chatHistory.length
    ? chatHistory
        .map(m => `${m.role === "user" ? "[질문]" : "[답변]"}: ${m.content}`)
        .join("\n\n")
    : "(이전 대화 없음)";

  const prompt = `당신은 세무법령 해석 전문가 AI입니다. 세무공무원이 이미 생성된 검토보고서에 대해 추가 질문을 하고 있습니다.

【절대 준수 원칙 — 중립 전용 답변】
1. 아래 "=== 참고 자료 ===" 와 "=== 기존 검토 보고서 ===" 에 실제로 수록된 내용만을 근거로 답변합니다
2. 참고자료에 없는 내용(법령 조문·판례·해석례·수치·날짜 등)은 절대 생성하거나 추론하지 않습니다
3. 질문자의 의향·목적·입장을 파악하거나 유리한 방향으로 해석을 유도하지 않습니다
4. "귀하에게 유리한", "이렇게 주장하면", "유리한 방향으로", "귀하의 경우" 등의 표현을 사용하지 않습니다
5. 오직 법령·판례·해석례가 명시하는 사실을 중립적으로 전달합니다
6. 법령·판례 번호 등은 참고자료에 실제로 있는 것만 인용합니다

【자료 충족 판정 — 필수】
답변 맨 첫 줄에 아래 둘 중 하나를 반드시 단독으로 적으세요:
  [자료충분] — 참고자료에서 이 질문에 직접 답변 가능
  [자료부족] — 참고자료가 이 질문을 충분히 다루지 않음

[자료부족]이면 답변 마지막에 "※ 이 질문의 핵심 내용은 현재 등록된 참고자료에서 확인되지 않습니다. taxlaw.nts.go.kr 또는 law.go.kr에서 직접 확인하세요."를 추가하세요.

=== 기존 검토 보고서 (참고용) ===
${reportSnippet}

=== 참고 자료 ===
${docText}

=== 이전 대화 ===
${historyText}

=== 현재 질문 ===
${chatMessage}

=== 답변 지침 ===
- 첫 줄: [자료충분] 또는 [자료부족] 태그만
- 3~6문장 내외로 간결하고 명확하게 답변하되, 복잡한 내용은 더 상세히 설명합니다
- 참고 자료의 구체적 근거(법령명·판례번호 등)를 명시합니다
- 중립적 사실 전달에 집중합니다

=== 답변 ===`;

  const raw = await callGemini(prompt, apiKey);

  // ── [자료충분]/[자료부족] 태그 파싱 (generateQuickAnswer와 동일한 로직) ──
  // 채팅 답변도 자료 충족 여부를 클라이언트에 전달해야 하므로 동일한 태그 시스템을 사용한다.
  // 태그가 있으면 제거하고 나머지를 reply 텍스트로, 없으면 raw 전체를 reply로 사용.
  const lines     = raw.trim().split('\n');
  const firstLine = lines[0].trim();
  const isGap     = firstLine.includes('자료부족');
  const isCovered = firstLine.includes('자료충분');
  const reply = (isGap || isCovered) ? lines.slice(1).join('\n').trim() : raw.trim();

  return { reply, coverageGap: isGap };
}

/**
 * 질문 첨부파일(PDF/이미지)을 Gemini 멀티모달로 읽어 마크다운 텍스트로 변환한다.
 * 별도 OCR API(Document AI 등) 없이 기존 GEMINI_API_KEY만으로 처리 — 단, 답변 생성과
 * 같은 할당량 풀을 공유하므로 첨부파일이 많은 질문은 API 호출 수가 그만큼 늘어난다.
 * @param {ArrayBuffer} fileBuffer
 * @param {string} mimeType  예: "application/pdf", "image/png", "image/jpeg"
 * @param {string} apiKey    env.GEMINI_API_KEY
 * @returns {Promise<string>} 변환된 마크다운 텍스트
 */
export async function ocrToMarkdown(fileBuffer, mimeType, apiKey) {
  const bytes = new Uint8Array(fileBuffer);
  let bin = "";
  const CHUNK = 8192; // 8KB씩 변환 — 큰 파일에서 String.fromCharCode 인자 개수 제한 회피
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  const base64Content = btoa(bin);

  const prompt = `다음 문서(이미지 또는 PDF)에 적힌 내용을 마크다운으로 그대로 옮겨 적어주세요.
- 문서에 없는 내용을 추가하거나 추측하지 마세요(할루시네이션 금지). 읽을 수 없는 부분은 [판독불가]로 표시하세요.
- 표는 마크다운 표 형식으로, 일반 문단은 그대로 줄글로 옮깁니다.
- 변환된 본문만 출력하고, 별도의 설명이나 인사말은 붙이지 마세요.`;

  const url = `${BASE_URL}/${MODEL}:generateContent?key=${apiKey}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_DELAY));

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: base64Content } },
          ],
        }],
        generationConfig: {
          maxOutputTokens: 8192,
          temperature: 0,          // OCR은 정확한 전사가 목적 — 창의성 불필요
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("");
      if (!text) throw new Error("Gemini OCR 응답이 비어있습니다");
      return text.trim();
    }
    if ((resp.status === 503 || resp.status === 429) && attempt < MAX_RETRIES) continue;
    throw new Error(`Gemini OCR 오류 (${resp.status}): ${await resp.text()}`);
  }
}
