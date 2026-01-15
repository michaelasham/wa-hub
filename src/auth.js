/**
 * Authentication middleware for API key validation
 */

const config = require('./config');
const { createErrorResponse } = require('./utils');

/**
 * Middleware to authenticate requests using API key
 * Checks for API key in Authorization header: Bearer {API_KEY}
 * or X-API-Key header
 */
function authenticateApiKey(req, res, next) {
  // Skip authentication for health check
  if (req.path === '/health') {
    return next();
  }

  // Get API key from environment or config
  const requiredApiKey = config.apiKey;
  
  if (!requiredApiKey) {
    // If no API key is configured, allow all requests (for development)
    console.warn('WARNING: API_KEY not configured. All requests are allowed.');
    return next();
  }

  // Try to get API key from Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  let providedApiKey = null;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    providedApiKey = authHeader.substring(7);
  } else if (req.headers['x-api-key']) {
    // Also support X-API-Key header
    providedApiKey = req.headers['x-api-key'];
  }

  // Validate API key
  if (!providedApiKey) {
    return res.status(401).json(createErrorResponse(
      'API key required. Provide it in Authorization header as "Bearer {API_KEY}" or X-API-Key header',
      401
    ));
  }

  if (providedApiKey !== requiredApiKey) {
    return res.status(403).json(createErrorResponse(
      'Invalid API key',
      403
    ));
  }

  // API key is valid
  next();
}

module.exports = {
  authenticateApiKey,
};


