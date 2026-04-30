// ============================================================
// js/interactions.js
//   1) 오디오 unlock (iOS 사용자 인터랙션 후 1회 재생 → 유지)
//   2) 스와이프(좌→우 = 완료 / 우→좌 = 미루기 메뉴)
//   3) 햄버거 드래그 정렬 (fixed 포지션으로 위치 버그 수정)
// ============================================================

import { JBN_CONFIG } from './config.js';

// ============================================================
// 1) Audio
// ============================================================
let jbn_audioUnlocked = false;
let jbn_audioBuffer   = null;
let jbn_audioCtx      = null;

function jbn_makeCtx() {
  if (jbn_audioCtx) return jbn_audioCtx;
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  jbn_audioCtx = new C();
  return jbn_audioCtx;
}

async function jbn_loadBuffer() {
  const ctx = jbn_makeCtx();
  if (!ctx) return;
  try {
    const url = encodeURI(JBN_CONFIG.completionSoundFile);
    const res = await fetch(url);
    const ab  = await res.arrayBuffer();
    jbn_audioBuffer = await new Promise((ok, no) => ctx.decodeAudioData(ab, ok, no));
  } catch (e) {
    console.warn('audio load fail', e);
  }
}

export async function jbn_unlockAudio() {
  if (jbn_audioUnlocked) return;
  const ctx = jbn_makeCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch {}
  }
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch {}
  if (!jbn_audioBuffer) await jbn_loadBuffer();
  jbn_audioUnlocked = true;
}

export function jbn_playCompleteSound() {
  if (!jbn_audioUnlocked) return;
  const ctx = jbn_audioCtx;
  if (!ctx || !jbn_audioBuffer) return;
  try {
    const src = ctx.createBufferSource();
    src.buffer = jbn_audioBuffer;
    src.connect(ctx.destination);
    src.start(0);
  } catch (e) { console.warn(e); }
}

['pointerdown','touchstart','click','keydown'].forEach(ev => {
  window.addEventListener(ev, () => jbn_unlockAudio(), { once: true, passive: true });
});

// ============================================================
// 2) 스와이프
// ============================================================
export function jbn_attachSwipe(el, { onSwipeLeft, onSwipeRight }) {
  let startX = 0, startY = 0, t0 = 0, active = false;
  const TH = 60;
  const VR = 35;
  const TI = 700;

  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX; startY = e.touches[0].clientY; t0 = Date.now(); active = true;
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (!active) return;
    const dx = e.touches[0].clientX - startX;
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dy > VR) { active = false; el.style.transform = ''; return; }
    el.style.transform = `translateX(${dx}px)`;
    el.style.transition = 'none';
  }, { passive: true });

  el.addEventListener('touchend', e => {
    if (!active) return;
    active = false;
    const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
    const dy = Math.abs((e.changedTouches[0]?.clientY ?? startY) - startY);
    const dt = Date.now() - t0;
    el.style.transition = 'transform .18s';
    el.style.transform  = '';
    if (dt > TI || dy > VR) return;
    if (dx >  TH && onSwipeRight) onSwipeRight();
    else if (dx < -TH && onSwipeLeft)  onSwipeLeft();
  }, { passive: true });

  let mDown = false, mX = 0;
  el.addEventListener('mousedown', e => { mDown = true; mX = e.clientX; });
  el.addEventListener('mousemove', e => {
    if (!mDown) return;
    el.style.transform = `translateX(${e.clientX - mX}px)`;
    el.style.transition = 'none';
  });
  const finish = e => {
    if (!mDown) return; mDown = false;
    const dx = (e.clientX || 0) - mX;
    el.style.transition = 'transform .18s';
    el.style.transform = '';
    if (dx >  TH && onSwipeRight) onSwipeRight();
    else if (dx < -TH && onSwipeLeft)  onSwipeLeft();
  };
  el.addEventListener('mouseup', finish);
  el.addEventListener('mouseleave', finish);
}

// ============================================================
// 3) 드래그 정렬
//
// 핵심 수정: position:fixed + pageY 기준으로 정확한 위치 계산.
// absolute 는 offsetParent 기준이라 스크롤 있으면 붕 뜨는 버그 발생.
// fixed 는 항상 뷰포트 기준이라 정확함.
//
// 실시간 동기화 재렌더 차단: jbn_dragLockState.locked = true 동안
// render.js 가 paint 를 미룸.
// ============================================================
export const jbn_dragLockState = { locked: false };

export function jbn_attachDragSort(container, onCommit) {
  let dragging     = null;
  let placeholder  = null;
  let dragOffsetY  = 0;  // 핸들 클릭 지점과 row 상단의 거리

  function onHandleStart(e, row) {
    e.preventDefault();
    e.stopPropagation();

    const clientY = e.touches?.[0]?.clientY ?? e.clientY;
    const rowRect  = row.getBoundingClientRect();

    dragging = row;
    dragOffsetY = clientY - rowRect.top;
    jbn_dragLockState.locked = true;

    // placeholder: 원래 자리에 빈 공간 유지
    placeholder = document.createElement('div');
    placeholder.className = 'jbn-drag-placeholder';
    placeholder.style.height = rowRect.height + 'px';
    row.parentNode.insertBefore(placeholder, row);

    // 드래그 중 row: fixed 로 뷰포트 기준 배치
    row.classList.add('jbn-dragging');
    row.style.position = 'fixed';
    row.style.left     = rowRect.left + 'px';
    row.style.width    = rowRect.width + 'px';
    row.style.top      = (clientY - dragOffsetY) + 'px';
    row.style.zIndex   = '9999';
    row.style.margin   = '0';

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend',  onEnd);
  }

  function onMove(e) {
    if (!dragging) return;
    e.preventDefault?.();
    const clientY = e.touches?.[0]?.clientY ?? e.clientY;

    // row 위치 갱신
    dragging.style.top = (clientY - dragOffsetY) + 'px';

    // placeholder 위치: 다른 row 들의 중간점 비교
    const rows = Array.from(container.children).filter(c => c !== dragging && c !== placeholder);
    let inserted = false;
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        container.insertBefore(placeholder, r);
        inserted = true;
        break;
      }
    }
    if (!inserted) container.appendChild(placeholder);
  }

  function onEnd() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onEnd);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend',  onEnd);
    if (!dragging) return;

    // row 를 placeholder 자리로 복원
    container.insertBefore(dragging, placeholder);
    placeholder.remove();

    // 스타일 초기화
    dragging.classList.remove('jbn-dragging');
    dragging.style.position = '';
    dragging.style.left     = '';
    dragging.style.top      = '';
    dragging.style.width    = '';
    dragging.style.zIndex   = '';
    dragging.style.margin   = '';

    const orderedIds = Array.from(container.children)
      .map(c => c.dataset.dragId).filter(Boolean);

    dragging   = null;
    placeholder = null;

    // 락 해제는 약간 지연 (마지막 paint 완료 후)
    setTimeout(() => { jbn_dragLockState.locked = false; }, 60);
    onCommit(orderedIds);
  }

  container.addEventListener('mousedown', e => {
    if (!e.target.closest('[data-drag-handle]')) return;
    const row = e.target.closest('[data-drag-id]');
    if (row) onHandleStart(e, row);
  });
  container.addEventListener('touchstart', e => {
    if (!e.target.closest('[data-drag-handle]')) return;
    const row = e.target.closest('[data-drag-id]');
    if (row) onHandleStart(e, row);
  }, { passive: false });
}
