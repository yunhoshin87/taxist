const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

export async function generateAnswer(question, taxCategory, documents, apiKey) {
  const docText = documents.length
    ? documents.map((d, i) => `[자료 ${i + 1}: ${d.name}]\n${d.content.slice(0, 8000)}`).join("\n\n---\n\n")
    : "※ 현재 활성화된 참고 자료가 없습니다.";

  const prompt = `당신은 세무행정 전문가 AI입니다. 세무공무원의 질의에 대해 법령·판례·실무서를 근거로 검토 보고서를 작성합니다.

[작성 원칙]
- 제공된 참고 자료(법령·판례·실무서)에서 직접 인용하고, 인용 시 출처를 반드시 명시하세요
- 출처 표기: (「법령명」 제N조, 대법원 XXXX두XXXXX 판결, 실무서명 등)
- 동일한 쟁점에 대해 복수의 해석이 가능한 경우, 각 해석의 근거와 타당성을 모두 서술하세요
- 과세관청 입장과 납세자 입장이 갈릴 수 있는 지점을 명확히 짚으세요
- 단정적 결론보다 "~로 해석될 여지가 있다", "~의 가능성이 있다" 등 신중한 표현을 사용하세요
- 답변은 아래 형식을 정확히 따르세요

=== 참고 자료 ===
${docText}

=== 질의 세목 ===
${taxCategory}

=== 질의 내용 ===
${question}

=== 검토 보고서 ===

## Ⅰ. 질의 요지

(핵심 쟁점을 3~4문장으로 명확히 정리하세요. 어떤 사실관계에서 어떤 세무 쟁점이 발생하는지 서술하세요.)

## Ⅱ. 관련 법령 검토

(질의와 관련된 법령 조문을 인용하고 그 의미를 해설하세요.)

**[적용 법령]**
- (법령명) 제(N)조: (조문 내용 요약)
- (시행령·시행규칙 등 하위법령 포함)

**[조문 해설]**
(조문의 입법 취지 및 적용 범위를 설명하세요.)

## Ⅲ. 판례 및 심판례 분석

(관련 판례·조세심판원 결정례를 분석하세요. 판례가 없으면 "관련 판례를 확인하지 못하였습니다"라고 기재하세요.)

**[주요 판례]**
- (사건번호, 선고일, 법원명): (판시사항·판결요지 핵심 내용)

**[판례의 시사점]**
(판례가 본 사안에 주는 시사점을 서술하세요.)

## Ⅳ. 실무 해설

(실무서·지침서 등에서의 해설을 인용하세요. 실무서가 없으면 생략하세요.)

(출처 실무서명: 내용 인용)

## Ⅴ. 해석 가능성 검토

(동일 사안에 대해 가능한 해석을 복수로 제시하세요.)

**[해석 1] (제목)**
> 근거: (법령 조문 또는 판례)
(해석 내용 및 타당성 설명)

**[해석 2] (제목)**
> 근거: (법령 조문 또는 판례)
(해석 내용 및 타당성 설명)

(해석이 1가지뿐인 경우 해석 1만 작성, 필요시 해석 3 추가)

## Ⅵ. 종합 검토 의견

(위 검토를 종합하여 가장 합리적인 해석 방향을 제시하세요. 다만 단정적 결론을 피하고, 사실관계에 따라 달라질 수 있음을 명시하세요.)

## Ⅶ. 추가 확인 필요사항

(정확한 판단을 위해 추가로 확인해야 할 사항을 구체적으로 열거하세요.)
- (확인 사항 1)
- (확인 사항 2)

---
※ 본 검토 보고서는 AI가 생성한 참고용 검토 의견으로, 제공된 자료의 범위 내에서 작성되었습니다. 구체적 사실관계에 따라 결론이 달라질 수 있으며, 최종 법적 판단의 책임은 담당자에게 있습니다.`;

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
