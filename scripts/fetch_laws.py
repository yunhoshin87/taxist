"""
국가법령정보 API - 전체 법령 최초 다운로드 스크립트

사용법:
  LAW_API_KEY=인증키 python scripts/fetch_laws.py

최초 1회 실행 시 모든 대상 법령을 다운로드합니다.
이후 업데이트는 daily_update.py 가 담당합니다.
"""

import json
import os
import sys
import time
import logging
from datetime import datetime
from pathlib import Path

import requests

# scripts/ 폴더를 path에 추가
sys.path.insert(0, os.path.dirname(__file__))
from config import (
    API_KEY, BASE_URL, TIMEOUT, DELAY, MAX_PREC,
    LAW_DIR, PREC_DIR, MANIFEST_FILE, UPDATE_LOG,
    TARGET_LAWS, PREC_KEYWORDS,
)
from law_to_md import law_to_md, prec_to_md, make_index_md

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────
# API 호출 헬퍼
# ─────────────────────────────────────────────────────────────

def _get(endpoint: str, params: dict) -> dict | None:
    """API GET 요청 공통 처리"""
    params = {**params, "OC": API_KEY, "type": "JSON"}
    url = f"{BASE_URL}/{endpoint}"
    try:
        resp = requests.get(url, params=params, timeout=TIMEOUT)
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.RequestException as e:
        log.error("API 요청 실패 (%s %s): %s", endpoint, params.get("query", ""), e)
        return None
    except json.JSONDecodeError as e:
        log.error("JSON 파싱 실패: %s", e)
        return None


def search_law(name: str) -> dict | None:
    """법령명으로 검색 → 첫 번째 현행 법령 정보 반환"""
    data = _get("lawSearch.do", {"target": "law", "query": name, "exact": "1", "display": "10"})
    if not data:
        return None
    laws = data.get("LawSearch", {}).get("law", [])
    if isinstance(laws, dict):
        laws = [laws]
    # 현행 + 법령명 정확 일치 우선
    for law in laws:
        if law.get("법령명한글", "").strip() == name and law.get("현행연혁코드") == "현행":
            return law
    # 정확 일치 없으면 첫 번째 현행
    for law in laws:
        if law.get("현행연혁코드") == "현행":
            return law
    return laws[0] if laws else None


def fetch_law_detail(mst: str) -> dict | None:
    """법령일련번호(MST)로 본문 조회"""
    return _get("lawService.do", {"target": "law", "MST": mst})


def search_prec(keyword: str, page: int = 1, display: int = 20) -> dict | None:
    """판례 검색"""
    return _get("lawSearch.do", {
        "target": "prec",
        "query": keyword,
        "page": str(page),
        "display": str(display),
        "sort": "ddes",   # 최신순
    })


# ─────────────────────────────────────────────────────────────
# 법령 수집
# ─────────────────────────────────────────────────────────────

def collect_law(name: str, folder: str, manifest: dict) -> bool:
    """법령 1건 수집 → MD 저장 → manifest 업데이트. 성공 시 True 반환."""
    log.info("  수집 중: %s", name)

    # 1. 검색
    time.sleep(DELAY)
    law_info = search_law(name)
    if not law_info:
        log.warning("  검색 결과 없음: %s", name)
        return False

    mst      = law_info.get("법령일련번호", "")
    시행일자 = law_info.get("시행일자", "")
    공포일자 = law_info.get("공포일자", "")

    # manifest에 변경 없으면 스킵 (재실행 시 불필요한 API 호출 방지)
    existing = manifest.get(name, {})
    if existing.get("mst") == mst and existing.get("시행일자") == 시행일자:
        log.info("  이미 최신: %s (시행일자: %s)", name, 시행일자)
        return False

    # 2. 본문 조회
    time.sleep(DELAY)
    detail = fetch_law_detail(mst)
    if not detail:
        log.warning("  본문 조회 실패: %s (MST: %s)", name, mst)
        return False

    # 3. MD 변환
    md_text = law_to_md(detail)

    # 4. 파일 저장
    out_dir = Path(LAW_DIR) / folder
    out_dir.mkdir(parents=True, exist_ok=True)
    safe_name = name.replace(" ", "_").replace("/", "_")
    out_path = out_dir / f"{safe_name}.md"
    out_path.write_text(md_text, encoding="utf-8")
    log.info("  저장 완료: %s", out_path)

    # 5. manifest 업데이트
    manifest[name] = {
        "mst":          mst,
        "시행일자":     _fmt_date(시행일자),
        "공포일자":     _fmt_date(공포일자),
        "folder":       folder,
        "file":         str(out_path.relative_to(Path(LAW_DIR).parent)),
        "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    return True


# ─────────────────────────────────────────────────────────────
# 판례 수집
# ─────────────────────────────────────────────────────────────

def collect_prec(category: str, keywords: list, manifest: dict) -> bool:
    """세목별 판례 수집 → MD 저장"""
    log.info("판례 수집: %s (%s)", category, ", ".join(keywords))
    all_prec = []
    seen_ids = set()

    for kw in keywords:
        collected = 0
        page = 1
        while collected < MAX_PREC // len(keywords):
            time.sleep(DELAY)
            data = search_prec(kw, page=page, display=20)
            if not data:
                break
            prec_wrap = data.get("PrecSearch", {})
            items = prec_wrap.get("prec", [])
            if isinstance(items, dict):
                items = [items]
            if not items:
                break

            for p in items:
                pid = p.get("판례정보일련번호", "")
                if pid and pid not in seen_ids:
                    seen_ids.add(pid)
                    all_prec.append(p)
                    collected += 1

            total = int(prec_wrap.get("totalCnt", "0") or "0")
            if page * 20 >= total or page >= 5:
                break
            page += 1

    if not all_prec:
        log.warning("  판례 없음: %s", category)
        return False

    # MD 변환 및 저장
    md_text = prec_to_md(all_prec, category, keywords)
    out_dir = Path(PREC_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{category}_판례.md"
    out_path.write_text(md_text, encoding="utf-8")
    log.info("  판례 저장: %s (%d건)", out_path, len(all_prec))

    manifest[f"prec_{category}"] = {
        "count":        len(all_prec),
        "keywords":     keywords,
        "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    return True


# ─────────────────────────────────────────────────────────────
# 메인
# ─────────────────────────────────────────────────────────────

def _fmt_date(raw: str) -> str:
    if raw and len(raw) == 8:
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    return raw or ""


def load_manifest() -> dict:
    if Path(MANIFEST_FILE).exists():
        with open(MANIFEST_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_manifest(manifest: dict):
    Path(MANIFEST_FILE).parent.mkdir(parents=True, exist_ok=True)
    with open(MANIFEST_FILE, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


def append_update_log(entries: list[str]):
    if not entries:
        return
    today = datetime.now().strftime("%Y-%m-%d %H:%M")
    log_path = Path(UPDATE_LOG)
    header = f"\n## {today}\n\n"
    body   = "\n".join(f"- {e}" for e in entries) + "\n"
    if log_path.exists():
        existing = log_path.read_text(encoding="utf-8")
    else:
        existing = "# TAXIST 법령 업데이트 로그\n"
    log_path.write_text(existing + header + body, encoding="utf-8")


def main():
    if not API_KEY:
        log.error("LAW_API_KEY 환경변수가 설정되지 않았습니다.")
        log.error("사용법: LAW_API_KEY=인증키 python scripts/fetch_laws.py")
        sys.exit(1)

    log.info("═══ 국가법령정보 전체 수집 시작 ═══")
    manifest = load_manifest()
    updated_entries = []

    # 법령 수집
    for folder, law_names in TARGET_LAWS.items():
        log.info("── %s 법령 수집 ──", folder)
        for name in law_names:
            changed = collect_law(name, folder, manifest)
            if changed:
                updated_entries.append(f"[법령 수집] {name}")
            save_manifest(manifest)  # 중간 저장 (중단 시 재개 가능)

    # 판례 수집
    log.info("── 판례 수집 ──")
    for category, keywords in PREC_KEYWORDS.items():
        changed = collect_prec(category, keywords, manifest)
        if changed:
            updated_entries.append(f"[판례 수집] {category} ({len(keywords)}개 키워드)")
        save_manifest(manifest)

    # 인덱스 MD 생성
    index_md = make_index_md(manifest)
    index_path = Path(LAW_DIR) / "index.md"
    index_path.write_text(index_md, encoding="utf-8")
    log.info("인덱스 생성: %s", index_path)

    # 업데이트 로그 기록
    append_update_log(updated_entries)

    save_manifest(manifest)
    log.info("═══ 수집 완료 — 총 %d건 업데이트 ═══", len(updated_entries))


if __name__ == "__main__":
    main()
