/**
 * Typing Indicator Utility
 * Simulates human typing before sending messages to make conversations feel natural
 */

const config = require('../config');

/**
 * Sleep utility with timeout safety
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Redact chatId for logging (show only last 4 digits)
 */
function redactChatId(chatId) {
  if (!chatId) return 'unknown';
  const str = String(chatId);
  if (str.length <= 4) return '****';
  return '***' + str.slice(-4);
}

/**
 * Compute typing duration (random between MIN and MAX, clamped to MAX_TOTAL)
 */
function computeTypingDuration() {
  const min = config.typingIndicatorMinMs || 600;
  const max = config.typingIndicatorMaxMs || 1800;
  const maxTotal = config.typingIndicatorMaxTotalMs || 2500;
  
  // Random duration between min and max
  const randomMs = Math.floor(Math.random() * (max - min + 1)) + min;
  
  // Clamp to maxTotal
  return Math.min(randomMs, maxTotal);
}

/**
 * Get chat and apply typing indicator before sending
 * @param {Client} client - WhatsApp client
 * @param {string} chatId - Chat ID (phone number with @c.us)
 * @param {Function} sendFn - Function that performs the actual send (returns Promise)
 * @param {Object} options - Options
 * @param {boolean} options.enabled - Whether typing is enabled
 * @param {number} options.timeoutMs - Maximum total time for typing + send (default: 2500ms)
 * @param {string} options.instanceName - Instance name for logging
 * @returns {Promise} Result of sendFn
 */
async function withTypingIndicator(client, chatId, sendFn, options = {}) {
  const {
    enabled = true,
    timeoutMs = config.typingIndicatorMaxTotalMs || 2500,
    instanceName = 'unknown',
  } = options;

  if (!enabled) {
    return sendFn();
  }

  // Safety: If client is null or not ready, skip typing
  if (!client) {
    console.log(`[${instanceName}] [Typing] Skipped: client not available (chatId: ${redactChatId(chatId)})`);
    return sendFn();
  }

  let chat = null;
  let typingMs = 0;
  let applied = false;
  let skipReason = null;

  try {
    // Get chat
    try {
      chat = await client.getChatById(chatId);
      if (!chat) {
        skipReason = 'chat_not_found';
        throw new Error('Chat not found');
      }
    } catch (error) {
      // Chat not found or error - skip typing but still send
      skipReason = 'chat_get_failed';
      console.log(`[${instanceName}] [Typing] Skipped: ${skipReason} (chatId: ${redactChatId(chatId)}, error: ${error.message})`);
      return sendFn();
    }

    // Check if chat is a group (we typically don't want typing in groups)
    // whatsapp-web.js Chat object has an `isGroup` property
    if (chat.isGroup) {
      skipReason = 'is_group';
      console.log(`[${instanceName}] [Typing] Skipped: ${skipReason} (chatId: ${redactChatId(chatId)})`);
      return sendFn();
    }

    // Compute typing duration
    typingMs = computeTypingDuration();
    
    // Start typing indicator (try multiple API methods)
    try {
      // Try different API methods (whatsapp-web.js versions may differ)
      if (typeof chat.sendStateTyping === 'function') {
        await chat.sendStateTyping();
        applied = true;
      } else if (typeof chat.sendSeen === 'function') {
        // Some versions might use a different method
        // For typing, we'd need to simulate it differently, but this is a fallback check
        skipReason = 'typing_api_not_available';
        console.log(`[${instanceName}] [Typing] Skipped: ${skipReason} (chatId: ${redactChatId(chatId)})`);
        return sendFn();
      } else {
        skipReason = 'typing_api_not_available';
        console.log(`[${instanceName}] [Typing] Skipped: ${skipReason} (chatId: ${redactChatId(chatId)})`);
        return sendFn();
      }
    } catch (error) {
      // If typing fails, log but proceed to send
      skipReason = 'typing_start_failed';
      console.log(`[${instanceName}] [Typing] Skipped: ${skipReason} (chatId: ${redactChatId(chatId)}, error: ${error.message})`);
      return sendFn();
    }

    // Wait for typing duration (but with hard timeout safety)
    const waitStart = Date.now();
    await Promise.race([
      sleep(typingMs),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Typing wait timeout')), timeoutMs))
    ]).catch(() => {
      // Timeout during wait - proceed to send anyway
    });

    const actualWait = Date.now() - waitStart;
    typingMs = Math.min(actualWait, timeoutMs); // Cap to timeout

    // Execute send function
    const sendResult = await sendFn();

    // Log success
    console.log(`[${instanceName}] [Typing] Applied: true, typingMs: ${typingMs}, chatId: ${redactChatId(chatId)}`);

    return sendResult;

  } catch (error) {
    // If sendFn throws, we need to clear typing state and rethrow
    // But also log the typing attempt
    if (applied) {
      const logData = {
        instanceName,
        chatId: redactChatId(chatId),
        typingMs,
        applied: true,
        sendError: error.message,
      };
      console.log(`[${instanceName}] [Typing] Applied but send failed:`, logData);
    } else {
      const logData = {
        instanceName,
        chatId: redactChatId(chatId),
        typingMs: 0,
        applied: false,
        reason: skipReason || 'unknown',
        sendError: error.message,
      };
      console.log(`[${instanceName}] [Typing] Skipped:`, logData);
    }

    // Clear typing state in finally (below), then rethrow
    throw error;

  } finally {
    // CRITICAL: Always clear typing state
    if (chat && applied) {
      try {
        // Try multiple methods to clear typing state
        if (typeof chat.clearState === 'function') {
          await chat.clearState();
        } else if (typeof chat.stopTyping === 'function') {
          await chat.stopTyping();
        } else {
          // If no clear method available, log warning but don't fail
          console.warn(`[${instanceName}] [Typing] No clearState method available, typing may persist briefly`);
        }
      } catch (clearError) {
        // Log but don't throw - we don't want to fail the send if clearing state fails
        console.error(`[${instanceName}] [Typing] Failed to clear state (chatId: ${redactChatId(chatId)}):`, clearError.message);
      }
    }

    // Log if not already logged above
    if (!applied && !skipReason) {
      console.log(`[${instanceName}] [Typing] Skipped: instance_not_ready (chatId: ${redactChatId(chatId)})`);
    }
  }
}

module.exports = {
  withTypingIndicator,
  computeTypingDuration,
  redactChatId,
};
