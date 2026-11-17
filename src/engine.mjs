// Down Detector v1.2.0 - state transitions and alert decisions (pure, no I/O)

export const LEVEL_RANK = { ok: 0, maintenance: 1, unknown: 2, degraded: 3, down: 4 };

export const LABEL = {
  ok: 'RECOVERED',
  maintenance: 'MAINTENANCE',
  unknown: "CAN'T CHECK",
  degraded: 'DEGRADED',
  down: 'DOWN',
};

export function worst(levels) {
  let best = null;
  for (const l of levels) {
    if (best === null || (LEVEL_RANK[l] ?? 2) > (LEVEL_RANK[best] ?? 2)) best = l;
  }
  return best;
}

export function signature(result) {
  const ids = (result.incidents || []).map((i) => String(i.id)).sort().join(',');
  return `${result.level}|${ids}`;
}

const QUIET = new Set(['ok', 'maintenance']);

/**
 * Decide the new state for one service and whether it needs an alert.
 * prev is the stored state from the last run (or undefined on first run).
 */
export function evaluate(service, result, prev, defaults = {}, now = new Date().toISOString()) {
  const failThreshold = service.failThreshold ?? defaults.failThreshold ?? 1;
  const unknownThreshold = service.unknownThreshold ?? defaults.unknownThreshold ?? 3;
  const notifyMaintenance = service.notifyMaintenance ?? defaults.notifyMaintenance ?? false;

  const state = {
    failCount: 0,
    unknownCount: 0,
    alertedLevel: prev?.alertedLevel ?? null,
    alertedSig: prev?.alertedSig ?? null,
    since: prev?.since ?? now,
    lastChecked: now,
    lastResult: result,
  };

  if (result.level === 'skipped') {
    return { state: { ...state, alertedLevel: null, alertedSig: null }, change: null };
  }

  let hold = false;
  if (result.level === 'unknown') {
    state.unknownCount = (prev?.unknownCount ?? 0) + 1;
    if (state.unknownCount < unknownThreshold) hold = true;
  } else if ((service.type === 'http' || service.type === 'tcp') && (result.level === 'down' || result.level === 'degraded')) {
    state.failCount = (prev?.failCount ?? 0) + 1;
    if (state.failCount < failThreshold) hold = true;
  }

  const sig = signature(result);
  if (hold || sig === state.alertedSig) return { state, change: null };

  const from = state.alertedLevel;
  const to = result.level;
  if (from !== to) state.since = now;
  state.alertedLevel = to;
  state.alertedSig = sig;

  // First time we see this service: record a baseline, only alert if it's already bad.
  if (from === null && QUIET.has(to)) return { state, change: null };
  // ok <-> maintenance flips are noise unless asked for.
  if (!notifyMaintenance && QUIET.has(to) && (from === null || QUIET.has(from))) return { state, change: null };

  let kind;
  if (to === 'ok') kind = 'recovered';
  else if (from === to) kind = 'updated';
  else if ((LEVEL_RANK[to] ?? 2) > (LEVEL_RANK[from] ?? 0)) kind = 'worse';
  else kind = 'better';

  return {
    state,
    change: {
      id: service.id,
      name: service.name,
      group: service.group || '',
      from,
      to,
      kind,
      summary: result.summary || '',
      incidents: result.incidents || [],
      url: (result.incidents || []).find((i) => i.url)?.url || service.pageUrl || service.url || '',
      at: now,
    },
  };
}
