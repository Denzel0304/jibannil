// ============================================================
// js/stats.js
//
// 핵심 함수:
//   jbn_buildTodayList(memberId, todayIso)
//     → 그 사람의 "오늘 화면"에 떠야 할 task 목록.
//        - 오늘이 발생일이고 / 본인에게 미루기 안된 것
//        - 본인이 다른 날에서 오늘로 미룬 것
//        - 과거 발생일 중 미완료/미연기 (overdue)
//
//   jbn_taskUnitProgress(task, memberId, targetDate, allMembers)
//     → 0~1, 그 사람의 그 task 진행도. (체크리스트 N개 → 1/N씩)
//
//   jbn_personDailyProgress(memberId, todayIso)
//     → 0~1, 그날 그 사람 전체 진행률.
//
//   jbn_overdueByMember(todayIso)
//     → { memberId: [{task, original_date}, ...] }
//
//   jbn_periodStats(memberId, fromIso, toIso)
//     → { totalSlots, doneSlots, byDate: {iso:{slots,done}} }
// ============================================================

import { jbnState } from './store.js';
import { jbn_isOccurrenceOn, jbn_pastOccurrences } from './recurrence.js';
import { jbn_isoDate, jbn_addDays, jbn_parseIso } from './util.js';

// 한 task 의 "1슬롯 = 체크리스트 1개 또는 (체크리스트 없으면) task 자체"
function jbn_taskSlots(taskId) {
  const cls = jbnState.checklist.filter(c => c.task_id === taskId);
  if (cls.length) return cls.map(c => ({ checklistId: c.id, title: c.title, sort: c.sort_order }));
  return [{ checklistId: null, title: null, sort: 0 }];
}

function jbn_isAssignee(taskId, memberId) {
  return jbnState.task_assignees.some(a => a.task_id === taskId && a.member_id === memberId);
}

function jbn_postponedAwayBy(taskId, memberId, originalDate) {
  return jbnState.postponements.some(p =>
    p.task_id === taskId && p.member_id === memberId && p.original_date === originalDate);
}

function jbn_postponedToHere(taskId, memberId, todayIso) {
  return jbnState.postponements.find(p =>
    p.task_id === taskId && p.member_id === memberId && p.postponed_to === todayIso);
}

function jbn_completedSlot(taskId, checklistId, memberId, targetDate) {
  return jbnState.completions.find(c =>
    c.task_id === taskId &&
    (c.checklist_id || null) === (checklistId || null) &&
    c.member_id === memberId &&
    c.target_date === targetDate
  );
}

// 이 task 가 해당 (member, date) 에서 "완료"로 간주되는 슬롯 개수와 전체 슬롯
function jbn_taskProgressCounts(task, memberId, targetDate) {
  const slots = jbn_taskSlots(task.id);
  const total = slots.length;
  let done = 0;
  for (const s of slots) {
    if (jbn_completedSlot(task.id, s.checklistId, memberId, targetDate)) done++;
  }
  return { total, done };
}

export function jbn_taskUnitProgress(task, memberId, targetDate) {
  const { total, done } = jbn_taskProgressCounts(task, memberId, targetDate);
  return total ? done / total : 0;
}

export function jbn_taskIsFullyDone(task, memberId, targetDate) {
  const { total, done } = jbn_taskProgressCounts(task, memberId, targetDate);
  return total > 0 && done >= total;
}

// ============================================================
// 오늘 목록 만들기
// 반환 항목 형태:
//   { task, occurrenceDate, displayDate, kind: 'today'|'postponed_in'|'overdue' }
// kind = today: 원래 오늘 발생
//       postponed_in: 다른 날에서 오늘로 미뤘다
//       overdue: 과거 발생인데 미완료/미연기 (빨간 강조)
// ============================================================
export function jbn_buildTodayList(memberId, todayIso, lookbackDays = 60) {
  const list = [];
  const myTasks = jbnState.tasks.filter(t => jbn_isAssignee(t.id, memberId));

  for (const task of myTasks) {
    // 1) 오늘이 원래 발생일이면서, 내가 오늘 자를 미루지 않았으면 today
    if (jbn_isOccurrenceOn(task, todayIso)) {
      const isPostponedAway = jbn_postponedAwayBy(task.id, memberId, todayIso);
      if (!isPostponedAway) {
        list.push({ task, occurrenceDate: todayIso, displayDate: todayIso, kind: 'today' });
      }
    }
    // 2) 다른 어떤 발생일을 오늘로 미뤘으면 postponed_in (중복 방지: 위 kind:'today'와 같은 날일 일은 없음)
    const into = jbnState.postponements.filter(p =>
      p.task_id === task.id && p.member_id === memberId && p.postponed_to === todayIso);
    for (const p of into) {
      list.push({ task, occurrenceDate: p.original_date, displayDate: todayIso, kind: 'postponed_in' });
    }
    // 3) 과거 발생일 중 미완료 + 미연기 → overdue
    const pasts = jbn_pastOccurrences(task, todayIso, lookbackDays);
    for (const iso of pasts) {
      if (jbn_postponedAwayBy(task.id, memberId, iso)) continue;
      // 과거 그 날에 본인이 task 를 모두 완료했는지
      if (jbn_taskIsFullyDone(task, memberId, iso)) continue;
      // 이미 다른 항목으로 들어가있는지(같은 task + 같은 occurrenceDate) 체크
      if (list.some(x => x.task.id === task.id && x.occurrenceDate === iso)) continue;
      list.push({ task, occurrenceDate: iso, displayDate: iso, kind: 'overdue' });
    }
  }

  // 정렬: overdue(오래된 순) → today/postponed_in(task.sort_order)
  list.sort((a, b) => {
    if (a.kind === 'overdue' && b.kind !== 'overdue') return -1;
    if (b.kind === 'overdue' && a.kind !== 'overdue') return 1;
    if (a.kind === 'overdue' && b.kind === 'overdue') return a.occurrenceDate.localeCompare(b.occurrenceDate);
    // 같은 위치 -> sort_order
    return (a.task.sort_order || 0) - (b.task.sort_order || 0);
  });
  return list;
}

// ============================================================
// 한 사람의 오늘 진행률 (overdue 제외, 오늘 슬롯만 분모)
// ============================================================
export function jbn_personDailyProgress(memberId, todayIso) {
  const items = jbn_buildTodayList(memberId, todayIso, 0).filter(x => x.kind !== 'overdue');
  // 위에서 lookback=0 이라 overdue 안 들어옴.
  let total = 0, done = 0;
  for (const it of items) {
    const { total: t, done: d } = jbn_taskProgressCounts(it.task, memberId, it.occurrenceDate);
    total += t;
    done  += d;
  }
  return { total, done, ratio: total ? done / total : 0 };
}

// 어제까지 누적 미완료 (빨간 표시 통계)
export function jbn_overdueByMember(todayIso, lookbackDays = 60) {
  const map = {};
  for (const m of jbnState.members) {
    const items = jbn_buildTodayList(m.id, todayIso, lookbackDays).filter(x => x.kind === 'overdue');
    map[m.id] = items;
  }
  return map;
}

// 기간 통계: from~to (inclusive)
export function jbn_periodStats(memberId, fromIso, toIso) {
  const byDate = {};
  let totalSlots = 0, doneSlots = 0;
  let cursor = fromIso;
  while (cursor <= toIso) {
    const slotsToday = (() => {
      // 그 사람에게 그 날 발생했고 미루지 않은 task 들
      const myTasks = jbnState.tasks.filter(t => jbn_isAssignee(t.id, memberId));
      let s = 0, d = 0;
      for (const task of myTasks) {
        // 그 날 원래 발생 + 그 날을 미루지 않음 → 그 날 슬롯
        const occToday = jbn_isOccurrenceOn(task, cursor) && !jbn_postponedAwayBy(task.id, memberId, cursor);
        // 다른 날에서 그 날로 미뤘다면도 포함
        const inHere = jbnState.postponements.some(p =>
          p.task_id === task.id && p.member_id === memberId && p.postponed_to === cursor);
        if (!occToday && !inHere) continue;
        const occDate = inHere
          ? jbnState.postponements.find(p => p.task_id === task.id && p.member_id === memberId && p.postponed_to === cursor).original_date
          : cursor;
        const { total, done } = jbn_taskProgressCounts(task, memberId, occDate);
        s += total; d += done;
      }
      return { s, d };
    })();
    byDate[cursor] = { slots: slotsToday.s, done: slotsToday.d };
    totalSlots += slotsToday.s; doneSlots += slotsToday.d;
    cursor = jbn_addDays(cursor, 1);
  }
  return { totalSlots, doneSlots, ratio: totalSlots ? doneSlots / totalSlots : 0, byDate };
}
