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
} from './sync.js';
import {
  jbn_$, jbn_el, jbn_clear, jbn_logicalToday, jbn_isoDate, JBN_WEEKDAY_KO,
} from './util.js';
import {
  jbn_openModal, jbn_closeModal, jbn_closeAllModals, jbn_confirm, jbn_alert, jbn_prompt, jbn_pickDate,
} from './modal.js';
import { jbn_attachDragSort } from './interactions.js';
import { jbn_recurrenceLabel } from './recurrence.js';

let jbn_adminTab = 'locations'; // 'locations' | 'members'
let jbn_locationOpen = null;    // location_id

export function jbn_renderAdmin(me) {
  const wrap = jbn_el('section', { class: 'jbn-page' });

  // 서브탭
  const sub = jbn_el('div', { class: 'jbn-subtab' });
  for (const [id, label] of [['locations','장소·할일'], ['members','구성원']]) {
    sub.appendChild(jbn_el('button', {
      class: 'jbn-subtab-btn' + (jbn_adminTab === id ? ' on' : ''),
      onclick: () => {
        jbn_adminTab = id;
        // 외부에서 paint 트리거
        document.dispatchEvent(new CustomEvent('jbn:rerender'));
      },
    }, label));
  }
  wrap.appendChild(sub);

  if (jbn_adminTab === 'locations') wrap.appendChild(jbn_renderLocationsAdmin());
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
    jbn_el('h2', { class: 'jbn-h2' }, '장소'),
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
        const ok = await jbn_confirm(`"${l.name}" 와 그 안의 모든 할 일을 삭제할까요?`);
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
      onclick: () => { jbn_locationOpen = null; document.dispatchEvent(new CustomEvent('jbn:rerender')); },
    }, '‹ 장소'),
    jbn_el('h2', { class: 'jbn-h2' }, loc.name),
    jbn_el('button', {
      class: 'jbn-btn jbn-btn-primary',
      onclick: () => jbn_openTaskEditor(null, loc.id),
    }, '+ 할일'),
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
    const assignees = jbnState.task_assignees.filter(a => a.task_id === t.id)
      .map(a => jbnState.members.find(m => m.id === a.member_id)?.display_name).filter(Boolean);
    if (assignees.length) titleWrap.appendChild(jbn_el('div', { class: 'jbn-row-sub' }, '담당: ' + assignees.join(', ')));
    titleWrap.addEventListener('click', () => jbn_openTaskEditor(t.id, loc.id));
    row.appendChild(titleWrap);

    row.appendChild(jbn_el('button', {
      class: 'jbn-icon-btn',
      onclick: () => jbn_openTaskEditor(t.id, loc.id),
    }, '✎'));
    row.appendChild(jbn_el('button', {
      class: 'jbn-icon-btn',
      onclick: async () => {
        const ok = await jbn_confirm(`"${t.title}" 을(를) 삭제할까요?`);
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
// ============================================================
function jbn_openTaskEditor(taskId, locationId) {
  const isNew = !taskId;
  const task = isNew
    ? {
        title: '',
        recurrence_type: 'daily',
        recurrence_data: {},
        start_date: jbn_logicalToday(),
        location_id: locationId,
      }
    : { ...jbnState.tasks.find(t => t.id === taskId) };
  let assigneeIds = isNew
    ? []
    : jbnState.task_assignees.filter(a => a.task_id === taskId).map(a => a.member_id);

  const root = jbn_el('div', {});

  // 제목
  root.appendChild(jbn_el('label', { class: 'jbn-label' }, '제목'));
  const titleInput = jbn_el('input', { class: 'jbn-input', type: 'text', value: task.title });
  root.appendChild(titleInput);

  // 담당자
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

  // 주기
  root.appendChild(jbn_el('label', { class: 'jbn-label' }, '반복 주기'));
  const recBox = jbn_el('div', { class: 'jbn-rec' });
  const typeRow = jbn_el('div', { class: 'jbn-chips' });
  const typeBtns = {};
  const typeArr = [
    ['daily','매일'], ['weekly','매주 요일'],
    ['monthly_nth','매월 N째주 요일'], ['every_n_days','N일마다'],
  ];
  for (const [v, label] of typeArr) {
    const b = jbn_el('button', {
      class: 'jbn-chip-btn' + (task.recurrence_type === v ? ' on' : ''),
      onclick: (e) => {
        e.preventDefault();
        task.recurrence_type = v;
        task.recurrence_data = (v === 'daily') ? {} :
          (v === 'weekly') ? { weekdays: [] } :
          (v === 'monthly_nth') ? { occurrences: [] } :
          { n: 3 };
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
      recBody.appendChild(jbn_el('div', { class: 'jbn-hint' }, '매일 발생합니다.'));
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
    } else if (t === 'monthly_nth') {
      // 달력에서 여러 날짜 선택 → (N째주, 요일) 로 정규화
      const summary = jbn_el('div', { class: 'jbn-hint' });
      const occs = d.occurrences || [];
      summary.textContent = occs.length
        ? '선택: ' + occs.map(o => `${o.week}째 ${JBN_WEEKDAY_KO[o.wd]}요일`).join(', ')
        : '아직 선택된 패턴 없음';
      const pickBtn = jbn_el('button', {
        class: 'jbn-btn',
        onclick: async (e) => {
          e.preventDefault();
          const dates = await jbn_pickDate({
            mode: 'multi',
            initial: jbn_logicalToday(),
            selected: [],
            title: '대표 날짜들 선택 (예: 첫째주 수,목)',
          });
          if (!dates) return;
          // 선택한 각 날짜 → (week, weekday) 추출하여 중복 제거
          const set = new Set();
          for (const iso of dates) {
            const dt = new Date(iso + 'T00:00');
            const wd = dt.getDay();
            const wk = Math.floor((dt.getDate() - 1) / 7) + 1;
            set.add(JSON.stringify({ week: wk, wd }));
          }
          d.occurrences = Array.from(set).map(s => JSON.parse(s)).sort((a,b)=>a.week-b.week||a.wd-b.wd);
          task.recurrence_data = d;
          renderRecBody();
        },
      }, '달력으로 선택');
      recBody.append(pickBtn, summary);
    } else if (t === 'every_n_days') {
      const inp = jbn_el('input', { class: 'jbn-input', type: 'number', min: '1', value: String(d.n || 3),
        oninput: (e) => { d.n = Math.max(1, Number(e.target.value) || 1); task.recurrence_data = d; } });
      recBody.append(jbn_el('div', { class: 'jbn-hint' }, '시작일부터 N일마다 발생'), inp);
    }
  }
  renderRecBody();

  // 시작일
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

  // 체크리스트 섹션 (신규/편집 모두 동일하게 표시)
  root.appendChild(jbn_el('div', { class: 'jbn-divider' }));

  // 신규일 때는 "저장 후 추가 가능" 안내, 편집일 때는 바로 추가 가능
  const clHeadRight = isNew
    ? jbn_el('div', { class: 'jbn-hint', style: 'font-size:11px;color:#8FAA94' }, '저장 후 추가 가능')
    : jbn_el('button', {
        class: 'jbn-btn',
        onclick: async (e) => {
          e.preventDefault();
          const v = await jbn_prompt('체크리스트 항목', '');
          if (v) jbn_addChecklist(taskId, v);
        },
      }, '+ 추가');

  root.appendChild(jbn_el('div', { class: 'jbn-section-head-mini' },
    jbn_el('div', { class: 'jbn-label' }, '체크리스트'),
    clHeadRight,
  ));

  const cl = jbn_el('div', { class: 'jbn-list' });
  if (!isNew) {
    const items = jbnState.checklist.filter(c => c.task_id === taskId).sort((a,b) => a.sort_order - b.sort_order);
    for (const c of items) {
      const r = jbn_el('div', { class: 'jbn-row', dataset: { dragId: c.id } });
      r.appendChild(jbn_el('span', { class: 'jbn-handle', dataset: { dragHandle: '1' } }, '☰'));
      r.appendChild(jbn_el('span', { class: 'jbn-row-title' }, c.title));
      r.appendChild(jbn_el('button', { class: 'jbn-icon-btn', onclick: async () => {
        const v = await jbn_prompt('항목 이름', c.title);
        if (v) jbn_updateChecklist(c.id, { title: v });
      } }, '✎'));
      r.appendChild(jbn_el('button', { class: 'jbn-icon-btn', onclick: async () => {
        const ok = await jbn_confirm('삭제할까요?');
        if (ok) jbn_deleteChecklist(c.id);
      } }, '✕'));
      cl.appendChild(r);
    }
    setTimeout(() => {
      jbn_attachDragSort(cl, (orderedIds) => jbn_reorderChecklist(taskId, orderedIds));
    }, 30);
  } else {
    cl.appendChild(jbn_el('div', { class: 'jbn-hint', style: 'padding:6px 2px' },
      '할일을 먼저 저장하면 체크리스트를 추가할 수 있어요.'));
  }
  root.appendChild(cl);

  // 저장 버튼
  const saveBtn = jbn_el('button', {
    class: 'jbn-btn jbn-btn-primary',
    onclick: () => {
      const title = titleInput.value.trim();
      if (!title) { jbn_alert('제목을 입력하세요'); return; }
      task.title = title;

      // 주기 데이터 검증
      if (task.recurrence_type === 'weekly' && !(task.recurrence_data.weekdays || []).length) {
        jbn_alert('요일을 하나 이상 선택하세요'); return;
      }
      if (task.recurrence_type === 'monthly_nth' && !(task.recurrence_data.occurrences || []).length) {
        jbn_alert('달력에서 패턴을 선택하세요'); return;
      }

      if (isNew) {
        // 새 할일 저장 후 곧바로 편집 모달로 재진입 (체크리스트 추가 가능)
        const newTask = jbn_addTask({
          location_id: task.location_id,
          title: task.title,
          recurrence_type: task.recurrence_type,
          recurrence_data: task.recurrence_data,
          start_date: task.start_date,
          assignee_ids: assigneeIds,
        });
        jbn_closeAllModals();
        // 저장 직후 편집 모달 열기 → 체크리스트 추가 가능
        setTimeout(() => jbn_openTaskEditor(newTask.id, locationId), 80);
      } else {
        jbn_updateTask(taskId, {
          title: task.title,
          recurrence_type: task.recurrence_type,
          recurrence_data: task.recurrence_data,
          start_date: task.start_date,
        }, assigneeIds);
        jbn_closeAllModals();
      }
    },
  }, isNew ? '저장 후 편집' : '저장');
  const cancelBtn = jbn_el('button', { class: 'jbn-btn', onclick: () => jbn_closeAllModals() }, '취소');

  jbn_openModal({ title: isNew ? '새 할일' : '할일 편집', body: root, footer: [cancelBtn, saveBtn] });
}

// ============================================================
// 구성원 관리
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
