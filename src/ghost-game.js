import { advanceEnvironment } from './room-settings.js';

export function ghostNight(environment, now = Date.now()) {
  const e = { hour: 12, at: now, rate: 0.04, paused: false, ...environment };
  const hour = advanceEnvironment(e, now).hour;
  const night = hour >= 18 || hour < 6;
  return { night, sunrise: night && !e.paused && e.rate > 0 ? now + (hour < 6 ? 6 - hour : 30 - hour) / e.rate * 1000 : null };
}

// Keep the browser's ghost-motion.js identical: both sides evaluate the same
// public orbit from room time, rather than streaming frame-by-frame positions.
export function ghostPosition(ghost, now) {
  const t = Math.max(0, (now - ghost.at) / 1000);
  const lat = ghost.latitude + Math.sin(t * 0.45 + ghost.phase) * 0.08;
  const lon = ghost.phase + t * ghost.speed;
  const radius = 26.2 + Math.sin(t * 0.9 + ghost.phase) * 0.3;
  return [Math.cos(lat) * Math.cos(lon) * radius, Math.sin(lat) * radius, Math.cos(lat) * Math.sin(lon) * radius];
}

export function makeGhosts(now) {
  const turn = Math.random() * Math.PI * 2;
  return Array.from({ length: 18 }, (_, i) => ({ id: crypto.randomUUID(), at: now,
    latitude: Math.asin(1 - 2 * (i + 0.5) / 18) * 0.8, phase: turn + i * 2.3999632297,
    speed: (i % 2 ? 1 : -1) * (0.022 + (i % 4) * 0.003), hiddenUntil: 0 }));
}
