# 데이터 수집 스크립트

## NTS 해석례 전문 수집 (핵심)

### 일괄 전문 수집 (최초 1회)

```bash
# 전체 실행 (Phase 1 → Phase 2 순서)
node scripts/fetch_full_content.mjs

# Phase 1만 (nts_doc_id 있는 9,055건)
node scripts/fetch_full_content.mjs --phase1

# Phase 2만 (nts_doc_id 없는 13,086건 — 제목 검색)
node scripts/fetch_full_content.mjs --phase2

# 테스트 (DB 저장 없음)
node scripts/fetch_full_content.mjs --dry-run

# 체크포인트 초기화 후 재시작
node scripts/fetch_full_content.mjs --reset
```

> 체크포인트: `scripts/full_content_checkpoint.json` (중단 후 재시작 가능)  
> 로그: `scripts/full_content.log`

### 월간 증분 수집 (매월 1회)

```bash
# 최근 35일 신규 문서 수집 (기본)
node scripts/fetch_incremental.mjs

# 기간 지정
node scripts/fetch_incremental.mjs --days 60

# 목록만 확인 (DB 저장 없음)
node scripts/fetch_incremental.mjs --dry-run
```

### 월간 자동화 (cron 설정 예시)

```bash
# crontab -e 에 추가 (매월 1일 새벽 3시 실행)
0 3 1 * *  cd /path/to/taxist && npx wrangler login --no-browser && node scripts/fetch_incremental.mjs >> scripts/incremental.log 2>&1
```

또는 GitHub Actions (`.github/workflows/monthly_nts.yml`):
```yaml
on:
  schedule:
    - cron: '0 18 1 * *'  # 매월 1일 KST 03:00
  workflow_dispatch:
jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node scripts/fetch_incremental.mjs
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
```

---

# 법령 수집 스크립트

국가법령정보센터 공개 API를 통해 세무행정 관련 법령·판례를 수집하여 Markdown으로 변환합니다.

## 파일 구조

```
scripts/
  config.py         수집 대상 법령 목록 및 API 설정
  fetch_laws.py     최초 전체 수집 스크립트
  daily_update.py   매일 변경사항 증분 업데이트
  law_to_md.py      JSON → Markdown 변환 유틸
  requirements.txt  Python 의존성
```

## 최초 설정

### 1. API 키 발급

1. [국가법령정보 공개 API](https://open.law.go.kr/lspo/main.do) 접속
2. 회원가입 → 로그인 → **오픈API 신청**
3. 서비스 종류: **법령/판례 조회**
4. 발급된 **인증키(OC)** 를 복사

### 2. GitHub Secret 등록

1. GitHub 레포지토리 → **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret** 클릭
3. Name: `LAW_API_KEY` / Secret: 발급받은 인증키 입력

### 3. 최초 전체 수집 실행

GitHub Actions에서 수동 실행:
1. **Actions** 탭 → **법령 일일 업데이트** 워크플로
2. **Run workflow** → mode: `full` 선택 → **Run**

또는 로컬에서 직접 실행:
```bash
cd taxist/
pip install -r scripts/requirements.txt
LAW_API_KEY=인증키 python scripts/fetch_laws.py
```

## 자동화 일정

| 작업 | 주기 | 방식 |
|---|---|---|
| 법령 변경 체크 | 매일 자정 KST | GitHub Actions 스케줄 |
| 판례 재수집 | 매주 (7일 간격) | daily_update.py 내부 로직 |
| 전체 재수집 | 수동 | workflow_dispatch (full 모드) |

## 수집 대상

### 법령 (총 19개)
- 국세기본법 + 시행령 + 시행규칙
- 법인세법 + 시행령 + 시행규칙
- 부가가치세법 + 시행령 + 시행규칙
- 소득세법 + 시행령 + 시행규칙
- 국세징수법 + 시행령
- 조세특례제한법 + 시행령
- 지방세법 + 시행령 + 지방세특례제한법 + 시행령

### 판례 (6개 세목 × 최대 100건)
- 법인세 / 부가세 / 조사 / 징세 / 재산세 / 개인세

## 출력 구조

```
taxist/
  법령자료/
    index.md            전체 법령 목록 인덱스
    국세기본/
      국세기본법.md
      국세기본법_시행령.md
    법인세/
      법인세법.md
      법인세법_시행령.md
    ...
  판례자료/
    법인세_판례.md
    부가세_판례.md
    ...
  law_manifest.json     수집 상태 및 버전 관리
  update_log.md         변경 이력 로그
```
