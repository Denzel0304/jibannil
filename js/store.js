// ============================================================
// js/store.js
//
// 동기화 전략 (요구 18번):
//   - 모든 mutation 은 우선 로컬 snapshot 에 즉시 반영(낙관적).
//   - 동시에 큐(queueOp)에 push, 백그라운드로 서버에 flush.
//   - 오프라인이면 큐에만 쌓이고 online 이벤트 때 flush.
//   - Realtime 으로 들어오는 변경은 snapshot 머지.
//   - 한 번에 여러 변경이 와도 동일 키 충돌은 마지막 ts 우선.
// ============================================================

import { jbnSupa } from './auth.js';
import { JBN_KEYS, jbn_uuid, jbn_toast } from './util.js';

// ---------- 메모리 스냅샷 ----------
export const jbnState = {
  members:        [],
  locations:      [],
  tasks:          [],
  task_assignees: [],
  checklist:      [],
  completions:    [],
  postponements:  [],
  fetchedAt:      0,
  hydrated:       false,
};

const jbn_changeListeners = new Set();
export function jbn_onStateChange(fn) {
  jbn_changeListeners.add(fn);
  return () => jbn_changeListeners.delete(fn);
}
let jbn_emitTimer = null;
export function jbn_emitChange(reason = '') {
  // 다중 변경 합치기 (한 프레임)
  if (jbn_emitTimer) return;
  jbn_emitTimer = requestAnimationFrame(() => {
    jbn_emitTimer = null;
    for (const fn of jbn_changeListeners) {
      try { fn(reason); } catch (e) { console.error(e); }
    }
  });
}

// ---------- 스냅샷 영속화 ----------
export function jbn_saveSnapshot() {
  try {
    const j = JSON.stringify({
      members: jbnState.members,
      locations: jbnState.locations,
      tasks: jbnState.tasks,
      task_assignees: jbnState.task_assignees,
      checklist: jbnState.checklist,
      completions: jbnState.completions,
      postponements: jbnState.postponements,
      fetchedAt: jbnState.fetchedAt,
    });
    localStorage.setItem(JBN_KEYS.snapshot, j);
  } catch (e) { console.warn('snapshot save fail', e); }
}

export function jbn_loadSnapshot() {
  try {
    const s = localStorage.getItem(JBN_KEYS.snapshot);
    if (!s) return false;
    const obj = JSON.parse(s);
    Object.assign(jbnState, obj);
    jbnState.hydrated = true;
    return true;
  } catch { return false; }
}

// ---------- 서버에서 전체 fetch ----------
export async function jbn_fetchAll() {
  const tables = [
    'jibannil_members',
    'jibannil_locations',
    'jibannil_tasks',
    'jibannil_task_assignees',
    'jibannil_checklist',
    'jibannil_completions',
    'jibannil_postponements',
  ];
  const results = await Promise.all(tables.map(t => jbnSupa.from(t).select('*')));
  for (let i = 0; i < tables.length; i++) {
    const { data, error } = results[i];
    if (error) { console.error(tables[i], error); continue; }
    const key = tables[i].replace('jibannil_','');
    jbnState[key] = data || [];
  }
  jbnState.fetchedAt = Date.now();
  jbnState.hydrated = true;
  jbn_saveSnapshot();
  jbn_emitChange('fetchAll');
}

// ---------- 로컬 머지 헬퍼 ----------
function jbn_pkOf(table, row) {
  if (table === 'task_assignees') return `${row.task_id}:${row.member_id}`;
  return row.id;
}

export function jbn_localUpsert(table, row) {
  const arr = jbnState[table];
  const pk = jbn_pkOf(table, row);
  const idx = arr.findIndex(r => jbn_pkOf(table, r) === pk);
  if (idx >= 0) arr[idx] = { ...arr[idx], ...row };
  else arr.push(row);
  jbn_saveSnapshot();
  jbn_emitChange(`upsert:${table}`);
}

export function jbn_localDelete(table, match) {
  const arr = jbnState[table];
  const next = arr.filter(r => !Object.entries(match).every(([k,v]) => r[k] === v));
  if (next.length !== arr.length) {
    jbnState[table] = next;
    jbn_saveSnapshot();
    jbn_emitChange(`delete:${table}`);
  }
}

// ============================================================
// 동기화 큐
// ============================================================

function jbn_loadQueue() {
  try { return JSON.parse(localStorage.getItem(JBN_KEYS.syncQueue) || '[]'); }
  catch { return []; }
}
function jbn_persistQueue(q) {
  localStorage.setItem(JBN_KEYS.syncQueue, JSON.stringify(q));
}

let jbn_flushing = false;

// op = { table, op:'insert'|'upsert'|'update'|'delete', payload, match }
export function jbn_enqueue(op) {
  const q = jbn_loadQueue();
  q.push({ ...op, id: 'op_' + jbn_uuid(), ts: Date.now(), tries: 0 });
  jbn_persistQueue(q);
  jbn_flushQueue(); // 즉시 시도, 실패해도 큐에 남음
}

export async function jbn_flushQueue() {
  if (jbn_flushing) return;
  if (!navigator.onLine) return;
  jbn_flushing = true;
  try {
    let q = jbn_loadQueue();
    while (q.length) {
      const head = q[0];
      try {
        await jbn_executeOp(head);
        q.shift(); // 성공 — 큐에서 제거
        jbn_persistQueue(q);
      } catch (e) {
        head.tries = (head.tries || 0) + 1;
        if (head.tries >= 6) {
          console.warn('drop op after retries', head, e);
          q.shift();
          jbn_persistQueue(q);
          jbn_toast('일부 변경 동기화 실패');
        } else {
          // 일시 오류 — 잠시 뒤 다시
          jbn_persistQueue(q);
          setTimeout(jbn_flushQueue, 4000);
          break;
        }
      }
    }
  } finally {
    jbn_flushing = false;
  }
}

async function jbn_executeOp(op) {
  const { table, op: kind, payload, match } = op;
  if (kind === 'insert') {
    const { error } = await jbnSupa.from(table).insert(payload);
    if (error) throw error;
  } else if (kind === 'upsert') {
    const { error } = await jbnSupa.from(table).upsert(payload, op.onConflict ? { onConflict: op.onConflict } : undefined);
    if (error) throw error;
  } else if (kind === 'update') {
    let q = jbnSupa.from(table).update(payload);
    for (const [k,v] of Object.entries(match)) q = q.eq(k, v);
    const { error } = await q;
    if (error) throw error;
  } else if (kind === 'delete') {
    let q = jbnSupa.from(table).delete();
    for (const [k,v] of Object.entries(match)) q = q.eq(k, v);
    const { error } = await q;
    if (error) throw error;
  } else if (kind === 'insert_with_children') {
    // parent row 먼저 insert, 성공 후 children 순서대로 insert (외래키 순서 보장)
    const { error: pErr } = await jbnSupa.from(table).upsert(payload, { onConflict: op.parentConflict || 'id' });
    if (pErr) throw pErr;
    for (const child of (op.children || [])) {
      const { error: cErr } = await jbnSupa.from(child.table).upsert(child.payload, { onConflict: child.onConflict || 'task_id,member_id' });
      if (cErr) throw cErr;
    }
  } else if (kind === 'reorder') {
    // reorder: rows = [{id, sort_order}, ...] 를 순서대로 update
    // 병렬로 보내면 Realtime 이벤트 순서가 뒤섞이므로 직렬 처리
    for (const { id, sort_order } of op.rows) {
      const { error } = await jbnSupa.from(table).update({ sort_order }).eq('id', id);
      if (error) throw error;
    }
  }
}

// 온라인 복귀 → 큐 flush
window.addEventListener('online', () => {
  jbn_toast('온라인 복귀, 동기화 중…', 1200);
  setTimeout(jbn_flushQueue, 500);
});

// 일정 주기로 한 번씩 (혹시 빠진 게 있으면)
setInterval(() => { if (navigator.onLine) jbn_flushQueue(); }, 30000);

// emitChange/saveSnapshot 없이 데이터만 머지 (reorder 등 배치 작업용)
export function jbn_localUpsertSilent(table, row) {
  const arr = jbnState[table];
  const pk = jbn_pkOf(table, row);
  const idx = arr.findIndex(r => jbn_pkOf(table, r) === pk);
  if (idx >= 0) arr[idx] = { ...arr[idx], ...row };
  else arr.push(row);
}
