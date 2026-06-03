# TAXIST 프로젝트 인수인계서

> 최종 업데이트: 2026-06-03  
> 작성 기준: 현재 운영 중인 Cloudflare Pages 배포 기준

---

## 1. 서비스 개요

**TAXIST**는 세무공무원 전용 AI 질의응답 웹 서비스다.  
세무행정 업무 중 발생하는 법령·판례·해석례 관련 질의에 대해  
국세청 질의회신 형식으로 AI가 검토 의견을 생성한다.

- **대상 사용자**: 세무서·지방자치단체 세무직 공무원
- **지원 세목**: 법인세·부가세·조사·징세·재산세·개인세 (6개)
- **이용 정책**: 가입 후 1개월 무료 (질문 5건 한도) → 유료 전환

---

## 2. 기술 스택

| 구분 | 기술 |
|---|---|
| 호스팅 | Cloudflare Pages |
| 백엔드 API | Cloudflare Pages Functions (ES Modules) |
| 데이터베이스 | Cloudflare D1 (SQLite) + FTS5 전문검색 |
| AI 엔진 | Google Gemini 2.5 Flash |
| 인증 | JWT HS256 (Web Crypto API, 7일 만료) |
| 비밀번호 | PBKDF2 SHA-256 (salt + 100,000회 반복) |
| 프론트엔드 | 순수 HTML/CSS/JS (프레임워크 없음) |
| 배포 도구 | Wrangler CLI |

---

## 3. 프로젝트 구조

```
taxist/
├── index.html              # 첫 화면 (로그인 페이지)
├── login.html              # 로그인 (index.html과 동일 내용)
├── signup.html             # 회원가입 (3단계)
├── ask.html                # 질문 작성 + 답변 (핵심 화면)
├── mypage.html             # 마이페이지 + 결제 UI
├── landing.html            # 기존 랜딩 페이지 (백업)
├── favicon.svg
├── wrangler.toml           # Cloudflare 배포 설정
├── HANDOVER.md             # 이 문서
│
├── functions/              # 서버리스 API (Cloudflare Functions)
│   ├── _middleware.js      # CORS 처리
│   └── _lib/
│       ├── auth.js         # JWT·비밀번호·권한 유틸
│       ├── docs.js         # 문서 검색 엔진 (FTS5)
│       └── gemini.js       # Gemini API 호출 + 재시도 로직
│   └── api/
│       ├── auth/
│       │   ├── login.js    # POST /api/auth/login
│       │   └── register.js # POST /api/auth/register
│       ├── questions/
│       │   ├── index.js    # GET·POST /api/questions
│       │   └── [id].js     # GET /api/questions/:id
│       ├── answers/
│       │   └── [id].js     # GET·PATCH /api/answers/:id
│       ├── users/
│       │   └── me.js       # GET·PATCH /api/users/me
│       ├── stats/
│       │   └── index.js    # GET /api/stats
│       └── admin/
│           ├── members.js  # 회원 관리
│           ├── questions.js
│           └── folders.js  # 자료 폴더 관리
│
├── admin/                  # 관리자 페이지 HTML
│   ├── index.html
│   ├── dashboard.html
│   ├── members.html
│   ├── questions.html
│   └── documents.html
│
├── dist_deploy/            # 배포용 빌드 디렉토리 (wrangler 배포 대상)
│   └── (루트 파일들의 복사본 + functions/)
│
├── 법령자료/               # 법령 MD 파일 (D1 시딩용)
├── 법인세자료/             # 세법 전문서적 PDF→MD 변환본
├── 법령자료/               # 국가법령정보센터 수집 법령
└── scripts/                # 데이터 수집·시딩 스크립트
    ├── fetch_all.mjs       # 법령 자동 수집
    ├── fetch_taxlaw_interp.mjs  # NTS 해석례 수집
    ├── fetch_prec.mjs      # 판례 수집
    ├── seed_d1.mjs         # D1 시딩
    └── migrate_fts.sql     # FTS5 인덱스 마이그레이션
```

---

## 4. 배포 정보

### Cloudflare 계정

| 항목 | 값 |
|---|---|
| 프로젝트명 | `taxist` |
| Account ID | `143f2323446f7c53f496c331d3f6ebd2` |
| Pages URL | `*.taxist.pages.dev` |
| D1 Database | `taxist-db` |
| Database ID | `f257e814-b8ff-4ba3-a45b-55981035b44a` |

### 배포 명령

```bash
# 루트 → dist_deploy 파일 동기화
cp index.html login.html signup.html ask.html mypage.html dist_deploy/
cp -r functions/ dist_deploy/functions/

# 배포
npx wrangler pages deploy dist_deploy --project-name taxist
```

> **주의**: `dist_deploy/`가 실제 배포 대상이다. 루트 파일을 수정한 후 반드시 dist_deploy에 복사해야 반영된다.

### 환경 변수 (Cloudflare Dashboard에서 설정)

| 변수명 | 설명 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio에서 발급 |
| `JWT_SECRET` | JWT 서명용 비밀키 (임의 긴 문자열) |

---

## 5. 데이터베이스 스키마

### users
```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT,
  email         TEXT UNIQUE,
  password_hash TEXT,
  org           TEXT,
  tax_categories TEXT,  -- JSON 배열 ["법인세","부가세"]
  role          TEXT DEFAULT 'user',  -- user | admin
  status        TEXT DEFAULT 'trial', -- trial | active | expired | suspended
  joined_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  trial_ends_at DATETIME,
  last_login_at DATETIME
);
```

### questions
```sql
CREATE TABLE questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id),
  tax_category TEXT,
  title        TEXT,
  content      TEXT,
  status       TEXT DEFAULT 'pending',  -- pending | processing | done | error
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### answers
```sql
CREATE TABLE answers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id     INTEGER REFERENCES questions(id),
  content         TEXT,         -- AI 원본 답변 (Markdown)
  content_edited  TEXT,         -- 사용자 편집본 (NULL이면 원본 표시)
  sources         TEXT DEFAULT '[]',  -- JSON 배열 (참조 문서명)
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      -- 편집 시 갱신
);
```

### folders / documents
```sql
CREATE TABLE folders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id       INTEGER,
  name            TEXT,
  tax_category    TEXT,
  is_active       INTEGER DEFAULT 1,
  permission_scope TEXT
);

CREATE TABLE documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id    INTEGER REFERENCES folders(id),
  name         TEXT,
  content      TEXT,         -- Markdown 내용
  tax_category TEXT,
  nts_doc_id   TEXT,         -- NTS 해석례 원본 ID
  is_summary   INTEGER DEFAULT 0,  -- 1이면 온디맨드 상세조회 필요
  is_active    INTEGER DEFAULT 1,
  updated_at   DATETIME
);

-- FTS5 전문검색 인덱스
CREATE VIRTUAL TABLE documents_fts USING fts5(
  content, name, content='documents', content_rowid='id'
);
```

---

## 6. 계정 정보

### 관리자 계정
| 항목 | 값 |
|---|---|
| 아이디 | `admin@taxist.kr` |
| 비밀번호 | `admin1234` (⚠️ 반드시 변경할 것) |
| 역할 | admin |

> **보안 주의**: `functions/api/auth/login.js` 19번째 줄에 초기 비밀번호가 하드코딩되어 있다. 운영 전 해당 코드 제거 필수.

### 테스트 계정
| 항목 | 값 |
|---|---|
| 이름 | 김민준 |
| 아이디 | `test@taxist.kr` |
| 역할 | user |
| 상태 | active (유료) |

---

## 7. 핵심 기능 상세

### 7-1. 문서 검색 파이프라인 (`functions/_lib/docs.js`)

질문 입력 시 4단계로 관련 문서를 검색한다.

```
1순위: FTS5 전문검색 (키워드 추출 → documents_fts MATCH)
1.5순위: 해석례 폴더 직접 포함 (세목별 최신 4건)
1.7순위: 판례 폴더 직접 포함 (세목별 최신 2건)
2순위: 세목 기반 폴백 (FTS 결과 부족 시)
+ 온디맨드 NTS 조회 (is_summary=1 문서 → 실시간 상세 취득 후 D1 캐시)
```

컨텍스트 한도: 문서당 2,400자, 총 24,000자

### 7-2. AI 답변 생성 (`functions/_lib/gemini.js`)

- 모델: `gemini-2.5-flash` (단일 모델 유지)
- 503 과부하 시: 5초 간격, 최대 4회 재시도
- 답변 형식: 질의요지 → 적용법령 → 판례결정례 → 검토의견 → 추가확인사항
- temperature: 0.15 (낮은 창의성, 높은 일관성)
- 번호 인용 규칙: 참고 자료에 실제 등장한 사건번호만 인용 (허위 생성 금지)

### 7-3. 이용권 정책

| 상태 | 조건 | 질문 가능 여부 |
|---|---|---|
| trial | 가입 후 1개월, 5건 미만 | 가능 |
| trial (한도 초과) | 5건 이상 사용 | 불가 |
| expired | 1개월 경과 | 불가 |
| active | 유료 전환 완료 | 무제한 |
| suspended | 관리자 정지 | 불가 |

### 7-4. 답변 편집 및 저장

- 답변 생성 직후 편집 모드 자동 활성화
- 편집 후 1.5초 자동저장 (`PATCH /api/answers/:id`)
- 편집본(`content_edited`)과 원본(`content`) 분리 저장
- 이력 불러오기 시 편집본 우선 표시

### 7-5. 다운로드

- **PDF**: `window.print()` + `@media print` CSS (질문 폼 숨김, 답변만 출력)
- **Word**: HTML → `.doc` Blob 다운로드 (맑은 고딕, A4 레이아웃, Word 호환 XML 헤더)

### 7-6. 세목별 통계 API (`GET /api/stats`)

- 세목별 질문 수·답변 완료율·편집 건수
- 최근 30일 일별 질문 추이
- 관리자: 전체 사용자 기준, 일반 회원: 본인 기준

---

## 8. 데이터 자산

### 법령 데이터 (`법령자료/`)
국가법령정보센터 API로 수집·갱신 (`scripts/fetch_all.mjs`)

| 분류 | 포함 법령 |
|---|---|
| 국세기본 | 국세기본법, 국세징수법, 조세범처벌법 (법·령·규칙) |
| 소득세 | 소득세법 (법·령·규칙) |
| 법인세 | 법인세법 (법·령·규칙) |
| 부가세 | 부가가치세법 (법·령·규칙) |
| 상속증여세 | 상속세 및 증여세법 (법·령·규칙) |
| 종합부동산세 | 종합부동산세법 (법·령·규칙) |
| 조세특례 | 조세특례제한법 (법·령·규칙) |
| 관세 | 관세법 및 관련 법규 |
| 지방세 | 지방세기본법·지방세법·지방세징수법·지방세특례제한법 |
| 국제조세 | 국제조세조정에 관한 법률 |
| 불복절차 | 행정심판법·행정소송법 |

### 세법 전문서적 (`법인세자료/`)
PDF → MD 변환 후 D1 저장

- 2024 세목별 최신 판례분석
- 2022 법인세 상담사례집 (3분권)
- 2024 포인트 법인조정 실무 (개정7판, 3분권)
- 2025 소득처분 이론과 실무 (개정1판, 2분권)
- 2023 부가가치세 실무 (개정증보18판, 2분권)
- 2024 신고대비 법인세 조정과 신고실무 (3분권)

### 해석례·판례
- NTS 세법해석례: 온디맨드 조회 + D1 캐싱
- 세목별 판례: 분류 저장 (folders 테이블 폴더 ID 13~17)

---

## 9. 법령 업데이트 방법

```bash
# 법령 최신화 (국가법령정보센터 API)
node scripts/fetch_all.mjs

# D1에 재시딩
node scripts/seed_d1_api.mjs

# 업데이트 이력 확인
cat update_log.md
```

`law_manifest.json`에 법령별 MST 코드·시행일·최근 수집일이 기록된다.

---

## 10. 향후 개발 과제

### 10-1. OCR 첨부파일 처리 (미구현)

**조사 결론**: LLM 없이 전용 엔진 조합 권장

```
PDF (텍스트형)  → pdfjs-dist 직접 추출 (무료)
DOCX           → mammoth.js Markdown 변환 (무료)
XLSX           → SheetJS Markdown 표 변환 (무료)
스캔 PDF·이미지 → Naver CLOVA OCR (한국어 최강, 1,000건/월 무료)
HWP / HWPX    → Upstage Document Parse (유일한 실용적 선택)
```

**핵심 전략**: 먼저 텍스트 레이어 유무를 확인하고, 스캔본만 OCR 호출 → 전체 업로드의 약 70~80%는 무료 처리 가능

**구현 시 추가 필요한 것**:
- `CLOVA_OCR_SECRET` 환경변수 (Naver Cloud Console 발급)
- `UPSTAGE_API_KEY` 환경변수
- `functions/api/upload/index.js` 신규 작성
- D1 documents 테이블에 업로드 문서 인덱싱

### 10-2. 결제 시스템 연동 (UI 완성, 로직 미구현)

- 마이페이지 결제 모달 UI는 완성 상태
- PG사 연동 필요 (토스페이먼츠 권장)
- `submitPayment()` 함수 교체만으로 연동 가능

### 10-3. 보안 조치 (운영 전 필수)

- [ ] `login.js` 19번째 줄 하드코딩 초기 비밀번호 코드 제거
- [ ] CORS `*` → 운영 도메인으로 제한 (`_middleware.js`)
- [ ] 관리자 비밀번호 변경

### 10-4. 추가 개발 예정

- 기관 단위 계정 관리
- 관리자 세목별 대시보드 (stats API 연동)
- 알림 기능 (무료기간 만료 예정 알림)
- 답변 품질 평가 루프

---

## 11. 주요 API 엔드포인트

| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| POST | `/api/auth/login` | 로그인 | 공개 |
| POST | `/api/auth/register` | 회원가입 | 공개 |
| GET | `/api/questions` | 내 질문 목록 | 로그인 |
| POST | `/api/questions` | 질문 등록 + AI 답변 | 로그인 |
| GET | `/api/questions/:id` | 질문 상세 | 본인·관리자 |
| GET | `/api/answers/:id` | 답변 조회 | 본인·관리자 |
| PATCH | `/api/answers/:id` | 답변 편집 저장 | 본인·관리자 |
| GET | `/api/users/me` | 내 프로필 | 로그인 |
| PATCH | `/api/users/me` | 프로필 수정 | 로그인 |
| GET | `/api/stats` | 통계 | 로그인 |
| GET | `/api/admin/members` | 회원 목록 | 관리자 |
| PUT | `/api/admin/members` | 회원 상태 변경 | 관리자 |
| GET | `/api/admin/questions` | 전체 질문 관리 | 관리자 |
| GET | `/api/admin/folders` | 자료 폴더 관리 | 관리자 |

---

## 12. 트러블슈팅

### Gemini 503 과부하
- `gemini-2.5-flash` 글로벌 과부하 현상 (사용량 무관)
- 현재 설정: 5초 간격, 최대 4회 재시도
- 지속 시 Google AI Studio 상태 페이지 확인

### wrangler 인증 만료
```bash
npx wrangler login
```

### D1 직접 쿼리
```bash
npx wrangler d1 execute taxist-db --remote --command "SELECT * FROM users;"
```

### 법령 업데이트 로그
```bash
cat update_log.md
```
