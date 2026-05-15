"""
국가법령정보 API JSON 응답 → Markdown 변환 유틸리티
"""

from datetime import datetime


def _fmt_date(raw: str) -> str:
    """'20240101' → '2024-01-01'"""
    if raw and len(raw) == 8:
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    return raw or ""


def law_to_md(data: dict) -> str:
    """법령 본문 JSON → Markdown 변환"""
    법령 = data.get("법령", {})
    기본 = 법령.get("기본정보", {})

    법령명  = 기본.get("법령명_한글", "")
    법령번호 = 기본.get("법령번호", "")
    공포일  = _fmt_date(기본.get("공포일자", ""))
    시행일  = _fmt_date(기본.get("시행일자", ""))
    부처명  = 기본.get("소관부처명", "")
    today   = datetime.now().strftime("%Y-%m-%d")

    lines = [
        f"# {법령명}",
        "",
        f"> **법령번호:** {법령번호}  ",
        f"> **공포일자:** {공포일}  ",
        f"> **시행일자:** {시행일}  ",
        f"> **소관부처:** {부처명}  ",
        f"> **최종수집:** {today}  ",
        f"> **출처:** [국가법령정보센터](https://www.law.go.kr)",
        "",
        "---",
        "",
    ]

    # 조문 처리
    조문_wrap = 법령.get("조문", {})
    조문_목록 = 조문_wrap.get("조문단위", [])
    if isinstance(조문_목록, dict):
        조문_목록 = [조문_목록]

    current_chapter = None

    for 조 in 조문_목록:
        # 장/절/관 구분
        편장절 = 조.get("편장절구분", "")
        편장절명 = 조.get("편장절제목", "") or 조.get("조문제목", "")

        if 편장절 in ("편", "장", "절", "관"):
            if current_chapter != 편장절명:
                current_chapter = 편장절명
                lines.append(f"## {편장절명}")
                lines.append("")
            continue

        조번호  = 조.get("조문번호", "")
        조제목  = 조.get("조문제목", "")
        조내용  = 조.get("조문내용", "") or ""

        # 조 제목
        if 조제목:
            lines.append(f"### 제{조번호}조 ({조제목})")
        else:
            lines.append(f"### 제{조번호}조")
        lines.append("")

        # 조 본문 (항이 없을 때)
        if 조내용.strip():
            lines.append(조내용.strip())
            lines.append("")

        # 항 처리
        항_목록 = 조.get("항", [])
        if isinstance(항_목록, dict):
            항_목록 = [항_목록]

        for 항 in 항_목록:
            항번호  = 항.get("항번호", "")
            항내용  = (항.get("항내용", "") or "").strip()

            if 항번호 and 항내용:
                lines.append(f"{'①②③④⑤⑥⑦⑧⑨⑩'[int(항번호)-1] if 항번호.isdigit() and int(항번호) <= 10 else f'({항번호})'} {항내용}")
            elif 항내용:
                lines.append(항내용)

            # 호 처리
            호_목록 = 항.get("호", [])
            if isinstance(호_목록, dict):
                호_목록 = [호_목록]
            for 호 in 호_목록:
                호번호 = 호.get("호번호", "")
                호내용 = (호.get("호내용", "") or "").strip()
                if 호내용:
                    lines.append(f"  {호번호}. {호내용}")

                # 목 처리
                목_목록 = 호.get("목", [])
                if isinstance(목_목록, dict):
                    목_목록 = [목_목록]
                for 목 in 목_목록:
                    목번호 = 목.get("목번호", "")
                    목내용 = (목.get("목내용", "") or "").strip()
                    if 목내용:
                        lines.append(f"    {목번호}) {목내용}")

        lines.append("")

    # 부칙
    부칙_wrap = 법령.get("부칙", {})
    부칙_목록 = 부칙_wrap.get("부칙단위", []) if 부칙_wrap else []
    if isinstance(부칙_목록, dict):
        부칙_목록 = [부칙_목록]

    if 부칙_목록:
        lines.append("---")
        lines.append("")
        lines.append("## 부칙")
        lines.append("")
        for 부 in 부칙_목록:
            공포일자 = _fmt_date(부.get("공포일자", ""))
            부칙내용 = (부.get("부칙내용", "") or "").strip()
            if 공포일자:
                lines.append(f"### 부칙 ({공포일자})")
                lines.append("")
            if 부칙내용:
                lines.append(부칙내용)
                lines.append("")

    return "\n".join(lines)


def prec_to_md(prec_list: list, category: str, keywords: list) -> str:
    """판례 목록 JSON → Markdown 변환"""
    today = datetime.now().strftime("%Y-%m-%d")

    lines = [
        f"# {category} 관련 판례 모음",
        "",
        f"> **수집 키워드:** {', '.join(keywords)}  ",
        f"> **수집 건수:** {len(prec_list)}건  ",
        f"> **최종수집:** {today}  ",
        f"> **출처:** [국가법령정보센터 판례](https://www.law.go.kr)",
        "",
        "---",
        "",
    ]

    for i, p in enumerate(prec_list, 1):
        사건명   = p.get("사건명", "")
        사건번호  = p.get("사건번호", "")
        선고일자  = _fmt_date(p.get("선고일자", ""))
        법원명   = p.get("법원명", "")
        판결유형  = p.get("판결유형", "")
        판시사항  = (p.get("판시사항", "") or "").strip()
        판결요지  = (p.get("판결요지", "") or "").strip()
        참조조문  = (p.get("참조조문", "") or "").strip()
        참조판례  = (p.get("참조판례", "") or "").strip()

        lines.append(f"## {i}. {사건명}")
        lines.append("")
        lines.append(f"| 항목 | 내용 |")
        lines.append(f"|---|---|")
        lines.append(f"| 사건번호 | {사건번호} |")
        lines.append(f"| 선고일자 | {선고일자} |")
        lines.append(f"| 법원명 | {법원명} |")
        lines.append(f"| 판결유형 | {판결유형} |")
        lines.append("")

        if 판시사항:
            lines.append("**판시사항**")
            lines.append("")
            lines.append(판시사항)
            lines.append("")

        if 판결요지:
            lines.append("**판결요지**")
            lines.append("")
            lines.append(판결요지)
            lines.append("")

        if 참조조문:
            lines.append(f"**참조조문:** {참조조문}")
            lines.append("")

        if 참조판례:
            lines.append(f"**참조판례:** {참조판례}")
            lines.append("")

        lines.append("---")
        lines.append("")

    return "\n".join(lines)


def make_index_md(manifest: dict) -> str:
    """법령 인덱스 MD 생성"""
    today = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        "# TAXIST 법령자료 인덱스",
        "",
        f"> 마지막 업데이트: {today}",
        "",
        "국가법령정보센터 API를 통해 자동 수집된 세무행정 관련 법령 및 판례입니다.",
        "",
        "---",
        "",
    ]

    from config import TARGET_LAWS
    for folder, law_names in TARGET_LAWS.items():
        lines.append(f"## {folder}")
        lines.append("")
        for name in law_names:
            key = name
            info = manifest.get(key, {})
            시행일 = info.get("시행일자", "-")
            updated = info.get("last_updated", "-")
            status = "✅" if info.get("mst") else "⏳"
            lines.append(f"- {status} **{name}** — 시행일: {시행일} / 수집: {updated}")
        lines.append("")

    return "\n".join(lines)
