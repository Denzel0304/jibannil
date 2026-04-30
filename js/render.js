// ============================================================
// js/render.js
// 메인 화면(오늘 / 통계) 렌더링.
// 관리(super) 화면은 admin.js 에서.
// ============================================================

import { jbnState, jbn_onStateChange } from './store.js';
import { jbn_me, jbn_logout } from './auth.js';
import {
  jbn_buildTodayList, jbn_personDailyProgress,
  jbn_taskUnitProgress, jbn_overdueByMember, jbn_periodStats,
} from './stats.js';
import {
  jbn_markComplete, jbn_unmarkComplete, jbn_postponeTask,
} from './sync.js';
import {
  jbn_$, jbn_$$, jbn_el, jbn_clear, jbn_logicalToday, jbn_isoDate,
  jbn_addDays, jbn_fmtTime, jbn_parseIso, jbn_diffDays, JBN_WEEKDAY_KO, jbn_toast,
} from './util.js';
import { jbn_attachSwipe, jbn_dragLockState, jbn_playCompleteSound } from './interactions.js';
import { jbn_recurrenceLabel } from './recurrence.js';
import { jbn_pickDate, jbn_openModal, jbn_closeModal, jbn_alert, jbn_confirm } from './modal.js';

let jbn_lastRoute = 'today';

export function jbn_setRoute(name) { jbn_lastRoute = name; jbn_paint(); }
export function jbn_currentRoute() { return jbn_lastRoute; }

let jbn_celebratedDate = null;

// 변경시 자동 재렌더 (드래그 중엔 미룸)
jbn_onStateChange(() => {
  if (jbn_dragLockState.locked) {
    setTimeout(jbn_paint, 80);
    return;
  }
  jbn_paint();
});

export function jbn_paint() {
  const me = jbn_me();
  if (!me) return;
  const main = jbn_$('#jbnMain');
  if (!main) return;
  jbn_clear(main);

  // 헤더 탭
  main.appendChild(jbn_renderTopBar(me));

  if (jbn_lastRoute === 'today')   main.appendChild(jbn_renderToday(me));
  else if (jbn_lastRoute === 'stats')   main.appendChild(jbn_renderStats(me));
  // admin 은 admin.js 의 jbn_renderAdmin 이 호출됨
  else if (jbn_lastRoute === 'admin' && me.is_super) {
    import('./admin.js').then(mod => {
      const node = mod.jbn_renderAdmin(me);
      if (node) main.appendChild(node);
    });
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
  if (!list.length) {
    listEl.appendChild(jbn_el('div', { class: 'jbn-empty' }, '쉬어가는 날이에요 ☕'));
  } else {
    for (const item of list) listEl.appendChild(jbn_renderTaskRow(me, item, todayIso));
  }
  wrap.appendChild(listEl);
  return wrap;
}

function jbn_renderTaskRow(me, item, todayIso) {
  const { task, occurrenceDate, kind } = item;
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
      (kind === 'postponed_in' ? ' postin' : ''),
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
        if (co) ckRow.appendChild(jbn_el('span', { class: 'jbn-check-time' }, jbn_fmtTime(co.completed_at)));
      }
      subWrap.appendChild(ckRow);
    }
    body.appendChild(subWrap);
  } else if (fullyDone) {
    const co = jbnState.completions.find(co =>
      co.task_id === task.id && !co.checklist_id &&
      co.member_id === me.id && co.target_date === occurrenceDate);
    if (co) body.appendChild(jbn_el('div', { class: 'jbn-time' }, '완료 ' + jbn_fmtTime(co.completed_at)));
  }

  row.append(star, body);

  // 스와이프
  jbn_attachSwipe(row, {
    onSwipeRight: () => {
      // 완료 토글
      if (cls.length) {
        // 체크리스트 있는 경우: 모두 완료 / 모두 해제 토글
        const allDone = cls.every(c => jbnState.completions.find(co =>
          co.task_id === task.id && co.checklist_id === c.id &&
          co.member_id === me.id && co.target_date === occurrenceDate));
        if (allDone) {
          for (const c of cls) jbn_unmarkComplete(task.id, c.id, occurrenceDate);
        } else {
          for (const c of cls) jbn_markComplete(task.id, c.id, occurrenceDate);
          jbn_playCompleteSound();
        }
      } else {
        if (fullyDone) jbn_unmarkComplete(task.id, null, occurrenceDate);
        else { jbn_markComplete(task.id, null, occurrenceDate); jbn_playCompleteSound(); }
      }
    },
    onSwipeLeft: () => jbn_openPostponeMenu(task, occurrenceDate, todayIso),
  });

  // 단일 클릭 (체크리스트 없을 때만)
  if (!cls.length) {
    body.addEventListener('click', () => {
      if (fullyDone) jbn_unmarkComplete(task.id, null, occurrenceDate);
      else { jbn_markComplete(task.id, null, occurrenceDate); jbn_playCompleteSound(); }
    });
  }
  return row;
}

function jbn_openPostponeMenu(task, occurrenceDate, todayIso) {
  const wrap = jbn_el('div', { class: 'jbn-menu' });
  const opt1 = jbn_el('button', { class: 'jbn-menu-item', onclick: () => {
    const target = jbn_addDays(todayIso, 1);
    jbn_postponeTask(task.id, occurrenceDate, target);
    jbn_closeModal();
    jbn_toast('내일로 미뤘어요');
  } }, '1일 뒤로');
  const opt2 = jbn_el('button', { class: 'jbn-menu-item', onclick: async () => {
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
  wrap.append(opt1, opt2);
  jbn_openModal({ title: `"${task.title}" 미루기`, body: wrap });
}

// ============================================================
// 통계 화면
// ============================================================
function jbn_renderStats(me) {
  const todayIso = jbn_logicalToday();
  const wrap = jbn_el('section', { class: 'jbn-page' });
  wrap.appendChild(jbn_el('h2', { class: 'jbn-h2' }, '통계'));

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
    const sec = jbn_el('div', { class: 'jbn-overdue-sec' });
    sec.appendChild(jbn_el('div', { class: 'jbn-overdue-name' },
      `${m.display_name} — ${items.length}건`));
    if (items.length === 0) {
      sec.appendChild(jbn_el('div', { class: 'jbn-overdue-empty' }, '깔끔! 👍'));
    } else {
      for (const it of items) {
        const loc = jbnState.locations.find(l => l.id === it.task.location_id);
        const days = jbn_diffDays(todayIso, it.occurrenceDate);
        sec.appendChild(jbn_el('div', { class: 'jbn-overdue-item' },
          jbn_el('span', { class: 'jbn-chip warn' }, `${days}일`),
          jbn_el('span', { class: 'jbn-overdue-title' },
            `${loc ? loc.name + ' · ' : ''}${it.task.title}`),
          jbn_el('span', { class: 'jbn-overdue-date' }, it.occurrenceDate),
        ));
      }
    }
    overdueCard.appendChild(sec);
  }
  wrap.appendChild(overdueCard);
  return wrap;
}
