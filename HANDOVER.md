# TAXIST 프로젝트 인수인계서

> 최종 업데이트: 2026-06-18
> 작성 기준: 현재 운영 중인 Cloudflare Pages 배포 기준 (이전 버전 HANDOVER.md 내용 중
> 실제 코드와 어긋난 부분—`dist_deploy/` 빌드 디렉토리, 로그인 코드 줄 번호 등—을
> 현재 상태에 맞게 갱신함)

---

## 1. 서비스 개요

**TAXIST**는 세무공무원 전용 AI 질의응답 웹 서비스다.
세무행정 업무 중 발생하는 법령·판례·해석례 관련 질의에 대해
국세청 질의회신 형식으로 AI가 검토 의견을 생성한다.

- **대상 사용자**: 세무서·지방자치단체 세무직 공무원
- **지원 세목**: 법인세·부가세·조사·징세·재산세·개인세 등
- **이용 정책**: 가입 후 30일 무료 체험(trial, 질문 5건 한도) → 유료 전환(active)
  또는 만료(expired). 결제 연동 자체는 미구현이며, 관리자가 회원 상태/체험기간을
  수동으로 조정하는 방식으로 운영 중.

---

## 2. 기술 스택

| 구분 | 기술 |
|---|---|
| 호스팅 | Cloudflare Pages |
| 백엔드 API | Cloudflare Pages Functions (ES Modules, Workers 런타임) |
| 데이터베이스 | Cloudflare D1 (SQLite 호환) + FTS5 전문검색 |
| AI 엔진 | Google Gemini 2.5 Flash (REST API 직접 호출) |
| 인증 | JWT HS256 (Web Crypto API로 직접 구현) |
| 비밀번호 | PBKDF2-SHA256 (salt + 100,000회 반복, Web Crypto API) |
| 프론트엔드 | 순수 HTML/CSS/JS (프레임워크 없음) |
| 배포 도구 | Wrangler CLI + GitHub Actions |

> Workers 런타임은 Node.js 네이티브 모듈(`crypto`, `jsonwebtoken`, `bcrypt` 등)을
> 쓸 수 없어서, JWT 서명/검증과 비밀번호 해시를 모두 Web Crypto API로 직접
> 구현했다 (`functions/_lib/auth.js`). 이는 라이브러리 미숙지가 아니라 플랫폼
> 제약에 따른 의도적 설계이므로, 추후 일반 Node.js 서버로 마이그레이션하지
> 않는 한 그대로 유지하면 된다.

---

## 3. 프로젝트 구조

```
taxist/
├── index.html, login.html      # 로그인 (동일 내용)
├── signup.html                 # 회원가입 (다단계)
├── ask.html                    # 질문 작성 + 답변 (핵심 화면)
├── mypage.html                 # 마이페이지(프로필/통계/이용권)
├── landing.html                # 랜딩 페이지
├── favicon.svg
├── wrangler.toml                # Cloudflare Pages/D1 바인딩 설정
├── schema.sql                   # D1 초기 스키마 + 기본 데이터
├── HANDOVER.md                  # 이 문서
│
├── functions/                   # Cloudflare Pages Functions (서버리스 API)
│   ├── _middleware.js           # 모든 요청 전처리 (CORS)
│   └── _lib/
│       ├── auth.js              # JWT·비밀번호 해시·인증 미들웨어
│       ├── docs.js               # RAG 검색(retrieval) 엔진 — FTS5 + 폴더 가중치 + NTS 온디맨드
│       └── gemini.js             # Gemini 호출 + 프롬프트 구성(generation) + 재시도 로직
│   └── api/
│       ├── auth/login.js, register.js
│       ├── questions/index.js, [id].js   # 질문 등록(핵심 파이프라인)/조회
│       ├── answers/[id].js               # 답변 편집(content vs content_edited)
│       ├── users/me.js                   # 프로필 조회/수정
│       ├── stats/index.js                # 통계 (마이페이지/관리자 대시보드 공용)
│       └── admin/
│           ├── members.js   # 회원 관리 (검색/상태변경/체험기간 연장)
│           ├── questions.js # 전체 질문/답변 조회 + 상태 강제 변경
│           └── folders.js   # 자료 폴더/문서 관리 (검색 대상 on/off, 신규 업로드)
│
├── admin/                       # 관리자 페이지 HTML
│   ├── _common.js, index.html, dashboard.html, members.html,
│   │   questions.html, documents.html
│
├── scripts/                     # 데이터 수집/시딩 스크립트 (배포 트리거 제외)
│   ├── fetch_all.mjs, fetch_all_taxlaw_full.mjs, fetch_incremental.mjs
│   ├── fetch_prec.mjs, fetch_full_content.mjs
│   ├── fetch_taxlaw_interp.mjs, fetch_taxlaw_resume.mjs
│   ├── seed_d1.mjs, seed_d1_api.mjs, seed_interp.mjs, seed_prec.mjs, seed_summary.mjs
│   ├── export_pending.mjs, import_collected.mjs, standalone_collect.mjs
│   ├── fetch_all.py, requirements.txt
│   ├── migrate_fts.sql, migrate_summary.sql, check_summary.sql,
│   │   fix_test_user.sql, update_doc_3102.sql
│   └── README.md, HANDOFF_수집작업.md
│
├── 법령자료/, 판례자료/, 법인세자료/   # 수집된 원본 법령·판례·해석례·전문서적 텍스트(MD)
│   (이 폴더들은 코드가 아니라 데이터다 — scripts/fetch_*, seed_*를 거쳐
│    D1 documents 테이블로 적재되고 답변 생성의 근거 자료가 됨. 법령 조문/판례
│    전문을 그대로 담고 있어 "주석"을 다는 것이 의미가 없으므로 원문 그대로 둠)
│
├── law_manifest.json            # 법령별 MST 코드·시행일·최근 수집일 기록
├── update_log.md                # 법령 업데이트 이력
└── .github/workflows/
    ├── deploy.yml                # main push 시 자동 배포 (데이터/scripts 변경은 트리거 제외)
    └── update_laws.yml           # 법령 자동 업데이트 (스케줄 실행)
```

> **`dist_deploy/`는 더 이상 사용하지 않는다.** 과거 버전 문서는 별도 빌드
> 디렉토리로 복사 후 배포하는 방식을 설명했지만, 현재는
> `.github/workflows/deploy.yml`이 `wrangler pages deploy .`로 **저장소 루트를
> 그대로** 배포한다 (Cloudflare Pages Functions 컨벤션상 `functions/` 폴더는
> 자동으로 라우팅 인식됨). 루트 HTML/admin 파일을 고치면 별도 복사 없이 그대로
> 배포에 반영된다.

---

## 4. 배포 정보

### Cloudflare 계정

| 항목 | 값 |
|---|---|
| 프로젝트명 | `taxist` |
| Account ID | `143f2323446f7c53f496c331d3f6ebd2` |
| D1 Database | `taxist-db` |
| Database ID | `f257e814-b8ff-4ba3-a45b-55981035b44a` |

### 배포 절차 (자동)

1. 작업 브랜치에서 개발 → `main`으로 머지 → push
2. GitHub Actions(`deploy.yml`)가 자동으로 `wrangler pages deploy . --project-name=taxist
   --branch=main`을 실행해 배포
3. 단, 다음 경로 변경은 `paths-ignore`에 의해 **배포를 트리거하지 않음**:
   `법령자료/**`, `판례자료/**`, `법인세자료/**`, `scripts/**`, `update_log.md`,
   `law_manifest.json` — 데이터만 갱신했을 때 불필요한 재배포를 막기 위함.
   데이터만 갱신하고 즉시 배포하고 싶다면 코드 파일도 함께 변경하거나
   `wrangler pages deploy .`를 로컬에서 직접 실행해야 한다.

### 수동 배포 (필요 시)

```bash
npx wrangler pages deploy . --project-name=taxist
```

### 환경 변수 / 시크릿 (Cloudflare Dashboard 또는 GitHub Secrets에서 설정)

| 변수명 | 설명 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio에서 발급, Gemini 호출용 |
| `JWT_SECRET` | JWT 서명용 비밀키 |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions 배포용 (repo secret) |

---

## 5. 데이터베이스 스키마

전체 스키마와 각 컬럼의 의도는 `schema.sql`에 상세 주석으로 정리되어 있다.
요약:

- **users**: 회원. `email`은 사실상 로그인 아이디(이메일 형식 검증 없음).
  `status`는 trial/expired/active/suspended. `tax_categories`는 JSON 배열 문자열.
- **questions**: 회원이 등록한 질의. `status`는 pending/processing/done/error.
- **answers**: 질문과 1:1. `content`(AI 원본) / `content_edited`(사용자 편집본,
  마이그레이션으로 추가된 컬럼, NULL이면 미편집) 분리 저장. `sources`는 JSON 배열.
- **folders**: 세목/업무 단위 자료 폴더 트리. `is_active=0`이면 검색 대상 제외.
- **documents**: 법령/판례/해석례/업로드 자료 본문. `nts_doc_id`/`is_summary`는
  마이그레이션으로 추가(NTS 온디맨드 캐싱용). `content`가 FTS5 검색 대상.
- **documents_fts**: FTS5 가상테이블 (`migrate_fts.sql`로 추가), documents와
  rowid로 1:1 매칭.

> **중요한 운영 함정**: `schema.sql`의 폴더 INSERT 순서가 그대로 폴더 `id`가 되고,
> `functions/_lib/docs.js`의 `INTERP_FOLDER_MAP`/`PREC_FOLDER_MAP`이 이 id 값을
> **하드코딩**으로 참조한다. 폴더를 추가/삭제/재정렬하면 이 매핑도 반드시
> 같이 수정해야 검색이 깨지지 않는다.

> 운영 DB는 `schema.sql`(초기 스키마) 위에 다음이 추가 적용된 상태이므로,
> `schema.sql`만 보고 전체 스키마를 판단하면 안 된다:
> - `scripts/migrate_fts.sql` → `documents_fts` 추가
> - `scripts/migrate_summary.sql` → `documents.nts_doc_id`, `documents.is_summary` 추가
> - 별도 ALTER TABLE → `answers.content_edited` 추가

---

## 6. 계정 정보

### 관리자 계정 (기본 시드, `schema.sql`)

| 항목 | 값 |
|---|---|
| 아이디 | `admin@taxist.kr` |
| 비밀번호 | `admin1234` (최초 1회만 허용, 아래 설명 참고) |
| 역할 | admin |

`schema.sql`에는 `password_hash`가 평문 마커 `"CHANGE_ME"`로 저장돼 있고,
`functions/api/auth/login.js`가 로그인 시 이 마커를 발견하면 `admin1234`로만
1회 로그인을 허용하는 특수 분기를 둔다. **운영 환경에서는 로그인 후 가능한
빨리 비밀번호를 정식 해시로 교체해야 한다** — 다만 현재 비밀번호 변경 UI가
없으므로, D1을 직접 조회/수정하거나 `register.js`의 해시 로직을 참고해
새 해시를 만들어 `UPDATE users SET password_hash=... WHERE email='admin@taxist.kr'`
형태로 직접 갱신해야 한다.

---

## 7. 핵심 기능 상세 (RAG 파이프라인)

### 7-1. 전체 흐름 (`functions/api/questions/index.js`)

1. 질문 등록 → `questions` 테이블 저장 (status='processing')
2. `loadDocuments()` (`functions/_lib/docs.js`)로 관련 자료 검색
3. `generateAnswer()` (`functions/_lib/gemini.js`)로 Gemini에 프롬프트 전송, 답변 생성
4. `answers` 테이블에 저장, `questions.status`를 done/error로 갱신 (에러 시
   에러 메시지를 답변 내용에 기록해 관리자가 확인 가능하게 함)
5. 가입 후 30일 경과 또는 무료 질문 5건 소진 시 추가 질문 차단 (trial/expired 분기)

### 7-2. 문서 검색 (`functions/_lib/docs.js`)

질문에서 키워드를 추출(불용어 제거 + 빈도 기반, 형태소 분석기 없음)한 후
다음 순서로 검색:

```
1순위:   FTS5 전문검색 (documents_fts MATCH)
1.5순위: 해석례 폴더 가중치 포함 (INTERP_FOLDER_MAP)
1.7순위: 판례 폴더 가중치 포함 (PREC_FOLDER_MAP)
2순위:   세목 기반 폴백 검색 (FTS 결과 부족 시, CATEGORY_MAP)
       ↓ 결과가 요약본(is_summary=1)인 경우
온디맨드: NTS API로 실시간 상세조회 후 D1에 캐시 (buildFullContent)
```

컨텍스트 압축: 문서당 최대 2,400자, 전체 최대 24,000자로 잘라 프롬프트에 포함.

### 7-3. AI 답변 생성 (`functions/_lib/gemini.js`)

- 모델: Gemini 2.5 Flash, REST API 직접 호출
- 503/429 에러 시 재시도 로직 포함
- `thinkingConfig.thinkingBudget=0`으로 설정해 "thinking" 토큰 대신 실제
  출력 토큰을 최대화
- **판례/결정례 인용 규칙(이번 세션에서 수정)**: 참고 자료에 실제로 등장하는
  판례·결정례·해석례만 인용하도록 강제. 참고 자료에 없는 사건은 사건번호도
  내용도 생성하지 않고 해당 섹션을 통째로 생략한다.
- **날짜 필드 규칙(이번 세션에서 수정)**: 심사청구/심판청구 등 조세심판
  자료는 API상 "결정일"이 아니라 "등록일"(`ntstDcmRgtDt`)만 수집되어 있으므로,
  프롬프트가 자료에 실제로 존재하는 필드명을 그대로 쓰도록 수정 (이전에는
  "결정일"을 요구해 AI가 "(결정일 미확인)"을 생성하는 문제가 있었음).

### 7-4. 답변 편집

- `content`(AI 원본)와 `content_edited`(사용자 편집본)를 분리 보관 (`answers/[id].js`)
- 조회 시 편집본이 있으면 편집본을 우선 표시, 원본은 항상 보존

### 7-5. 통계 (`functions/api/stats/index.js`)

- 세목별/일별(최근 30일) 질문·답변 집계
- 관리자는 전체 회원, 일반 회원은 본인 데이터만 (쿼리에 조건부 `WHERE q.user_id=?` 분기)

---

## 8. 관리자 기능

- **회원 관리** (`admin/members.html` + `functions/api/admin/members.js`):
  검색/상태 필터, 상태 직접 변경, 체험기간 연장(연장 시 만료됐던 계정도
  다시 trial로 복원).
- **질문/답변 관리** (`admin/questions.html` + `functions/api/admin/questions.js`):
  세목/상태 필터 + 페이지네이션, 상태 강제 변경(품질 검토·재답변 표시용).
- **자료 폴더 관리** (`admin/documents.html` + `functions/api/admin/folders.js`):
  폴더/문서 트리 조회, 폴더·문서 단위 활성/비활성 토글(폴더를 끄면 하위
  문서도 함께 비활성화), 새 문서 업로드(엑셀/텍스트, 500,000자로 자름,
  FTS5 색인 시도 — 실패해도 문서 저장 자체는 성공 처리되고 세목 폴백
  검색에는 계속 노출됨).

---

## 9. 법령 데이터 수집/업데이트 (`scripts/`)

- `fetch_all.mjs`, `fetch_all_taxlaw_full.mjs`: 국가법령정보센터에서 법령 전문 수집
- `fetch_incremental.mjs`: 최근 N일간 신규 해석례/결정례만 증분 수집 (cron 운영 가능)
- `fetch_prec.mjs`, `fetch_full_content.mjs`: 판례/상세 본문 수집
- `fetch_taxlaw_interp.mjs`, `fetch_taxlaw_resume.mjs`: NTS 해석례 수집(이어받기 지원)
- `seed_d1.mjs`, `seed_d1_api.mjs`, `seed_interp.mjs`, `seed_prec.mjs`, `seed_summary.mjs`:
  수집한 MD 파일을 D1에 적재 (서로 다른 데이터 유형/적재 방식별로 분리)
- `export_pending.mjs`, `import_collected.mjs`, `standalone_collect.mjs`: 수집 작업
  내보내기/가져오기/독립 실행 보조 스크립트
- `migrate_fts.sql`, `migrate_summary.sql`: 스키마 마이그레이션 (5절 참고)
- `.github/workflows/update_laws.yml`: 법령 자동 업데이트 스케줄 실행

업데이트 후 `law_manifest.json`(법령별 MST 코드·시행일·최근 수집일)과
`update_log.md`(업데이트 이력)가 갱신된다.

> 이 스크립트들과 데이터 폴더(법령자료/판례자료/법인세자료) 변경은
> `deploy.yml`의 `paths-ignore`에 포함되어 있어 **자동 배포를 트리거하지
> 않는다.** 데이터만 갱신해도 서비스에는 즉시 반영되지만(D1 직접 갱신이므로),
> 코드 배포 자체는 별도로 일어나지 않는다는 점에 유의.

---

## 10. 이번 세션에서 수정/작업한 내용

1. **버그 수정**: AI 답변에서 판례·결정례의 사건번호·날짜가 "(미확인)"으로
   잘못 표기되던 문제를 `functions/_lib/gemini.js`의 프롬프트 수정으로 해결
   (7-3절 참고). main 머지 및 GitHub Actions 자동 배포로 적용 완료.
2. **주석 작업**: 백엔드(`functions/`), 스키마(`schema.sql`), 배포 설정
   (`wrangler.toml`), 관리자/사용자 프론트엔드(`admin/*.html`, 루트 `*.html`),
   데이터 수집 스크립트(`scripts/*`)에 핵심 동작 원리와 설계 의도를 설명하는
   한국어 주석을 추가 (기존 로직/마크업/문법은 변경하지 않음).
3. 법령자료/판례자료/법인세자료 등 원본 데이터 폴더는 법령 조문·판례 전문
   자체이므로 별도 주석을 달지 않고 원문 그대로 보존했다 (3절 참고).

---

## 11. 알려진 미해결 과제 (이전 버전 문서 기준, 현재도 유효)

- **결제 시스템 미연동**: 마이페이지 결제 UI는 있으나 PG사 연동 로직은 없음.
  관리자가 회원 상태(`active`)와 체험기간(`trial_ends_at`)을 수동으로 조정.
- **비밀번호 변경 UI 없음**: 관리자 기본 비밀번호 교체를 포함해, 회원 비밀번호
  변경 기능 자체가 아직 없음.
- **OCR/첨부파일 업로드 미구현**: 질문에 PDF/이미지 등 첨부파일을 첨부해
  AI가 인식하는 기능은 없음.
- **CORS**: `functions/_middleware.js`의 CORS 허용 범위를 운영 단계에서
  필요 범위로 좁히는 것을 검토할 것.

---

## 12. 트러블슈팅

### Gemini 503/429 과부하
- `functions/_lib/gemini.js`에 재시도 로직이 있음 (모델 자체의 글로벌 과부하는
  재시도로도 해결 안 될 수 있음 — 지속되면 Google AI Studio 상태 확인)

### wrangler 인증 만료
```bash
npx wrangler login
```

### D1 직접 쿼리
```bash
npx wrangler d1 execute taxist-db --remote --command "SELECT * FROM users;"
```

### 법령 업데이트 로그 확인
```bash
cat update_log.md
```
