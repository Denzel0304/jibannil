// ============================================================
// js/admin.js
// super 전용 관리 화면.
// 1차: 위치 목록(드래그 정렬, 추가/이름/삭제)
//   → 위치 클릭 시 그 위치의 할일 목록 (드래그 정렬, 추가/편집/삭제)
//     → 할일 안에 체크리스트 (드래그 정렬, 추가/이름/삭제)
// 별도: 가족 구성원 관리, 주기 편집기.
// ============================================================

import { jbnState } from './store.js';
import {
  jbn_addLocation, jbn_renameLocation, jbn_deleteLocation, jbn_reorderLocations,
  jbn_addTask, jbn_updateTask, jbn_deleteTask, jbn_reorderTasks,
  jbn_addChecklist, jbn_updateChecklist, jbn_deleteChecklist, jbn_reorderChecklist,
  jbn_setSuper, jbn_renameMember, jbn_setMemberColor,
  jbn_markCompleteAs, jbn_unmarkCompleteAs,
} from './sync.js';
import {
  jbn_$, jbn_el, jbn_clear, jbn_logicalToday, jbn_isoDate, JBN_WEEKDAY_KO, jbn_fmtDateTime,
} from './util.js';
import {
  jbn_openModal, jbn_closeModal, jbn_closeAllModals, jbn_confirm, jbn_alert, jbn_prompt, jbn_pickDate,
  jbn_hasOpenModal, jbn_isProgrammaticClose,
} from './modal.js';
import { jbn_attachDragSort } from './interactions.js';
import { jbn_recurrenceLabel } from './recurrence.js';
import { jbn_isOccurrenceOn, jbn_pastOccurrences } from './recurrence.js';

let jbn_adminTab = 'locations'; // 'locations' | 'alltasks' | 'members'
let jbn_locationOpen = null;    // location_id

// 뒤로가기 처리 (admin.js 는 modal.js 보다 먼저 등록됨)
//
// 1) 모달이 열려 있으면 → modal.js 에 맡기고 여기선 무시.
//    (modal.js 의 popstate 가 뒤에 실행되어 모달을 닫음)
//
// 2) 방금 이동한 state 가 {jbnModal:true} 면 → 이미 닫힌 모달의
//    orphan history entry. 자동으로 한 칸 더 back 해서 건너뜀.
//    (프로그래매틱 closeModal/closeAllModals 는 history cleanup 없이
//     DOM 만 제거하므로 orphan entry 가 남을 수 있음)
//
// 3) 그 외, location 이 열려 있으면 → location 닫기 (장소 목록으로).
window.addEventListener('popstate', (e) => {
  if (jbn_isProgrammaticClose) return;     // (0) modal.js 의 history.go() 가 유발한 이벤트 → 무시
  if (jbn_hasOpenModal()) return;          // (1) 모달이 살아 있음 → modal.js 처리
  if (e.state?.jbnModal) {                 // (2) orphan modal entry → 건너뜀
    history.back();
    return;
  }
  if (jbn_locationOpen) {                  // (3) 장소 목록으로 복귀
    jbn_locationOpen = null;
    window.scrollTo(0, 0);
    document.dispatchEvent(new CustomEvent('jbn:rerender'));
  }
});

export function jbn_renderAdmin(me) {
  const wrap = jbn_el('section', { class: 'jbn-page' });

  // 서브탭
  const sub = jbn_el('div', { class: 'jbn-subtab jbn-subtab-fixed' });
  for (const [id, label] of [['locations','장소·할일'], ['alltasks','모든 일'], ['members','구성원']]) {
    sub.appendChild(jbn_el('button', {
      class: 'jbn-subtab-btn' + (jbn_adminTab === id ? ' on' : ''),
      onclick: () => {
        jbn_adminTab = id;
        window.scrollTo(0, 0);
        document.dispatchEvent(new CustomEvent('jbn:rerender'));
      },
    }, label));
  }
  wrap.appendChild(sub);
  wrap.appendChild(jbn_el('div', { style: 'height:54px;flex-shrink:0' }));

  if (jbn_adminTab === 'locations') wrap.appendChild(jbn_renderLocationsAdmin());
  else if (jbn_adminTab === 'alltasks') wrap.appendChild(jbn_renderAllTasksAdmin());
  else if (jbn_adminTab === 'members') wrap.appendChild(jbn_renderMembersAdmin(me));
  return wrap;
}

// ============================================================
// 장소 관리
// ============================================================
function jbn_renderLocationsAdmin() {
  if (jbn_locationOpen) {
    const loc = jbnState.locations.find(l => l.id === jbn_locationOpen);
    if (loc) return jbn_renderTasksOfLocation(loc);
    jbn_locationOpen = null;
  }

  const wrap = jbn_el('div', {});
  wrap.appendChild(jbn_el('div', { class: 'jbn-section-head' },
    (() => {
      const h = jbn_el('h2', { class: 'jbn-h2', style: 'flex:1;text-align:center;display:flex;align-items:center;justify-content:center;gap:6px' });
      h.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
      h.appendChild(document.createTextNode('장소'));
      return h;
    })(),
    jbn_el('button', {
      class: 'jbn-btn jbn-btn-primary',
      onclick: async () => {
        const name = await jbn_prompt('장소 이름', '');
        if (name) jbn_addLocation(name);
      },
    }, '+ 장소'),
  ));

  const list = jbn_el('div', { class: 'jbn-list' });
  const sorted = [...jbnState.locations].sort((a,b) => a.sort_order - b.sort_order);
  for (const l of sorted) {
    const row = jbn_el('div', { class: 'jbn-row', dataset: { dragId: l.id } });
    row.appendChild(jbn_el('span', { class: 'jbn-handle', dataset: { dragHandle: '1' } }, '☰'));
    row.appendChild(jbn_el('span', {
      class: 'jbn-row-title',
      onclick: () => {
        jbn_locationOpen = l.id;
        window.scrollTo(0, 0);
        history.pushState({ jbnLocation: true }, '');
        document.dispatchEvent(new CustomEvent('jbn:rerender'));
      },
    }, l.name + ` (${jbnState.tasks.filter(t => t.location_id === l.id).length})`));
    row.appendChild(jbn_el('button', {
      class: 'jbn-icon-btn',
      onclick: async (e) => {
        e.stopPropagation();
        const v = await jbn_prompt('새 이름', l.name);
        if (v) jbn_renameLocation(l.id, v);
      },
    }, '✎'));
    row.appendChild(jbn_el('button', {
      class: 'jbn-icon-btn',
      onclick: async (e) => {
        e.stopPropagation();
        const ok = await jbn_confirm(`"${l.name}" 과(와) 그 안의 모든 할 일을 삭제할까요?`);
        if (ok) jbn_deleteLocation(l.id);
      },
    }, '✕'));
    list.appendChild(row);
  }
  wrap.appendChild(list);

  setTimeout(() => {
    jbn_attachDragSort(list, (orderedIds) => jbn_reorderLocations(orderedIds));
  }, 30);
  return wrap;
}

// ============================================================
// 한 위치의 할일 목록
// ============================================================
function jbn_renderTasksOfLocation(loc) {
  const wrap = jbn_el('div', {});
  wrap.appendChild(jbn_el('div', { class: 'jbn-section-head' },
    jbn_el('button', {
      class: 'jbn-btn',
      onclick: () => { jbn_locationOpen = null; window.scrollTo(0, 0); document.dispatchEvent(new CustomEvent('jbn:rerender')); },
    }, '‹ 장소'),
    jbn_el('h2', { class: 'jbn-h2', style: 'flex:1;text-align:center' }, loc.name),
    jbn_el('button', {
      class: 'jbn-btn jbn-btn-primary',
      onclick: () => jbn_openTaskEditor(null, loc.id),
    }, '+ 할 일'),
  ));

  const list = jbn_el('div', { class: 'jbn-list' });
  const tasks = jbnState.tasks
    .filter(t => t.location_id === loc.id)
    .sort((a,b) => a.sort_order - b.sort_order);

  for (const t of tasks) {
    const row = jbn_el('div', { class: 'jbn-row', dataset: { dragId: t.id } });
    row.appendChild(jbn_el('span', { class: 'jbn-handle', dataset: { dragHandle: '1' } }, '☰'));
    const titleWrap = jbn_el('div', { class: 'jbn-row-title' });
    titleWrap.appendChild(jbn_el('div', {}, t.title));
    titleWrap.appendChild(jbn_el('div', { class: 'jbn-row-sub' }, jbn_recurrenceLabel(t)));
    const assignees = jbnState.members
      .filter(m => jbnState.task_assignees.some(a => a.task_id === t.id && a.member_id === m.id))
      .sort((a, b) => (a.member_order ?? 0) - (b.member_order ?? 0))
      .map(m => m.display_name);
    if (assignees.length) titleWrap.appendChild(jbn_el('div', { class: 'jbn-row-sub' }, '담당: ' + assignees.join(', ')));
    row.appendChild(titleWrap);

    row.appendChild(jbn_el('button', {
      class: 'jbn-icon-btn',
      onclick: () => jbn_openTaskEditor(t.id, loc.id),
    }, '✎'));
    row.appendChild(jbn_el('button', {
      class: 'jbn-icon-btn',
      onclick: async () => {
        const ok = await jbn_confirm(`"${t.title}" 를(을) 삭제할까요?`);
        if (ok) jbn_deleteTask(t.id);
      },
    }, '✕'));
    list.appendChild(row);
  }
  wrap.appendChild(list);

  setTimeout(() => {
    jbn_attachDragSort(list, (orderedIds) => jbn_reorderTasks(loc.id, orderedIds));
  }, 30);
  return wrap;
}

// ============================================================
// 할일 편집기 (모달)
// 신규/편집 모두 체크리스트를 모달 안에서 바로 추가·삭제·정렬 가능.
// 신규일 때는 임시 배열(draftChecklist)에 쌓아뒀다가
// 저장 시 task 생성 직후 한꺼번에 DB에 넣음.
// ============================================================
function jbn_openTaskEditor(taskId, locationId) {
  const isNew = !taskId;
  const task = isNew
    ? {
        title: '',
        recurrence_type: null,   // 사용자가 직접 선택해야 함
        recurrence_data: {},
        start_date: jbn_logicalToday(),
        location_id: locationId,
      }
    : { ...jbnState.tasks.find(t => t.id === taskId) };
  let assigneeIds = isNew
    ? []
    : jbnState.task_assignees.filter(a => a.task_id === taskId).map(a => a.member_id);

  // 신규: 메모리에서만 관리하는 임시 체크리스트
  // 편집: 실제 store 데이터를 참조 (추가·삭제·정렬은 즉시 store에 반영)
  let draftChecklist = isNew
    ? []
    : null; // null = 편집 모드, store 직접 사용

  const root = jbn_el('div', {});

  // ── 제목 ──
  root.appendChild(jbn_el('label', { class: 'jbn-label' }, '제목'));
  const titleInput = jbn_el('input', { class: 'jbn-input', type: 'text', value: task.title });
  root.appendChild(titleInput);

  // ── 담당자 ──
  root.appendChild(jbn_el('label', { class: 'jbn-label' }, '담당자 (복수 선택)'));
  const memWrap = jbn_el('div', { class: 'jbn-chips' });
  for (const m of [...jbnState.members].sort((a,b) => a.member_order - b.member_order)) {
    const chip = jbn_el('button', {
      class: 'jbn-chip-btn' + (assigneeIds.includes(m.id) ? ' on' : ''),
      onclick: (e) => {
        e.preventDefault();
        if (assigneeIds.includes(m.id)) assigneeIds = assigneeIds.filter(x => x !== m.id);
        else assigneeIds.push(m.id);
        chip.classList.toggle('on');
      },
    }, m.display_name);
    memWrap.appendChild(chip);
  }
  root.appendChild(memWrap);

  // ── 반복 주기 ──
  root.appendChild(jbn_el('label', { class: 'jbn-label' }, '반복 주기'));
  const recBox = jbn_el('div', { class: 'jbn-rec' });
  const typeRow = jbn_el('div', { class: 'jbn-chips' });
  const typeBtns = {};
  const typeArr = [
    ['daily','매일'], ['weekly','매주 요일'],
    ['every_n_days','N일마다'],
  ];
  for (const [v, label] of typeArr) {
    const b = jbn_el('button', {
      class: 'jbn-chip-btn' + (task.recurrence_type === v ? ' on' : ''),
      onclick: (e) => {
        e.preventDefault();
        task.recurrence_type = v;
        task.recurrence_data = (v === 'daily') ? {} :
          (v === 'weekly') ? { weekdays: [] } :
          { n: null };   // every_n_days: 빈칸으로 시작
        Object.values(typeBtns).forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        renderRecBody();
      },
    }, label);
    typeBtns[v] = b;
    typeRow.appendChild(b);
  }
  recBox.appendChild(typeRow);
  const recBody = jbn_el('div', { class: 'jbn-rec-body' });
  recBox.appendChild(recBody);
  root.appendChild(recBox);

  function renderRecBody() {
    jbn_clear(recBody);
    const t = task.recurrence_type;
    const d = task.recurrence_data || {};
    if (t === 'daily') {
      
    } else if (t === 'weekly') {
      const wks = d.weekdays || [];
      const row = jbn_el('div', { class: 'jbn-chips' });
      for (let i = 0; i < 7; i++) {
        const on = wks.includes(i);
        const b = jbn_el('button', {
          class: 'jbn-chip-btn' + (on ? ' on' : ''),
          onclick: (e) => {
            e.preventDefault();
            const set = new Set(d.weekdays || []);
            if (set.has(i)) set.delete(i); else set.add(i);
            d.weekdays = Array.from(set).sort();
            task.recurrence_data = d;
            renderRecBody();
          },
        }, JBN_WEEKDAY_KO[i]);
        row.appendChild(b);
      }
      recBody.appendChild(row);
    } else if (t === 'every_n_days') {
      const inp = jbn_el('input', {
        class: 'jbn-input', type: 'number', min: '1',
        value: d.n != null ? String(d.n) : '',
        placeholder: '일 수 입력',
        oninput: (e) => {
          const v = Number(e.target.value);
          d.n = e.target.value === '' ? null : Math.max(1, v || 1);
          task.recurrence_data = d;
        },
      });
      recBody.append(inp);
    }
  }
  renderRecBody();

  // ── 시작일 ──
  root.appendChild(jbn_el('label', { class: 'jbn-label' }, '시작일'));
  const startBtn = jbn_el('button', {
    class: 'jbn-btn',
    onclick: async (e) => {
      e.preventDefault();
      const v = await jbn_pickDate({ mode: 'single', initial: task.start_date });
      if (v) { task.start_date = v; startBtn.textContent = v; }
    },
  }, task.start_date);
  root.appendChild(startBtn);

  // ── 체크리스트 (신규/편집 모두 표시) ──
  root.appendChild(jbn_el('div', { class: 'jbn-divider' }));

  const clHead = jbn_el('div', { class: 'jbn-section-head-mini' });
  clHead.appendChild(jbn_el('div', { class: 'jbn-label' }, '체크리스트'));
  const clAddBtn = jbn_el('button', { class: 'jbn-btn', onclick: async (e) => {
    e.preventDefault();
    const v = await jbn_prompt('체크리스트 항목', '');
    if (!v) return;
    if (isNew) {
      // 신규: 임시 배열에 추가 후 목록 재렌더
      draftChecklist.push({ id: 'draft_' + Date.now() + '_' + Math.random(), title: v, sort_order: draftChecklist.length });
      renderChecklistArea();
    } else {
      // 편집: 즉시 store에 반영 후 목록 재렌더
      jbn_addChecklist(taskId, v);
      renderChecklistArea();
    }
  } }, '+ 추가');
  clHead.appendChild(clAddBtn);
  root.appendChild(clHead);

  const cl = jbn_el('div', { class: 'jbn-list' });
  root.appendChild(cl);

  function renderChecklistArea() {
    jbn_clear(cl);
    const items = isNew
      ? draftChecklist.slice().sort((a,b) => a.sort_order - b.sort_order)
      : jbnState.checklist.filter(c => c.task_id === taskId).sort((a,b) => a.sort_order - b.sort_order);

    for (const c of items) {
      const r = jbn_el('div', { class: 'jbn-row', dataset: { dragId: c.id } });
      r.appendChild(jbn_el('span', { class: 'jbn-handle', dataset: { dragHandle: '1' } }, '☰'));
      r.appendChild(jbn_el('span', { class: 'jbn-row-title' }, c.title));
      r.appendChild(jbn_el('button', { class: 'jbn-icon-btn', onclick: async (e) => {
        e.preventDefault();
        const v = await jbn_prompt('항목 이름', c.title);
        if (!v) return;
        if (isNew) {
          const idx = draftChecklist.findIndex(x => x.id === c.id);
          if (idx >= 0) draftChecklist[idx].title = v;
          renderChecklistArea();
        } else {
          jbn_updateChecklist(c.id, { title: v });
        }
      } }, '✎'));
      r.appendChild(jbn_el('button', { class: 'jbn-icon-btn', onclick: async (e) => {
        e.preventDefault();
        const ok = await jbn_confirm('삭제할까요?');
        if (!ok) return;
        if (isNew) {
          draftChecklist = draftChecklist.filter(x => x.id !== c.id);
          draftChecklist.forEach((x, i) => { x.sort_order = i; });
          renderChecklistArea();
        } else {
          jbn_deleteChecklist(c.id);
          renderChecklistArea();
        }
      } }, '✕'));
      cl.appendChild(r);
    }

    // 드래그 정렬
    setTimeout(() => {
      jbn_attachDragSort(cl, (orderedIds) => {
        if (isNew) {
          // 임시 배열 순서 갱신
          const map = Object.fromEntries(draftChecklist.map(x => [x.id, x]));
          orderedIds.forEach((id, i) => { if (map[id]) map[id].sort_order = i; });
          draftChecklist = orderedIds.map(id => map[id]).filter(Boolean);
        } else {
          jbn_reorderChecklist(taskId, orderedIds);
        }
      });
    }, 30);
  }
  renderChecklistArea();

  // ── 저장 버튼 ──
  const saveBtn = jbn_el('button', {
    class: 'jbn-btn jbn-btn-primary',
    onclick: () => {
      const title = titleInput.value.trim();
      if (!title) { jbn_alert('제목을 입력하세요'); return; }
      task.title = title;

      if (!assigneeIds.length) { jbn_alert('담당자를 한 명 이상 선택하세요'); return; }

      if (!task.recurrence_type) { jbn_alert('반복 주기를 선택하세요'); return; }
      if (task.recurrence_type === 'weekly' && !(task.recurrence_data.weekdays || []).length) {
        jbn_alert('요일을 하나 이상 선택하세요'); return;
      }
      if (task.recurrence_type === 'every_n_days' && !task.recurrence_data.n) {
        jbn_alert('일 수를 입력하세요'); return;
      }

      if (isNew) {
        // task + assignees + checklist 를 하나의 op 로 묶어 전송 (FK 순서 보장)
        jbn_addTask({
          location_id: task.location_id,
          title: task.title,
          recurrence_type: task.recurrence_type,
          recurrence_data: task.recurrence_data,
          start_date: task.start_date,
          assignee_ids: assigneeIds,
          checklist_titles: draftChecklist.slice().sort((a,b) => a.sort_order - b.sort_order).map(c => c.title),
        });
      } else {
        jbn_updateTask(taskId, {
          title: task.title,
          recurrence_type: task.recurrence_type,
          recurrence_data: task.recurrence_data,
          start_date: task.start_date,
        }, assigneeIds);
      }
      jbn_closeAllModals();
    },
  }, isNew ? '추가' : '저장');
  const cancelBtn = jbn_el('button', { class: 'jbn-btn', onclick: () => jbn_closeAllModals() }, '취소');

  jbn_openModal({ title: isNew ? '새 할일' : '할 일 편집', body: root, footer: [cancelBtn, saveBtn] });
  if (isNew) setTimeout(() => titleInput.focus(), 30);
}

// ============================================================
// 모든 일 — 인라인 헬퍼 (stats.js import 순환 방지용)
// ============================================================
function jbn_adm_isAssignee(taskId, memberId) {
  return jbnState.task_assignees.some(a => a.task_id === taskId && a.member_id === memberId);
}
function jbn_adm_postponedAwayBy(taskId, memberId, originalDate) {
  return jbnState.postponements.some(p =>
    p.task_id === taskId && p.member_id === memberId && p.original_date === originalDate);
}
function jbn_adm_completedSlot(taskId, checklistId, memberId, targetDate) {
  return jbnState.completions.find(c =>
    c.task_id === taskId &&
    (c.checklist_id || null) === (checklistId || null) &&
    c.member_id === memberId &&
    c.target_date === targetDate
  );
}
function jbn_adm_taskSlots(taskId) {
  const cls = jbnState.checklist.filter(c => c.task_id === taskId);
  if (cls.length) return cls.map(c => ({ checklistId: c.id, title: c.title, sort: c.sort_order }));
  return [{ checklistId: null, title: null, sort: 0 }];
}
function jbn_adm_taskIsFullyDone(task, memberId, targetDate) {
  const slots = jbn_adm_taskSlots(task.id);
  return slots.length > 0 && slots.every(s => jbn_adm_completedSlot(task.id, s.checklistId, memberId, targetDate));
}
function jbn_adm_buildTodayList(memberId, todayIso) {
  const list = [];
  const myTasks = jbnState.tasks.filter(t => jbn_adm_isAssignee(t.id, memberId));
  for (const task of myTasks) {
    if (jbn_isOccurrenceOn(task, todayIso) && !jbn_adm_postponedAwayBy(task.id, memberId, todayIso)) {
      list.push({ task, occurrenceDate: todayIso, kind: 'today' });
    }
    const into = jbnState.postponements.filter(p =>
      p.task_id === task.id && p.member_id === memberId && p.postponed_to === todayIso);
    for (const p of into) {
      // 완료됐으면 완료한 날 +1 자정에 사라져야 함 (오늘 완료한 것은 오늘 자정까지 유지)
      if (jbn_adm_taskIsFullyDone(task, memberId, p.original_date)) {
        const recs = jbnState.completions.filter(c =>
          c.task_id === task.id && c.member_id === memberId && c.target_date === p.original_date);
        const doneBeforeToday = recs.length > 0 && recs.every(c =>
          c.completed_at && jbn_isoDate(new Date(c.completed_at)) < todayIso);
        if (doneBeforeToday) continue;
      }
      list.push({ task, occurrenceDate: p.original_date, displayDate: todayIso, kind: 'postponed_in' });
    }
    const pasts = jbn_pastOccurrences(task, todayIso, 30); // 30 = 완료기록 보관기간과 일치 (늘리면 phantom overdue 재발)
    for (const iso of pasts) {
      if (jbn_adm_postponedAwayBy(task.id, memberId, iso)) continue;
      if (jbn_adm_taskIsFullyDone(task, memberId, iso)) {
        // 완료됐어도 오늘 완료한 것이면 자정까지 유지. 자정이 지난 완료만 제거.
        const recs = jbnState.completions.filter(c =>
          c.task_id === task.id && c.member_id === memberId && c.target_date === iso);
        const doneBeforeToday = recs.length > 0 && recs.every(c =>
          c.completed_at && jbn_isoDate(new Date(c.completed_at)) < todayIso);
        if (doneBeforeToday) continue;
      }
      if (list.some(x => x.task.id === task.id && x.occurrenceDate === iso)) continue;
      list.push({ task, occurrenceDate: iso, kind: 'overdue' });
    }
    // 미래로 미뤄진 항목
    const futurePostponed = jbnState.postponements.filter(p =>
      p.task_id === task.id && p.member_id === memberId && p.postponed_to > todayIso
    );
    for (const p of futurePostponed) {
      if (list.some(x => x.task.id === task.id && x.occurrenceDate === p.original_date && x.kind === 'postponed_future')) continue;
      // 완료됐으면 완료한 날 +1 자정에 사라져야 함 (오늘 완료한 것은 오늘 자정까지 유지)
      if (jbn_adm_taskIsFullyDone(task, memberId, p.original_date)) {
        const recs = jbnState.completions.filter(c =>
          c.task_id === task.id && c.member_id === memberId && c.target_date === p.original_date);
        const doneBeforeToday = recs.length > 0 && recs.every(c =>
          c.completed_at && jbn_isoDate(new Date(c.completed_at)) < todayIso);
        if (doneBeforeToday) continue;
      }
      list.push({ task, occurrenceDate: p.original_date, displayDate: p.postponed_to, kind: 'postponed_future' });
    }
  }
  return list;
}

// ============================================================
// 모든 일 (super 전용 — 전 구성원 오늘 목록 통합 뷰)
// 정렬: member_order 내림차순(3→2→1→0), 각 멤버 안에서 overdue 먼저(오래된 순) → today(오래된 순)
// ============================================================
function jbn_renderAllTasksAdmin() {
  const todayIso = jbn_logicalToday();
  const wrap = jbn_el('div', {});

  // member_order 내림차순(3,2,1,0)
  const members = [...jbnState.members].sort((a, b) => (b.member_order ?? 0) - (a.member_order ?? 0));

  if (!members.length) {
    wrap.appendChild(jbn_el('div', { class: 'jbn-empty' }, '구성원이 없습니다.'));
    return wrap;
  }

  for (const member of members) {
    const items = jbn_adm_buildTodayList(member.id, todayIso);
    // 정렬: overdue 먼저(오래된 순) → today/postponed_in(오래된 순)
    // jbn_buildTodayList 이미 overdue 먼저 정렬하지만 today 는 sort_order 기준 → occurrenceDate 기준으로 재정렬
    items.sort((a, b) => {
      const aOver = a.kind === 'overdue';
      const bOver = b.kind === 'overdue';
      if (aOver && !bOver) return -1;
      if (!aOver && bOver) return 1;
      return a.occurrenceDate.localeCompare(b.occurrenceDate);
    });

    const overdueItems    = items.filter(x => x.kind === 'overdue');
    const todayItems      = items.filter(x => x.kind !== 'overdue' && x.kind !== 'postponed_future');
    const futureItems     = items.filter(x => x.kind === 'postponed_future');

    // 멤버 헤더
    const totalSlots = items.reduce((s, it) => {
      const cls = jbnState.checklist.filter(c => c.task_id === it.task.id);
      return s + (cls.length || 1);
    }, 0);
    const doneSlots = items.reduce((s, it) => {
      const cls = jbnState.checklist.filter(c => c.task_id === it.task.id);
      const slots = cls.length ? cls : [{ id: null }];
      return s + slots.filter(c => jbnState.completions.some(cp =>
        cp.task_id === it.task.id &&
        (cp.checklist_id || null) === (c.id || null) &&
        cp.member_id === member.id &&
        cp.target_date === it.occurrenceDate
      )).length;
    }, 0);
    const pct = totalSlots ? Math.round(doneSlots / totalSlots * 100) : 0;

    const accent = member.accent_color || '#7BC47F';
    const header = jbn_el('div', {
      style: `
        display:flex; align-items:center; gap:10px;
        margin: 18px 0 6px;
        padding: 10px 14px;
        background: var(--jbn-card);
        border-radius: var(--jbn-radius);
        border-left: 4px solid ${accent};
        box-shadow: var(--jbn-shadow);
      `,
    });
    header.appendChild(jbn_el('span', {
      style: `font-weight:700; font-size:15px; flex:1; color:${accent}`,
    }, member.display_name));
    header.appendChild(jbn_el('span', {
      style: 'font-size:13px; color:var(--jbn-muted)',
    }, `${doneSlots}/${totalSlots} (${pct}%)`));
    wrap.appendChild(header);

    if (!items.length) {
      wrap.appendChild(jbn_el('div', { class: 'jbn-empty', style: 'padding:12px 0' }, '할 일 없음'));
      continue;
    }

    // 밀린 일 소섹션
    if (overdueItems.length) {
      wrap.appendChild(jbn_el('div', {
        style: 'font-size:12px; font-weight:700; color:var(--jbn-warn); margin:8px 0 4px 4px; letter-spacing:.3px',
      }, `⚠ 밀린 일 (${overdueItems.length})`));
      for (const it of overdueItems) {
        wrap.appendChild(jbn_buildAdminTaskRow(member, it, todayIso));
      }
    }

    // 오늘 일 소섹션
    if (todayItems.length) {
      const label = todayItems.some(x => x.kind === 'postponed_in') ? '오늘 일 / 미뤄온 일' : '오늘 일';
      wrap.appendChild(jbn_el('div', {
        style: 'font-size:12px; font-weight:700; color:var(--jbn-primary-d); margin:8px 0 4px 4px; letter-spacing:.3px',
      }, `✓ ${label} (${todayItems.length})`));
      for (const it of todayItems) {
        wrap.appendChild(jbn_buildAdminTaskRow(member, it, todayIso));
      }
    }

    // 미룬 일 소섹션 (미래 날짜로 미뤄진 항목)
    if (futureItems.length) {
      // displayDate 기준 정렬
      futureItems.sort((a, b) => a.displayDate.localeCompare(b.displayDate));
      wrap.appendChild(jbn_el('div', {
        style: 'font-size:12px; font-weight:700; color:#C07020; margin:8px 0 4px 4px; letter-spacing:.3px',
      }, `📅 미룬 일 (${futureItems.length})`));
      for (const it of futureItems) {
        wrap.appendChild(jbn_buildAdminTaskRow(member, it, todayIso));
      }
    }
  }

  return wrap;
}

// 개별 할일 카드 (관리자용 — 완료/미완료 토글 포함)
function jbn_buildAdminTaskRow(member, item, todayIso) {
  const { task, occurrenceDate, displayDate, kind } = item;
  const checklists = jbnState.checklist
    .filter(c => c.task_id === task.id)
    .sort((a, b) => a.sort_order - b.sort_order);
  const hasChecklist = checklists.length > 0;

  const isOverdue    = kind === 'overdue';
  const isPostponed  = kind === 'postponed_in';
  const isFuture     = kind === 'postponed_future';
  const isFullyDone  = jbn_adm_taskIsFullyDone(task, member.id, occurrenceDate);

  const card = jbn_el('div', {
    class: 'jbn-task' + (isFullyDone ? ' done' : '') + (isOverdue ? ' overdue' : '') + ((isPostponed || isFuture) ? ' postin' : ''),
    style: 'margin-bottom:8px',
  });

  // 별 아이콘 (완료 표시, 체크리스트 없는 경우 클릭 토글)
  const star = jbn_el('div', { class: 'jbn-star' }, isFullyDone ? '★' : '☆');
  if (!hasChecklist) {
    star.style.cursor = 'pointer';
    star.addEventListener('click', () => {
      if (isFullyDone) {
        jbn_unmarkCompleteAs(member.id, task.id, null, occurrenceDate);
      } else {
        jbn_markCompleteAs(member.id, task.id, null, occurrenceDate);
      }
      document.dispatchEvent(new CustomEvent('jbn:rerender'));
    });
  }
  card.appendChild(star);

  const body = jbn_el('div', { class: 'jbn-task-body' });

  // 제목 + chip들
  const titleRow = jbn_el('div', { style: 'display:flex; align-items:center; gap:6px; flex-wrap:wrap' });
  titleRow.appendChild(jbn_el('span', { class: 'jbn-task-title' }, task.title));
  if (isOverdue) {
    titleRow.appendChild(jbn_el('span', { class: 'jbn-chip warn' }, `미이행 날짜: ${occurrenceDate}`));
  } else if (isPostponed) {
    titleRow.appendChild(jbn_el('span', { class: 'jbn-chip warn' }, `미이행 날짜: ${occurrenceDate}`));
    titleRow.appendChild(jbn_el('span', { class: 'jbn-chip soft' }, `미룬 날짜: ${displayDate}`));
  } else if (isFuture) {
    titleRow.appendChild(jbn_el('span', { class: 'jbn-chip warn' }, `미이행 날짜: ${occurrenceDate}`));
    titleRow.appendChild(jbn_el('span', { class: 'jbn-chip soft' }, `미룬 날짜: ${displayDate}`));
  }
  body.appendChild(titleRow);

  // 장소
  const loc = jbnState.locations.find(l => l.id === task.location_id);
  if (loc) {
    body.appendChild(jbn_el('div', { class: 'jbn-time' }, `📍 ${loc.name}`));
  }

  // 체크리스트
  if (hasChecklist) {
    const clWrap = jbn_el('div', { class: 'jbn-checks' });
    for (const cl of checklists) {
      const isDone = jbnState.completions.some(c =>
        c.task_id === task.id &&
        c.checklist_id === cl.id &&
        c.member_id === member.id &&
        c.target_date === occurrenceDate
      );
      const row = jbn_el('div', { class: 'jbn-check' + (isDone ? ' on' : ''), style: 'cursor:pointer' });
      row.appendChild(jbn_el('span', { class: 'jbn-check-mark' }, isDone ? '★' : '☆'));
      row.appendChild(jbn_el('span', { class: 'jbn-check-title' }, cl.title));
      if (isDone) {
        const co = jbnState.completions.find(c =>
          c.task_id === task.id && c.checklist_id === cl.id &&
          c.member_id === member.id && c.target_date === occurrenceDate);
        if (co) row.appendChild(jbn_el('span', { class: 'jbn-check-time' }, jbn_fmtDateTime(co.completed_at)));
      }
      row.addEventListener('click', () => {
        if (isDone) {
          jbn_unmarkCompleteAs(member.id, task.id, cl.id, occurrenceDate);
        } else {
          jbn_markCompleteAs(member.id, task.id, cl.id, occurrenceDate);
        }
        document.dispatchEvent(new CustomEvent('jbn:rerender'));
      });
      clWrap.appendChild(row);
    }
    body.appendChild(clWrap);
  } else if (isFullyDone) {
    const co = jbnState.completions.find(c =>
      c.task_id === task.id && !c.checklist_id &&
      c.member_id === member.id && c.target_date === occurrenceDate);
    if (co) body.appendChild(jbn_el('div', { class: 'jbn-time' }, '완료 ' + jbn_fmtDateTime(co.completed_at)));
  }

  card.appendChild(body);
  return card;
}

// ============================================================
// ============================================================
function jbn_renderMembersAdmin(me) {
  const wrap = jbn_el('div', {});
  const list = jbn_el('div', { class: 'jbn-list' });
  const sorted = [...jbnState.members].sort((a,b) => a.member_order - b.member_order);
  for (const m of sorted) {
    const row = jbn_el('div', { class: 'jbn-row' });
    row.appendChild(jbn_el('span', {
      class: 'jbn-color-dot',
      style: `background:${m.accent_color || '#7BC47F'}`,
    }));
    row.appendChild(jbn_el('span', { class: 'jbn-row-title' }, m.display_name + (m.is_super ? ' ⭐' : '')));

    // 이름·색상 변경: founder만 가능 (본인 포함 모든 구성원 대상)
    if (me.is_founder) {
      row.appendChild(jbn_el('button', {
        class: 'jbn-icon-btn',
        onclick: async () => {
          const v = await jbn_prompt('표시 이름', m.display_name);
          if (v) jbn_renameMember(m.id, v);
        },
      }, '✎'));
      row.appendChild(jbn_el('button', {
        class: 'jbn-icon-btn',
        onclick: async () => {
          const v = await jbn_prompt('색상 (#RRGGBB)', m.accent_color || '#7BC47F');
          if (v && /^#[0-9A-Fa-f]{6}$/.test(v)) jbn_setMemberColor(m.id, v);
          else if (v) jbn_alert('형식: #7BC47F');
        },
      }, '🎨'));
    }

    // 권한 부여/해제: founder(나)만 가능. 본인·다른 founder 행은 건드릴 수 없음.
    if (me.is_founder && m.id !== me.id && !m.is_founder) {
      row.appendChild(jbn_el('button', {
        class: 'jbn-btn',
        onclick: async () => {
          const ok = await jbn_confirm(
            m.is_super
              ? `${m.display_name} 의 최고관리자 권한을 해제할까요?`
              : `${m.display_name} 에게 최고관리자 권한을 부여할까요?`
          );
          if (ok) jbn_setSuper(m.id, !m.is_super);
        },
      }, m.is_super ? '권한 해제' : '권한 부여'));
    }
    list.appendChild(row);
  }
  wrap.appendChild(list);
  return wrap;
}
