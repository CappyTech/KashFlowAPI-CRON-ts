export function human(ms: number) {
  if (ms < 1000) return ms + ' ms';
  const sec = ms / 1000;
  if (sec < 60) return sec.toFixed(sec < 10 ? 2 : 1) + ' s';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const remMs = Math.floor(ms % 1000);
  if (sec < 3600) return m + 'm ' + s + 's' + (remMs ? ' ' + remMs + 'ms' : '');
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h + 'h ' + mm + 'm ' + s + 's';
}
