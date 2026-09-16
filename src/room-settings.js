export function initialEnvironment(seed) {
  return { hour: 8 + (seed % 800) / 100, at: Date.now(), rate: 0.04,
    paused: false, fog: 0, moonlight: 0.5, winter: false, snowCover: 0.75,
    snowfall: 0.4, revision: 0, author: '' };
}

export function validEnvironmentChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return false;
  return Object.entries(changes).every(([key, value]) => {
    if (['winter', 'paused'].includes(key)) return typeof value === 'boolean';
    if (key === 'hour') return Number.isFinite(value) && value >= 0 && value < 24;
    if (key === 'rate') return [0.04, 0.1].includes(value);
    if (['fog', 'moonlight', 'snowCover', 'snowfall'].includes(key)) return Number.isFinite(value) && value >= 0 && value <= 1;
    return false;
  });
}

export function advanceEnvironment(environment, now = Date.now()) {
  return { ...environment, at: now,
    hour: ((environment.hour + (environment.paused ? 0 : Math.max(0, now - environment.at) / 1000 * environment.rate)) % 24 + 24) % 24 };
}
