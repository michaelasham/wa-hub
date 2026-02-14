/**
 * Selective Read Receipts (Blue Ticks)
 *
 * Marks chats as "seen" selectively to appear human-like without triggering restrictions.
 * Keep sendSeen: false on all sendMessage calls - we control when to mark seen manually.
 */

const config = require('../config');
const { formatPhoneForWhatsApp, extractPhoneNumber } = require('../utils');

// Tunable patterns for order-related detection
const ORDER_KEYWORDS = ['yes', 'confirm', 'ok', 'okay', 'no', 'cancel', 'تأكيد', 'إلغاء'];
const ORDER_NUMBER_REGEX = /#?\d{4,}/; // Order numbers: #11302, 12345

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Check if an incoming message is likely order-related (confirmations, cancellations, replies to our polls).
 * Tunable patterns: keywords, quoted messages, order number mentions.
 *
 * @param {object} msg - whatsapp-web.js Message
 * @returns {boolean}
 */
function isOrderRelatedMessage(msg) {
  if (!msg) return false;

  const text = ((msg.body || msg.text || '').trim()).toLowerCase();
  if (!text && msg.type !== 'poll_response') return false;

  // Reply/quote to our message - high likelihood order-related
  if (msg.hasQuotedMsg) return true;

  // Poll vote responses are always order-related
  if (msg.type === 'poll_response') return true;

  // Keyword match
  if (ORDER_KEYWORDS.some((kw) => text.includes(kw))) return true;

  // Order number pattern
  if (ORDER_NUMBER_REGEX.test(text)) return true;

  return false;
}

/**
 * Safely call chat.sendSeen(). Never throws.
 * Logs on error but does not crash.
 */
async function safeSendSeen(chat, logPrefix = '[wa-hub]') {
  if (!chat || typeof chat.sendSeen !== 'function') return;
  try {
    await chat.sendSeen();
  } catch (err) {
    const msg = err?.message || String(err);
    if (!msg.includes('Target closed') && !msg.includes('Execution context was destroyed')) {
      console.warn(`${logPrefix} [Seen] sendSeen failed:`, msg);
    }
  }
}

/**
 * Mark chat as seen after bot successfully sends a message.
 * Low-risk: we just interacted with the thread, marking seen is natural.
 * Optional 1-3s random delay to avoid instant-seen patterns.
 *
 * Integration: call after sendMessage/sendPoll success.
 */
async function markSeenAfterSend(client, chatId, logPrefix = '[wa-hub]') {
  if (!config.markSeenAfterSend || !client) return;

  const delayMin = config.markSeenAfterSendDelayMinMs ?? 1000;
  const delayMax = config.markSeenAfterSendDelayMaxMs ?? 3000;
  const delayMs = randomBetween(delayMin, delayMax);

  await sleep(delayMs);

  try {
    const chat = await client.getChatById(chatId).catch(() => null);
    if (chat) await safeSendSeen(chat, logPrefix);
  } catch {
    // Ignore - chat not found or client closed
  }
}

/**
 * Mark chat as seen on relevant incoming messages.
 * Low-risk: only for order-related messages, ~40% probability, with 2-6s reading delay.
 * Simulates human "I read it" behavior without marking everything.
 *
 * Integration: call from client.on('message') / processIncomingMessage.
 */
async function markSeenOnRelevantIncoming(client, message, logPrefix = '[wa-hub]') {
  if (!config.markSeenOnRelevantIncoming || !client) return;

  // Skip self, status, groups if not relevant
  if (message.fromMe) return;
  if (message.id?.remote === 'status@broadcast') return;

  if (!isOrderRelatedMessage(message)) return;

  // Probability gate
  const p = Math.min(1, Math.max(0, config.markSeenProbabilityIncoming ?? 0.4));
  if (Math.random() > p) return;

  const delayMin = config.readingDelayMinMs ?? 2000;
  const delayMax = config.readingDelayMaxMs ?? 6000;
  const delayMs = randomBetween(delayMin, delayMax);

  await sleep(delayMs);

  try {
    let chat = null;
    if (typeof message.getChat === 'function') {
      chat = await message.getChat().catch(() => null);
    }
    if (!chat && message.from) {
      const chatId = typeof message.from === 'string'
        ? message.from
        : (message.from._serialized || formatPhoneForWhatsApp(extractPhoneNumber(message.from)));
      if (chatId) chat = await client.getChatById(chatId).catch(() => null);
    }
    if (chat) await safeSendSeen(chat, logPrefix);
  } catch {
    // Ignore
  }
}

module.exports = {
  isOrderRelatedMessage,
  safeSendSeen,
  markSeenAfterSend,
  markSeenOnRelevantIncoming,
};
