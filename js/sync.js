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
import { jbn_uuid, jbn_logicalToday, jbn_addDays } from './util.js';
import { jbn_dragLockState } from './interactions.js';

// ============================================================
// Realtime 구독
// ============================================================
let jbn_rtChannel    = null;
let jbn_rtBatchTimer = null;
let jbn_rtStarted    = false;  // 이중 구독 방지 플래그

export function jbn_startRealtime() {
  // 이미 시작 요청했으면 건너뜀 (joined 타이밍 문제 없이 플래그로 관리)
  if (jbn_rtStarted) return;
  jbn_rtStarted = true;

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
        jbn_rtStarted = false;  // 재연결 허용
        setTimeout(jbn_startRealtime, 3000);
      } else if (status === 'CLOSED') {
        console.warn('[RT] channel closed');
      }
    });
}

// 온라인 복귀 시 realtime 재연결
window.addEventListener('online', () => {
  console.log('[RT] online → restart');
  jbn_rtStarted = false;  // 재연결 허용
  setTimeout(jbn_startRealtime, 800);
});

// ============================================================
// Realtime 이벤트 처리
// 로컬 데이터는 즉시 머지, emitChange 는 80ms 디바운스로 묶음
// ============================================================
function jbn_applyRt(table, ev) {
  if (ev.eventType === 'INSERT' || ev.eventType === 'UPDATE') {
    // 드래그 정렬 중에 sort_order 만 바뀌는 Realtime 이벤트는 무시
    // (내가 방금 보낸 reorder op의 echo가 돌아오는 것 — 로컬이 이미 정답)
    if (jbn_dragLockState.locked) return;
    const isOnlySortOrder = ev.eventType === 'UPDATE'
      && ev.new && ev.old
      && Object.keys(ev.new).length <= 3   // id, sort_order, updated_at 정도
      && 'sort_order' in ev.new
      && !('title' in ev.new) && !('name' in ev.new);
    if (isOnlySortOrder && jbn_dragLockState.reorderCooldown) return;
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
  orderedIds.forEach((id, i) => jbn_localUpsertSilent('locations', { id, sort_order: i }));
  jbn_saveSnapshot();
  jbn_emitChange('reorder:locations');
  // 단일 reorder op로 직렬 처리 — N개 개별 enqueue 시 Realtime echo 순서 뒤섞힘 방지
  _enqueueReorder('jibannil_locations', orderedIds);
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

  const children = [];

  // assignees
  for (const mid of (payload.assignee_ids || [])) {
    const a = { task_id: row.id, member_id: mid };
    jbn_localUpsert('task_assignees', a);
    children.push({ table: 'jibannil_task_assignees', payload: a, onConflict: 'task_id,member_id' });
  }

  // checklist — task FK 보장을 위해 함께 묶음
  const checklistTitles = (payload.checklist_titles || []);
  checklistTitles.forEach((title, i) => {
    const c = {
      id: jbn_uuid(),
      task_id: row.id,
      title,
      sort_order: i,
      created_at: new Date().toISOString(),
    };
    jbn_localUpsert('checklist', c);
    children.push({ table: 'jibannil_checklist', payload: c, onConflict: 'id' });
  });

  // task INSERT 후 assignees + checklist 를 하나의 op 로 묶어 순서 보장
  if (children.length) {
    jbn_enqueue({
      table: 'jibannil_tasks',
      op: 'insert_with_children',
      payload: row,
      parentConflict: 'id',
      children,
    });
  } else {
    jbn_enqueue({ table: 'jibannil_tasks', op: 'insert', payload: row });
  }
  return row;
}

export function jbn_updateTask(id, patch, newAssigneeIds) {
  const updated_at = new Date().toISOString();
  jbn_localUpsert('tasks', { id, ...patch, updated_at });

  if (Array.isArray(newAssigneeIds)) {
    // 로컬: 기존 assignees 전부 제거 후 새 목록으로 교체
    jbnState.task_assignees = jbnState.task_assignees.filter(a => a.task_id !== id);
    for (const m of newAssigneeIds) {
      jbn_localUpsert('task_assignees', { task_id: id, member_id: m });
    }

    // 서버: task update + assignees replace 를 하나의 op 로 묶어 순서 보장
    // replace_assignees op → executeOp 에서 처리:
    //   1) tasks update
    //   2) task_assignees 에서 task_id 일치 행 전부 delete
    //   3) 새 assignees upsert
    jbn_enqueue({
      table: 'jibannil_tasks',
      op: 'update_with_assignees',
      payload: { ...patch, updated_at },
      match: { id },
      taskId: id,
      assigneeIds: newAssigneeIds,
    });
  } else {
    jbn_enqueue({ table: 'jibannil_tasks', op: 'update', payload: { ...patch, updated_at }, match: { id } });
  }
  jbn_saveSnapshot();
  jbn_emitChange('updateTask');
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
  _enqueueReorder('jibannil_tasks', orderedIds);
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
  _enqueueReorder('jibannil_checklist', orderedIds);
}

// ============================================================
// Completions (완료 체크)
// ============================================================

// 미루기 기록 30일치만 유지 (original_date 기준)
function jbn_prunePostponements(memberId) {
  const todayIso = jbn_logicalToday();
  const cutoff = jbn_addDays(todayIso, -30);
  const toDelete = jbnState.postponements.filter(p =>
    p.member_id === memberId && p.original_date < cutoff
  );
  for (const p of toDelete) {
    jbn_localDelete('postponements', { id: p.id });
    jbn_enqueue({ table: 'jibannil_postponements', op: 'delete', match: { id: p.id } });
  }
}

// 완료 insert 후 31일 이전 오래된 기록 정리 (멤버당 30일치만 유지)
function jbn_pruneCompletions(memberId) {
  const todayIso = jbn_logicalToday();
  const cutoff = jbn_addDays(todayIso, -30); // cutoff 미만은 삭제
  const toDelete = jbnState.completions.filter(c =>
    c.member_id === memberId && c.target_date < cutoff
  );
  for (const c of toDelete) {
    jbn_localDelete('completions', { id: c.id });
    jbn_enqueue({ table: 'jibannil_completions', op: 'delete', match: { id: c.id } });
  }
}

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
  jbn_pruneCompletions(me.id);
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

// 관리자용 — 특정 멤버 대신 완료 처리
export function jbn_markCompleteAs(memberId, taskId, checklistId, targetDate) {
  const existing = jbnState.completions.find(c =>
    c.task_id === taskId &&
    (c.checklist_id || null) === (checklistId || null) &&
    c.member_id === memberId &&
    c.target_date === targetDate
  );
  if (existing) return existing;
  const row = {
    id: jbn_uuid(),
    task_id: taskId,
    checklist_id: checklistId || null,
    member_id: memberId,
    target_date: targetDate,
    completed_at: new Date().toISOString(),
  };
  jbn_localUpsert('completions', row);
  jbn_enqueue({ table: 'jibannil_completions', op: 'insert', payload: row });
  jbn_pruneCompletions(memberId);
  return row;
}

// 관리자용 — 특정 멤버 완료 취소
export function jbn_unmarkCompleteAs(memberId, taskId, checklistId, targetDate) {
  const existing = jbnState.completions.find(c =>
    c.task_id === taskId &&
    (c.checklist_id || null) === (checklistId || null) &&
    c.member_id === memberId &&
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
  jbn_prunePostponements(me.id);
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
// ============================================================
// reorder 헬퍼: 단일 op로 묶어서 직렬 처리
// store.js executeOp 의 'reorder' 타입이 처리함
// ============================================================
function _enqueueReorder(table, orderedIds) {
  const rows = orderedIds.map((id, i) => ({ id, sort_order: i }));
  jbn_enqueue({ table, op: 'reorder', rows });
  // reorder echo가 Realtime으로 돌아오는 동안 쿨다운 (2초)
  jbn_dragLockState.reorderCooldown = true;
  clearTimeout(jbn_dragLockState._cooldownTimer);
  jbn_dragLockState._cooldownTimer = setTimeout(() => {
    jbn_dragLockState.reorderCooldown = false;
  }, 2000);
}
