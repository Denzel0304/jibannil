// ============================================================
// js/modal.js
// 자체 모달 + 달력. iPhone <input type="date"> 정책 우회 위해 직접 구현.
// 단일 선택 / 복수 선택 / 확인 / 알림 / 일반 컨텐츠 모드 지원.
//
// [핵심 수정] 단일 루트 → 모달 스택 구조로 변경.
//   기존: jbn_openModal() 호출 시 jbn_clear(root) 로 기존 내용 전부 삭제
//         → 부모 모달(할일 편집기)이 하위 모달(prompt/pickDate) 열릴 때 사라지는 버그
//   변경: 모달마다 새 overlay 를 body 에 append (스택 push)
//         닫을 때 가장 위 overlay 만 제거 (스택 pop)
//         → 부모 모달은 그대로 유지됨
//
//   추가: jbn_closeAllModals() — 저장/취소 시 전체 닫기용
//
// [history 스택 누적 수정]
//   jbn_openModal() 마다 history.pushState() 로 entry 를 쌓고,
//   프로그래매틱 닫기(closeModal/closeAllModals) 시 DOM 제거 + history.go(-n) 으로
//   entry 도 함께 정리.
//   admin.js 의 popstate 가 동시에 실행되는 부작용을 막기 위해
//   jbn_isProgrammaticClose 플래그를 export → admin.js 에서 체크.
// ============================================================

import {
  jbn_$, jbn_$$, jbn_el, jbn_clear, jbn_isoDate, jbn_parseIso, JBN_WEEKDAY_KO,
} from './util.js';

// 열린 모달 레이어 스택
const jbn_modalStack = [];

// 프로그래매틱 닫기 중임을 외부(admin.js)에 알리는 플래그
// admin.js 의 popstate 핸들러가 이 플래그를 확인해 불필요한 장소 닫기를 방지.
export let jbn_isProgrammaticClose = false;

export function jbn_hasOpenModal() { return jbn_modalStack.length > 0; }

// 뒤로가기: 모달이 있으면 닫기.
window.addEventListener('popstate', (e) => {
  // 프로그래매틱 닫기가 유발한 popstate 는 무시 (DOM은 이미 제거됨)
  if (jbn_isProgrammaticClose) return;

  if (jbn_modalStack.length > 0) {
    e.stopImmediatePropagation();
    const top = jbn_modalStack.pop();
    if (top) top.remove();
  }
});

// 가장 위 모달 1개만 닫기 (프로그래매틱)
export function jbn_closeModal() {
  const top = jbn_modalStack.pop();
  if (top) {
    top.remove();
    _historyBack(1);
  }
}

// 전체 닫기 (할일 저장/취소 등 부모 모달까지 모두 닫을 때)
export function jbn_closeAllModals() {
  const count = jbn_modalStack.length;
  while (jbn_modalStack.length) {
    const top = jbn_modalStack.pop();
    if (top) top.remove();
  }
  if (count > 0) _historyBack(count);
}

// history.go(-n) 래퍼.
// 플래그를 true 로 세팅해 modal.js / admin.js 양쪽 popstate 가 무시하게 함.
function _historyBack(n) {
  if (n <= 0) return;
  jbn_isProgrammaticClose = true;
  history.go(-n);
  // history.go() 는 비동기이므로 짧은 시간 후 플래그 해제
  setTimeout(() => { jbn_isProgrammaticClose = false; }, 200);
}

// 일반 컨텐츠 모달 — 호출마다 새 overlay 를 body 에 추가
export function jbn_openModal({ title, body, footer }) {
  // 뒤로가기로 이 모달을 닫을 수 있도록 history entry 추가.
  history.pushState({ jbnModal: true }, '');

  const overlay = jbn_el('div', { class: 'jbn-modal-root on' });
  const back = jbn_el('div', {
    class: 'jbn-modal-back',
    onclick: (e) => { if (e.target === back) jbn_closeModal(); },
  });
  const card = jbn_el('div', { class: 'jbn-modal-card' });

  if (title) card.appendChild(jbn_el('div', { class: 'jbn-modal-title' }, title));

  const bodyEl = jbn_el('div', { class: 'jbn-modal-body' });
  if (body instanceof Node) bodyEl.appendChild(body);
  else if (typeof body === 'string') bodyEl.textContent = body;
  card.appendChild(bodyEl);

  if (footer) {
    card.appendChild(
      jbn_el('div', { class: 'jbn-modal-foot' },
        ...(Array.isArray(footer) ? footer : [footer]))
    );
  }

  back.appendChild(card);
  overlay.appendChild(back);
  document.body.appendChild(overlay);
  jbn_modalStack.push(overlay);

  return { overlay, card, body: bodyEl, close: jbn_closeModal };
}

// 확인창 (예/아니오)
export function jbn_confirm(message, { yes = '확인', no = '취소' } = {}) {
  return new Promise(resolve => {
    const yesBtn = jbn_el('button', { class: 'jbn-btn jbn-btn-primary',
      onclick: () => { jbn_closeModal(); resolve(true); } }, yes);
    const noBtn = jbn_el('button', { class: 'jbn-btn',
      onclick: () => { jbn_closeModal(); resolve(false); } }, no);
    jbn_openModal({ body: message, footer: [noBtn, yesBtn] });
  });
}

// 알림창
export function jbn_alert(message, { ok = '확인' } = {}) {
  return new Promise(resolve => {
    const okBtn = jbn_el('button', { class: 'jbn-btn jbn-btn-primary',
      onclick: () => { jbn_closeModal(); resolve(); } }, ok);
    jbn_openModal({ body: message, footer: [okBtn] });
  });
}

// 입력창 (단일 텍스트)
export function jbn_prompt(label, defaultValue = '') {
  return new Promise(resolve => {
    const input = jbn_el('input', { type: 'text', class: 'jbn-input', value: defaultValue });
    const wrap = jbn_el('div', {});
    if (label) wrap.appendChild(jbn_el('label', { class: 'jbn-label' }, label));
    wrap.appendChild(input);
    const ok = jbn_el('button', { class: 'jbn-btn jbn-btn-primary',
      onclick: () => { const v = input.value.trim(); jbn_closeModal(); resolve(v || null); } }, '확인');
    const cancel = jbn_el('button', { class: 'jbn-btn',
      onclick: () => { jbn_closeModal(); resolve(null); } }, '취소');
    jbn_openModal({ body: wrap, footer: [cancel, ok] });
    setTimeout(() => input.focus(), 30);
  });
}

// ============================================================
// 달력
// mode: 'single' | 'multi'
// returns: 'YYYY-MM-DD' | string[] | null
// ============================================================
export function jbn_pickDate({
  mode = 'single',
  initial = jbn_isoDate(new Date()),
  selected = [],
  title = mode === 'multi' ? '날짜들 선택' : '날짜 선택',
  minDate = null,
} = {}) {
  return new Promise(resolve => {
    let viewDate = jbn_parseIso(typeof initial === 'string' ? initial : jbn_isoDate(new Date()));
    let pickedSet = new Set(selected);
    let pickedSingle = mode === 'single' ? (typeof initial === 'string' ? initial : null) : null;

    const wrap = jbn_el('div', { class: 'jbn-cal' });

    function rebuild() {
      jbn_clear(wrap);
      const head = jbn_el('div', { class: 'jbn-cal-head' });
      const prev = jbn_el('button', { class: 'jbn-cal-nav',
        onclick: () => { viewDate.setMonth(viewDate.getMonth() - 1); rebuild(); } }, '‹');
      const next = jbn_el('button', { class: 'jbn-cal-nav',
        onclick: () => { viewDate.setMonth(viewDate.getMonth() + 1); rebuild(); } }, '›');
      const label = jbn_el('div', { class: 'jbn-cal-label' },
        `${viewDate.getFullYear()}년 ${viewDate.getMonth() + 1}월`);
      head.append(prev, label, next);
      wrap.appendChild(head);

      const grid = jbn_el('div', { class: 'jbn-cal-grid' });
      for (const w of JBN_WEEKDAY_KO) grid.appendChild(jbn_el('div', { class: 'jbn-cal-wd' }, w));

      const firstDow = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1).getDay();
      const daysIn = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
      for (let i = 0; i < firstDow; i++) grid.appendChild(jbn_el('div', {}));
      for (let d = 1; d <= daysIn; d++) {
        const iso = jbn_isoDate(new Date(viewDate.getFullYear(), viewDate.getMonth(), d));
        const disabled = minDate && iso < minDate;
        const isSelected =
          (mode === 'multi' && pickedSet.has(iso)) ||
          (mode === 'single' && pickedSingle === iso);
        const cell = jbn_el('button', {
          class: 'jbn-cal-cell' + (isSelected ? ' on' : '') + (disabled ? ' off' : ''),
          disabled: disabled || false,
          onclick: () => {
            if (disabled) return;
            if (mode === 'multi') {
              if (pickedSet.has(iso)) pickedSet.delete(iso); else pickedSet.add(iso);
            } else {
              pickedSingle = iso;
            }
            rebuild();
          },
        }, String(d));
        grid.appendChild(cell);
      }
      wrap.appendChild(grid);
    }
    rebuild();

    const ok = jbn_el('button', { class: 'jbn-btn jbn-btn-primary',
      onclick: () => {
        jbn_closeModal();
        resolve(mode === 'multi' ? Array.from(pickedSet).sort() : pickedSingle);
      } }, '확인');
    const cancel = jbn_el('button', { class: 'jbn-btn',
      onclick: () => { jbn_closeModal(); resolve(null); } }, '취소');

    jbn_openModal({ title, body: wrap, footer: [cancel, ok] });
  });
}
