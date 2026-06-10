const MODEL   = "gemini-2.5-flash";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// 503 과부하 시 재시도 설정
const MAX_RETRIES  = 4;          // 최대 4회 재시도 (총 5번 시도)
const RETRY_DELAY  = 5000;       // 재시도 간격 5초

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
          temperature: 0.15,
          topP: 0.85,
          thinkingConfig: { thinkingBudget: 0 },   // 추론 토큰 0 → 출력 전부를 답변에 사용
        },
        safetySettings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }],
      }),
    });

    // 성공
    if (resp.ok) {
      const data = await resp.json();
      const cand = data.candidates?.[0];
      const text = cand?.content?.parts?.map(p => p.text).filter(Boolean).join("");
      if (!text) throw new Error("Gemini 응답이 비어있습니다");
      if (cand?.finishReason === "MAX_TOKENS") {
        console.warn(`[Gemini] 응답이 출력 토큰 한도(MAX_TOKENS)에 도달해 잘렸을 수 있습니다 (길이 ${text.length}자)`);
      }
      if (attempt > 0) console.log(`[Gemini] ${attempt}차 재시도에서 성공`);
      return text;
    }

    // 503 과부하 → 재시도
    if (resp.status === 503) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[Gemini] 503 과부하 (${attempt + 1}/${MAX_RETRIES + 1}회 시도), ${RETRY_DELAY / 1000}초 후 재시도`);
        continue;
      }
      throw new Error("서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요.");
    }

    // 429 할당량 초과 → 재시도
    if (resp.status === 429) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[Gemini] 429 할당량 초과, ${RETRY_DELAY / 1000}초 후 재시도`);
        continue;
      }
      throw new Error("API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.");
    }

    // 그 외 에러는 즉시 throw
    const body = await resp.text();
    throw new Error(`Gemini API 오류 (${resp.status}): ${body}`);
  }
}

export async function generateAnswer(question, taxCategory, documents, apiKey) {
  const docText = documents.length
    ? documents.map((d, i) => `[자료 ${i + 1}: ${d.name}]\n${d.content.slice(0, 8000)}`).join("\n\n---\n\n")
    : "※ 현재 활성화된 참고 자료가 없습니다.";

  const prompt = `당신은 세무행정 전문가 AI입니다. 세무공무원의 질의에 대해 국세청 세법해석례 양식(질의회신 형식)으로 회신을 작성합니다.

[작성 원칙]
- 제공된 참고 자료([자료 N])를 최우선으로 활용하세요

【중요 — 번호 인용 규칙】
- 사건번호·문서번호·결정번호는 반드시 참고 자료에 실제로 등장하는 것만 인용하세요
  · 참고 자료에 있는 번호 → 그대로 인용 (대법원 XXXX두XXXXX, 서면-XXXX-XXXX, 조심 XXXX 등)
  · 참고 자료에 없는 번호 → 절대 생성 금지. "(사건번호 미확인)" 표시 없이 판시 내용만 서술
  · 그럴듯해 보이는 번호를 임의로 만드는 것은 허위 정보 생성으로 엄격히 금지됩니다
- 판례 및 결정례는 3건 이상 인용하되, 참고 자료에서 찾을 수 있는 것 우선 인용
  · 참고 자료에 사건번호가 있는 판례: 번호 포함 인용
  · 참고 자료에 없는 판례: 사건번호 없이 "대법원은 (내용)" 형식으로 서술
- 아래 유형을 다양하게 포함하세요
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

(반드시 3건 이상 인용. 대법원 판결·조세심판원 결정·이의신청·심사청구·과세적부심사·세법해석례 등을 다양하게 포함하세요.)

**[법원 판결]**
- (사건번호), (선고일), (법원명): (판시사항·판결요지 핵심)

**[심판·불복 결정례]**
- (결정번호), (결정일), (결정기관—조세심판원/감사원/세무서장/과세적부심사): (결정요지)

**[세법해석례]**
- (문서번호 또는 서면-XXXX-세목-XXXX, 회신일): (해석요지)

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

  const sources = documents.map(d => d.name);
  return { content: text, sources };
}
