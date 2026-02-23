/**
 * Inbound event buffer during SYNCING mode.
 * Message/vote events are buffered and flushed when mode returns to NORMAL.
 */

const config = require('../config');

const buffer = [];
const MAX = config.inboundMaxBuffer;
const BATCH = config.inboundFlushBatch;
const INTERVAL_MS = config.inboundFlushIntervalMs;

function push(entry) {
  if (buffer.length >= MAX) {
    buffer.shift();
  }
  buffer.push({
    ...entry,
    ts: entry.ts || new Date().toISOString(),
  });
}

function getCount() {
  return buffer.length;
}

function getBuffer() {
  return [...buffer];
}

/**
 * Flush up to BATCH items, calling deliverFn for each.
 * @param { (entry: object) => Promise<void> } deliverFn
 * @returns { Promise<{ sent: number, failed: number }> }
 */
async function flushBatch(deliverFn) {
  let sent = 0;
  let failed = 0;
  const toSend = buffer.splice(0, BATCH);
  for (const entry of toSend) {
    try {
      await deliverFn(entry);
      sent++;
    } catch (err) {
      failed++;
      buffer.unshift(entry);
      console.error(`[InboundBuffer] flush failed for ${entry.instanceId} ${entry.eventType}:`, err?.message);
    }
  }
  return { sent, failed };
}

/**
 * Flush all in batches with INTERVAL_MS between batches.
 */
async function flushAll(deliverFn) {
  let totalSent = 0;
  let totalFailed = 0;
  while (buffer.length > 0) {
    const { sent, failed } = await flushBatch(deliverFn);
    totalSent += sent;
    totalFailed += failed;
    if (buffer.length > 0 && INTERVAL_MS > 0) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }
  return { sent: totalSent, failed: totalFailed };
}

module.exports = {
  push,
  getCount,
  getBuffer,
  flushBatch,
  flushAll,
  MAX,
  BATCH,
  INTERVAL_MS,
};
