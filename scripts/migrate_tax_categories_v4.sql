-- ─────────────────────────────────────────────────────────────────
-- 담당 세목(tax_categories) 값을 구 영문 코드에서 새 한글 세목명으로 변환.
-- 배경: 가입/마이페이지가 예전엔 corporate_tax/vat/audit/collection/property_tax/
--       individual_tax 같은 영문 코드를 저장했는데, 검색 로직(functions/_lib/docs.js의
--       CATEGORY_MAP 등)은 한글 키(법인세/부가세/...)를 쓰고 있어 서로 매칭되지 않았다.
--       이번에 UI가 8개 한글 세목(법인세/소득세/부가세/원천세/종합부동산세/양도소득세/
--       상속세/증여세)으로 바뀌면서, 기존 가입자 데이터도 함께 변환해야 한다.
--
-- 매핑 (구 코드 → 신 세목, 1:1로 대응 안 되는 것은 가장 가까운 세목으로 치환):
--   corporate_tax   → 법인세        (그대로 대응)
--   vat             → 부가세        (그대로 대응)
--   property_tax    → 종합부동산세  (재산세 → 새 목록에 없어 종합부동산세로 대체)
--   individual_tax  → 소득세        (개인세 → 새 목록에 없어 소득세로 대체.
--                                    구 개인세는 docs.js에서 소득세/상속증여세 폴더를
--                                    함께 썼던 카테고리라 가장 가까운 단일 세목으로 정함)
--   audit           → 소득세        (조사 → 세목이 아닌 업무 구분이라 새 목록에 대응 항목이
--                                    없음. 임시로 소득세로 치환 — 필요시 회원에게 재선택 요청)
--   collection      → 소득세        (징세 → 위와 동일한 이유로 임시 치환)
--
-- ※ audit/collection은 세목이 아닌 업무 분류였어서 1:1 대응이 불가능하다.
--   이 매핑이 적절하지 않다면, 해당 회원들에게 마이페이지에서 담당 세목을
--   다시 선택해 달라고 안내하는 것을 권장한다.
--
-- 실행 방법: npx wrangler d1 execute taxist-db --remote --file=scripts/migrate_tax_categories_v4.sql
--   (로컬 개발 D1이면 --remote 생략)
-- 멱등성: REPLACE 대상 영문 코드가 이미 없으면 아무 일도 일어나지 않으므로 재실행해도 안전하다.
-- ─────────────────────────────────────────────────────────────────
UPDATE users SET tax_categories = REPLACE(
  REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(tax_categories, 'corporate_tax', '법인세'),
        'individual_tax', '소득세'),
      'property_tax', '종합부동산세'),
    'collection', '소득세'),
  'audit', '소득세'),
'vat', '부가세');
