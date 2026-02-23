/**
 * Sequential restore scheduler: prevents stampede on server start.
 * Restores one instance at a time with cooldown and memory gating.
 */

const os = require('os');
const config = require('./config');

const queue = [];
let processing = false;
let lastProcessedAt = null;
let schedulerIntervalId = null;

function getFreeMemMB() {
  return Math.floor(os.freemem() / 1048576);
}

function getQueueState() {
  return {
    queueLength: queue.length,
    processing,
    lastProcessedAt: lastProcessedAt ? lastProcessedAt.toISOString() : null,
    freeMemMB: getFreeMemMB(),
    minFreeMemMB: config.restoreMinFreeMemMb,
    queueSummary: queue.map((i) => ({ type: i.type || 'restore', id: i.id || i.instanceId, attempts: i.attempts || 0 })),
  };
}

/**
 * Enqueue an instance to restore. Item = { id, name, webhookUrl, webhookEvents, typingIndicatorEnabled, applyTypingTo, attempts? }.
 */
function enqueue(item) {
  queue.push({
    ...item,
    type: item.type || 'restore',
    attempts: item.attempts != null ? item.attempts : 0,
    enqueuedAt: new Date(),
  });
}

/**
 * Enqueue a retry for an existing instance (ERROR/FAILED_QR_TIMEOUT). Processed by scheduler like restore.
 */
function enqueueRetry(instanceId) {
  queue.push({ type: 'retry', instanceId, enqueuedAt: new Date(), attempts: 0 });
}

/**
 * Process the next item in the queue: wait for memory gate + cooldown, then invoke createFn(item).
 * On reject, re-enqueue with backoff until max attempts; then call markFailedFn(item, message).
 * @param {Function} createFn - (item) => Promise
 * @param {Function} [markFailedFn] - (item, message) => void - when max attempts reached
 */
async function processNext(createFn, markFailedFn) {
  if (processing || queue.length === 0) return;
  const cooldownMs = config.restoreCooldownMs || 30000;
  if (lastProcessedAt) {
    const elapsed = Date.now() - lastProcessedAt.getTime();
    if (elapsed < cooldownMs) return;
  }
  const minFreeMb = config.restoreMinFreeMemMb ?? 800;
  if (getFreeMemMB() < minFreeMb) {
    return;
  }
  const now = Date.now();
  const idx = queue.findIndex((i) => !i.nextAttemptAfter || new Date(i.nextAttemptAfter).getTime() <= now);
  if (idx < 0) return;
  const item = queue.splice(idx, 1)[0];
  processing = true;
  try {
    await createFn(item);
    lastProcessedAt = new Date();
  } catch (err) {
    if (item.type === 'retry') {
      console.error(`[RestoreScheduler] Retry ${item.instanceId} failed: ${err.message}`);
      lastProcessedAt = new Date();
      processing = false;
      return;
    }
    const attempts = (item.attempts || 0) + 1;
    const maxAttempts = config.restoreMaxAttempts ?? 5;
    if (attempts >= maxAttempts) {
      console.error(`[RestoreScheduler] ${item.id} failed after ${maxAttempts} attempts: ${err.message}. Marking ERROR.`);
      if (typeof markFailedFn === 'function') {
        markFailedFn(item, `RESTORE_MAX_ATTEMPTS: ${err.message}`);
      }
    } else {
      const backoffBase = config.restoreBackoffBaseMs ?? 15000;
      const backoffMs = Math.min(backoffBase * Math.pow(2, attempts - 1), 120000);
      item.attempts = attempts;
      item.nextAttemptAfter = new Date(Date.now() + backoffMs);
      queue.push(item);
      console.warn(`[RestoreScheduler] ${item.id} attempt ${attempts}/${maxAttempts} failed. Re-queued (next in ${Math.round(backoffMs / 1000)}s). ${err.message}`);
    }
    lastProcessedAt = new Date();
  } finally {
    processing = false;
  }
}

/**
 * Start the scheduler loop: every 10s try to process next (memory gate + cooldown inside processNext).
 * Idempotent: only starts once.
 */
function startSchedulerLoop(createFn, markFailedFn) {
  if (schedulerIntervalId != null) return;
  const intervalMs = 10000;
  schedulerIntervalId = setInterval(() => {
    processNext(createFn, markFailedFn).catch((err) => {
      console.error('[RestoreScheduler] processNext error:', err.message);
    });
  }, intervalMs);
  console.log(`[RestoreScheduler] Started (concurrency=1, cooldown=${config.restoreCooldownMs}ms, minFreeMem=${config.restoreMinFreeMemMb}MB)`);
}

function getQueue() {
  return [...queue];
}

module.exports = {
  enqueue,
  enqueueRetry,
  getQueueState,
  getQueue,
  processNext,
  startSchedulerLoop,
  getFreeMemMB,
};
