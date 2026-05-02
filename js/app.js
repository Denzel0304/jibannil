// ============================================================
// js/app.js
// 부팅 진입점.
//   1) auth 초기화 → 세션 있으면 메인, 없으면 로그인 화면
//   2) 로컬 스냅샷 즉시 페인트 → 백그라운드로 서버 fetch → realtime 시작
// ============================================================

import { jbn_initAuth, jbn_login, jbn_session, jbn_me, jbn_onAuthChange } from './auth.js';
import { jbn_loadSnapshot, jbn_fetchAll, jbn_onStateChange } from './store.js';
import { jbn_startRealtime } from './sync.js';
import { jbn_paint, jbn_setRoute, jbn_schedulePaint_exported as jbn_schedulePaint } from './render.js';
import { jbn_$, jbn_el, jbn_clear, jbn_toast } from './util.js';
import { jbn_unlockAudio } from './interactions.js';

// 내부에서 재렌더 트리거할 때 쓰는 커스텀 이벤트 (admin 등에서 발사)
document.addEventListener('jbn:rerender', () => jbn_schedulePaint());

// ============================================================
// 스플래시 제어
// ============================================================
let jbn_splashDone = false;

// 스플래시 → '시작하려면 터치하세요' 문구 표시
function jbn_splashShowTouch() {
  const el = document.getElementById('jbnSplashTouch');
  if (el) el.classList.add('show');
}

// 터치 후: 오디오 unlock → 스플래시 페이드아웃 → 실제 앱 표시
function jbn_splashDismiss() {
  if (jbn_splashDone) return;
  jbn_splashDone = true;

  jbn_unlockAudio(); // 사용자 인터랙션 컨텍스트에서 AudioContext 활성화

  const splash = document.getElementById('jbnSplash');
  if (splash) {
    splash.classList.add('hide');
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  }
}

// ============================================================
// 부트
// ============================================================
async function jbn_boot() {
  // history 루트 상태 확보 (뒤로가기 기준점)
  history.replaceState({ jbnRoot: true }, '');

  // 1) 캐시된 스냅샷 즉시 로드 (오프라인 첫 화면 띄우기용)
  jbn_loadSnapshot();

  // 2) 인증 초기화
  await jbn_initAuth();

  // 3) UI 진입 (스플래시 뒤에 미리 렌더 준비)
  jbn_routeByAuth();

  // 4) 인증 상태 바뀌면 다시 라우팅 (debounce: 토큰 갱신 중 일시적 null 무시)
  let jbn_authRouteTimer = null;
  jbn_onAuthChange(() => {
    clearTimeout(jbn_authRouteTimer);
    jbn_authRouteTimer = setTimeout(() => jbn_routeByAuth(), 300);
  });

  // 5) 로딩 완료 → 터치 문구 표시, 클릭하면 스플래시 닫기
  jbn_splashShowTouch();
  const splash = document.getElementById('jbnSplash');
  if (splash) {
    splash.addEventListener('click', jbn_splashDismiss, { once: true });
  }
}

// 이미 메인 화면이 떠 있으면 재진입하지 않음 (세션 일시 null → 화면 깜빡임 방지)
let jbn_mainRendered = false;

async function jbn_routeByAuth() {
  const sess = jbn_session();
  const me = jbn_me();
  const app = jbn_$('#jbnApp');
  if (!app) return;
  if (!sess) {
    // auth.js 에서 SIGNED_OUT 일 때만 여기 도달하므로 무조건 로그인 화면으로
    jbn_renderLogin();
    return;
  }
  if (sess && !me) {
    // 로그인은 했는데 jibannil_members 에 등록 안 된 사용자
    if (!jbn_mainRendered) jbn_renderUnregistered();
    return;
  }
  // 정상 진입 — 이미 메인이 떠있으면 shell 재생성 없이 데이터만 fetch
  if (!jbn_mainRendered) {
    jbn_renderMainShell();
    jbn_mainRendered = true;
    jbn_setRoute('today');
  }
  // 백그라운드로 서버 fetch + realtime
  if (navigator.onLine) {
    jbn_fetchAll().catch(e => console.warn(e));
  }
  jbn_startRealtime();
}

function jbn_renderMainShell() {
  const app = jbn_$('#jbnApp');
  jbn_clear(app);
  const main = jbn_el('main', { id: 'jbnMain' });
  app.appendChild(main);
}

function jbn_renderLogin() {
  jbn_mainRendered = false;   // 진짜 로그아웃 → 플래그 리셋
  const app = jbn_$('#jbnApp');
  jbn_clear(app);
  const wrap = jbn_el('div', { class: 'jbn-login' });
  wrap.appendChild(jbn_el('h1', {}, '지반일'));
  wrap.appendChild(jbn_el('div', { class: 'jbn-hint' },
    '우리 가족 집안일 기록. 첫 1회만 로그인하면 그 다음부턴 자동.'));

  const card = jbn_el('div', { class: 'jbn-login-card' });
  const email = jbn_el('input', { class: 'jbn-input', type: 'email', placeholder: '이메일',
    autocapitalize: 'off', autocomplete: 'email' });
  const pw = jbn_el('input', { class: 'jbn-input', type: 'password', placeholder: '비밀번호',
    autocomplete: 'current-password' });
  const errBox = jbn_el('div', { class: 'jbn-hint', style: 'color:#E04F4F;display:none' });
  const loginBtn = jbn_el('button', {
    class: 'jbn-btn jbn-btn-primary',
    onclick: async () => {
      errBox.style.display = 'none';
      loginBtn.disabled = true;
      loginBtn.textContent = '로그인 중…';
      try {
        await jbn_login(email.value.trim(), pw.value);
      } catch (e) {
        errBox.style.display = 'block';
        errBox.textContent = '로그인 실패: ' + (e?.message || '확인 필요');
        loginBtn.disabled = false;
        loginBtn.textContent = '로그인';
      }
    },
  }, '로그인');

  // Enter 로 제출
  for (const inp of [email, pw]) {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginBtn.click(); });
  }

  card.append(email, pw, errBox, loginBtn);
  wrap.appendChild(card);

  const app2 = jbn_$('#jbnApp');
  app2.appendChild(wrap);
}

function jbn_renderUnregistered() {
  const app = jbn_$('#jbnApp');
  jbn_clear(app);
  const wrap = jbn_el('div', { class: 'jbn-login' });
  wrap.appendChild(jbn_el('h1', {}, '지반일'));
  wrap.appendChild(jbn_el('div', { class: 'jbn-hint' },
    '로그인은 됐지만, 가족 구성원 등록이 필요합니다. 최고관리자에게 알려주세요.'));
  app.appendChild(wrap);
}

// 시작
jbn_boot().catch(err => {
  console.error(err);
  // 오류 시 스플래시 즉시 제거 후 에러 표시
  const splash = document.getElementById('jbnSplash');
  if (splash) splash.remove();
  const app = jbn_$('#jbnApp');
  if (app) {
    jbn_clear(app);
    const wrap = jbn_el('div', { class: 'jbn-login' });
    wrap.appendChild(jbn_el('h1', {}, '지반일'));
    wrap.appendChild(jbn_el('div', { class: 'jbn-hint',
      style: 'color:#E04F4F' },
      '초기화 실패. config.js 의 supabaseUrl / supabaseAnonKey 가 올바른지 확인해주세요.'));
    app.appendChild(wrap);
  }
});
