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

function jbn_postponedAwayBy(taskId, memberId, originalDate, todayIso) {
  return jbnState.postponements.some(p => {
    if (p.task_id !== taskId || p.member_id !== memberId || p.original_date !== originalDate) return false;
    // 오늘 일을 미뤘다가 오늘로 복귀한 경우(original_date === todayIso === postponed_to) → away 아님
    if (originalDate === todayIso && p.postponed_to === todayIso) return false;
    return true;
  });
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
      const isPostponedAway = jbn_postponedAwayBy(task.id, memberId, todayIso, todayIso);
      if (!isPostponedAway) {
        list.push({ task, occurrenceDate: todayIso, displayDate: todayIso, kind: 'today' });
      }
    }
    // 2) 다른 어떤 발생일을 오늘로 미뤘으면
    //    - original_date === todayIso : 원래 오늘 일을 미뤘다 복귀 → today 로 처리
    //    - original_date < todayIso  : 과거 미이행일을 오늘로 미룬 것 → overdue 딱지 유지
    const into = jbnState.postponements.filter(p =>
      p.task_id === task.id && p.member_id === memberId && p.postponed_to === todayIso);
    for (const p of into) {
      if (p.original_date === todayIso) {
        // 원래 오늘 발생일인 일을 미뤘다 복귀 → today 로 편입
        if (!list.some(x => x.task.id === task.id && x.occurrenceDate === todayIso)) {
          list.push({ task, occurrenceDate: todayIso, displayDate: todayIso, kind: 'today' });
        }
      } else {
        // 과거 미이행일을 오늘로 미룬 것 → 미이행 딱지 유지
        list.push({ task, occurrenceDate: p.original_date, displayDate: todayIso, kind: 'overdue_in' });
      }
    }
    // 3) 과거 발생일 중 미완료 + 미연기 → overdue
    const pasts = jbn_pastOccurrences(task, todayIso, lookbackDays);
    for (const iso of pasts) {
      if (jbn_postponedAwayBy(task.id, memberId, iso, todayIso)) continue;
      // 이미 다른 항목으로 들어가있는지(같은 task + 같은 occurrenceDate) 체크
      if (list.some(x => x.task.id === task.id && x.occurrenceDate === iso)) continue;
      list.push({ task, occurrenceDate: iso, displayDate: iso, kind: 'overdue' });
    }
    // 4) 미래로 미뤄진 항목 → postponed_future
    //    (오늘 이후 날짜로 미뤄진 postponements 레코드)
    const futurePostponed = jbnState.postponements.filter(p =>
      p.task_id === task.id && p.member_id === memberId && p.postponed_to > todayIso
    );
    for (const p of futurePostponed) {
      // 이미 목록에 없으면 추가
      if (list.some(x => x.task.id === task.id && x.occurrenceDate === p.original_date && x.kind === 'postponed_future')) continue;
      list.push({ task, occurrenceDate: p.original_date, displayDate: p.postponed_to, kind: 'postponed_future' });
    }
  }

  // 정렬: overdue(오래된 순) → today/postponed_in(sort_order) → postponed_future(날짜순)
  list.sort((a, b) => {
    const rankKind = k => (k === 'overdue' || k === 'overdue_in') ? 0 : k === 'postponed_future' ? 2 : 1;
    const ra = rankKind(a.kind), rb = rankKind(b.kind);
    if (ra !== rb) return ra - rb;
    if (a.kind === 'overdue') return a.occurrenceDate.localeCompare(b.occurrenceDate);
    if (a.kind === 'postponed_future') return a.displayDate.localeCompare(b.displayDate);
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
  // 미완료 누적 = 과거 발생일 중 완료 기록이 없는 슬롯.
  // 미뤘는지(postpone) 여부와 무관하게, 실제로 완료되지 않은 것만 카운트.
  const map = {};
  for (const m of jbnState.members) {
    const items = [];
    const myTasks = jbnState.tasks.filter(t =>
      jbnState.task_assignees.some(a => a.task_id === t.id && a.member_id === m.id)
    );
    for (const task of myTasks) {
      const pasts = jbn_pastOccurrences(task, todayIso, lookbackDays);
      for (const iso of pasts) {
        // 해당 발생일에 완료 기록이 하나라도 없으면 미완료
        const slots = jbn_taskSlots(task.id);
        const allDone = slots.every(s =>
          jbnState.completions.some(c =>
            c.task_id === task.id &&
            (c.checklist_id || null) === (s.checklistId || null) &&
            c.member_id === m.id &&
            c.target_date === iso
          )
        );
        if (!allDone) {
          items.push({ task, occurrenceDate: iso });
        }
      }
    }
    // 오래된 순 정렬
    items.sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
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
        const occToday = jbn_isOccurrenceOn(task, cursor) && !jbn_postponedAwayBy(task.id, memberId, cursor, cursor);
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
