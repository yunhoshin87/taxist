"""
국가법령정보 API - 세무행정 관련 법령 전체 다운로드 & MD 변환

사용법:
  python scripts/fetch_all.py 인증키

  예시:
  python scripts/fetch_all.py abc123xyz

GitHub Actions에서는:
  LAW_API_KEY=xxx python scripts/fetch_all.py

--update 옵션: 변경된 법령만 재수집 (GitHub Actions 일일 업데이트용)
  python scripts/fetch_all.py 인증키 --update

다른 스크립트와의 관계 / 실행 시점 (인수인계 핵심 정보):
  - 이 파일은 scripts/fetch_all.mjs(Node.js)와 로직이 거의 1:1 대응하는 "동일 기능의 Python 구현"이다.
    검색 쿼리 목록(SEARCH_QUERIES), 판례 키워드(PREC_QUERIES), 폴더 분류 규칙(FOLDER_RULES),
    법령/판례 → Markdown 변환 로직까지 .mjs 버전과 거의 동일하게 포팅되어 있다(다만 일부 검색어가
    .mjs보다 더 많음: "조세범 처벌절차법", "교통 에너지 환경세법", "자유무역협정의 이행을 위한 관세법",
    "감사원법", "역외탈세방지" 등 추가 항목 존재).
  - 그러나 GitHub Actions 자동화(.github/workflows/update_laws.yml)는 fetch_all.mjs만 직접 호출하며,
    이 fetch_all.py는 워크플로에서 실행되지 않는다(워크플로 파일에 python 호출 없음, node만 호출).
    즉 이 파일은 CI에서 쓰이는 "현역" 스크립트가 아니라, Node.js 환경이 없거나 로컬에서 Python으로
    같은 작업을 수동 실행하고 싶을 때 쓰는 대체/백업 구현으로 보인다. 신규 기능을 추가할 때는
    fetch_all.mjs를 기준으로 변경하고, 필요하면 이 파일에도 동일하게 반영해야 두 구현이 갈라지지 않는다.
  - 의존성: requests 패키지 필요 (pip install requests). fetch_all.mjs는 Node 18+ 내장 fetch만 써서
    별도 설치가 없으므로, 그 점에서도 .mjs 쪽이 CI에 더 적합해 메인으로 채택된 것으로 보인다.
  - 국가법령정보센터(law.go.kr) 공식 Open API만 사용. taxlaw.nts.go.kr(국세법령정보시스템) 비공개
    AJAX를 다루는 scripts/standalone_collect.mjs와는 전혀 다른 데이터소스/목적의 스크립트이니 혼동하지 말 것.
"""

import sys
import os
import json
import time
import logging
import re
import argparse
from datetime import datetime
from pathlib import Path

import requests

# ─────────────────────────────────────────────────────────────
# 설정
# ─────────────────────────────────────────────────────────────

BASE_URL   = "https://www.law.go.kr/DRF"
TIMEOUT    = 30
DELAY      = 0.3   # 요청 간 딜레이 (초) — 공식 API라도 연속 호출 시 차단/지연을 막기 위한 완충 시간

BASE_DIR      = Path(__file__).resolve().parent.parent
OUT_DIR       = BASE_DIR / "법령자료"
PREC_DIR      = BASE_DIR / "판례자료"
MANIFEST_FILE = BASE_DIR / "law_manifest.json"
UPDATE_LOG    = BASE_DIR / "update_log.md"

# ── 검색 쿼리 목록 (이 키워드로 모든 관련 법령을 망라) ──
# 법령명 검색 → 법률 + 시행령 + 시행규칙이 모두 포함됨
SEARCH_QUERIES = [
    # 국세
    "국세기본법",
    "국세징수법",
    "조세범 처벌법",
    "조세범 처벌절차법",
    "납세자 보호법",
    # 소득
    "소득세법",
    "법인세법",
    # 소비·유통
    "부가가치세법",
    "개별소비세법",
    "주세법",
    "교통 에너지 환경세법",
    "인지세법",
    "증권거래세법",
    # 재산·이전
    "상속세 및 증여세법",
    "종합부동산세법",
    # 특례·감면
    "조세특례제한법",
    "농어촌특별세법",
    "교육세법",
    # 관세
    "관세법",
    "자유무역협정의 이행을 위한 관세법",
    # 지방세
    "지방세기본법",
    "지방세법",
    "지방세징수법",
    "지방세특례제한법",
    # 불복·심판
    "감사원법",         # 감사원 심사청구 관련
    "행정심판법",
    "행정소송법",
    # 국제조세
    "국제조세조정에 관한 법률",
    "역외탈세방지",
]

# ── 판례 수집 키워드 (세목별) ──
PREC_QUERIES = {
    "법인세": ["법인세법", "법인세 부당행위계산", "이월결손금", "소득처분"],
    "부가세": ["부가가치세법", "세금계산서 매입세액", "영세율 면세"],
    "소득세": ["소득세법", "양도소득세", "종합소득세", "근로소득"],
    "징세":   ["국세징수법", "체납처분 압류 공매"],
    "재산세": ["재산세 지방세법", "시가표준액 과세기준일"],
    "조세특례": ["조세특례제한법", "세액공제 감면"],
}

# ─────────────────────────────────────────────────────────────
# 로거
# ─────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(BASE_DIR / "fetch_all.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────
# API 헬퍼
# ─────────────────────────────────────────────────────────────

API_KEY = ""


# 공통 GET 헬퍼: 모든 API 호출(법령 검색/본문, 판례 검색)이 이 함수를 거친다.
# 최대 3회 재시도 — 일시적 네트워크 오류/타임아웃을 흡수해 한 건 실패로 전체 수집이 멈추지 않게 함.
# 429(rate limit)는 10초 더 대기한 뒤 같은 for 루프에서 다음 attempt로 재시도(시도 횟수 3회 안에 포함).
def _get(endpoint: str, params: dict) -> dict | None:
    url = f"{BASE_URL}/{endpoint}"
    p = {**params, "OC": API_KEY, "type": "JSON"}
    for attempt in range(3):
        try:
            r = requests.get(url, params=p, timeout=TIMEOUT)
            r.raise_for_status()
            return r.json()
        except requests.exceptions.HTTPError as e:
            if r.status_code == 429:
                log.warning("  Rate limit — 10초 대기 후 재시도...")
                time.sleep(10)
            else:
                log.error("  HTTP 오류 %s: %s", r.status_code, e)
                return None
        except (requests.exceptions.RequestException, json.JSONDecodeError) as e:
            log.error("  요청 실패 (시도 %d/3): %s", attempt + 1, e)
            time.sleep(2)
    return None


def fmt_date(raw: str) -> str:
    if raw and len(raw) == 8 and raw.isdigit():
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    return raw or ""


# ─────────────────────────────────────────────────────────────
# 법령 목록 수집 (검색 → 전체 페이지)
# ─────────────────────────────────────────────────────────────

def search_all_laws(query: str) -> list[dict]:
    """쿼리로 검색되는 모든 법령 목록 반환 (페이지네이션)

    display=100으로 한 번에 최대치를 받아 요청 수(=누적 DELAY 대기시간)를 줄인다.
    API가 결과 1건일 때 배열이 아닌 단일 객체로 응답하는 경우가 있어 매번 isinstance 체크로 정규화한다.
    """
    results = []
    page = 1
    while True:
        time.sleep(DELAY)
        data = _get("lawSearch.do", {
            "target":  "law",
            "query":   query,
            "display": "100",
            "page":    str(page),
            "sort":    "efYd",
        })
        if not data:
            break

        wrap  = data.get("LawSearch", {})
        total = int(wrap.get("totalCnt", 0) or 0)
        items = wrap.get("law", [])
        if isinstance(items, dict):
            items = [items]
        if not items:
            break

        results.extend(items)
        log.info("    쿼리 '%s' — %d/%d 수집", query, len(results), total)

        if len(results) >= total or page * 100 >= total:
            break
        page += 1

    return results


# ─────────────────────────────────────────────────────────────
# 법령 본문 → MD 변환
# ─────────────────────────────────────────────────────────────

def _s(v) -> str:
    """API 응답값을 안전하게 문자열로 변환 (리스트·딕셔너리 포함)"""
    if v is None:
        return ""
    if isinstance(v, list):
        return "\n".join(_s(x) for x in v if x is not None).strip()
    if isinstance(v, dict):
        return str(v).strip()
    return str(v).strip()


def law_to_md(data: dict, meta: dict) -> str:
    """법령 API 응답 JSON → Markdown

    조문 → 항 → 호 → 목의 위계를 들여쓰기와 동그라미 숫자(①②③...)로 표현해 사람이 읽는 법령
    조문 표기 관행을 그대로 재현한다. 편/장/절 같은 상위 구분은 헤딩(##)으로, 실제 조문은 ###로 분리.
    """
    법령 = data.get("법령", {})
    기본 = 법령.get("기본정보", {})

    법령명  = 기본.get("법령명_한글") or meta.get("법령명한글", "")
    법령번호 = 기본.get("법령번호", "")
    공포일  = fmt_date(기본.get("공포일자", ""))
    시행일  = fmt_date(기본.get("시행일자", ""))
    부처명  = 기본.get("소관부처명", "")
    today   = datetime.now().strftime("%Y-%m-%d")

    lines = [
        f"# {법령명}",
        "",
        f"> **법령번호:** {법령번호}",
        f"> **시행일자:** {시행일}",
        f"> **공포일자:** {공포일}",
        f"> **소관부처:** {부처명}",
        f"> **수집일자:** {today}",
        f"> **출처:** [국가법령정보센터](https://www.law.go.kr)",
        "",
        "---",
        "",
    ]

    # 조문 처리
    조문_wrap = 법령.get("조문", {})
    조문_목록 = 조문_wrap.get("조문단위", []) if 조문_wrap else []
    if isinstance(조문_목록, dict):
        조문_목록 = [조문_목록]

    for 조 in 조문_목록:
        편장절  = _s(조.get("편장절구분"))
        편장절명 = _s(조.get("편장절제목"))
        조번호  = _s(조.get("조문번호"))
        조제목  = _s(조.get("조문제목"))
        조내용  = _s(조.get("조문내용"))

        if 편장절 in ("편", "장", "절", "관", "목"):
            num = _s(조.get("편장절번호"))
            lines += [f"## {편장절} {num} {편장절명}".strip(), ""]
            continue

        heading = f"제{조번호}조"
        if 조제목:
            heading += f" ({조제목})"
        lines += [f"### {heading}", ""]

        if 조내용:
            lines += [조내용, ""]

        # 항
        항_목록 = 조.get("항", [])
        if isinstance(항_목록, dict):
            항_목록 = [항_목록]
        for 항 in 항_목록:
            항번호 = _s(항.get("항번호"))
            항내용 = _s(항.get("항내용"))
            prefix = _circle(항번호)
            if 항내용:
                lines.append(f"{prefix} {항내용}")

            # 호
            호_목록 = 항.get("호", [])
            if isinstance(호_목록, dict):
                호_목록 = [호_목록]
            for 호 in 호_목록:
                호번호 = _s(호.get("호번호"))
                호내용 = _s(호.get("호내용"))
                if 호내용:
                    lines.append(f"  {호번호}. {호내용}")
                # 목
                목_목록 = 호.get("목", [])
                if isinstance(목_목록, dict):
                    목_목록 = [목_목록]
                for 목 in 목_목록:
                    목번호 = _s(목.get("목번호"))
                    목내용 = _s(목.get("목내용"))
                    if 목내용:
                        lines.append(f"    {목번호}) {목내용}")
        lines.append("")

    # 부칙
    부칙_wrap = 법령.get("부칙", {})
    부칙_목록 = 부칙_wrap.get("부칙단위", []) if 부칙_wrap else []
    if isinstance(부칙_목록, dict):
        부칙_목록 = [부칙_목록]
    if 부칙_목록:
        lines += ["---", "", "## 부칙", ""]
        for 부 in 부칙_목록:
            pub  = fmt_date(_s(부.get("공포일자")))
            내용 = _s(부.get("부칙내용"))
            if pub:
                lines += [f"### 부칙 ({pub})", ""]
            if 내용:
                lines += [내용, ""]

    return "\n".join(lines)


# 항번호(숫자)를 법령 표기 관용인 동그라미 숫자로 변환. 범위(1~20) 밖이면 "(n)"으로 안전하게 폴백.
def _circle(n: str) -> str:
    circles = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
    try:
        idx = int(n) - 1
        return circles[idx] if 0 <= idx < len(circles) else f"({n})"
    except (ValueError, TypeError):
        return f"({n})" if n else ""


# ─────────────────────────────────────────────────────────────
# 판례 → MD 변환
# ─────────────────────────────────────────────────────────────

def collect_prec_for(category: str, keywords: list[str]) -> list[dict]:
    # 세목별로 키워드를 여러 개 두는 이유: 한 키워드로는 누락되는 판례가 있어 키워드별로 검색해 합치고,
    # "판례정보일련번호"로 중복을 제거(seen)한다. 한 세목당 200건 상한(all_prec < 200)을 두어
    # 과도한 페이지네이션으로 시간이 무한정 늘어나는 것을 방지.
    all_prec, seen = [], set()
    for kw in keywords:
        page = 1
        while len(all_prec) < 200:
            time.sleep(DELAY)
            data = _get("lawSearch.do", {
                "target":  "prec",
                "query":   kw,
                "display": "20",
                "page":    str(page),
                "sort":    "ddes",
            })
            if not data:
                break
            wrap  = data.get("PrecSearch", {})
            total = int(wrap.get("totalCnt", 0) or 0)
            items = wrap.get("prec", [])
            if isinstance(items, dict):
                items = [items]
            for p in items:
                pid = p.get("판례정보일련번호", "")
                if pid and pid not in seen:
                    seen.add(pid)
                    all_prec.append(p)
            if not items or page * 20 >= min(total, 200):
                break
            page += 1
    return all_prec


def prec_to_md(prec_list: list, category: str) -> str:
    today = datetime.now().strftime("%Y-%m-%d")
    lines = [
        f"# {category} 관련 판례 모음",
        "",
        f"> **수집 건수:** {len(prec_list)}건",
        f"> **수집일자:** {today}",
        f"> **출처:** [국가법령정보센터](https://www.law.go.kr)",
        "",
        "---",
        "",
    ]
    for i, p in enumerate(prec_list, 1):
        사건명  = p.get("사건명", "")
        사건번호 = p.get("사건번호", "")
        선고일  = fmt_date(p.get("선고일자", ""))
        법원명  = p.get("법원명", "")
        판시사항 = (p.get("판시사항") or "").strip()
        판결요지 = (p.get("판결요지") or "").strip()
        참조조문 = (p.get("참조조문") or "").strip()

        lines += [
            f"## {i}. {사건명}",
            "",
            f"| 사건번호 | {사건번호} |",
            f"|---|---|",
            f"| 선고일자 | {선고일} |",
            f"| 법원 | {법원명} |",
            "",
        ]
        if 판시사항:
            lines += ["**판시사항**", "", 판시사항, ""]
        if 판결요지:
            lines += ["**판결요지**", "", 판결요지, ""]
        if 참조조문:
            lines += [f"**참조조문:** {참조조문}", ""]
        lines += ["---", ""]
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────
# 폴더명 결정 (법령명 기반 자동 분류)
# ─────────────────────────────────────────────────────────────

FOLDER_RULES = [
    (r"국세기본|국세징수|조세범|납세자",  "국세기본"),
    (r"소득세",                           "소득세"),
    (r"법인세",                           "법인세"),
    (r"부가가치세|부가세",                "부가세"),
    (r"상속세|증여세",                    "상속증여세"),
    (r"종합부동산세",                     "종합부동산세"),
    (r"개별소비세|주세|교통.*에너지|인지세|증권거래세", "소비세"),
    (r"조세특례|농어촌특별세|교육세",     "조세특례"),
    (r"관세",                             "관세"),
    (r"지방세",                           "지방세"),
    (r"행정심판|행정소송|감사원",         "불복절차"),
    (r"국제조세|역외탈세",                "국제조세"),
]


# 법령명을 정규식으로 매칭해 보관 폴더를 결정. 목록 순서가 우선순위이므로(첫 매칭 채택),
# 더 구체적인 패턴을 위에 두어야 한다(예: "지방세" 계열이 일반 "세"보다 먼저 분기되도록).
def law_folder(name: str) -> str:
    for pattern, folder in FOLDER_RULES:
        if re.search(pattern, name):
            return folder
    return "기타"


def safe_filename(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", name).strip()


# ─────────────────────────────────────────────────────────────
# Manifest
# ─────────────────────────────────────────────────────────────

# law_manifest.json: 법령명 → {mst, 시행일자, 공포일자, folder, last_updated} 매핑 저장소.
# --update 모드에서 "이전에 수집한 시행일자와 동일하면 스킵"하는 변경분 판별 기준이자 index.md 생성용 메타데이터.
# 파일이 없거나 손상돼도 빈 dict로 시작해 전체 재수집과 동일하게 동작하도록 함(예외로 죽지 않게).
def load_manifest() -> dict:
    if MANIFEST_FILE.exists():
        with open(MANIFEST_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_manifest(m: dict):
    with open(MANIFEST_FILE, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)


def append_log(entries: list[str]):
    if not entries:
        return
    header = f"\n## {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
    body   = "\n".join(f"- {e}" for e in entries) + "\n"
    existing = UPDATE_LOG.read_text(encoding="utf-8") if UPDATE_LOG.exists() else "# TAXIST 법령 업데이트 로그\n"
    UPDATE_LOG.write_text(existing + header + body, encoding="utf-8")


# ─────────────────────────────────────────────────────────────
# 인덱스 MD 생성
# ─────────────────────────────────────────────────────────────

def make_index(manifest: dict):
    today = datetime.now().strftime("%Y-%m-%d %H:%M")
    law_entries   = {k: v for k, v in manifest.items() if not k.startswith("prec_")}
    prec_entries  = {k: v for k, v in manifest.items() if k.startswith("prec_")}

    # 폴더별 그룹화
    by_folder: dict[str, list] = {}
    for name, info in law_entries.items():
        folder = info.get("folder", "기타")
        by_folder.setdefault(folder, []).append((name, info))

    lines = [
        "# TAXIST 법령자료 인덱스",
        "",
        f"> 마지막 업데이트: {today}",
        f"> 수집 법령: {len(law_entries)}건 | 판례: {sum(v.get('count',0) for v in prec_entries.values())}건",
        "",
        "---",
        "",
    ]

    for folder, items in sorted(by_folder.items()):
        lines += [f"## {folder}", ""]
        lines += [
            f"| 법령명 | 시행일자 | 수집일 |",
            f"|---|---|---|",
        ]
        for name, info in sorted(items):
            시행일 = info.get("시행일자", "-")
            updated = info.get("last_updated", "-")[:10]
            lines.append(f"| {name} | {시행일} | {updated} |")
        lines.append("")

    if prec_entries:
        lines += ["## 판례", "", "| 세목 | 수집건수 | 수집일 |", "|---|---|---|"]
        for key, info in sorted(prec_entries.items()):
            cat = key.replace("prec_", "")
            lines.append(f"| {cat} | {info.get('count', 0)}건 | {info.get('last_updated', '-')[:10]} |")
        lines.append("")

    (OUT_DIR / "index.md").write_text("\n".join(lines), encoding="utf-8")
    log.info("인덱스 생성 완료: 법령 %d건", len(law_entries))


# ─────────────────────────────────────────────────────────────
# 메인
# ─────────────────────────────────────────────────────────────

def main():
    # 메인 흐름: [1] 검색쿼리로 법령 목록 수집 → [2] 각 법령 본문을 가져와 MD로 저장(manifest에 누적 기록,
    # 매 건마다 save_manifest로 중간 저장 — 중단되어도 재실행 시 이미 처리된 항목은 건너뀀) → [3] 세목별 판례 수집.
    # --update 모드일 때 [2]는 시행일자 변경분만, [3]은 7일 이상 지난 세목만 다시 수집해 불필요한 API 호출을 줄인다.
    global API_KEY

    parser = argparse.ArgumentParser(description="국가법령정보 전체 다운로드")
    parser.add_argument("key", nargs="?", default=os.environ.get("LAW_API_KEY", ""),
                        help="API 인증키 (또는 LAW_API_KEY 환경변수)")
    parser.add_argument("--update", action="store_true",
                        help="변경된 법령만 재수집 (일일 업데이트 모드)")
    args = parser.parse_args()

    API_KEY = args.key
    if not API_KEY:
        print("오류: API 키를 입력해주세요.")
        print("사용법: python scripts/fetch_all.py 인증키")
        sys.exit(1)

    mode = "업데이트" if args.update else "전체 수집"
    log.info("══════════════════════════════════")
    log.info("TAXIST 법령 %s 시작", mode)
    log.info("══════════════════════════════════")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    PREC_DIR.mkdir(parents=True, exist_ok=True)

    manifest = load_manifest()
    updated  = []

    # ── STEP 1: 검색 쿼리로 법령 목록 전체 수집 ──────────────
    log.info("")
    log.info("[1/3] 법령 목록 수집 중...")
    all_laws: dict[str, dict] = {}   # MST → meta

    for query in SEARCH_QUERIES:
        items = search_all_laws(query)
        for item in items:
            mst = item.get("법령일련번호", "")
            if mst and item.get("현행연혁코드") == "현행":
                all_laws[mst] = item

    log.info("→ 고유 현행 법령 %d건 발견", len(all_laws))

    # ── STEP 2: 각 법령 본문 다운로드 & MD 저장 ──────────────
    log.info("")
    log.info("[2/3] 법령 본문 다운로드 & MD 변환 중...")
    total = len(all_laws)

    for idx, (mst, meta) in enumerate(all_laws.items(), 1):
        name    = (meta.get("법령명한글") or "").strip()
        시행일자 = meta.get("시행일자", "")
        folder  = law_folder(name)

        # 업데이트 모드: 시행일자 변경 없으면 스킵
        if args.update:
            existing = manifest.get(name, {})
            if existing.get("mst") == mst and existing.get("시행일자") == fmt_date(시행일자):
                continue

        log.info("  [%d/%d] %s", idx, total, name)

        time.sleep(DELAY)
        detail = _get("lawService.do", {"target": "law", "MST": mst})
        if not detail:
            log.warning("    본문 조회 실패: %s", name)
            continue

        # MD 변환 및 저장
        md_text   = law_to_md(detail, meta)
        out_dir   = OUT_DIR / folder
        out_dir.mkdir(parents=True, exist_ok=True)
        safe_name = safe_filename(name)
        out_path  = out_dir / f"{safe_name}.md"
        out_path.write_text(md_text, encoding="utf-8")

        manifest[name] = {
            "mst":          mst,
            "시행일자":     fmt_date(시행일자),
            "공포일자":     fmt_date(meta.get("공포일자", "")),
            "folder":       folder,
            "file":         str(out_path.relative_to(BASE_DIR)),
            "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        }
        updated.append(f"[법령] {name}")
        save_manifest(manifest)   # 중간 저장 (중단 후 재개 가능)

    log.info("→ 법령 저장 완료: %d건", len(updated))

    # ── STEP 3: 판례 수집 ────────────────────────────────────
    log.info("")
    log.info("[3/3] 판례 수집 중...")

    for category, keywords in PREC_QUERIES.items():
        # 업데이트 모드: 7일 미만이면 스킵
        if args.update:
            last = manifest.get(f"prec_{category}", {}).get("last_updated", "")
            if last:
                try:
                    last_dt = datetime.strptime(last[:10], "%Y-%m-%d")
                    if (datetime.now() - last_dt).days < 7:
                        log.info("  판례 스킵 (7일 미경과): %s", category)
                        continue
                except ValueError:
                    pass

        log.info("  판례 수집: %s", category)
        prec_list = collect_prec_for(category, keywords)
        if not prec_list:
            continue

        md_text  = prec_to_md(prec_list, category)
        out_path = PREC_DIR / f"{category}_판례.md"
        out_path.write_text(md_text, encoding="utf-8")

        manifest[f"prec_{category}"] = {
            "count":        len(prec_list),
            "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        }
        updated.append(f"[판례] {category} {len(prec_list)}건")
        save_manifest(manifest)
        log.info("  → %s 판례 저장: %d건", category, len(prec_list))

    # ── 인덱스 및 로그 ───────────────────────────────────────
    save_manifest(manifest)
    make_index(manifest)
    append_log(updated)

    log.info("")
    log.info("══════════════════════════════════")
    log.info("완료: 총 %d건 처리", len(updated))
    log.info("법령자료 위치: %s", OUT_DIR)
    log.info("판례자료 위치: %s", PREC_DIR)
    log.info("══════════════════════════════════")

    # GitHub Actions용 출력
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"changed={len(updated)}\n")


if __name__ == "__main__":
    main()
