// ============================================================
// js/config.js
// Supabase 프로젝트 정보. 깃허브에 그대로 올려도 OK.
// 이 키만으로는 RLS 때문에 jibannil_* 테이블 접근 불가.
// ============================================================

export const JBN_CONFIG = {
  // Supabase 콘솔 → Project Settings → API → Project URL
  supabaseUrl: 'https://qtmdwcndafncqixzpsxa.supabase.co',

  // 같은 화면 → "anon public" key
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0bWR3Y25kYWZuY3FpeHpwc3hhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0MDcwMTQsImV4cCI6MjA5Mjk4MzAxNH0.HGKKm4lJ40HkXZ160IajtLdGQyhKAmcoD8JsD9Mngro',

  // 하루의 시작 시각(시). 새벽 4시 = 이전 날의 연장.
  dayStartHour: 4,

  // 완료 효과음 파일명. 루트(index.html 옆)에 둘 것.
  completionSoundFile: 'effect 1.mp3',

  // JWT 갱신 안전 마진(초). 만료 이 시간 전에 미리 refresh.
  jwtRefreshLeadSeconds: 90,
};
