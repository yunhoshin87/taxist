// 관리자 공통 유틸 — JWT 기반 실제 API 연동

function _decodeJWT(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
  } catch { return null; }
}

function getToken() {
  return localStorage.getItem('taxist_token');
}

function requireAdmin() {
  const token = getToken();
  if (!token) { window.location.href = 'index.html'; return; }
  const p = _decodeJWT(token);
  if (!p || p.role !== 'admin' || p.exp < Date.now() / 1000) {
    localStorage.removeItem('taxist_token');
    localStorage.removeItem('taxist_user');
    window.location.href = 'index.html';
  }
}

function logout() {
  localStorage.removeItem('taxist_token');
  localStorage.removeItem('taxist_user');
  localStorage.removeItem('adminAuth');
  localStorage.removeItem('adminName');
  window.location.href = 'index.html';
}

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
const STATUS_LABEL = { trial:'무료사용중', expired:'만료', suspended:'정지', active:'활성' };
const STATUS_COLOR = { trial:'green', expired:'orange', suspended:'red', active:'blue' };
const Q_STATUS_LABEL = { done:'답변완료', error:'오류', processing:'처리중', pending:'대기중' };
const Q_STATUS_COLOR = { done:'green', error:'red', processing:'orange', pending:'blue' };
