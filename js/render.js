// ============================================================
// js/render.js
// 메인 화면(오늘 / 통계) 렌더링.
// 관리(super) 화면은 admin.js 에서.
// ============================================================

import { jbnState, jbn_onStateChange } from './store.js';
import { jbn_me, jbn_logout } from './auth.js';
import { jbn_renderAdmin } from './admin.js';
import {
  jbn_buildTodayList, jbn_personDailyProgress,
  jbn_taskUnitProgress, jbn_overdueByMember, jbn_periodStats,
} from './stats.js';
import {
  jbn_markComplete, jbn_unmarkComplete, jbn_postponeTask,
} from './sync.js';
import {
  jbn_$, jbn_$$, jbn_el, jbn_clear, jbn_logicalToday, jbn_isoDate,
  jbn_addDays, jbn_fmtTime, jbn_fmtDateTime, jbn_parseIso, jbn_diffDays, JBN_WEEKDAY_KO, jbn_toast,
} from './util.js';
import { jbn_attachSwipe, jbn_dragLockState, jbn_playCompleteSound } from './interactions.js';
import { jbn_recurrenceLabel } from './recurrence.js';
import { jbn_pickDate, jbn_openModal, jbn_closeModal, jbn_alert, jbn_confirm } from './modal.js';

let jbn_lastRoute = 'today';

export function jbn_schedulePaint_exported() { jbn_schedulePaint(); }
export function jbn_setRoute(name) { jbn_lastRoute = name; jbn_schedulePaint(); }
export function jbn_currentRoute() { return jbn_lastRoute; }

let jbn_celebratedDate = null;

// ── paint 디바운스 ──────────────────────────────────────────
// store.js 의 jbn_emitChange 가 RAF 로 한 번 묶지만,
// Realtime echo N개가 연속으로 와서 RAF 를 여러 번 통과하는 경우를 막기 위해
// render 레벨에서 한 번 더 16ms(1프레임) 디바운스를 건다.
let jbn_paintPending = false;
function jbn_schedulePaint() {
  if (jbn_paintPending) return;
  jbn_paintPending = true;
  requestAnimationFrame(() => {
    jbn_paintPending = false;
    jbn_paint();
  });
}

jbn_onStateChange((reason) => {
  if (jbn_dragLockState.locked) {
    // 드래그 중 — 락 해제 후(60ms) paint 가 이미 예약되므로 여기선 무시
    return;
  }
  jbn_schedulePaint();
});

export function jbn_paint() {
  const me = jbn_me();
  if (!me) return;
  const main = jbn_$('#jbnMain');
  if (!main) return;

  // ── tabbar 는 건드리지 않고 컨텐츠만 교체 ──────────────────
  // tabbar 가 매번 재생성되면 버튼 포커스/ripple 이 끊겨 번쩍임이 생김
  let tabbar = main.querySelector('.jbn-tabbar');
  let contentWrap = main.querySelector('#jbnContent');

  if (!tabbar) {
    // 최초 렌더 또는 shell 재생성 후
    jbn_clear(main);
    tabbar = jbn_renderTopBar(me);
    main.appendChild(tabbar);
    contentWrap = jbn_el('div', { id: 'jbnContent' });
    main.appendChild(contentWrap);
  } else {
    // tabbar 탭 active 상태만 갱신 (DOM 재생성 없이)
    main.querySelectorAll('.jbn-tab').forEach(btn => {
      const id = btn.dataset.route;
      if (id) btn.classList.toggle('on', id === jbn_lastRoute);
    });
    jbn_clear(contentWrap);
  }

  if (jbn_lastRoute === 'today')        contentWrap.appendChild(jbn_renderToday(me));
  else if (jbn_lastRoute === 'stats')   contentWrap.appendChild(jbn_renderStats(me));
  else if (jbn_lastRoute === 'admin' && me.is_super) {
    const node = jbn_renderAdmin(me);
    if (node) contentWrap.appendChild(node);
  }
}

function jbn_renderTopBar(me) {
  const bar = jbn_el('div', { class: 'jbn-tabbar' });
  const tabs = [
    { id: 'today', label: '오늘' },
    { id: 'stats', label: '통계' },
  ];
  if (me.is_super) tabs.push({ id: 'admin', label: '관리' });
  for (const t of tabs) {
    bar.appendChild(jbn_el('button', {
      class: 'jbn-tab' + (jbn_lastRoute === t.id ? ' on' : ''),
      dataset: { route: t.id },
      onclick: () => jbn_setRoute(t.id),
    }, t.label));
  }
  // 로그아웃 버튼 — 비번(ss2412) 맞아야만 실행
  const logoutBtn = jbn_el('button', {
    class: 'jbn-tab-logout',
    title: '로그아웃',
    onclick: async () => {
      const pw = await jbn_promptLogout();
      if (!pw) return;
      const ok = await jbn_logout(pw);
      if (!ok) jbn_toast('비번이 틀렸어요');
    },
  });
  // CSS로 그린 문+화살표 아이콘 (구형 PC 호환)
  logoutBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <polyline points="16 17 21 12 16 7"/>
    <line x1="21" y1="12" x2="9" y2="12"/>
  </svg>`;
  bar.appendChild(logoutBtn);
  return bar;
}

// 로그아웃용 비번 입력창 (modal.js 의존 없이 간단 inline)
function jbn_promptLogout() {
  return new Promise(resolve => {
    const overlay = jbn_el('div', { class: 'jbn-modal-root on' });
    const back    = jbn_el('div', { class: 'jbn-modal-back' });
    const card    = jbn_el('div', { class: 'jbn-modal-card' });
    const title   = jbn_el('div', { class: 'jbn-modal-title' }, '로그아웃');
    const inp     = jbn_el('input', {
      class: 'jbn-input', type: 'password', placeholder: '비밀번호 입력',
      autocomplete: 'off',
    });
    const foot = jbn_el('div', { class: 'jbn-modal-foot' });
    const cancel = jbn_el('button', { class: 'jbn-btn', onclick: () => { overlay.remove(); resolve(null); } }, '취소');
    const ok     = jbn_el('button', { class: 'jbn-btn jbn-btn-primary', onclick: () => { overlay.remove(); resolve(inp.value); } }, '확인');
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { overlay.remove(); resolve(inp.value); } });
    foot.append(cancel, ok);
    card.append(title, inp, foot);
    back.appendChild(card);
    back.addEventListener('click', e => { if (e.target === back) { overlay.remove(); resolve(null); } });
    overlay.appendChild(back);
    document.body.appendChild(overlay);
    setTimeout(() => inp.focus(), 30);
  });
}

// ============================================================
// 오늘 화면
// ============================================================
function jbn_renderToday(me) {
  const todayIso = jbn_logicalToday();
  const list = jbn_buildTodayList(me.id, todayIso);
  const wrap = jbn_el('section', { class: 'jbn-page' });

  // 고정 헤더 (스크롤해도 안 움직임)
  const today = new Date();
  const wd = today.getDay(); // 0=일, 6=토
  const dateColorClass = wd === 0 ? ' jbn-date-sun' : wd === 6 ? ' jbn-date-sat' : '';
  const hdr = jbn_el('div', { class: 'jbn-greet-fixed' });
  const hello = jbn_el('div', { class: 'jbn-hello' }, `${me.display_name}의 오늘`);
  const dateLabel = jbn_el('div', { class: 'jbn-date' + dateColorClass },
    `${today.getFullYear()}년 ${today.getMonth()+1}월 ${today.getDate()}일 ${JBN_WEEKDAY_KO[today.getDay()]}요일`);
  hdr.append(hello, dateLabel);
  wrap.appendChild(hdr);

  // 진행 바
  const { total, done, ratio } = jbn_personDailyProgress(me.id, todayIso);
  const bar = jbn_el('div', { class: 'jbn-progress' });
  const fill = jbn_el('div', { class: 'jbn-progress-fill' });
  fill.style.width = (ratio * 100).toFixed(1) + '%';
  bar.appendChild(fill);
  bar.appendChild(jbn_el('div', { class: 'jbn-progress-text' },
    total ? `${done} / ${total} (${Math.round(ratio*100)}%)` : ''));
  wrap.appendChild(bar);

  // 100% 축하
  if (total > 0 && done === total && jbn_celebratedDate !== todayIso) {
    jbn_celebratedDate = todayIso;
    setTimeout(() => {
      jbn_alert(`🎉 ${me.display_name}, 오늘 할 일을 모두 마쳤어요! 100% 완료!`);
    }, 400);
  } else if (done < total) {
    // 같은 날 다시 미완료가 되면 축하 다시 보일 수 있게 reset
    if (jbn_celebratedDate === todayIso) jbn_celebratedDate = null;
  }

  // 리스트
  const listEl = jbn_el('div', { class: 'jbn-task-list' });

  // 오늘/밀린 항목과 미래 미룬 항목 분리
  const todayItems   = list.filter(x => x.kind !== 'postponed_future');
  const futureItems  = list.filter(x => x.kind === 'postponed_future');

  if (!todayItems.length && !futureItems.length) {
    listEl.appendChild(jbn_el('div', { class: 'jbn-empty' }, '쉬어가는 날이에요 ☕'));
  } else {
    // 섹션 구분선 생성 헬퍼
    function makeDivider(label, color) {
      const d = jbn_el('div', {
        style: [
          'display:flex; align-items:center; gap:8px;',
          'margin:16px 0 8px;',
          'font-size:12px; font-weight:700;',
          `color:${color};`,
          'letter-spacing:.3px;',
        ].join(''),
      });
      const line = jbn_el('div', { style: `flex:1; height:1px; background:${color}; opacity:.3` });
      d.append(jbn_el('span', {}, label), line);
      return d;
    }

    const overdueItems = todayItems.filter(x => x.kind === 'overdue');
    const todayOnlyItems = todayItems.filter(x => x.kind !== 'overdue');

    // 밀린 일 섹션
    if (overdueItems.length) {
      listEl.appendChild(makeDivider(`⚠ 밀린 일 (${overdueItems.length}건)`, 'var(--jbn-warn)'));
      for (const item of overdueItems) listEl.appendChild(jbn_renderTaskRow(me, item, todayIso));
    }

    // 오늘 일 섹션
    if (todayOnlyItems.length) {
      listEl.appendChild(makeDivider(`✓ 오늘 일 (${todayOnlyItems.length}건)`, 'var(--jbn-primary-d)'));
      for (const item of todayOnlyItems) listEl.appendChild(jbn_renderTaskRow(me, item, todayIso));
    }

    // 미룬 일 — 날짜별 섹션
    if (futureItems.length) {
      const byDate = {};
      for (const item of futureItems) {
        const d = item.displayDate;
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push(item);
      }
      for (const dateIso of Object.keys(byDate).sort()) {
        const dp = jbn_parseIso(dateIso);
        const dateLabel = `📅 ${dp.getFullYear()}년 ${dp.getMonth()+1}월 ${dp.getDate()}일 ${JBN_WEEKDAY_KO[dp.getDay()]}요일 (미룬 날짜)`;
        listEl.appendChild(makeDivider(dateLabel, '#C07020'));
        for (const item of byDate[dateIso]) listEl.appendChild(jbn_renderTaskRow(me, item, todayIso));
      }
    }
  }
  wrap.appendChild(listEl);
  return wrap;
}

function jbn_renderTaskRow(me, item, todayIso) {
  const { task, occurrenceDate, displayDate, kind } = item;
  const loc = jbnState.locations.find(l => l.id === task.location_id);
  const cls = jbnState.checklist
    .filter(c => c.task_id === task.id)
    .sort((a,b) => a.sort_order - b.sort_order);
  const ratio = jbn_taskUnitProgress(task, me.id, occurrenceDate);
  const fullyDone = ratio >= 1;

  const row = jbn_el('div', {
    class: 'jbn-task' +
      (fullyDone ? ' done' : '') +
      (kind === 'overdue' ? ' overdue' : '') +
      (kind === 'postponed_in' ? ' postin' : '') +
      (kind === 'postponed_future' ? ' postin' : ''),
    dataset: { dragId: task.id },
  });

  // 좌측: 별표 영역(완료 인디케이터)
  const star = jbn_el('div', { class: 'jbn-star' }, fullyDone ? '★' : '☆');

  // 본문
  const body = jbn_el('div', { class: 'jbn-task-body' });
  const titleLine = jbn_el('div', { class: 'jbn-task-title' }, task.title);
  const sub = jbn_el('div', { class: 'jbn-task-sub' });
  if (loc) sub.appendChild(jbn_el('span', { class: 'jbn-chip' }, loc.name));
  sub.appendChild(jbn_el('span', { class: 'jbn-chip ghost' }, jbn_recurrenceLabel(task)));
  if (kind === 'overdue') {
    const day = jbn_diffDays(todayIso, occurrenceDate);
    sub.appendChild(jbn_el('span', { class: 'jbn-chip warn' }, `${day}일 밀림`));
  }
  if (kind === 'postponed_in') {
    sub.appendChild(jbn_el('span', { class: 'jbn-chip soft' }, '미룬 일'));
  }
  if (kind === 'postponed_future') {
    // displayDate = postponed_to (미래 날짜)
    sub.appendChild(jbn_el('span', { class: 'jbn-chip soft' }, `미룬 날짜: ${displayDate}`));
  }
  body.append(titleLine, sub);

  // 체크리스트 (있으면)
  if (cls.length) {
    const subWrap = jbn_el('div', { class: 'jbn-checks' });
    for (const c of cls) {
      const isDone = !!jbnState.completions.find(co =>
        co.task_id === task.id && co.checklist_id === c.id &&
        co.member_id === me.id && co.target_date === occurrenceDate);
      const ckRow = jbn_el('div', {
        class: 'jbn-check' + (isDone ? ' on' : ''),
        onclick: () => {
          if (isDone) jbn_unmarkComplete(task.id, c.id, occurrenceDate);
          else { jbn_markComplete(task.id, c.id, occurrenceDate); jbn_playCompleteSound(); }
        },
      });
      ckRow.appendChild(jbn_el('span', { class: 'jbn-check-mark' }, isDone ? '★' : '○'));
      ckRow.appendChild(jbn_el('span', { class: 'jbn-check-title' }, c.title));
      if (isDone) {
        const co = jbnState.completions.find(co =>
          co.task_id === task.id && co.checklist_id === c.id &&
          co.member_id === me.id && co.target_date === occurrenceDate);
        if (co) ckRow.appendChild(jbn_el('span', { class: 'jbn-check-time' }, jbn_fmtDateTime(co.completed_at)));
      }
      subWrap.appendChild(ckRow);
    }
    body.appendChild(subWrap);
  } else if (fullyDone) {
    const co = jbnState.completions.find(co =>
      co.task_id === task.id && !co.checklist_id &&
      co.member_id === me.id && co.target_date === occurrenceDate);
    if (co) body.appendChild(jbn_el('div', { class: 'jbn-time' }, '완료 ' + jbn_fmtDateTime(co.completed_at)));
  }

  // 점3개 버튼 — PC에서 미루기 팝업 트리거 (스와이프 우→좌 대체)
  // 완료 상태면 비활성(흐리게), 미완료일 때만 클릭 가능
  const moreBtn = jbn_el('button', {
    class: 'jbn-icon-btn',
    title: '미루기',
    style: fullyDone ? 'opacity:.25; cursor:default; flex:none' : 'flex:none',
    onclick: (e) => {
      e.stopPropagation();
      if (fullyDone) return;
      jbn_openPostponeMenu(task, occurrenceDate, todayIso);
    },
  }, '⋮');
  row.append(star, body, moreBtn);

  // 스와이프 규칙:
  //   좌→우: 체크리스트 없음+미완료 → 완료 처리 / 나머지 모두 무반응
  //   우→좌: 체크리스트 있음+미완료 OR 체크리스트 없음+미완료 → 미루기 팝업 / 완료 상태면 무반응
  jbn_attachSwipe(row, {
    onSwipeRight: () => {
      if (cls.length) return;   // 체크리스트 있으면 무반응 (개별 클릭으로만 완료)
      if (fullyDone) return;    // 이미 완료면 무반응
      jbn_markComplete(task.id, null, occurrenceDate);
      jbn_playCompleteSound();
    },
    onSwipeLeft: () => {
      if (fullyDone) return;    // 완료 상태면 무반응
      jbn_openPostponeMenu(task, occurrenceDate, todayIso);
    },
  });

  // 단일 클릭 (체크리스트 없을 때만) — body 클릭 또는 별표 클릭
  if (!cls.length) {
    const toggleDone = () => {
      if (fullyDone) jbn_unmarkComplete(task.id, null, occurrenceDate);
      else { jbn_markComplete(task.id, null, occurrenceDate); jbn_playCompleteSound(); }
    };
    body.addEventListener('click', toggleDone);
    star.addEventListener('click', toggleDone);
  }
  return row;
}

function jbn_openPostponeMenu(task, occurrenceDate, todayIso) {
  const wrap = jbn_el('div', { class: 'jbn-menu' });
  const opt = jbn_el('button', { class: 'jbn-menu-item', onclick: async () => {
    jbn_closeModal();
    const picked = await jbn_pickDate({
      mode: 'single',
      initial: jbn_addDays(todayIso, 1),
      minDate: jbn_addDays(todayIso, 1),
      title: '미룰 날짜 선택',
    });
    if (picked) {
      jbn_postponeTask(task.id, occurrenceDate, picked);
      jbn_toast(`${picked} 로 미뤘어요`);
    }
  } }, '날짜 선택');
  wrap.append(opt);
  jbn_openModal({ title: `"${task.title}" 미루기`, body: wrap });
}

// ============================================================
// 통계 화면
// ============================================================
function jbn_renderStats(me) {
  const todayIso = jbn_logicalToday();
  const wrap = jbn_el('section', { class: 'jbn-page' });
  const statsHeader = jbn_el('h2', { class: 'jbn-h2', style: 'display:flex;align-items:center;justify-content:center;gap:6px;text-align:center' });
  statsHeader.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>';
  statsHeader.appendChild(document.createTextNode('통계'));
  wrap.appendChild(statsHeader);

  // 오늘 — 전체 구성원
  const todayCard = jbn_el('div', { class: 'jbn-card' });
  todayCard.appendChild(jbn_el('div', { class: 'jbn-card-title' }, '오늘 진행률'));
  const memSorted = [...jbnState.members].sort((a,b) => a.member_order - b.member_order);
  for (const m of memSorted) {
    const { total, done, ratio } = jbn_personDailyProgress(m.id, todayIso);
    const row = jbn_el('div', { class: 'jbn-stat-row' });
    row.appendChild(jbn_el('div', { class: 'jbn-stat-name' }, m.display_name));
    const barOuter = jbn_el('div', { class: 'jbn-bar' });
    const barInner = jbn_el('div', { class: 'jbn-bar-fill' });
    barInner.style.width = (ratio * 100).toFixed(1) + '%';
    barInner.style.background = m.accent_color || '#7BC47F';
    barOuter.appendChild(barInner);
    row.appendChild(barOuter);
    row.appendChild(jbn_el('div', { class: 'jbn-stat-val' },
      total ? `${done}/${total} (${Math.round(ratio*100)}%)` : '—'));
    todayCard.appendChild(row);
  }
  wrap.appendChild(todayCard);

  // 주간 / 월간
  const weekFrom  = jbn_addDays(todayIso, -6);
  const monthFrom = jbn_addDays(todayIso, -29);
  for (const [label, from] of [['최근 7일', weekFrom], ['최근 30일', monthFrom]]) {
    const card = jbn_el('div', { class: 'jbn-card' });
    card.appendChild(jbn_el('div', { class: 'jbn-card-title' }, label));
    for (const m of memSorted) {
      const ps = jbn_periodStats(m.id, from, todayIso);
      const row = jbn_el('div', { class: 'jbn-stat-row' });
      row.appendChild(jbn_el('div', { class: 'jbn-stat-name' }, m.display_name));
      const barOuter = jbn_el('div', { class: 'jbn-bar' });
      const barInner = jbn_el('div', { class: 'jbn-bar-fill' });
      barInner.style.width = (ps.ratio * 100).toFixed(1) + '%';
      barInner.style.background = m.accent_color || '#7BC47F';
      barOuter.appendChild(barInner);
      row.appendChild(barOuter);
      row.appendChild(jbn_el('div', { class: 'jbn-stat-val' },
        ps.totalSlots ? `${ps.doneSlots}/${ps.totalSlots} (${Math.round(ps.ratio*100)}%)` : '—'));
      card.appendChild(row);
    }
    wrap.appendChild(card);
  }

  // 미완료 누적 (사람별 + 항목별 상세)
  const overdueCard = jbn_el('div', { class: 'jbn-card' });
  overdueCard.appendChild(jbn_el('div', { class: 'jbn-card-title' }, '미완료 누적'));
  const map = jbn_overdueByMember(todayIso);
  for (const m of memSorted) {
    const items = map[m.id] || [];
    const doneCnt = items.filter(it => {
      const slots = jbnState.checklist.filter(c => c.task_id === it.task.id);
      if (slots.length) return slots.every(c => jbnState.completions.some(co =>
        co.task_id === it.task.id && co.checklist_id === c.id &&
        co.member_id === m.id && co.target_date === it.occurrenceDate));
      return jbnState.completions.some(co =>
        co.task_id === it.task.id && !co.checklist_id &&
        co.member_id === m.id && co.target_date === it.occurrenceDate);
    }).length;
    const sec = jbn_el('div', { class: 'jbn-overdue-sec' });
    sec.appendChild(jbn_el('div', { class: 'jbn-overdue-name' },
      `${m.display_name} — ${items.length}건` + (doneCnt ? ` (${doneCnt}건 완료됨)` : '')));
    if (items.length === 0) {
      sec.appendChild(jbn_el('div', { class: 'jbn-overdue-empty' }, '깔끔! 👍'));
    } else {
      for (const it of items) {
        const loc = jbnState.locations.find(l => l.id === it.task.location_id);
        const days = jbn_diffDays(todayIso, it.occurrenceDate);
        // 완료 여부 체크
        const slots = jbnState.checklist.filter(c => c.task_id === it.task.id);
        const isDone = slots.length
          ? slots.every(c => jbnState.completions.some(co =>
              co.task_id === it.task.id && co.checklist_id === c.id &&
              co.member_id === m.id && co.target_date === it.occurrenceDate))
          : jbnState.completions.some(co =>
              co.task_id === it.task.id && !co.checklist_id &&
              co.member_id === m.id && co.target_date === it.occurrenceDate);
        const item = jbn_el('div', { class: 'jbn-overdue-item' });
        item.appendChild(jbn_el('span', { class: isDone ? 'jbn-chip' : 'jbn-chip warn' },
          isDone ? '★ 완료' : `${days}일`));
        const titleEl = jbn_el('span', { class: 'jbn-overdue-title' },
          `${loc ? loc.name + ' · ' : ''}${it.task.title}`);
        if (isDone) titleEl.style.cssText = 'text-decoration:line-through; color:var(--jbn-muted)';
        item.appendChild(titleEl);
        item.appendChild(jbn_el('span', { class: 'jbn-overdue-date' }, it.occurrenceDate));
        sec.appendChild(item);
      }
    }
    overdueCard.appendChild(sec);
  }
  wrap.appendChild(overdueCard);
  return wrap;
}
