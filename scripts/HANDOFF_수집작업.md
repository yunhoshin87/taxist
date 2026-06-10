# NTS 해석례 전문 수집 — 작업 인수인계

> 이 문서는 **다른 AI(또는 다른 PC의 작업자)** 에게 NTS 해석례 전문 수집을
> 맡기기 위한 지시서입니다. 아래 "다른 AI에게 줄 프롬프트"를 그대로 복사해
> 전달하면 됩니다.

---

## 0. 전체 그림 (왜 이렇게 나누는가)

수집 데이터의 최종 목적지는 **소유자의 Cloudflare D1 데이터베이스**입니다.
하지만 그 DB에 쓰려면 소유자 계정 인증 토큰이 필요하고, 이를 외부 AI와
공유하는 것은 보안상 위험합니다. 그래서 **수집(외부)** 과 **DB 반영(소유자)**
을 파일로 분리합니다.

```
┌─ 소유자 환경 ──────────┐   파일 전달   ┌─ 다른 AI / 다른 PC ─────────┐
│ ① export_pending.mjs   │ ───────────▶ │ ② standalone_collect.mjs    │
│   D1 → pending_docs    │ pending_docs │   NTS 공개API로 전문 수집     │
│                        │   .jsonl     │   (인증·토큰 불필요)          │
│ ④ import_collected.mjs │ ◀─────────── │   → collected.jsonl          │
│   collected → D1 + FTS  │ collected    │                              │
└────────────────────────┘   .jsonl     └──────────────────────────────┘
```

- ①·④ = **소유자(이 환경)만** 실행 (D1 토큰 필요)
- ② = **다른 AI가** 실행 (토큰 불필요, NTS 공개 사이트만 호출)

---

## 1. 현재 진행 상황 (2026-06-09 기준)

| 구분 | 건수 |
|---|---|
| 전체 해석례 | 22,141건 |
| 전문 수집 완료 | 약 9,950건 |
| **미완료(이번에 맡길 분량)** | **11,866건** |
| └ nts_doc_id 있음 (빠름·정확) | 1,849건 |
| └ nts_doc_id 없음 (제목검색 필요·느림) | 10,017건 |

미완료 목록은 이미 `scripts/pending_docs.jsonl` 로 추출되어 있습니다.
이 파일을 다른 AI에게 전달하세요.

---

## 2. 다른 AI에게 전달할 파일 (2개)

1. `scripts/standalone_collect.mjs` — 수집 실행 스크립트 (D1/토큰 의존성 없음)
2. `scripts/pending_docs.jsonl` — 수집 대상 목록 (11,866줄)

> 두 파일만 있으면 됩니다. Node.js 18+ 와 인터넷(taxlaw.nts.go.kr 접근)만 필요.

---

## 3. ✂️ 다른 AI에게 줄 프롬프트 (이 블록을 그대로 복사)

```
아래 두 파일을 같은 폴더(scripts/)에 두고 작업해 줘.
  - standalone_collect.mjs  (수집 스크립트)
  - pending_docs.jsonl       (수집 대상 11,866건)

[작업 내용]
국세청 해석례 사이트(taxlaw.nts.go.kr)의 공개 API에서 각 문서의 전문을
수집해 collected.jsonl 로 저장하는 작업이야. 스크립트가 모든 로직을
담고 있으니 너는 실행·모니터링·재시작만 하면 돼. 인증/토큰 불필요.

[실행 순서]
1) Node.js 18+ 확인:  node --version
2) 빠른 것 먼저 (nts_doc_id 있는 1,849건, 직접조회):
     node scripts/standalone_collect.mjs --has-id
3) 느린 것 (nts_doc_id 없는 10,017건, 제목검색):
     node scripts/standalone_collect.mjs --no-id
   ※ 한 번에 다 하려면 옵션 없이:  node scripts/standalone_collect.mjs

[중단/재시작]
- 중간에 멈춰도 scripts/collect_checkpoint.json 에 진행상태가 저장돼.
  같은 명령을 다시 실행하면 이미 한 건은 건너뛰고 이어서 진행해.
- collected.jsonl 은 append 모드라 재실행해도 기존 결과가 보존돼.

[주의]
- 요청 간 1초 딜레이가 기본이야(NTS 서버 부하 배려). 너무 빨리 돌리지 마.
- "세션 초기화 실패: ECONNRESET" 로그는 정상이야(자동 재시도됨). 무시해.
- 제목검색(--no-id)은 1건당 여러 번 검색하므로 느려(분당 약 15건).
  전체 10,017건이면 11시간 이상 걸릴 수 있어. 나눠서 돌려도 돼:
     node scripts/standalone_collect.mjs --no-id --limit 2000

[완료 후]
- scripts/collected.jsonl 파일을 소유자에게 전달해 줘.
- 진행 요약(수집 성공/실패 건수)도 함께 알려줘.
```

---

## 4. collected.jsonl 형식 (다른 AI의 산출물 명세)

한 줄 = JSON 객체 1개. 예:

```json
{"id":658,"content":"# 제목\n\n| 항목 | 내용 |\n...","nts_doc_id":"12345"}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `id` | ✅ | pending_docs.jsonl 의 문서 id 그대로 (D1 documents.id) |
| `content` | ✅ | 수집한 전문(Markdown). 질의요지 + 회신 포함 |
| `nts_doc_id` | 선택 | 제목검색으로 새로 찾은 경우 그 ID (없으면 생략 가능) |

> **중요**: `id` 는 반드시 입력으로 받은 값을 그대로 유지해야 함.
> 이 id 로 소유자 DB의 정확한 레코드를 찾아 갱신함.

---

## 5. 소유자(이 환경)가 결과를 받은 뒤 할 일

```bash
# 1) 다른 AI가 준 collected.jsonl 을 scripts/ 에 복사

# 2) 먼저 검증 (DB 변경 없음)
node scripts/import_collected.mjs --dry-run

# 3) 실제 반영 + FTS5 재인덱싱
node scripts/import_collected.mjs
```

`import_collected.mjs` 가 하는 일:
- `documents.content` 채우고 `is_summary = 0` 으로 전환 (요약→전문)
- 비어있던 `nts_doc_id` 보강
- 마지막에 FTS5 전문검색 인덱스 재구성 → 검색에 즉시 반영

반영 후 남은 미완료가 있으면 ①(export)부터 다시 돌려 2차분을 맡기면 됨.

---

## 6. 참고 — 직접 이어서 할 경우 (다른 AI 없이)

소유자 환경에서 그냥 이어받으려면 기존 통합 스크립트 사용:

```bash
node scripts/fetch_full_content.mjs            # 체크포인트부터 이어서
node scripts/fetch_full_content.mjs --phase1   # nts_doc_id 있는 것만
node scripts/fetch_full_content.mjs --phase2   # 제목검색 분만
```

> 주의: 장시간 작업이라 PC 절전/네트워크 끊김 시 중단됨.
> 또한 Cloudflare OAuth 토큰은 수 시간 후 만료되므로, 중단되면
> `npx wrangler d1 list` 한 번 실행해 토큰을 갱신한 뒤 재시작할 것.

---

## 7. 파일 요약

| 파일 | 실행 위치 | 역할 |
|---|---|---|
| `export_pending.mjs` | 소유자 | D1 → 미완료 목록(pending_docs.jsonl) 추출 |
| `pending_docs.jsonl` | (전달물) | 수집 대상 11,866건 |
| `standalone_collect.mjs` | 다른 AI | NTS 전문 수집 → collected.jsonl |
| `collected.jsonl` | (전달물) | 수집 결과 |
| `import_collected.mjs` | 소유자 | collected.jsonl → D1 반영 + FTS rebuild |
| `fetch_full_content.mjs` | 소유자 | (대안) 직접 통합 수집 |
