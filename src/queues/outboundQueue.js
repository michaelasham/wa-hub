/**
 * Outbound action queue during SYNCING mode.
 * Actions are enqueued when system mode is SYNCING; drained when NORMAL.
 */

const config = require('../config');

const queue = [];
const MAX = config.maxOutboundQueue;
const TTL_MS = config.outboundQueueTtlMs;
const DRAIN_DELAY_MS = config.outboundDrainDelayMs;

function enqueue(actionType, instanceId, payload, requestedAt = Date.now()) {
  if (queue.length >= MAX) return { ok: false, reason: 'queue_full' };
  const item = { actionType, instanceId, payload, requestedAt };
  queue.push(item);
  return { ok: true, queueId: queue.length, queued: true };
}

function getCount() {
  return queue.length;
}

/** Per-instance count of queued outbound items. */
function getCountByInstance() {
  const byId = {};
  for (const item of queue) {
    byId[item.instanceId] = (byId[item.instanceId] || 0) + 1;
  }
  return byId;
}

function getQueue() {
  return [...queue];
}

/** Drop items older than TTL. */
function dropExpired() {
  const now = Date.now();
  let dropped = 0;
  while (queue.length > 0 && now - queue[0].requestedAt > TTL_MS) {
    queue.shift();
    dropped++;
  }
  return dropped;
}

/**
 * Drain queue sequentially with delay between items.
 * @param { (item: object) => Promise<any> } executor - runs one action
 * @returns { Promise<{ processed: number, failed: number }> }
 */
async function drain(executor) {
  dropExpired();
  let processed = 0;
  let failed = 0;
  while (queue.length > 0) {
    const item = queue.shift();
    if (Date.now() - item.requestedAt > TTL_MS) continue;
    try {
      await executor(item);
      processed++;
    } catch (err) {
      failed++;
      console.error(`[OutboundQueue] drain failed for ${item.actionType} ${item.instanceId}:`, err?.message);
    }
    if (queue.length > 0 && DRAIN_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, DRAIN_DELAY_MS));
    }
  }
  return { processed, failed };
}

module.exports = {
  enqueue,
  getCount,
  getCountByInstance,
  getQueue,
  dropExpired,
  drain,
  MAX,
  TTL_MS,
};
