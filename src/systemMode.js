/**
 * Global system mode for low-power during QR/auth/sync.
 * NORMAL = no instance in connecting/needs_qr (with grace for needs_qr); SYNCING = at least one instance in those states.
 * NEEDS_QR only keeps SYNCING for QR_SYNC_GRACE_MS. CONNECTING/starting_browser only keep SYNCING for SYNCING_MAX_MS (default 1h)
 * so a stuck instance doesn't hold the system in low power mode forever.
 */

const EventEmitter = require('events');
const config = require('./config');

const SystemMode = {
  NORMAL: 'normal',
  SYNCING: 'syncing',
};

let state = {
  mode: SystemMode.NORMAL,
  since: null,
  syncingInstanceId: null,
};

/** After user clicks "Cancel low power mode", don't re-enter SYNCING until this time (ms). */
let userForceNormalUntil = 0;

const emitter = new EventEmitter();
emitter.setMaxListeners(20);

function getSystemMode() {
  return { ...state, userForceNormalUntil: userForceNormalUntil > 0 ? userForceNormalUntil : null };
}

function setSystemMode(mode, meta = {}) {
  const prev = state.mode;
  const nextSyncingId = mode === SystemMode.NORMAL ? null : (meta.syncingInstanceId ?? state.syncingInstanceId);
  state = {
    mode,
    since: new Date(),
    syncingInstanceId: nextSyncingId,
  };
  if (prev !== mode) {
    console.log(`[SystemMode] ${prev} -> ${mode}${state.syncingInstanceId ? ` (syncing: ${state.syncingInstanceId})` : ''}`);
    emitter.emit('mode', { mode: state.mode, since: state.since, syncingInstanceId: state.syncingInstanceId });
  }
  return state;
}

/** Force NORMAL and ignore syncing instances for cooldownMs (so low power doesn't kick back in). */
function forceNormal(cooldownMs = 0) {
  userForceNormalUntil = cooldownMs > 0 ? Date.now() + cooldownMs : 0;
  setSystemMode(SystemMode.NORMAL, {});
  if (cooldownMs > 0) {
    console.log(`[SystemMode] User forced NORMAL; will not re-enter SYNCING for ${Math.round(cooldownMs / 60000)} minutes`);
  }
}

/** Call when an instance enters CONNECTING or NEEDS_QR. No-op if user recently forced NORMAL (cooldown). */
function enterSyncing(instanceId) {
  if (Date.now() < userForceNormalUntil) return;
  setSystemMode(SystemMode.SYNCING, { syncingInstanceId: instanceId });
}

/** Call when no instance is in CONNECTING/NEEDS_QR (recompute from instance list). Respects user force-normal cooldown. */
function recomputeFromInstances(getInstancesFn) {
  const instances = getInstancesFn();
  const now = Date.now();
  if (now < userForceNormalUntil) return; // User cancelled low power; don't re-enter SYNCING until cooldown expires

  const graceMs = config.qrSyncGraceMs || 30000;
  const syncingMaxMs = config.syncingMaxMs || 3600000; // cap so stuck CONNECTING/starting_browser don't hold SYNCING forever

  const syncing = instances.find((i) => {
    if (i.state === 'starting_browser' || i.state === 'connecting') {
      const since = i.lastStateChangeAt ? new Date(i.lastStateChangeAt).getTime() : 0;
      return since > 0 && (now - since) <= syncingMaxMs;
    }
    if (i.state === 'needs_qr') {
      const since = i.needsQrSince ? new Date(i.needsQrSince).getTime() : 0;
      return since > 0 && (now - since) <= graceMs;
    }
    return false;
  });

  if (syncing) {
    if (state.mode !== SystemMode.SYNCING) setSystemMode(SystemMode.SYNCING, { syncingInstanceId: syncing.id });
  } else {
    if (state.mode !== SystemMode.NORMAL) setSystemMode(SystemMode.NORMAL, {});
  }
}

function shouldRunBackgroundTask(taskName) {
  if (state.mode === SystemMode.SYNCING) return false;
  return true;
}

module.exports = {
  SystemMode,
  getSystemMode,
  setSystemMode,
  forceNormal,
  enterSyncing,
  recomputeFromInstances,
  shouldRunBackgroundTask,
  on: emitter.on.bind(emitter),
  off: emitter.off.bind(emitter),
};
