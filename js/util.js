// ============================================================
// js/util.js
// 공용 유틸 — 날짜, DOM, localStorage 키 네임스페이스.
// 키 이름은 다른 앱과 절대 안 겹치게 의도적으로 독특한 prefix 사용.
// ============================================================

import { JBN_CONFIG } from './config.js';

// --- localStorage / sessionStorage 키 네임스페이스 ----------
// 다른 프로그램에서 흔히 쓰는 'su_session','app_token' 같은 이름 회피.
export const JBN_KEYS = Object.freeze({
  authStore:     'jbnl_anchor_q7m3k_v1',   // Supabase auth persist key
  syncQueue:     'jbnl_pending_ops_h4r8',  // 오프라인 동기화 대기열
  snapshot:      'jbnl_snapshot_n6p2',     // 마지막 서버 스냅샷
  refreshLock:   'jbnl_refresh_mutex_w3y5',// 토큰 갱신 락
  uiPrefs:       'jbnl_ui_prefs_x4e9',     // 마지막 본 화면 등
});

// --- 날짜: "오늘"이란? ----------
// 새벽 dayStartHour 시 이전은 어제로 친다.
// returns YYYY-MM-DD
export function jbn_logicalToday(now = new Date()) {
  const cutoff = JBN_CONFIG.dayStartHour;
  const d = new Date(now);
  if (d.getHours() < cutoff) {
    d.setDate(d.getDate() - 1);
  }
  return jbn_isoDate(d);
}

export function jbn_isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function jbn_parseIso(s) {
  // 'YYYY-MM-DD' → Date(local)
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function jbn_addDays(iso, n) {
  const d = jbn_parseIso(iso);
  d.setDate(d.getDate() + n);
  return jbn_isoDate(d);
}

export function jbn_diffDays(isoA, isoB) {
  const ms = jbn_parseIso(isoA) - jbn_parseIso(isoB);
  return Math.round(ms / 86400000);
}

// 0=일 ~ 6=토
export function jbn_weekday(iso) {
  return jbn_parseIso(iso).getDay();
}

// 한국식 요일 이름
export const JBN_WEEKDAY_KO = ['일','월','화','수','목','금','토'];

// 시간 포맷 HH:MM
export function jbn_fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// 년월일 + 시간 (완료 시각 표시용)
export function jbn_fmtDateTime(ts) {
  const d = new Date(ts);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${m}/${day} ${hh}:${mm}`;
}

// --- DOM ----------
export function jbn_$(sel, root = document) { return root.querySelector(sel); }
export function jbn_$$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

export function jbn_el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

export function jbn_clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// --- ID 생성 (uuid v4 ish; 충돌나도 서버가 거절하면 큐에서 처리) ---
export function jbn_uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  // fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// --- 작은 토스트 ---
let jbn_toastTimer = null;
export function jbn_toast(msg, ms = 1800) {
  let host = jbn_$('#jbnToast');
  if (!host) {
    host = jbn_el('div', { id: 'jbnToast', class: 'jbn-toast' });
    document.body.appendChild(host);
  }
  host.textContent = msg;
  host.classList.add('on');
  clearTimeout(jbn_toastTimer);
  jbn_toastTimer = setTimeout(() => host.classList.remove('on'), ms);
}

// 디바운스
export function jbn_debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
