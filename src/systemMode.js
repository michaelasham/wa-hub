/**
 * Global system mode for low-power during QR/auth/sync.
 * NORMAL = no instance in connecting/needs_qr (with grace for needs_qr); SYNCING = at least one instance in those states.
 * NEEDS_QR only keeps SYNCING for QR_SYNC_GRACE_MS so a stuck instance doesn't hold the system.
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

const emitter = new EventEmitter();
emitter.setMaxListeners(20);

function getSystemMode() {
  return { ...state };
}

function setSystemMode(mode, meta = {}) {
  const prev = state.mode;
  state = {
    mode,
    since: new Date(),
    syncingInstanceId: meta.syncingInstanceId ?? state.syncingInstanceId,
  };
  if (prev !== mode) {
    console.log(`[SystemMode] ${prev} -> ${mode}${state.syncingInstanceId ? ` (syncing: ${state.syncingInstanceId})` : ''}`);
    emitter.emit('mode', { mode: state.mode, since: state.since, syncingInstanceId: state.syncingInstanceId });
  }
  return state;
}

/** Call when an instance enters CONNECTING or NEEDS_QR. */
function enterSyncing(instanceId) {
  setSystemMode(SystemMode.SYNCING, { syncingInstanceId: instanceId });
}

/** Call when no instance is in CONNECTING/NEEDS_QR (recompute from instance list). */
function recomputeFromInstances(getInstancesFn) {
  const instances = getInstancesFn();
  const now = Date.now();
  const graceMs = config.qrSyncGraceMs || 30000;

  const syncing = instances.find((i) => {
    if (i.state === 'starting_browser' || i.state === 'connecting') return true;
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
  enterSyncing,
  recomputeFromInstances,
  shouldRunBackgroundTask,
  on: emitter.on.bind(emitter),
  off: emitter.off.bind(emitter),
};
