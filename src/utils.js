/**
 * Utility functions for wa-hub service
 */

const qrcode = require('qrcode');

/**
 * Format phone number for WhatsApp (remove non-digits, add @c.us suffix)
 * @param {string} phone - Phone number in any format
 * @returns {string} Formatted phone number (e.g., "201224885551@c.us")
 */
function formatPhoneForWhatsApp(phone) {
  if (!phone) return null;
  // Remove all non-digits
  const digits = phone.replace(/\D/g, '');
  // Add @c.us suffix
  return digits + '@c.us';
}

/**
 * Convert QR code string to base64 image
 * @param {string} qrString - QR code string from whatsapp-web.js
 * @returns {Promise<string>} Base64 encoded QR code image
 */
async function qrToBase64(qrString) {
  try {
    const base64 = await qrcode.toDataURL(qrString);
    // Remove data:image/png;base64, prefix if present
    return base64.replace(/^data:image\/png;base64,/, '');
  } catch (error) {
    console.error('Error converting QR to base64:', error);
    throw error;
  }
}

/**
 * Extract phone number from WhatsApp ID
 * @param {string} whatsappId - WhatsApp ID (e.g., "201224885551@c.us")
 * @returns {string} Phone number without suffix
 */
function extractPhoneNumber(whatsappId) {
  if (!whatsappId) return null;
  return whatsappId.replace('@c.us', '').replace('@g.us', '');
}

/**
 * Map whatsapp-web.js state to WAAPI status
 * @param {string} state - State from whatsapp-web.js
 * @returns {string} Status string
 */
function mapStateToStatus(state) {
  const stateMap = {
    'CONNECTED': 'ready',
    'OPENING': 'qr',
    'PAIRING': 'qr',
    'UNPAIRED': 'qr',
  };
  
  return stateMap[state] || 'disconnected';
}

/**
 * Map whatsapp-web.js status to WAAPI instance status
 * @param {string} status - Status from whatsapp-web.js (can be session status or WAState)
 * @returns {string} Instance status (qr, ready, authenticated, disconnected, loading_screen, auth_failure)
 */
function mapToInstanceStatus(status) {
  if (!status) return 'disconnected';
  
  const statusStr = status.toString().toUpperCase();
  
  // Handle WAState enum values from getState()
  if (statusStr === 'CONNECTED') {
    return 'ready';
  }
  if (statusStr === 'OPENING' || statusStr === 'PAIRING' || statusStr === 'UNPAIRED' || statusStr === 'UNPAIRED_IDLE') {
    return 'qr';
  }
  if (statusStr === 'TIMEOUT' || statusStr === 'TOS_BLOCK' || statusStr === 'SMB_TOS_BLOCK' || statusStr === 'PROXYBLOCK') {
    return 'disconnected';
  }
  
  // Handle session status strings (already in correct format)
  const lowerStatus = status.toLowerCase();
  const validStatuses = ['qr', 'ready', 'authenticated', 'disconnected', 'loading_screen', 'auth_failure', 'initializing'];
  if (validStatuses.includes(lowerStatus)) {
    return lowerStatus;
  }
  
  // Default fallback
  return 'disconnected';
}

/**
 * Create standardized API response
 * @param {any} data - Response data
 * @param {string} status - Status string (default: "success")
 * @returns {object} Standardized response object
 */
function createSuccessResponse(data, status = 'success') {
  return {
    ...data,
    status,
  };
}

/**
 * Create standardized error response
 * @param {string} message - Error message
 * @param {number} code - HTTP status code
 * @returns {object} Error response object
 */
function createErrorResponse(message, code = 400) {
  return {
    error: message,
    status: code,
  };
}

/**
 * Extract instance ID from request params
 * @param {object} params - Express request params
 * @returns {string|null} Instance ID
 */
function getInstanceId(params) {
  return params.id || params.instanceId;
}

/**
 * Validate instance ID format
 * @param {string} id - Instance ID
 * @returns {boolean} True if valid
 */
function isValidInstanceId(id) {
  return id && typeof id === 'string' && id.length > 0;
}

/**
 * Sanitize instance ID for LocalAuth clientId
 * LocalAuth only allows alphanumeric, underscores, and hyphens
 * @param {string} id - Instance ID (may contain dots or other chars)
 * @returns {string} Sanitized instance ID
 */
function sanitizeInstanceId(id) {
  if (!id) return id;
  // Replace any character that's not alphanumeric, underscore, or hyphen with underscore
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

module.exports = {
  formatPhoneForWhatsApp,
  qrToBase64,
  extractPhoneNumber,
  mapStateToStatus,
  mapToInstanceStatus,
  createSuccessResponse,
  createErrorResponse,
  getInstanceId,
  isValidInstanceId,
  sanitizeInstanceId,
};

