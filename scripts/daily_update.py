"""
국가법령정보 API - 매일 변경사항 확인 및 증분 업데이트 스크립트

GitHub Actions에서 매일 자정(KST) 자동 실행됩니다.
변경된 법령만 재수집하여 MD 파일을 갱신합니다.

사용법:
  LAW_API_KEY=인증키 python scripts/daily_update.py
"""

import json
import os
import sys
import time
import logging
from datetime import datetime
from pathlib import Path

import requests

sys.path.insert(0, os.path.dirname(__file__))
from config import (
    API_KEY, BASE_URL, TIMEOUT, DELAY, MAX_PREC,
    LAW_DIR, PREC_DIR, MANIFEST_FILE, UPDATE_LOG,
    TARGET_LAWS, PREC_KEYWORDS,
)
from law_to_md import law_to_md, prec_to_md, make_index_md
from fetch_laws import (
    _get, search_law, fetch_law_detail, search_prec,
    collect_law, collect_prec, _fmt_date,
    load_manifest, save_manifest, append_update_log,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)


def check_law_changed(name: str, manifest: dict) -> bool:
    """
    API에서 법령의 최신 시행일자를 조회하여
    manifest에 저장된 값과 다르면 True 반환.
    """
    time.sleep(DELAY)
    law_info = search_law(name)
    if not law_info:
        return False

    new_mst  = law_info.get("법령일련번호", "")
    new_date = law_info.get("시행일자", "")
    existing = manifest.get(name, {})

    if existing.get("mst") != new_mst or existing.get("시행일자") != _fmt_date(new_date):
        log.info("  변경 감지: %s (기존 %s → 신규 %s)",
                 name, existing.get("시행일자", "없음"), _fmt_date(new_date))
        return True
    return False


def check_prec_changed(category: str, manifest: dict) -> bool:
    """
    판례는 매주 월요일에만 전체 재수집 (변경 감지 어렵기 때문)
    """
    today = datetime.now()
    existing = manifest.get(f"prec_{category}", {})
    last_updated = existing.get("last_updated", "")

    if not last_updated:
        return True  # 한 번도 수집 안 됨

    try:
        last_dt = datetime.strptime(last_updated[:10], "%Y-%m-%d")
        days_since = (today - last_dt).days
        # 7일 이상 지났으면 재수집
        return days_since >= 7
    except ValueError:
        return True


def main():
    if not API_KEY:
        log.error("LAW_API_KEY 환경변수가 설정되지 않았습니다.")
        sys.exit(1)

    log.info("═══ 일일 업데이트 체크 시작 (%s) ═══",
             datetime.now().strftime("%Y-%m-%d %H:%M"))

    manifest = load_manifest()
    updated_entries = []
    checked = 0
    changed = 0

    # ── 법령 변경 체크 ──
    log.info("── 법령 변경사항 확인 중 ──")
    for folder, law_names in TARGET_LAWS.items():
        for name in law_names:
            checked += 1
            if check_law_changed(name, manifest):
                success = collect_law(name, folder, manifest)
                if success:
                    changed += 1
                    updated_entries.append(f"[법령 업데이트] {name}")
                    save_manifest(manifest)

    # ── 판례 주간 갱신 ──
    log.info("── 판례 업데이트 확인 중 ──")
    for category, keywords in PREC_KEYWORDS.items():
        if check_prec_changed(category, manifest):
            success = collect_prec(category, keywords, manifest)
            if success:
                changed += 1
                updated_entries.append(f"[판례 갱신] {category}")
                save_manifest(manifest)

    # ── 인덱스 재생성 (변경이 있을 때만) ──
    if updated_entries:
        index_md = make_index_md(manifest)
        index_path = Path(LAW_DIR) / "index.md"
        index_path.write_text(index_md, encoding="utf-8")
        log.info("인덱스 업데이트 완료")

        append_update_log(updated_entries)

    save_manifest(manifest)

    log.info("── 결과: 확인 %d건 / 업데이트 %d건 ──", checked, changed)

    # GitHub Actions 출력 (GITHUB_OUTPUT 환경변수 있을 때)
    github_output = os.environ.get("GITHUB_OUTPUT", "")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"changed={changed}\n")
            f.write(f"summary={'변경 없음' if changed == 0 else f'{changed}건 업데이트'}\n")

    if changed == 0:
        log.info("변경사항 없음 — 커밋 스킵")
    else:
        log.info("═══ 업데이트 완료 (%d건) ═══", changed)

    sys.exit(0)


if __name__ == "__main__":
    main()
