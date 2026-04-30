// ============================================================
// js/sync.js
//
// (1) Realtime 구독 — 다른 기기/브라우저에서 일어난 변경을 실시간 반영.
//     - postgres_changes 로 모든 테이블 구독
//     - 연속 이벤트(드래그 순서 N개)는 80ms 디바운스로 묶어 1회 재렌더
//     - 채널 재구독: 기존 채널 제거 후 새로 생성 (auth 변화 대응)
//     - CHANNEL_ERROR / TIMED_OUT 시 3초 후 자동 재연결
//
// (2) 고수준 mutation API — UI 는 이 함수들만 호출.
//     각 함수는: 1) 로컬 즉시 반영 → 2) 큐에 enqueue (서버는 백그라운드)
// ============================================================

import { jbnSupa, jbn_me } from './auth.js';
import {
  jbnState,
  jbn_localUpsert, jbn_localUpsertSilent, jbn_localDelete,
  jbn_enqueue, jbn_emitChange,
  jbn_saveSnapshot,
} from './store.js';
import { jbn_uuid } from './util.js';

// ============================================================
// Realtime 구독
// ============================================================
let jbn_rtChannel    = null;
let jbn_rtBatchTimer = null;

export function jbn_startRealtime() {
  // 기존 채널 제거
  if (jbn_rtChannel) {
    try { jbnSupa.removeChannel(jbn_rtChannel); } catch (e) { console.warn('[RT] removeChannel', e); }
    jbn_rtChannel = null;
  }

  // 매번 유니크한 채널명 → 이전 구독 좀비 방지
  jbn_rtChannel = jbnSupa
    .channel('jbn_rt_' + Date.now())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_members'        }, ev => jbn_applyRt('members',        ev))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_locations'      }, ev => jbn_applyRt('locations',      ev))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_tasks'          }, ev => jbn_applyRt('tasks',          ev))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_task_assignees' }, ev => jbn_applyRt('task_assignees', ev))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_checklist'      }, ev => jbn_applyRt('checklist',      ev))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_completions'    }, ev => jbn_applyRt('completions',    ev))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_postponements'  }, ev => jbn_applyRt('postponements',  ev))
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('[RT] subscribed OK');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[RT] ' + status + ' — retry in 3s', err);
        setTimeout(jbn_startRealtime, 3000);
      } else if (status === 'CLOSED') {
        console.warn('[RT] channel closed');
      }
    });
}

// 온라인 복귀 시 realtime 재연결
window.addEventListener('online', () => {
  console.log('[RT] online → restart');
  setTimeout(jbn_startRealtime, 800);
});

// ============================================================
// Realtime 이벤트 처리
// 로컬 데이터는 즉시 머지, emitChange 는 80ms 디바운스로 묶음
// ============================================================
function jbn_applyRt(table, ev) {
  if (ev.eventType === 'INSERT' || ev.eventType === 'UPDATE') {
    _mergeLocal(table, ev.new);
  } else if (ev.eventType === 'DELETE') {
    if (table === 'task_assignees') {
      _deleteLocal(table, { task_id: ev.old.task_id, member_id: ev.old.member_id });
    } else {
      _deleteLocal(table, { id: ev.old.id });
    }
  }

  // 연속 이벤트 묶기
  clearTimeout(jbn_rtBatchTimer);
  jbn_rtBatchTimer = setTimeout(() => {
    jbn_saveSnapshot();
    jbn_emitChange('realtime');
  }, 80);
}

function _pkOf(table, row) {
  if (table === 'task_assignees') return `${row.task_id}:${row.member_id}`;
  return row.id;
}

function _mergeLocal(table, row) {
  const arr = jbnState[table];
  if (!arr) return;
  const pk = _pkOf(table, row);
  const idx = arr.findIndex(r => _pkOf(table, r) === pk);
  if (idx >= 0) arr[idx] = { ...arr[idx], ...row };
  else arr.push(row);
}

function _deleteLocal(table, match) {
  if (!jbnState[table]) return;
  const next = jbnState[table].filter(
    r => !Object.entries(match).every(([k, v]) => r[k] === v)
  );
  if (next.length !== jbnState[table].length) jbnState[table] = next;
}

// ============================================================
// Locations
// ============================================================
export function jbn_addLocation(name) {
  const row = {
    id: jbn_uuid(),
    name,
    sort_order: jbnState.locations.length
      ? Math.max(...jbnState.locations.map(l => l.sort_order)) + 1
      : 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  jbn_localUpsert('locations', row);
  jbn_enqueue({ table: 'jibannil_locations', op: 'insert', payload: row });
  return row;
}

export function jbn_renameLocation(id, name) {
  const updated_at = new Date().toISOString();
  jbn_localUpsert('locations', { id, name, updated_at });
  jbn_enqueue({ table: 'jibannil_locations', op: 'update', payload: { name, updated_at }, match: { id } });
}

export function jbn_deleteLocation(id) {
  jbnState.tasks
    .filter(t => t.location_id === id)
    .forEach(t => {
      jbnState.task_assignees = jbnState.task_assignees.filter(a => a.task_id !== t.id);
      jbnState.checklist      = jbnState.checklist.filter(c => c.task_id !== t.id);
      jbnState.completions    = jbnState.completions.filter(c => c.task_id !== t.id);
      jbnState.postponements  = jbnState.postponements.filter(p => p.task_id !== t.id);
    });
  jbnState.tasks     = jbnState.tasks.filter(t => t.location_id !== id);
  jbnState.locations = jbnState.locations.filter(l => l.id !== id);
  jbn_saveSnapshot();
  jbn_emitChange('cascadeDelete:location');
  jbn_enqueue({ table: 'jibannil_locations', op: 'delete', match: { id } });
}

export function jbn_reorderLocations(orderedIds) {
  // 로컬은 silent 머지 후 한 번만 emit (N개 연속 emitChange 방지)
  orderedIds.forEach((id, i) => jbn_localUpsertSilent('locations', { id, sort_order: i }));
  jbn_saveSnapshot();
  jbn_emitChange('reorder:locations');
  orderedIds.forEach((id, i) => {
    jbn_enqueue({ table: 'jibannil_locations', op: 'update', payload: { sort_order: i }, match: { id } });
  });
}

// ============================================================
// Tasks
// ============================================================
export function jbn_addTask(payload) {
  const row = {
    id: jbn_uuid(),
    location_id: payload.location_id,
    title: payload.title,
    recurrence_type: payload.recurrence_type,
    recurrence_data: payload.recurrence_data || {},
    start_date: payload.start_date,
    sort_order: jbnState.tasks
      .filter(t => t.location_id === payload.location_id)
      .reduce((m, t) => Math.max(m, t.sort_order + 1), 0),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  jbn_localUpsert('tasks', row);
  jbn_enqueue({ table: 'jibannil_tasks', op: 'insert', payload: row });

  for (const mid of (payload.assignee_ids || [])) {
    const a = { task_id: row.id, member_id: mid };
    jbn_localUpsert('task_assignees', a);
    jbn_enqueue({ table: 'jibannil_task_assignees', op: 'insert', payload: a });
  }
  return row;
}

export function jbn_updateTask(id, patch, newAssigneeIds) {
  const updated_at = new Date().toISOString();
  jbn_localUpsert('tasks', { id, ...patch, updated_at });
  jbn_enqueue({ table: 'jibannil_tasks', op: 'update', payload: { ...patch, updated_at }, match: { id } });

  if (Array.isArray(newAssigneeIds)) {
    const cur = jbnState.task_assignees.filter(a => a.task_id === id).map(a => a.member_id);
    const toAdd = newAssigneeIds.filter(m => !cur.includes(m));
    const toRm  = cur.filter(m => !newAssigneeIds.includes(m));
    for (const m of toAdd) {
      const row = { task_id: id, member_id: m };
      jbn_localUpsert('task_assignees', row);
      jbn_enqueue({ table: 'jibannil_task_assignees', op: 'insert', payload: row });
    }
    for (const m of toRm) {
      jbn_localDelete('task_assignees', { task_id: id, member_id: m });
      jbn_enqueue({ table: 'jibannil_task_assignees', op: 'delete', match: { task_id: id, member_id: m } });
    }
  }
}

export function jbn_deleteTask(id) {
  jbnState.task_assignees = jbnState.task_assignees.filter(a => a.task_id !== id);
  jbnState.checklist      = jbnState.checklist.filter(c => c.task_id !== id);
  jbnState.completions    = jbnState.completions.filter(c => c.task_id !== id);
  jbnState.postponements  = jbnState.postponements.filter(p => p.task_id !== id);
  jbnState.tasks          = jbnState.tasks.filter(t => t.id !== id);
  jbn_saveSnapshot();
  jbn_emitChange('cascadeDelete:task');
  jbn_enqueue({ table: 'jibannil_tasks', op: 'delete', match: { id } });
}

export function jbn_reorderTasks(locationId, orderedIds) {
  orderedIds.forEach((id, i) => jbn_localUpsertSilent('tasks', { id, sort_order: i }));
  jbn_saveSnapshot();
  jbn_emitChange('reorder:tasks');
  orderedIds.forEach((id, i) => {
    jbn_enqueue({ table: 'jibannil_tasks', op: 'update', payload: { sort_order: i }, match: { id } });
  });
}

// ============================================================
// Checklist
// ============================================================
export function jbn_addChecklist(taskId, title) {
  const row = {
    id: jbn_uuid(),
    task_id: taskId,
    title,
    sort_order: jbnState.checklist.filter(c => c.task_id === taskId).length,
    created_at: new Date().toISOString(),
  };
  jbn_localUpsert('checklist', row);
  jbn_enqueue({ table: 'jibannil_checklist', op: 'insert', payload: row });
  return row;
}

export function jbn_updateChecklist(id, patch) {
  jbn_localUpsert('checklist', { id, ...patch });
  jbn_enqueue({ table: 'jibannil_checklist', op: 'update', payload: patch, match: { id } });
}

export function jbn_deleteChecklist(id) {
  jbnState.completions = jbnState.completions.filter(c => c.checklist_id !== id);
  jbn_localDelete('checklist', { id });
  jbn_enqueue({ table: 'jibannil_checklist', op: 'delete', match: { id } });
}

export function jbn_reorderChecklist(taskId, orderedIds) {
  orderedIds.forEach((id, i) => jbn_localUpsertSilent('checklist', { id, sort_order: i }));
  jbn_saveSnapshot();
  jbn_emitChange('reorder:checklist');
  orderedIds.forEach((id, i) => {
    jbn_enqueue({ table: 'jibannil_checklist', op: 'update', payload: { sort_order: i }, match: { id } });
  });
}

// ============================================================
// Completions (완료 체크)
// ============================================================
export function jbn_markComplete(taskId, checklistId, targetDate) {
  const me = jbn_me();
  if (!me) return;
  const existing = jbnState.completions.find(c =>
    c.task_id === taskId &&
    (c.checklist_id || null) === (checklistId || null) &&
    c.member_id === me.id &&
    c.target_date === targetDate
  );
  if (existing) return existing;
  const row = {
    id: jbn_uuid(),
    task_id: taskId,
    checklist_id: checklistId || null,
    member_id: me.id,
    target_date: targetDate,
    completed_at: new Date().toISOString(),
  };
  jbn_localUpsert('completions', row);
  jbn_enqueue({ table: 'jibannil_completions', op: 'insert', payload: row });
  return row;
}

export function jbn_unmarkComplete(taskId, checklistId, targetDate) {
  const me = jbn_me();
  if (!me) return;
  const existing = jbnState.completions.find(c =>
    c.task_id === taskId &&
    (c.checklist_id || null) === (checklistId || null) &&
    c.member_id === me.id &&
    c.target_date === targetDate
  );
  if (!existing) return;
  jbn_localDelete('completions', { id: existing.id });
  jbn_enqueue({ table: 'jibannil_completions', op: 'delete', match: { id: existing.id } });
}

// ============================================================
// Postponements (개인별 미루기)
// ============================================================
export function jbn_postponeTask(taskId, originalDate, postponedTo) {
  const me = jbn_me();
  if (!me) return;
  const existing = jbnState.postponements.find(p =>
    p.task_id === taskId && p.member_id === me.id && p.original_date === originalDate
  );
  if (existing) {
    jbn_localUpsert('postponements', { ...existing, postponed_to: postponedTo });
    jbn_enqueue({
      table: 'jibannil_postponements', op: 'update',
      payload: { postponed_to: postponedTo }, match: { id: existing.id },
    });
  } else {
    const row = {
      id: jbn_uuid(),
      task_id: taskId,
      member_id: me.id,
      original_date: originalDate,
      postponed_to: postponedTo,
      created_at: new Date().toISOString(),
    };
    jbn_localUpsert('postponements', row);
    jbn_enqueue({ table: 'jibannil_postponements', op: 'insert', payload: row });
  }
}

// ============================================================
// Members
// ============================================================
export function jbn_setSuper(memberId, isSuper) {
  jbn_localUpsert('members', { id: memberId, is_super: isSuper });
  jbn_enqueue({ table: 'jibannil_members', op: 'update', payload: { is_super: isSuper }, match: { id: memberId } });
}

export function jbn_renameMember(memberId, name) {
  jbn_localUpsert('members', { id: memberId, display_name: name });
  jbn_enqueue({ table: 'jibannil_members', op: 'update', payload: { display_name: name }, match: { id: memberId } });
}

export function jbn_setMemberColor(memberId, color) {
  jbn_localUpsert('members', { id: memberId, accent_color: color });
  jbn_enqueue({ table: 'jibannil_members', op: 'update', payload: { accent_color: color }, match: { id: memberId } });
}
