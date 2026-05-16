// Gemini API 답변 생성

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

export async function generateAnswer(question, taxCategory, documents, apiKey) {
  const docText = documents.length
    ? documents.map((d, i) => `[자료 ${i + 1}] ${d.name}\n${d.content.slice(0, 8000)}`).join("\n\n---\n\n")
    : "※ 현재 활성화된 참고 자료가 없습니다.";

  const prompt = `당신은 세무행정 전문가 AI 어시스턴트입니다.
세무공무원의 행정업무 질의에 대해 법령·판례·내부 자료를 근거로 검토 의견을 작성합니다.

규칙:
- 반드시 아래 제공된 자료만을 근거로 사용하세요
- 각 주장에 출처(자료명, 조문번호 등)를 명시하세요
- 확실하지 않은 내용은 "추가 확인 필요"로 명시하세요
- 최종 법적 판단은 담당자 검토가 필요함을 안내하세요
- 답변은 반드시 아래 형식을 따르세요

=== 참고 자료 ===
${docText}

=== 질의 세목 ===
${taxCategory}

=== 질의 내용 ===
${question}

=== 답변 (아래 형식 그대로 작성) ===

## 1. 질의 요지

질문의 핵심 쟁점을 2~3문장으로 요약하세요.

## 2. 사실관계 정리

질의에서 확인되는 사실관계를 정리하세요.

## 3. 관련 법령 및 판례

| 구분 | 명칭 | 주요 내용 | 관련성 |
|---|---|---|---|
| 법령 | (법령명 조문) | (내용) | (관련성) |
| 판례 | (사건번호) | (요지) | (관련성) |

## 4. 종합 검토 의견

법령과 판례를 종합한 검토 의견을 작성하세요.

## 5. 결론

핵심 판단 의견을 2~3문장으로 작성하세요.

## 6. 추가 확인 필요사항

정확한 판단을 위해 추가로 확인이 필요한 사항을 나열하세요.

---
※ 본 답변은 AI가 생성한 참고용 검토 의견이며, 최종 법적 판단의 책임은 담당자에게 있습니다.`;

  const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.1,
        topP: 0.8,
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

  // 사용된 자료 출처 추출
  const sources = documents.map(d => d.name);

  return { content: text, sources };
}
