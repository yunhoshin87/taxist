const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

export async function generateAnswer(question, taxCategory, documents, apiKey) {
  const docText = documents.length
    ? documents.map((d, i) => `[자료 ${i + 1}: ${d.name}]\n${d.content.slice(0, 8000)}`).join("\n\n---\n\n")
    : "※ 현재 활성화된 참고 자료가 없습니다.";

  const prompt = `당신은 세무행정 전문가 AI입니다. 세무공무원의 질의에 대해 국세청 세법해석례 양식(질의회신 형식)으로 회신을 작성합니다.

[작성 원칙]
- 제공된 참고 자료(법령·판례·해석례)를 최우선으로 활용하세요
  · 참고 자료에 문서번호(서면-XXXX, 재정경제부 XXXX, 조심 XXXX 등)가 있으면 그 번호를 그대로 인용하세요
  · 참고 자료에 없는 경우에만 학습 데이터 기반의 실제 판례·결정례를 보완 인용하세요
- 출처 표기: (「법령명」 제N조, 대법원 XXXX두XXXXX 판결, 조심 XXXX-XXXX 결정, 서면-XXXX-XXXX 등)
- 판례 및 결정례는 반드시 3건 이상 인용하고, 아래 유형을 다양하게 포함하세요
  · 대법원·고등법원·행정법원 판결 — 실제 사건번호 명시
  · 조세심판원 심판청구 결정 — 실제 결정번호 명시
  · 국세청(감사관실) 심사청구 결정
  · 세무서장 이의신청 결정
  · 과세적부심사 결정
- "관련 판례를 확인하지 못하였습니다"라고 기재하는 것은 허용되지 않습니다
- 세법해석례(서면·문서번호 형식)가 참고 자료에 있으면 해당 문서번호를 정확히 인용하세요
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

  const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.15,
        topP: 0.85,
      },
      safetySettings: [
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API 오류 (${resp.status}): ${err}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini 응답이 비어있습니다");

  const sources = documents.map(d => d.name);
  return { content: text, sources };
}
