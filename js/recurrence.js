// ============================================================
// js/recurrence.js
//
// recurrence_data 형식:
//   daily          : {}
//   weekly         : { weekdays: [1,3,5] }              // 0=일~6=토
//   every_n_days   : { n: 3 }                           // start_date 기준
//
// 함수 jbn_isOccurrenceOn(task, isoDate) → boolean
// ============================================================

import {
  jbn_parseIso, jbn_diffDays, jbn_weekday, jbn_isoDate,
} from './util.js';

export function jbn_isOccurrenceOn(task, iso) {
  if (!task || !task.recurrence_type) return false;
  if (iso < task.start_date) return false;

  const t = task.recurrence_type;
  const data = task.recurrence_data || {};

  if (t === 'daily') return true;

  if (t === 'weekly') {
    const wd = jbn_weekday(iso);
    return Array.isArray(data.weekdays) && data.weekdays.includes(wd);
  }

  if (t === 'every_n_days') {
    const n = Math.max(1, Number(data.n) || 1);
    const diff = jbn_diffDays(iso, task.start_date);
    return diff >= 0 && (diff % n === 0);
  }

  return false;
}

// 사람이 읽을 라벨
export function jbn_recurrenceLabel(task) {
  const t = task.recurrence_type;
  const d = task.recurrence_data || {};
  if (t === 'daily') return '매일';
  if (t === 'weekly') {
    const names = ['일','월','화','수','목','금','토'];
    return '매주 ' + (d.weekdays || []).slice().sort().map(w => names[w]).join(',');
  }
  if (t === 'every_n_days') return `${d.n}일마다`;
  return '';
}

// 과거 어느 날부터 어제까지의 발생일 중, 미완료/미연기 건을 찾기 위해
// 발생일을 역순으로 반환. (lookbackDays 일 전까지)
export function jbn_pastOccurrences(task, todayIso, lookbackDays = 30) { // 30 = 완료기록 보관기간과 일치 (늘리면 phantom overdue 재발)
  const out = [];
  const start = task.start_date;
  for (let i = 1; i <= lookbackDays; i++) {
    const d = new Date(jbn_parseIso(todayIso));
    d.setDate(d.getDate() - i);
    const iso = jbn_isoDate(d);
    if (iso < start) break;
    if (jbn_isOccurrenceOn(task, iso)) out.push(iso);
  }
  return out; // 최신순
}
