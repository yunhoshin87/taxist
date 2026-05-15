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
DELAY      = 0.3   # 요청 간 딜레이 (초)

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
    """쿼리로 검색되는 모든 법령 목록 반환 (페이지네이션)"""
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

def law_to_md(data: dict, meta: dict) -> str:
    """법령 API 응답 JSON → Markdown"""
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
        편장절  = (조.get("편장절구분") or "").strip()
        편장절명 = (조.get("편장절제목") or "").strip()
        조번호  = (조.get("조문번호") or "").strip()
        조제목  = (조.get("조문제목") or "").strip()
        조내용  = (조.get("조문내용") or "").strip()

        if 편장절 in ("편", "장", "절", "관", "목"):
            num  = 조.get("편장절번호") or ""
            lines += [f"## {편장절} {num} {편장절명}".strip(), ""]
            continue

        # 조 제목 줄
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
            항번호 = (항.get("항번호") or "").strip()
            항내용 = (항.get("항내용") or "").strip()
            prefix = _circle(항번호)
            if 항내용:
                lines.append(f"{prefix} {항내용}")

            # 호
            호_목록 = 항.get("호", [])
            if isinstance(호_목록, dict):
                호_목록 = [호_목록]
            for 호 in 호_목록:
                호번호 = (호.get("호번호") or "").strip()
                호내용 = (호.get("호내용") or "").strip()
                if 호내용:
                    lines.append(f"  {호번호}. {호내용}")
                # 목
                목_목록 = 호.get("목", [])
                if isinstance(목_목록, dict):
                    목_목록 = [목_목록]
                for 목 in 목_목록:
                    목번호 = (목.get("목번호") or "").strip()
                    목내용 = (목.get("목내용") or "").strip()
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
            pub = fmt_date(부.get("공포일자", ""))
            내용 = (부.get("부칙내용") or "").strip()
            if pub:
                lines += [f"### 부칙 ({pub})", ""]
            if 내용:
                lines += [내용, ""]

    return "\n".join(lines)


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
