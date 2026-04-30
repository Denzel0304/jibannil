// ============================================================
// js/sync.js
//
// (1) Realtime 구독 — 다른 기기/브라우저에서 일어난 변경을 실시간 반영.
// (2) 고수준 mutation API — UI 는 이 함수들만 호출.
//     각 함수는: 1) 로컬 즉시 반영 → 2) 큐에 enqueue (서버는 백그라운드)
// ============================================================

import { jbnSupa, jbn_me } from './auth.js';
import {
  jbnState, jbn_localUpsert, jbn_localDelete, jbn_enqueue, jbn_emitChange,
} from './store.js';
import { jbn_uuid } from './util.js';

// ---------- Realtime ----------
let jbn_rtChannel = null;

export function jbn_startRealtime() {
  if (jbn_rtChannel) return;
  jbn_rtChannel = jbnSupa.channel('jbn_room_realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_members'        }, ev => jbn_applyRt('members',        ev))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_locations'      }, ev => jbn_applyRt('locations',      ev))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_tasks'          }, ev => jbn_applyRt('tasks',          ev))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_task_assignees' }, ev => jbn_applyRt('task_assignees', ev))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_checklist'      }, ev => jbn_applyRt('checklist',      ev))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_completions'    }, ev => jbn_applyRt('completions',    ev))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jibannil_postponements'  }, ev => jbn_applyRt('postponements',  ev))
    .subscribe();
}

function jbn_applyRt(table, ev) {
  if (ev.eventType === 'INSERT' || ev.eventType === 'UPDATE') {
    jbn_localUpsert(table, ev.new);
  } else if (ev.eventType === 'DELETE') {
    if (table === 'task_assignees') {
      jbn_localDelete(table, { task_id: ev.old.task_id, member_id: ev.old.member_id });
    } else {
      jbn_localDelete(table, { id: ev.old.id });
    }
  }
}

// ============================================================
// Locations
// ============================================================
export function jbn_addLocation(name) {
  const row = {
    id: jbn_uuid(),
    name,
    sort_order: (jbnState.locations.length ? Math.max(...jbnState.locations.map(l => l.sort_order)) + 1 : 0),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  jbn_localUpsert('locations', row);
  jbn_enqueue({ table: 'jibannil_locations', op: 'insert', payload: row });
  return row;
}

export function jbn_renameLocation(id, name) {
  jbn_localUpsert('locations', { id, name, updated_at: new Date().toISOString() });
  jbn_enqueue({ table: 'jibannil_locations', op: 'update', payload: { name }, match: { id } });
}

export function jbn_deleteLocation(id) {
  // 캐스케이드는 서버에서. 로컬도 같이 정리.
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
  jbn_emitChange('cascadeDelete:location');
  jbn_enqueue({ table: 'jibannil_locations', op: 'delete', match: { id } });
}

export function jbn_reorderLocations(orderedIds) {
  orderedIds.forEach((id, i) => {
    jbn_localUpsert('locations', { id, sort_order: i });
    jbn_enqueue({ table: 'jibannil_locations', op: 'update', payload: { sort_order: i }, match: { id } });
  });
}

// ============================================================
// Tasks
// ============================================================
export function jbn_addTask(payload) {
  // payload: location_id, title, recurrence_type, recurrence_data, start_date, assignee_ids[]
  const row = {
    id: jbn_uuid(),
    location_id: payload.location_id,
    title: payload.title,
    recurrence_type: payload.recurrence_type,
    recurrence_data: payload.recurrence_data || {},
    start_date: payload.start_date,
    sort_order: jbnState.tasks
      .filter(t => t.location_id === payload.location_id)
      .reduce((m,t)=>Math.max(m,t.sort_order+1),0),
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
  jbn_emitChange('cascadeDelete:task');
  jbn_enqueue({ table: 'jibannil_tasks', op: 'delete', match: { id } });
}

export function jbn_reorderTasks(locationId, orderedIds) {
  orderedIds.forEach((id, i) => {
    jbn_localUpsert('tasks', { id, sort_order: i });
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
  orderedIds.forEach((id, i) => {
    jbn_localUpsert('checklist', { id, sort_order: i });
    jbn_enqueue({ table: 'jibannil_checklist', op: 'update', payload: { sort_order: i }, match: { id } });
  });
}

// ============================================================
// Completions (완료)
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
  // 동일 (task, member, original_date) 가 있으면 update, 없으면 insert
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
// Members (super 만)
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
