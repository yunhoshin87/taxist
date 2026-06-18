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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
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

    // 성공: candidates[0]의 모든 parts.text를 이어붙여 최종 답변 텍스트로 사용
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

    // 503 과부하 → 잠시 대기 후 재시도 (모델 단기 과부하는 보통 몇 초 내 해소됨)
    if (resp.status === 503) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[Gemini] 503 과부하 (${attempt + 1}/${MAX_RETRIES + 1}회 시도), ${RETRY_DELAY / 1000}초 후 재시도`);
        continue;
      }
      throw new Error("서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요.");
    }

    // 429 할당량 초과 → 재시도 (단, 동일한 API 키의 분당/일일 한도이므로
    // 재시도해도 계속 429가 나면 한도 자체가 초과된 상태)
    if (resp.status === 429) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[Gemini] 429 할당량 초과, ${RETRY_DELAY / 1000}초 후 재시도`);
        continue;
      }
      throw new Error("API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.");
    }

    // 그 외(400/401/500 등)는 재시도해도 해결되지 않는 오류이므로 즉시 throw
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
  const docText = documents.length
    ? documents.map((d, i) => `[자료 ${i + 1}: ${d.name}]\n${d.content.slice(0, 8000)}`).join("\n\n---\n\n")
    : "※ 현재 활성화된 참고 자료가 없습니다.";

  // ── 프롬프트 본문 ──
  // 구조: (1) 역할/원칙 지시 → (2) 판례 인용 규칙(허위정보 방지) → (3) 실제
  // 참고자료/질문 삽입 → (4) 답변 출력 형식(마크다운 템플릿, 모델이 그대로
  // 채워 넣도록 빈 괄호 placeholder로 구성).
  const prompt = `당신은 세무행정 전문가 AI입니다. 세무공무원의 질의에 대해 국세청 세법해석례 양식(질의회신 형식)으로 회신을 작성합니다.

[작성 원칙]
- 제공된 참고 자료([자료 N])를 최우선으로 활용하세요

【중요 — 판례·결정례 인용 규칙】
- 판례·결정례·세법해석례는 참고 자료([자료 N])에 실제로 등장하는 것만 인용하세요
  · 참고 자료에 없는 판례·결정례는 절대 인용하지 마세요. 사건번호가 없다고 내용만 일반론으로 서술하는 것도 금지합니다
  · 참고 자료에 등장하는 사건번호·문서번호·결정번호는 그대로 인용 (대법원 XXXX두XXXXX, 서면-XXXX-XXXX, 조심 XXXX 등)
  · 날짜는 참고 자료에 적힌 항목명을 그대로 사용하세요 (예: 자료에 "등록일"로 표기되어 있으면 "결정일"이 아니라 "등록일"이라고 쓰세요. 자료에 없는 날짜는 비워두지 말고 해당 괄호 항목 자체를 생략하세요)
  · 그럴듯해 보이는 번호나 날짜를 임의로 만드는 것은 허위 정보 생성으로 엄격히 금지됩니다
- 참고 자료에서 찾을 수 있는 판례·결정례를 최대한 인용하되, 3건 미만이면 찾은 만큼만 인용하세요. 참고 자료에 판례·결정례가 전혀 없으면 "나. 판례 및 결정례" 항목 전체를 생략하고 법령 해석만으로 답변하세요
- 참고 자료에 있는 경우, 아래 유형을 다양하게 포함하세요
  · 대법원·고등법원·행정법원 판결
  · 조세심판원 심판청구 결정
  · 국세청 심사청구·이의신청·과세적부심사 결정
- 세법해석례는 참고 자료에 있는 문서번호(서면-, 재정경제부, 법인세제과- 등)를 그대로 인용하세요
- 복수의 해석이 가능한 경우 각 해석의 근거와 결론을 모두 서술하세요
- 단정적 결론보다 "~로 해석됩니다", "~에 해당할 수 있습니다" 등 신중한 표현을 사용하세요
- 답변은 아래 형식을 정확히 따르세요

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

### 가. 적용 법령

(질의와 관련된 주요 법령 조문을 인용하고 해설하세요.)

**[주요 조문]**
- 「(법령명)」 제(N)조 제(N)항: (조문 내용 요약)
- (시행령·시행규칙 등 하위법령 포함)

**[조문 해설]**
(조문의 입법 취지 및 본 사안에의 적용 범위를 설명하세요.)

### 나. 판례 및 결정례

(참고 자료에 실제로 있는 판례·결정례만 인용하세요. 자료에 없으면 이 항목 전체를 생략하세요. 대법원 판결·조세심판원 결정·이의신청·심사청구·과세적부심사·세법해석례 중 자료에 있는 유형만 다양하게 포함하세요.)

**[법원 판결]** (자료에 있을 때만)
- (사건번호), (선고일 — 자료의 날짜 항목명 그대로 표기), (법원명): (판시사항·판결요지 핵심)

**[심판·불복 결정례]** (자료에 있을 때만)
- (결정번호 또는 문서번호), (자료의 날짜 항목명 그대로 — 예: 등록일/결정일), (결정기관—조세심판원/감사원/세무서장/과세적부심사): (결정요지)

**[세법해석례]** (자료에 있을 때만)
- (문서번호 또는 서면-XXXX-세목-XXXX, 자료의 날짜 항목명 그대로): (해석요지)

**[시사점]**
(위 판례·결정례가 본 사안에 주는 시사점을 서술하세요.)

### 다. 검토 의견

(위 법령·판례·해석례를 종합하여 본 사안에 가장 타당한 해석 방향을 제시하세요.)

(복수 해석이 가능한 경우에만 아래 형식 사용:)

**[해석 1] (제목)**
> 근거: (법령 조문 또는 판례)
(해석 내용 및 타당성 설명)

**[해석 2] (제목)**
> 근거: (법령 조문 또는 판례)
(해석 내용 및 타당성 설명)

## 추가 확인 필요사항

(정확한 판단을 위해 추가로 확인해야 할 사실관계나 서류를 구체적으로 열거하세요.)
- (확인 사항 1)
- (확인 사항 2)

---
※ 본 회신은 AI가 생성한 참고용 검토 의견으로, 제공된 자료의 범위 내에서 작성되었습니다. 구체적 사실관계에 따라 결론이 달라질 수 있으며, 최종 법적 판단의 책임은 담당자에게 있습니다.`;

  const text = await callGemini(prompt, apiKey);

  // sources: 답변 생성에 사용된 참고문서 이름 목록 (questions/answers 테이블에
  // 함께 저장되어, 추후 "이 답변이 어떤 자료를 근거로 했는지" 추적 가능하게 한다)
  const sources = documents.map(d => d.name);
  return { content: text, sources };
}
