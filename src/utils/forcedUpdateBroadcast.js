/**
 * Guards for the admin "force update" broadcast.
 *
 * On 31 Jul 2026 a single `notifications/global` document holding
 * `{ active: true, type: 'update', forced: true }` reloaded every client on
 * every page load, forever: nothing compared the demanded version against the
 * version already running, and the document had no expiry. Recovery required
 * editing Firestore by hand while every user sat in a reload loop.
 *
 * Every clause here is a loop stopper, so all of them fail closed — when the
 * broadcast is ambiguous the caller shows a toast instead of reloading.
 */

export const FORCE_RELOAD_TTL_MS = 15 * 60 * 1000;
export const FORCE_RELOAD_MAX_AGE_MS = 30 * 60 * 1000;
export const FORCE_RELOAD_MARKER_KEY = 'iswmp_forced_reload';

/** Accepts Firestore Timestamps, Dates, and ISO strings alike. */
export function broadcastMillis(value) {
  if (value == null) return NaN;
  if (typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    return typeof millis === 'number' ? millis : NaN;
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}

export function forcedBroadcastMarker(notification) {
  const target = notification?.version ?? notification?.latest;
  return `${target}:${broadcastMillis(notification?.timestamp)}`;
}

export function shouldForceReload(notification, options = {}) {
  const {
    appVersion,
    nowMs = Date.now(),
    storage = typeof globalThis !== 'undefined'
      ? globalThis.sessionStorage
      : null,
  } = options;

  if (!notification || notification.forced !== true) return false;
  if (typeof appVersion !== 'string' || !appVersion) return false;
  if (!Number.isFinite(nowMs)) return false;

  // An unnamed target cannot be compared against what we already run, which is
  // exactly how a broadcast reloads a client that is already up to date.
  const target = notification.version ?? notification.latest;
  if (typeof target !== 'string' || !target) return false;
  if (target === appVersion) return false;

  const expiresAtMs = broadcastMillis(notification.expiresAt);
  if (Number.isFinite(expiresAtMs)) {
    if (nowMs >= expiresAtMs) return false;
  } else {
    // Broadcasts written before expiry support existed age out instead.
    const issuedAtMs = broadcastMillis(notification.timestamp);
    if (!Number.isFinite(issuedAtMs)) return false;
    if (issuedAtMs > nowMs) return false;
    if (nowMs - issuedAtMs > FORCE_RELOAD_MAX_AGE_MS) return false;
  }

  // One reload per broadcast per tab. If reloading does not actually change the
  // running version, the next pass stops here instead of looping.
  const marker = forcedBroadcastMarker(notification);
  try {
    if (!storage) return false;
    if (storage.getItem(FORCE_RELOAD_MARKER_KEY) === marker) return false;
    storage.setItem(FORCE_RELOAD_MARKER_KEY, marker);
  } catch {
    return false;
  }

  return true;
}
