// ============================================================================
// admin/_common.js — 관리자 페이지 전역 공통 유틸리티
// ============================================================================
// 모든 admin/*.html 페이지에서 <script src="_common.js">로 로드해 공용으로 쓴다.
// 역할은 크게 3가지:
//   1) JWT 디코딩 및 로그인 상태/권한 확인 (requireAdmin, logout)
//   2) 관리자 API 공통 호출 래퍼 (api()) — 인증 헤더 자동 첨부 + 에러 처리 통일
//   3) DB의 상태 코드값을 화면에 보여줄 한글 라벨/색상으로 매핑하는 상수
// 백엔드는 별도 인증 서버 없이 자체 발급 JWT(role 클레임 포함)를 사용하므로,
// 별도 JWT 라이브러리를 쓰지 않고 직접 base64url 디코딩만 한다(서버 서명 검증은
// 하지 않음 — 프론트는 만료/role만 확인하는 보조적 가드이고, 실제 인가는 서버가 담당).
// ============================================================================

// JWT의 payload(두번째 segment)만 디코딩한다. 서명 검증은 하지 않는다.
// 서버가 매 API 요청마다 토큰을 검증하므로, 여기서는 화면 표시/라우팅 판단용으로만 쓰면 충분하다.
function _decodeJWT(token) {
  try {
    // JWT는 base64url 인코딩이라 표준 base64(atob)가 쓰는 +/ 문자로 치환하고 패딩(=)을 보정해야 한다.
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
  } catch { return null; }
}

function getToken() {
  return localStorage.getItem('taxist_token');
}

// 각 관리자 페이지 로드 시 최상단에서 호출하는 가드.
// 토큰이 없거나, role이 admin이 아니거나, 만료(exp)되었으면 즉시 로그인 페이지로 쫓아낸다.
// 일반 회원이 admin URL을 직접 입력해 들어오는 것을 막는 1차 방어선(최종 방어는 서버 API의 role 체크).
function requireAdmin() {
  const token = getToken();
  if (!token) { window.location.href = 'index.html'; return; }
  const p = _decodeJWT(token);
  if (!p || p.role !== 'admin' || p.exp < Date.now() / 1000) {
    // 무효 토큰을 남겨두면 다음 로드 때도 같은 검사를 반복하게 되므로 미리 정리한다.
    localStorage.removeItem('taxist_token');
    localStorage.removeItem('taxist_user');
    window.location.href = 'index.html';
  }
}

// 로그아웃 시 인증 관련 localStorage 키를 전부 제거한다.
// adminAuth/adminName은 과거 버전에서 쓰던 키로, 잔존 데이터가 있을 수 있어 함께 정리한다.
function logout() {
  localStorage.removeItem('taxist_token');
  localStorage.removeItem('taxist_user');
  localStorage.removeItem('adminAuth');
  localStorage.removeItem('adminName');
  window.location.href = 'index.html';
}

// 관리자 페이지 전용 fetch 래퍼.
// 모든 /api/admin/* 호출이 Authorization 헤더(JWT)를 동일하게 필요로 하므로
// 매 호출마다 헤더를 직접 작성하지 않도록 여기서 공통 처리한다.
// 에러 응답(res.ok=false)은 throw로 변환해서 호출부가 try/catch 한 곳에서 처리할 수 있게 한다.
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + getToken(),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '요청 실패 (' + res.status + ')');
  return data;
}

// DB 상태값 → UI 레이블/색상 매핑
// 백엔드 DB는 영문 코드값(trial/expired/...)을 그대로 저장/반환하므로,
// 화면에 표시할 한글 라벨과 뱃지 색상을 페이지마다 따로 정의하지 않고 여기서 한 번만 정의해 재사용한다.
// 회원 상태(STATUS_*)와 질문 상태(Q_STATUS_*)는 의미가 다른 별도의 상태 체계이므로 분리되어 있다.
const STATUS_LABEL = { trial:'무료사용중', expired:'만료', suspended:'정지', active:'활성' };
const STATUS_COLOR = { trial:'green', expired:'orange', suspended:'red', active:'blue' };
const Q_STATUS_LABEL = { done:'답변완료', error:'오류', processing:'처리중', pending:'대기중' };
const Q_STATUS_COLOR = { done:'green', error:'red', processing:'orange', pending:'blue' };
