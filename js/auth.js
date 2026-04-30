// ============================================================
// js/auth.js
// Supabase 클라이언트 + JWT 자동 로그인/갱신.
//
// 핵심 설계:
//  - persistSession: true → 로그인 한 번 하면 그 기기에서 영구 유지.
//  - autoRefreshToken: true → SDK 가 알아서 access_token 갱신.
//    + 만료 임박 전(jwtRefreshLeadSeconds 초 전) 우리도 한 번 더 강제 점검.
//  - 동시 갱신 충돌 방지: localStorage refreshLock + 짧은 만료시간.
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { JBN_CONFIG } from './config.js';
import { JBN_KEYS, jbn_toast } from './util.js';

// 다른 Supabase 앱과 storageKey 충돌 안 나게 명시.
export const jbnSupa = createClient(
  JBN_CONFIG.supabaseUrl,
  JBN_CONFIG.supabaseAnonKey,
  {
    auth: {
      storage: window.localStorage,
      storageKey: JBN_KEYS.authStore,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    realtime: {
      params: { eventsPerSecond: 4 },
    },
  }
);

let jbn_currentSession = null;
let jbn_currentMember  = null;
const jbn_authListeners = new Set();

export function jbn_onAuthChange(fn) {
  jbn_authListeners.add(fn);
  return () => jbn_authListeners.delete(fn);
}
function jbn_emitAuth() {
  for (const fn of jbn_authListeners) {
    try { fn({ session: jbn_currentSession, member: jbn_currentMember }); } catch (e) { console.error(e); }
  }
}

export function jbn_session() { return jbn_currentSession; }
export function jbn_me()      { return jbn_currentMember; }

// ============================================================
// 시작 시 호출. 저장된 세션 복원, 멤버 정보 로드.
// ============================================================
export async function jbn_initAuth() {
  const { data: { session } } = await jbnSupa.auth.getSession();
  jbn_currentSession = session;

  jbnSupa.auth.onAuthStateChange((_evt, sess) => {
    jbn_currentSession = sess;
    if (!sess) {
      jbn_currentMember = null;
    }
    jbn_emitAuth();
  });

  if (session) {
    await jbn_loadMyMember();
    jbn_scheduleRefreshWatchdog();
  }
  jbn_emitAuth();
  return session;
}

// ============================================================
// 로그인 (이메일/비번)
// ============================================================
export async function jbn_login(email, password) {
  const { data, error } = await jbnSupa.auth.signInWithPassword({ email, password });
  if (error) throw error;
  jbn_currentSession = data.session;
  await jbn_loadMyMember();
  jbn_scheduleRefreshWatchdog();
  jbn_emitAuth();
  return data.session;
}

// ============================================================
// 내 멤버 레코드 (jibannil_members) 로드
// ============================================================
export async function jbn_loadMyMember() {
  if (!jbn_currentSession) { jbn_currentMember = null; return null; }
  const uid = jbn_currentSession.user.id;
  const { data, error } = await jbnSupa
    .from('jibannil_members')
    .select('*')
    .eq('id', uid)
    .maybeSingle();
  if (error) { console.error('member load', error); return null; }
  jbn_currentMember = data;
  return data;
}

// ============================================================
// JWT 만료 직전 자동 점검 (SDK autoRefresh 위에 한 겹 더)
// 만료 leadSeconds 초 전에 깨워서 getSession 호출 → 자동 갱신 트리거.
// ============================================================
let jbn_refreshTimer = null;

function jbn_scheduleRefreshWatchdog() {
  if (jbn_refreshTimer) clearTimeout(jbn_refreshTimer);
  if (!jbn_currentSession?.expires_at) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = jbn_currentSession.expires_at;
  const lead   = JBN_CONFIG.jwtRefreshLeadSeconds;
  // 만료 - lead 이 음수면 즉시
  const inMs = Math.max(1000, (expSec - lead - nowSec) * 1000);

  jbn_refreshTimer = setTimeout(async () => {
    if (!navigator.onLine) {
      // 오프라인 — 다시 30초 뒤 시도
      jbn_refreshTimer = setTimeout(jbn_scheduleRefreshWatchdog, 30000);
      return;
    }
    await jbn_safeRefresh();
    jbn_scheduleRefreshWatchdog();
  }, inMs);
}

// 동시 갱신 방지용 mutex (탭 여러개 / 리스너 중복 대비)
async function jbn_safeRefresh() {
  const lockKey = JBN_KEYS.refreshLock;
  const now = Date.now();
  const existing = Number(localStorage.getItem(lockKey) || 0);
  if (existing && (now - existing) < 8000) {
    // 다른 곳에서 8초 이내에 이미 갱신 시도중. 잠깐 기다렸다 세션만 다시 읽어옴.
    await new Promise(r => setTimeout(r, 1500));
    const { data: { session } } = await jbnSupa.auth.getSession();
    jbn_currentSession = session;
    return;
  }
  localStorage.setItem(lockKey, String(now));
  try {
    const { data, error } = await jbnSupa.auth.refreshSession();
    if (error) {
      console.warn('refresh failed', error.message);
      // 실패해도 세션이 살아있을 수 있으니 다시 읽기
      const { data: { session } } = await jbnSupa.auth.getSession();
      jbn_currentSession = session;
    } else {
      jbn_currentSession = data.session;
    }
  } finally {
    localStorage.removeItem(lockKey);
  }
}

// 외부에서 강제 갱신 필요할 때 (네트워크 복귀 직후 등)
export async function jbn_forceRefresh() { await jbn_safeRefresh(); }

// 온라인 복귀시 토큰 점검
window.addEventListener('online', () => {
  if (jbn_currentSession) {
    jbn_safeRefresh().then(() => jbn_scheduleRefreshWatchdog());
  }
});

// ============================================================
// 로그아웃 (세션 + localStorage 완전 삭제)
// 비번 'ss2412' 맞아야만 실행됨.
// ============================================================
const JBN_LOGOUT_PW = 'ss2412';

export async function jbn_logout(inputPw) {
  if (inputPw !== JBN_LOGOUT_PW) return false;
  // Supabase 세션 종료
  await jbnSupa.auth.signOut();
  // 우리 앱 관련 localStorage 키 전부 삭제
  Object.values(JBN_KEYS).forEach(k => localStorage.removeItem(k));
  // 혹시 남은 Supabase auth 키도 삭제
  Object.keys(localStorage)
    .filter(k => k.startsWith('sb-') || k.startsWith('supabase'))
    .forEach(k => localStorage.removeItem(k));
  jbn_currentSession = null;
  jbn_currentMember  = null;
  jbn_emitAuth();
  return true;
}
