# TAXIST 인수인계서 v2
**세무공무원 전용 AI 세무행정 질의응답 시스템**

작성일: 2026-06-19  
소스 경로: `/workspace/trans/taxist_src/`

---

## 1. 서비스 개요

**TAXIST**는 세무공무원이 세무행정 질의를 입력하면 AI(Gemini 2.5 Flash)가 등록된 법령·판례·해석례 DB에만 근거해 국세청 질의회신 양식으로 답변을 생성하는 서비스입니다.

### 핵심 원칙
- **할루시네이션 절대 금지**: AI는 DB에 없는 내용을 생성하지 않음
- **중립적 답변**: 질문자의 의향 추론·유리한 해석 유도 금지
- **참고자료 투명성**: 사용된 참고문서 출처를 항상 표시
- **자료 부족 공개**: DB 자료가 불충분할 경우 경고 배너로 명시

### 기술 스택
| 구분 | 기술 |
|------|------|
| 배포 플랫폼 | Cloudflare Pages (Functions + D1) |
| AI 모델 | Gemini 2.5 Flash (gemini-2.5-flash) |
| DB | Cloudflare D1 (SQLite 호환, FTS5 전문검색) |
| 인증 | JWT HS512 + PBKDF2-SHA512 (Web Crypto API) |
| 프론트엔드 | 순수 HTML/CSS/JS (번들러 없음) |

---

## 2. 디렉토리 구조

```
taxist_src/
├── functions/                    # Cloudflare Pages Functions (서버리스 API)
│   ├── _middleware.js            # CORS 헤더 전역 적용
│   ├── _lib/
│   │   ├── auth.js               # JWT 발급·검증, PBKDF2 비밀번호 해시
│   │   ├── docs.js               # RAG 검색 엔진 (FTS5 + 쿼리 확장)
│   │   └── gemini.js             # Gemini API 호출 (재시도, 자료 부족 감지)
│   └── api/
│       ├── questions/index.js    # 질문 등록 + AI 답변 생성 (백그라운드)
│       ├── answers/[id].js       # 답변 조회·편집·공유
│       ├── chat.js               # 보고서 기반 대화형 질의
│       ├── share.js              # 공개 보고서 공유 (인증 불필요)
│       ├── templates.js          # 질문 템플릿 CRUD
│       ├── stats/index.js        # 통계 (세목별·날짜별)
│       ├── users/me.js           # 내 정보 조회·수정
│       └── auth/
│           ├── login.js          # 로그인 + JWT 발급
│           └── register.js       # 회원가입 (30일 무료체험)
│       └── admin/
│           ├── folders.js        # 참고자료 폴더·문서 관리
│           ├── members.js        # 회원 상태 관리
│           └── questions.js      # 관리자용 질문 목록·상태 변경
├── schema.sql                    # 최초 DB 스키마
├── scripts/
│   ├── migrate_summary.sql       # 마이그레이션 1: 요약 컬럼
│   ├── migrate_fts.sql           # 마이그레이션 2: FTS5 가상 테이블
│   ├── migrate_v2.sql            # 마이그레이션 3: question_type 컬럼
│   ├── migrate_chat.sql          # 마이그레이션 4: chat_messages 테이블
│   ├── migrate_v3.sql            # 마이그레이션 5: coverage_gap 컬럼 ← NEW
│   ├── seed_d1.mjs               # 수집된 자료를 D1에 bulk insert
│   ├── fetch_taxlaw_interp.mjs   # 국세법령정보시스템 해석례 수집
│   ├── fetch_prec.mjs            # 판례 수집
│   └── ...                       # 기타 수집 스크립트
├── ask.html                      # 질의응답 메인 페이지 (SPA)
├── admin/                        # 관리자 페이지
├── login.html / signup.html
├── mypage.html / share.html / landing.html
└── wrangler.toml                 # Cloudflare 배포 설정
```

---

## 3. DB 스키마 및 마이그레이션 순서

### 최초 배포 시: 총 6단계 순서대로 실행

```bash
# 1단계: 기본 스키마 생성
wrangler d1 execute taxist-db --file=schema.sql --remote

# 2단계: 요약 컬럼
wrangler d1 execute taxist-db --file=scripts/migrate_summary.sql --remote

# 3단계: FTS5 전문검색 가상 테이블
wrangler d1 execute taxist-db --file=scripts/migrate_fts.sql --remote

# 4단계: 간단질의/보고서 구분 컬럼
wrangler d1 execute taxist-db --file=scripts/migrate_v2.sql --remote

# 5단계: 채팅 메시지 테이블
wrangler d1 execute taxist-db --file=scripts/migrate_chat.sql --remote

# 6단계: 참고자료 충족도 컬럼 (v3 신규)
wrangler d1 execute taxist-db --file=scripts/migrate_v3.sql --remote
```

> **주의**: 이미 운영 중인 DB에 migrate_v3.sql만 추가로 실행하는 경우,
> `ALTER TABLE answers ADD COLUMN coverage_gap INTEGER DEFAULT 0;` 한 줄만 실행됩니다.
> 기존 데이터의 coverage_gap은 DEFAULT 0(자료 충분)으로 처리됩니다.

### 주요 테이블 요약

| 테이블 | 설명 |
|--------|------|
| `users` | 회원 (role: admin/user, status: trial/active/expired) |
| `questions` | 질문 (status: processing/done/error, question_type: full/quick) |
| `answers` | AI 생성 답변 (coverage_gap: 0/1, share_token, content_edited) |
| `chat_messages` | 보고서 기반 채팅 이력 (role: user/assistant) |
| `documents` | 참고자료 (법령·판례·해석례, is_summary: 0/1) |
| `folders` | 참고자료 분류 폴더 (tax_category, type) |
| `question_templates` | 사용자 저장 질문 템플릿 |
| `documents_fts` | FTS5 가상 테이블 (documents와 동기화) |

---

## 4. RAG 파이프라인 상세 (docs.js)

질문 → 참고자료 검색 → Gemini 프롬프트 구성의 전체 흐름:

### 4.1 키워드 추출
- 한국어 불용어 제거 (조사·어미·범용 단어 약 60개)
- 빈도 기반 상위 8개 키워드 채택
- 형태소 분석 없이 순수 JS (Cloudflare Workers에서 native module 사용 불가)

### 4.2 3단계 FTS5 검색 캐스케이드 (신규)

```
1단계: 추출된 키워드 전체(최대 8개)로 FTS5 검색
    ↓ (결과 0건이면)
2단계: 상위 3개 키워드로만 재검색 (노이즈 키워드 제거 효과)
    ↓ (여전히 0건이면 && apiKey 있으면)
3단계: Gemini에게 유사 세무 용어 5개 생성 요청 → 원본 + 확장 키워드 합쳐서 재검색
```

- **2단계 목적**: 가끔 드문 조사·변형이 섞여 FTS 매칭이 안 될 때 핵심 키워드만으로 재시도
- **3단계(쿼리 확장)**: "양도소득" 검색 실패 시 Gemini가 "취득가액, 장기보유특별공제, 양도차익, 비과세" 등 확장 → 재검색
- `expandKeywordsWithGemini()`: 60 토큰 제한, temperature=0, thinkingBudget=0 — 최소 비용으로 빠르게 키워드만 생성

### 4.3 세목별 추가 검색
- FTS 결과 외에 질문 세목(tax_category)에 해당하는 폴더의 최신 문서 자동 보충
- FTS 결과가 적을 때 다양성 확보 목적

### 4.4 NTS 온디맨드 전문 조회
- `is_summary=1`인 해석례는 국세법령정보시스템에서 전문을 실시간으로 가져옴
- 조회 성공 시 D1에 `is_summary=0`으로 캐싱 (다음 질문부터 즉시 재사용)

### 4.5 컨텍스트 압축
- 문서당 키워드 관련 단락만 추출 (1800자 제한)
- 판례 문서: "## N." 헤더 단위로 분리 (사건번호+판시사항+판결요지 묶음 보존)
- 일반 문서: 빈 줄/섹션 헤더 단위로 분리

---

## 5. AI 답변 생성 (gemini.js)

### 5.1 함수별 역할

| 함수 | 반환 타입 | 용도 |
|------|-----------|------|
| `generateAnswer()` | `{content, sources}` | 전체 보고서 (국세청 질의회신 양식) |
| `generateQuickAnswer()` | `{text, coverageGap}` | 간단질의 직접 답변 |
| `generateChatReply()` | `{reply, coverageGap}` | 보고서 기반 후속 채팅 |

### 5.2 참고자료 부족 감지 (coverageGap) — 신규

**`generateQuickAnswer` / `generateChatReply`** 프롬프트에는 Gemini가 답변 첫 줄에 태그를 출력하도록 지시합니다:

```
[자료충분] 참고자료로 충분히 답변 가능한 경우
[자료부족] DB 자료가 부족해 완전한 답변 불가한 경우
```

- 태그는 파싱 후 제거되어 답변 본문에는 표시되지 않음
- `coverageGap=true`이면 `answers.coverage_gap = 1`로 저장
- 프론트엔드에서 주황색 경고 배너 표시
- **`generateAnswer`(전체 보고서)**: 이 태그 시스템을 사용하지 않음 — 자료 부족 부분을 보고서 내 "추가 확인 필요사항" 섹션으로 처리하기 때문

### 5.3 재시도 로직
- 503 (서버 과부하) / 429 (할당량 초과): 5초 고정 대기 후 최대 4회 재시도
- 그 외 오류 (400/401/500 등): 즉시 throw (재시도 불필요)

### 5.4 할루시네이션 방지 설계
- `temperature=0.15`: 창의성 최소화, 보수적 답변 우선
- `thinkingBudget=0`: 출력 토큰 16384개 전부를 실제 답변에 사용
- 프롬프트에 명시적 금지 지시:
  - DB에 없는 판례·사건번호 임의 생성 금지
  - 참고자료에 없는 법령 조문 인용 금지
  - AI 학습 데이터 기반 서술 금지

---

## 6. 질의 유형 (question_type)

| 유형 | 값 | 특징 |
|------|----|------|
| 전체 보고서 | `full` | 국세청 질의회신 양식 마크다운, 섹션별 상세 기술 |
| 간단 질의 | `quick` | 핵심만 직접 답변, coverageGap 감지 |

- `full`: `generateAnswer()` 사용 → 보고서 형식 (질의요지/회신/적용법령/판례/결정례)
- `quick`: `generateQuickAnswer()` 사용 → 자유 형식 직접 답변 + coverageGap

---

## 7. 인증 시스템 (auth.js)

- **JWT HS512**: Cloudflare Workers Web Crypto API로 직접 구현 (jsonwebtoken 패키지 불가)
- **비밀번호 해시**: PBKDF2-SHA512 (100,000 iterations)
- **SHA-512 업그레이드**: 기존 bcrypt/SHA-256 해시 회원이 로그인 시 자동으로 PBKDF2-SHA512로 업그레이드
- **회원 상태**: `trial`(30일 무료, 5건 제한) → `active`(정식) / `expired`(만료)

---

## 8. 주요 기능 목록

### 사용자 기능 (ask.html)
| 기능 | 설명 |
|------|------|
| 전체 보고서 질의 | 세목 선택 후 질문 → 국세청 질의회신 양식 보고서 |
| 간단 질의 | 핵심만 빠르게 직접 답변 |
| 검색 | 과거 질문 목록 검색 (제목·내용) |
| 질문 템플릿 | 자주 쓰는 질문 저장·불러오기 |
| 보고서 공유 | share_token 기반 공개 URL 생성 (인증 불필요) |
| 임시저장 | 작성 중인 질문 localStorage 자동 저장 |
| AI 평가 | 답변 품질 피드백 (thumbs up/down) |
| 후속 채팅 | 생성된 보고서 기반 대화형 추가 질의 |
| 법령 링크 | 보고서 내 법령명 자동 감지 → 국가법령정보센터 연결 |
| 자료 부족 경고 | DB 자료 불충분 시 주황 경고 배너 표시 |

### 관리자 기능 (admin/)
| 기능 | 설명 |
|------|------|
| 참고자료 관리 | 폴더(세목별) + 문서 CRUD, FTS5 자동 동기화 |
| 회원 관리 | 상태 변경 (trial/active/expired), 관리자 승격 |
| 질문 모니터링 | 전체 사용자 질문 목록·상태 조회 |
| 답변 편집 | 관리자가 AI 답변을 직접 수정 (content_edited 컬럼) |

---

## 9. 배포 절차 (신규 환경 최초 배포)

### 9.1 사전 준비

```bash
# 1. Cloudflare 계정 로그인
wrangler login

# 2. D1 데이터베이스 생성
wrangler d1 create taxist-db
# 출력되는 database_id를 wrangler.toml의 [[d1_databases]] database_id에 기입
```

### 9.2 wrangler.toml 수정

```toml
name = "taxist"
pages_build_output_dir = "dist_deploy"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "taxist-db"
database_id = "여기에_생성된_database_id_기입"
```

### 9.3 Pages 환경 변수 설정 (Cloudflare Dashboard)

Cloudflare Dashboard → Pages → taxist → Settings → Environment Variables에서 설정:

| 변수명 | 값 | 필수 |
|--------|-----|------|
| `GEMINI_API_KEY` | Google AI Studio에서 발급한 키 | ✅ 필수 |
| `JWT_SECRET` | 무작위 64자 이상 문자열 (예: `openssl rand -base64 48`) | ✅ 필수 |

> ⚠️ `JWT_SECRET`이 없으면 로그인·회원가입 전혀 동작 안 함  
> ⚠️ `GEMINI_API_KEY`가 없으면 AI 답변 생성 불가 (쿼리 확장도 비활성화됨) — `/api/ocr`(첨부파일 OCR)도 같은 키를 쓰므로 함께 막힘  
> 📌 `functions/api/ocr.js`는 별도 OCR API(Document AI 등) 없이 `GEMINI_API_KEY`로 Gemini 멀티모달 호출만 사용한다(`functions/_lib/gemini.js`의 `ocrToMarkdown()`). 업로드된 원본 파일은 어디에도 저장하지 않고, 변환된 마크다운 텍스트만 질문 본문(`questions.content`)에 합쳐서 저장한다. 별도 파일 저장소(R2 등)는 쓰지 않는다.  
> ⚠️ 첨부파일 OCR도 답변 생성과 같은 Gemini 할당량 풀을 공유한다 — 첨부파일이 많은 질문일수록 API 호출 수가 늘어 분당/일일 한도가 더 빨리 소진될 수 있음 (§13.3 참고).

### 9.4 배포 빌드 디렉토리 준비

```bash
# dist_deploy/ 폴더에 정적 파일 복사
mkdir -p dist_deploy/admin
cp ask.html dist_deploy/
cp index.html landing.html login.html signup.html mypage.html share.html dist_deploy/
cp -r admin/ dist_deploy/admin/
cp favicon.svg dist_deploy/
# law_manifest.json은 법령 링크 기능용 — 없어도 배포 가능 (링크 기능만 비활성)
cp law_manifest.json dist_deploy/ 2>/dev/null || true
```

### 9.5 D1 스키마 및 마이그레이션 실행

```bash
# --remote 플래그로 실제 Cloudflare D1에 직접 적용
wrangler d1 execute taxist-db --file=schema.sql --remote
wrangler d1 execute taxist-db --file=scripts/migrate_summary.sql --remote
wrangler d1 execute taxist-db --file=scripts/migrate_fts.sql --remote
wrangler d1 execute taxist-db --file=scripts/migrate_v2.sql --remote
wrangler d1 execute taxist-db --file=scripts/migrate_chat.sql --remote
wrangler d1 execute taxist-db --file=scripts/migrate_v3.sql --remote
```

### 9.6 초기 관리자 계정 생성

배포 후 signup.html에서 회원가입 → D1 콘솔에서 역할 승격:

```sql
-- Cloudflare Dashboard → D1 → Console에서 실행
UPDATE users SET role = 'admin', status = 'active' WHERE email = '관리자이메일@domain.com';
```

### 9.7 배포

```bash
# Cloudflare Pages에 배포
wrangler pages deploy dist_deploy --project-name=taxist

# 또는 GitHub 연동 자동 배포:
# Cloudflare Dashboard → Pages → Create a project → Connect to Git
# Build command: (없음 — 빌드 불필요)
# Build output directory: dist_deploy
```

### 9.8 참고자료 데이터 적재

```bash
# 수집된 법령·판례·해석례를 D1에 적재
# (scripts/fetch_*.mjs 로 수집 후)
node scripts/seed_d1_api.mjs
# 또는
node scripts/import_collected.mjs
```

---

## 10. 운영 중 DB 마이그레이션 (기존 운영 DB에 v3 추가)

이미 운영 중인 서비스에 `migrate_v3.sql`을 추가하는 경우:

```bash
# 1. 로컬 테스트 먼저 (--local)
wrangler d1 execute taxist-db --file=scripts/migrate_v3.sql --local

# 2. 프로덕션 적용
wrangler d1 execute taxist-db --file=scripts/migrate_v3.sql --remote
```

> `ALTER TABLE ADD COLUMN`은 데이터 손실 없는 안전한 DDL.  
> 기존 answers 레코드의 coverage_gap은 모두 DEFAULT 0(자료 충분)으로 처리됨.

---

## 11. API 엔드포인트 목록

| 메서드 | 경로 | 기능 | 인증 |
|--------|------|------|------|
| POST | /api/auth/register | 회원가입 | 없음 |
| POST | /api/auth/login | 로그인 | 없음 |
| GET | /api/questions | 내 질문 목록 | JWT |
| POST | /api/questions | 질문 등록+AI 생성 | JWT |
| GET | /api/questions/:id | 질문+답변 조회 | JWT |
| PATCH | /api/answers/:id | 답변 편집 | JWT(admin) |
| POST | /api/answers/:id | 공유 토큰 생성 | JWT |
| GET | /api/share/:token | 공개 공유 조회 | 없음 |
| GET | /api/chat | 채팅 이력 조회 | JWT |
| POST | /api/chat | 채팅 메시지+AI 답변 | JWT |
| GET | /api/templates | 내 템플릿 목록 | JWT |
| POST | /api/templates | 템플릿 저장 | JWT |
| DELETE | /api/templates/:id | 템플릿 삭제 | JWT |
| GET | /api/stats | 통계 조회 | JWT(admin) |
| GET | /api/users/me | 내 정보 조회 | JWT |
| PATCH | /api/users/me | 내 정보 수정 | JWT |
| GET | /api/admin/folders | 폴더 목록 | JWT(admin) |
| POST | /api/admin/folders | 폴더 생성 | JWT(admin) |
| POST | /api/admin/folders/:id/documents | 문서 업로드 | JWT(admin) |
| GET | /api/admin/members | 회원 목록 | JWT(admin) |
| PATCH | /api/admin/members/:id | 회원 상태 변경 | JWT(admin) |
| GET | /api/admin/questions | 전체 질문 목록 | JWT(admin) |

---

## 12. 주요 데이터 흐름

### 12.1 질문 등록 ~ 답변 생성 흐름

```
클라이언트 POST /api/questions
  → questions 테이블에 status='processing' 저장
  → 202 Accepted 즉시 반환
  → [백그라운드 waitUntil]
      → docs.js: FTS5 캐스케이드 검색 (3단계)
      → gemini.js: AI 답변 생성 (재시도 포함)
      → answers 테이블 저장 (coverage_gap 포함)
      → questions.status = 'done' 갱신
클라이언트: GET /api/questions/:id 폴링 (2초 간격, 최대 120초)
  → status='done' 감지 → UI 렌더링
```

### 12.2 참고자료 부족 감지 흐름

```
간단 질의 / 채팅 답변 생성 시:
  gemini.js: 프롬프트에 [자료충분]/[자료부족] 태그 출력 지시
  → Gemini 응답 첫 줄에서 태그 파싱 → 태그 제거 후 본문 반환
  → { text/reply, coverageGap: true/false }
  
질문 답변 저장 시:
  → answers.coverage_gap = 1 (DB 저장, 영구 추적)
  
채팅 답변은:
  → DB 저장 안 함 (chat_messages 테이블에 coverage_gap 컬럼 없음)
  → JSON 응답의 coverage_gap 필드로 클라이언트에 실시간 전달
  
ask.html:
  → showAnswer(..., coverageGap): 주황 배너 표시
  → appendChatBubble(..., coverageGap): 버블에 경고 스타일 + "⚠️ 참고자료 부족" 레이블
```

---

## 13. 알려진 제약사항 및 주의사항

### 13.1 Cloudflare Workers 런타임 제약
- Node.js 네이티브 모듈(fs, bcrypt, jsonwebtoken 등) 사용 불가 → Web Crypto API로 직접 구현
- `nodejs_compat` 플래그로 일부 API 호환하나 전체 Node.js 환경이 아님
- ESM(ES Modules) 방식 — CommonJS `require()` 사용 불가

### 13.2 D1 FTS5 주의사항
- FTS5 가상 테이블(`documents_fts`)은 `documents` 테이블과 별도 관리
- 관리자가 문서를 추가/수정/삭제 시 `admin/folders.js`가 FTS5도 자동 동기화
- 직접 D1 콘솔에서 `documents`를 수정한 경우 FTS5도 수동으로 업데이트 필요:
  ```sql
  DELETE FROM documents_fts WHERE rowid IN (SELECT rowid FROM documents WHERE id = ?);
  INSERT INTO documents_fts(rowid, title, content) SELECT id, name, content FROM documents WHERE id = ?;
  ```

### 13.3 Gemini API
- 할당량 초과(429) 시 최대 5회 재시도 (25초 소요) — 사용량 모니터링 필요
- 무료 티어: 분당 15회, 일 1,500회 제한 → 유료 전환 권장 (Pro 이상)
- `thinkingBudget=0`: 추론 토큰 비용 제로화 — 빠른 응답이 필요한 서비스 특성 반영

### 13.4 NTS 온디맨드 조회
- `taxlaw.nts.go.kr`의 내부 비공개 API 사용 → 사이트 구조 변경 시 중단 가능
- 실패 시 기존 요약본(is_summary=1) 데이터로 폴백 처리됨 (서비스 중단 없음)
- 세션 쿠키(JSESSIONID) 필요 → `getNtsSession()`으로 매번 신규 취득

### 13.5 보안
- `JWT_SECRET` 유출 시 모든 사용자 토큰 위조 가능 → 즉시 교체 후 재배포
- 관리자 권한은 D1 콘솔에서만 부여 가능 (API 경로로 자가 승격 불가)
- CORS는 `_middleware.js`에서 전역 처리 (필요 시 origin 화이트리스트 추가 검토)

---

## 14. 로컬 개발 환경

```bash
# 로컬 D1 초기화
wrangler d1 execute taxist-db --file=schema.sql --local
wrangler d1 execute taxist-db --file=scripts/migrate_summary.sql --local
wrangler d1 execute taxist-db --file=scripts/migrate_fts.sql --local
wrangler d1 execute taxist-db --file=scripts/migrate_v2.sql --local
wrangler d1 execute taxist-db --file=scripts/migrate_chat.sql --local
wrangler d1 execute taxist-db --file=scripts/migrate_v3.sql --local

# 로컬 개발 서버 기동 (환경 변수 별도 설정 필요)
GEMINI_API_KEY=xxx JWT_SECRET=xxx wrangler pages dev dist_deploy --d1=DB=taxist-db
```

---

## 15. 최신 변경 이력

### v3 (최신 — 이 인수인계서 기준)
- **참고자료 부족 감지 (coverageGap)**: 간단질의·채팅에서 DB 자료 부족 시 경고 배너/스타일 표시
  - `answers.coverage_gap` 컬럼 추가 (`migrate_v3.sql`)
  - `generateQuickAnswer` / `generateChatReply` 반환 타입 변경: `string` → `{text/reply, coverageGap}`
- **쿼리 확장 (Query Expansion)**: FTS 검색 실패 시 Gemini로 유사 세무 용어 생성 후 재검색
  - `docs.js`에 `expandKeywordsWithGemini()` / `runFTS()` 함수 추가
  - `loadDocuments()` 3단계 캐스케이드 검색으로 개선

### v2
- 간단질의(`question_type: 'quick'`) / 전체 보고서(`full`) 분리
- 보고서 기반 후속 채팅 (`chat_messages` 테이블 + `/api/chat`)
- 공유 기능 (`share_token`, `/share.html`)
- 질문 템플릿 저장·불러오기

### v1 (초기)
- 기본 질의·답변 파이프라인 (RAG + Gemini)
- JWT 인증 + 30일 무료체험
- 관리자 참고자료 관리

---

*인수인계서 작성: Claude AI (TAXIST 개발 세션)*
