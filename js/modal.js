// ============================================================
// js/modal.js
// 자체 모달 + 달력. iPhone <input type="date"> 정책 우회 위해 직접 구현.
// 단일 선택 / 복수 선택 / 확인 / 알림 / 일반 컨텐츠 모드 지원.
//
// [스택 무한 누적 수정]
// 기존: jbn_openModal() 마다 history.pushState() → 프로그래매틱 닫기
//       (closeModal/closeAllModals) 시 DOM만 제거, history entry 는 남아 orphan 누적.
//
// 변경: 모달 1개당 pushState 1회 (동일). 단, 프로그래매틱으로 닫을 때는
//       닫는 모달 수만큼 history.go(-n) 으로 entry 를 함께 제거.
//       → 뒤로가기로 닫을 때: popstate 이벤트 → DOM 제거 (history entry는 자동 소비)
//       → 프로그래매틱으로 닫을 때: DOM 제거 + history.go(-n)
//
// 결과: history entry 가 항상 모달 스택과 1:1 대응 → 무한 누적 없음.
// ============================================================

import {
  jbn_$, jbn_$$, jbn_el, jbn_clear, jbn_isoDate, jbn_parseIso, JBN_WEEKDAY_KO,
} from './util.js';

// 열린 모달 레이어 스택
const jbn_modalStack = [];

// 프로그래매틱 닫기로 인해 history.go() 중인지 여부 (popstate 중복 방지)
let jbn_closingProgrammatically = false;

export function jbn_hasOpenModal() { return jbn_modalStack.length > 0; }

// 뒤로가기: 모달이 있으면 닫기.
window.addEventListener('popstate', (e) => {
  // 프로그래매틱 닫기가 유발한 popstate 는 무시 (이미 DOM은 제거됨)
  if (jbn_closingProgrammatically) return;

  if (jbn_modalStack.length > 0) {
    e.stopImmediatePropagation();
    const top = jbn_modalStack.pop();
    if (top) top.remove();
  }
});

// 가장 위 모달 1개만 닫기 (프로그래매틱)
// DOM 제거 + history entry 1칸 되돌리기
export function jbn_closeModal() {
  const top = jbn_modalStack.pop();
  if (top) {
    top.remove();
    _historyBack(1);
  }
}

// 전체 닫기 (할일 저장/취소 등 부모 모달까지 모두 닫을 때)
// DOM 전부 제거 + history entry n칸 되돌리기
export function jbn_closeAllModals() {
  const count = jbn_modalStack.length;
  while (jbn_modalStack.length) {
    const top = jbn_modalStack.pop();
    if (top) top.remove();
  }
  if (count > 0) _historyBack(count);
}

// history.go(-n) 래퍼: popstate 가 중복 실행되지 않도록 플래그 세팅
function _historyBack(n) {
  if (n <= 0) return;
  jbn_closingProgrammatically = true;
  history.go(-n);
  // history.go() 는 비동기이므로 짧은 시간 후 플래그 해제
  setTimeout(() => { jbn_closingProgrammatically = false; }, 200);
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
