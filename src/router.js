/**
 * API router for wa-hub service
 * Implements all endpoints as described in expectations.md
 */

const express = require('express');
const instanceManager = require('./instance-manager');
const { InstanceState } = require('./instance-manager');
const config = require('./config');
const sentry = require('./observability/sentry');
const systemMode = require('./systemMode');
const outboundQueue = require('./queues/outboundQueue');
const inboundBuffer = require('./queues/inboundBuffer');
const restoreScheduler = require('./restoreScheduler');
const launchOptions = require('./browser/launchOptions');
const os = require('os');
const shm = require('./system/shm');
const { 
  formatPhoneForWhatsApp, 
  extractPhoneNumber,
  createSuccessResponse,
  createErrorResponse,
  getInstanceId,
  isValidInstanceId,
  sanitizeInstanceId,
} = require('./utils');

const router = express.Router();

/**
 * Map InstanceState to legacy status format for backward compatibility
 */
function mapInstanceStateToStatus(state) {
  const stateMap = {
    [InstanceState.READY]: 'ready',
    [InstanceState.STARTING_BROWSER]: 'initializing',
    [InstanceState.CONNECTING]: 'initializing',
    [InstanceState.DISCONNECTED]: 'disconnected',
    [InstanceState.NEEDS_QR]: 'qr',
    [InstanceState.ERROR]: 'disconnected',
    [InstanceState.RESTRICTED]: 'restricted',
    [InstanceState.PAUSED]: 'paused',
    [InstanceState.FAILED_QR_TIMEOUT]: 'disconnected',
  };
  return stateMap[state] || 'disconnected';
}

/**
 * GET /instances
 * List all instances
 */
router.get('/instances', (req, res) => {
  try {
    const allInstances = instanceManager.getAllInstances();
    const instances = allInstances.map(inst => ({
      id: inst.id,
      name: inst.name,
      status: mapInstanceStateToStatus(inst.state),
      phoneNumber: inst.phoneNumber || undefined,
      webhookUrl: inst.webhookUrl || null,
      webhookEvents: inst.webhookEvents || [],
      lastError: inst.lastError || undefined,
    }));

    res.json(instances);
  } catch (error) {
    console.error('Error listing instances:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * POST /instances
 * Create a new instance
 */
router.post('/instances', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json(createErrorResponse('Instance name is required', 400));
    }

    // Generate session ID (use name as ID but sanitize it for LocalAuth)
    // LocalAuth clientId only allows alphanumeric, underscores, and hyphens
    const sessionId = sanitizeInstanceId(name);

    // Check if instance already exists
    const existing = instanceManager.getInstance(sessionId);
    if (existing) {
      // If instance is ready, return success with current status (simulates "already_connected")
      if (existing.state === InstanceState.READY) {
        return res.json(createSuccessResponse({
          instance: {
            id: sessionId,
            name: existing.name,
            status: mapInstanceStateToStatus(existing.state),
          },
          message: 'Instance already connected',
        }));
      }
      
      // If instance is disconnected, start reconnection in background (don't wait)
      if (existing.state === InstanceState.DISCONNECTED) {
        // Start reconnection asynchronously (don't await - return immediately)
        instanceManager.ensureReady(sessionId).catch((error) => {
          console.error(`[${sessionId}] Background reconnection failed:`, error);
        });
        
        // Return immediately with current status
        return res.json(createSuccessResponse({
          instance: {
            id: sessionId,
            name: existing.name,
            status: 'initializing', // Reconnection in progress
          },
          message: 'Reconnection initiated',
        }));
      }
      
      // For other statuses, return current status
      return res.json(createSuccessResponse({
        instance: {
          id: sessionId,
          name: existing.name,
          status: mapInstanceStateToStatus(existing.state),
        },
        message: 'Instance exists with status: ' + existing.state,
      }));
    }

    // Get webhook config from request body (required)
    const webhookConfig = req.body.webhook || {};
    
    // Validate that webhook URL is provided
    if (!webhookConfig.url || typeof webhookConfig.url !== 'string') {
      return res.status(400).json(createErrorResponse(
        'Webhook URL is required. Provide it in webhook.url field when creating the instance.',
        400
      ));
    }

    // Create instance
    const instance = await instanceManager.createInstance(sessionId, name, webhookConfig);

    // Return the sanitized sessionId as the instance ID
    // Note: Dots and other invalid chars are replaced with underscores for LocalAuth compatibility
    res.json(createSuccessResponse({
      instance: {
        id: sessionId,
        name: instance.name,
        status: mapInstanceStateToStatus(instance.state),
      },
    }));
  } catch (error) {
    console.error('Error creating instance:', error);
    
    // Check if it's a duplicate error
    if (error.message.includes('already exists')) {
      return res.status(400).json(createErrorResponse(error.message, 400));
    }
    
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * PUT /instances/:id
 * Update instance (webhook configuration)
 */
router.put('/instances/:id', (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const instance = instanceManager.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    const { name, webhook, typingIndicatorEnabled, applyTypingTo } = req.body;

    // Update name if provided
    if (name && typeof name === 'string') {
      instance.name = name;
    }

    // Update webhook configuration if provided (also handles typing indicator settings)
    if (webhook || typingIndicatorEnabled !== undefined || applyTypingTo) {
      const configUpdate = { ...webhook };
      if (typingIndicatorEnabled !== undefined) {
        configUpdate.typingIndicatorEnabled = typingIndicatorEnabled;
      }
      if (applyTypingTo) {
        configUpdate.applyTypingTo = applyTypingTo;
      }
      instanceManager.updateWebhookConfig(instanceId, configUpdate);
    }

    res.json(createSuccessResponse({
      instance: {
        id: instance.id,
        name: instance.name,
        status: mapInstanceStateToStatus(instance.state),
      },
    }));
  } catch (error) {
    console.error('Error updating instance:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * GET /instances/:id/client/qr
 * Get QR code for instance
 */
router.get('/instances/:id/client/qr', (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const instance = instanceManager.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    // Check if QR code is available
    if (!instance.qrCode) {
      return res.status(404).json(createErrorResponse('QR code not available yet. Please wait a few seconds.', 404));
    }

    res.json(createSuccessResponse({
      qrCode: {
        data: {
          qr_code: instance.qrCode,
        },
      },
    }));
  } catch (error) {
    console.error('Error getting QR code:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * GET /instances/:id/client/status
 * Get instance status
 */
router.get('/instances/:id/client/status', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const instance = instanceManager.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    // Get client state if available
    let clientState = null;
    if (instance.client) {
      try {
        clientState = await instance.client.getState();
      } catch (error) {
        // Ignore errors
      }
    }

    const instanceStatus = mapInstanceStateToStatus(instance.state);
    const data = {};
    
    if (instance.phoneNumber) {
      data.phoneNumber = instance.phoneNumber;
      data.formattedNumber = instance.phoneNumber;
    }

    res.json(createSuccessResponse({
      clientStatus: {
        instanceStatus,
        instanceId: instance.id,
        data,
        // Enhanced status info
        state: instance.state,
        queueDepth: instance.queue.length,
        lastEvent: instance.lastEvent,
        lastDisconnectReason: instance.lastDisconnectReason,
        lastError: instance.lastError || undefined,
        restartAttempts: instance.restartAttempts,
        // Countdown: when waiting for ready (needs_qr/authenticated/connecting)
        readyWatchdogMs: config.readyWatchdogMs,
        readyWatchdogStartAt: instance.readyWatchdogStartAt ? instance.readyWatchdogStartAt.toISOString() : null,
        authenticatedAt: instance.authenticatedAt ? instance.authenticatedAt.toISOString() : null,
        readySource: instance.readySource,
        readyAt: instance.readyAt ? instance.readyAt.toISOString() : null,
        authenticatedToReadyMs: instance.authenticatedToReadyMs,
        readyPollAttempts: instance.readyPollAttempts || 0,
        lastReadyPollError: instance.lastReadyPollError,
      },
    }));
  } catch (error) {
    console.error('Error getting status:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * GET /instances/:id/client/info-raw
 * Debug: get raw client.info regardless of state (proves ready-poll fallback concept)
 */
router.get('/instances/:id/client/info-raw', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));

    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const instance = instanceManager.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    let info = null;
    let error = null;
    try {
      if (instance.client) {
        info = instance.client.info;
      }
    } catch (e) {
      error = e.message;
    }

    res.json(createSuccessResponse({
      instanceState: instance.state,
      clientExists: !!instance.client,
      clientInfoPresent: !!info,
      clientInfo: info ? {
        pushname: info.pushname,
        wid: info.wid ? { user: info.wid.user, _serialized: info.wid._serialized } : null,
      } : null,
      error: error,
      readySource: instance.readySource,
      readyAt: instance.readyAt ? instance.readyAt.toISOString() : null,
      authenticatedToReadyMs: instance.authenticatedToReadyMs,
      readyPollAttempts: instance.readyPollAttempts || 0,
      lastReadyPollError: instance.lastReadyPollError,
    }));
  } catch (error) {
    console.error('Error getting raw client info:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * GET /instances/:id/client/me
 * Get client details (connected user info)
 */
router.get('/instances/:id/client/me', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const instance = instanceManager.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    // Check if client is ready
    if (instance.state !== InstanceState.READY) {
      return res.status(400).json(createErrorResponse(
        `Instance is not connected. Current state: ${instance.state}`,
        400
      ));
    }

    // Get client info
    let clientInfo = {};
    if (instance.client && instance.client.info) {
      const info = instance.client.info;
      clientInfo = {
        displayName: info.pushname || null,
        contactId: info.wid?.user || null,
        formattedNumber: info.wid?.user || null,
        profilePicUrl: null, // whatsapp-web.js doesn't provide this directly
      };
    } else {
      // Fallback to instance stored data
      clientInfo = {
        displayName: instance.displayName || null,
        contactId: instance.phoneNumber || null,
        formattedNumber: instance.phoneNumber || null,
        profilePicUrl: null,
      };
    }

    res.json(createSuccessResponse({
      me: {
        data: clientInfo,
      },
    }));
  } catch (error) {
    console.error('Error getting client details:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * POST /instances/:id/client/action/create-poll
 * Send poll message
 */
router.post('/instances/:id/client/action/create-poll', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const instance = instanceManager.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    const { chatId, caption, options, multipleAnswers } = req.body;

    if (!chatId || typeof chatId !== 'string') {
      return res.status(400).json(createErrorResponse('chatId is required', 400));
    }

    if (!caption || typeof caption !== 'string') {
      return res.status(400).json(createErrorResponse('caption is required', 400));
    }

    if (!options || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json(createErrorResponse('options array with at least 2 items is required', 400));
    }

    // Format chatId
    const formattedChatId = formatPhoneForWhatsApp(chatId);
    if (!formattedChatId) {
      return res.status(400).json(createErrorResponse('Invalid chatId format', 400));
    }

    if (systemMode.getSystemMode().mode === 'syncing') {
      const r = outboundQueue.enqueue('send_poll', instanceId, {
        formattedChatId,
        caption,
        options,
        multipleAnswers,
      });
      if (!r.ok) {
        return res.status(429).json(createErrorResponse('Outbound queue full during sync', 429));
      }
      return res.status(202).json(createSuccessResponse({
        queued: true,
        reason: 'system_syncing',
        queueDepth: outboundQueue.getCount(),
      }));
    }

    // Use instanceManager.sendPoll (handles queue automatically)
    const result = await instanceManager.sendPoll(
      instanceId,
      formattedChatId,
      caption,
      options,
      multipleAnswers
    );

    // Return result with enhanced info
    if (result.status === 'sent') {
      res.json(createSuccessResponse({
        messageId: result.messageId,
        status: result.status,
        instanceState: result.instanceState,
        queueDepth: result.queueDepth,
      }));
    } else if (result.status === 'queued') {
      res.status(202).json(createSuccessResponse({
        status: result.status,
        instanceState: result.instanceState,
        queueDepth: result.queueDepth,
        queueId: result.queueId,
        message: 'Message queued. Will be sent when instance becomes ready.',
      }));
    } else {
      res.status(400).json(createErrorResponse(result.error || 'Failed to send poll', 400));
    }
  } catch (error) {
    console.error('Error sending poll:', error);
    const errorMessage = error.message || String(error);
    
    // Handle terminal states
    if (errorMessage.includes('needs QR') || errorMessage.includes('NEEDS_QR')) {
      return res.status(400).json(createErrorResponse(
        'Instance needs QR code scan. Please check the instance status and scan QR code.',
        400
      ));
    }
    
    // Handle queue full
    if (errorMessage.includes('Queue full')) {
      return res.status(429).json(createErrorResponse(errorMessage, 429));
    }
    
    res.status(500).json(createErrorResponse(errorMessage, 500));
  }
});

/**
 * POST /instances/:id/client/action/send-message
 * Send text message
 */
router.post('/instances/:id/client/action/send-message', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const instance = instanceManager.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    const { chatId, message } = req.body;

    if (!chatId || typeof chatId !== 'string') {
      return res.status(400).json(createErrorResponse('chatId is required', 400));
    }

    if (!message || typeof message !== 'string') {
      return res.status(400).json(createErrorResponse('message is required', 400));
    }

    // Format chatId
    const formattedChatId = formatPhoneForWhatsApp(chatId);
    if (!formattedChatId) {
      return res.status(400).json(createErrorResponse('Invalid chatId format', 400));
    }

    if (systemMode.getSystemMode().mode === 'syncing') {
      const r = outboundQueue.enqueue('send_message', instanceId, { formattedChatId, message });
      if (!r.ok) {
        return res.status(429).json(createErrorResponse('Outbound queue full during sync', 429));
      }
      return res.status(202).json(createSuccessResponse({
        queued: true,
        reason: 'system_syncing',
        queueDepth: outboundQueue.getCount(),
      }));
    }

    // Use instanceManager.sendMessage (handles queue automatically)
    const result = await sentry.startSpan(
      { op: 'http.server', name: 'POST /instances/:id/client/action/send-message' },
      (span) => {
        span.setAttribute('instance_id', instanceId);
        return instanceManager.sendMessage(instanceId, formattedChatId, message);
      }
    );

    // Return result with enhanced info
    if (result.status === 'sent') {
      res.json(createSuccessResponse({
        messageId: result.messageId,
        status: result.status,
        instanceState: result.instanceState,
        queueDepth: result.queueDepth,
      }));
    } else if (result.status === 'queued') {
      res.status(202).json(createSuccessResponse({
        status: result.status,
        instanceState: result.instanceState,
        queueDepth: result.queueDepth,
        queueId: result.queueId,
        message: 'Message queued. Will be sent when instance becomes ready.',
      }));
    } else {
      res.status(400).json(createErrorResponse(result.error || 'Failed to send message', 400));
    }
  } catch (error) {
    console.error('Error sending message:', error);
    const errorMessage = error.message || String(error);
    
    // Handle terminal states
    if (errorMessage.includes('needs QR') || errorMessage.includes('NEEDS_QR')) {
      return res.status(400).json(createErrorResponse(
        'Instance needs QR code scan. Please check the instance status and scan QR code.',
        400
      ));
    }
    
    // Handle queue full
    if (errorMessage.includes('Queue full')) {
      return res.status(429).json(createErrorResponse(errorMessage, 429));
    }
    
    res.status(500).json(createErrorResponse(errorMessage, 500));
  }
});

/**
 * DELETE /instances/:id
 * Hard delete: destroys client, removes from runtime + persisted list, purges LocalAuth session.
 * Idempotent: if instance not in memory, still purges session dirs if they exist.
 * Recreating with same id will require a new QR and can connect a different number.
 */
router.delete('/instances/:id', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));

    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const result = await instanceManager.deleteInstance(instanceId);

    res.json(createSuccessResponse({
      message: `Instance ${instanceId} deleted successfully`,
      deleted: result.deleted,
      purged: result.purged,
      purgedPaths: result.purgedPaths,
      warnings: result.warnings.length ? result.warnings : undefined,
    }));
  } catch (error) {
    console.error('Error deleting instance:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * GET /instances/:id/queue
 * Get queue details for an instance
 */
router.get('/instances/:id/queue', (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const queueDetails = instanceManager.getQueueDetails(instanceId);
    
    res.json(createSuccessResponse(queueDetails));
  } catch (error) {
    console.error('Error getting queue details:', error);
    res.status(404).json(createErrorResponse(error.message, 404));
  }
});

/**
 * DELETE /instances/:id/queue
 * Clear message/poll queue for an instance
 */
router.delete('/instances/:id/queue', (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const result = instanceManager.clearQueue(instanceId);
    
    res.json(createSuccessResponse({
      message: `Queue cleared for instance ${instanceId}`,
      cleared: result.cleared,
      queueDepth: result.queueDepth,
    }));
  } catch (error) {
    console.error('Error clearing queue:', error);
    res.status(404).json(createErrorResponse(error.message, 404));
  }
});

/**
 * POST /instances/:id/queue/trigger
 * Manually trigger send loop for an instance
 */
router.post('/instances/:id/queue/trigger', (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const result = instanceManager.triggerSendLoop(instanceId);
    
    if (result.success) {
      res.json(createSuccessResponse(result));
    } else {
      res.status(400).json(createErrorResponse(result.message, 400));
    }
  } catch (error) {
    console.error('Error triggering send loop:', error);
    res.status(404).json(createErrorResponse(error.message, 404));
  }
});

/**
 * Measure event loop lag (ms) - helps detect VM pressure causing stuck states
 */
function measureEventLoopLag() {
  return new Promise((resolve) => {
    const start = Date.now();
    setImmediate(() => {
      resolve(Date.now() - start);
    });
  });
}

/**
 * GET /instances/:id/diagnostics
 * Get per-instance diagnostic info (for debugging stuck NEEDS_QR/CONNECTING)
 * Includes process resource metrics (memory, uptime, event loop lag)
 */
router.get('/instances/:id/diagnostics', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));

    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const diagnostics = instanceManager.getInstanceDiagnostics(instanceId);
    if (!diagnostics) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    const mem = process.memoryUsage();
    const eventLoopLagMs = await measureEventLoopLag();

    const response = {
      ...diagnostics,
      process: {
        memoryUsage: {
          rss: mem.rss,
          heapTotal: mem.heapTotal,
          heapUsed: mem.heapUsed,
          external: mem.external,
        },
        uptimeSeconds: Math.floor(process.uptime()),
        eventLoopLagMs,
      },
    };

    res.json(createSuccessResponse(response));
  } catch (error) {
    console.error('Error getting diagnostics:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * POST /instances/:id/client/action/logout
 * Hard delete (same as DELETE /instances/:id): destroys client, purges LocalAuth session.
 */
router.post('/instances/:id/client/action/logout', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));

    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const result = await instanceManager.deleteInstance(instanceId);

    res.json(createSuccessResponse({
      message: `Instance ${instanceId} logged out and destroyed successfully`,
      deleted: result.deleted,
      purged: result.purged,
      purgedPaths: result.purgedPaths,
      warnings: result.warnings.length ? result.warnings : undefined,
    }));
  } catch (error) {
    console.error('Error logging out instance:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * GET /instances/:id/status
 * Get comprehensive instance status (health endpoint with full context)
 */
router.get('/instances/:id/status', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const instance = instanceManager.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    // Calculate counters from timestamp arrays
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const oneDayAgo = now - 86400000;
    
    const sent24h = instance.counters.sent24h.filter(ts => ts > oneDayAgo).length;
    const sent1h = instance.counters.sent1h.filter(ts => ts > oneHourAgo).length;
    const failures1h = instance.counters.failures1h.filter(ts => ts > oneHourAgo).length;
    const disconnects1h = instance.counters.disconnects1h.filter(ts => ts > oneHourAgo).length;
    
    res.json(createSuccessResponse({
      instance: {
        id: instance.id,
        name: instance.name,
        state: instance.state,
        status: mapInstanceStateToStatus(instance.state),
        createdAt: instance.createdAt?.toISOString() || null,
      },
      client: {
        phoneNumber: instance.phoneNumber || null,
        displayName: instance.displayName || null,
        lastReadyAt: instance.lastReadyAt?.toISOString() || null,
        lastDisconnectAt: instance.lastDisconnectAt?.toISOString() || null,
        lastDisconnectReason: instance.lastDisconnectReason || null,
        lastAuthFailureAt: instance.lastAuthFailureAt?.toISOString() || null,
        lastEvent: instance.lastEvent || null,
      },
      queue: {
        depth: instance.queue.length,
        sendLoopRunning: instance.sendLoopRunning || false,
        maxSize: config.maxQueueSize,
      },
      reconnection: {
        restartAttempts: instance.restartAttempts,
        lastRestartAt: instance.lastRestartAt?.toISOString() || null,
        restartHistoryLength: instance.restartHistory?.length || 0,
        rateLimitExceeded: instance.checkRestartRateLimit ? instance.checkRestartRateLimit() : false,
      },
      rateLimits: {
        sendsPerMinute: {
          current: instance.sendHistory1min?.length || 0,
          max: config.maxSendsPerMinute,
          limited: instance.isRateLimitedPerMinute ? instance.isRateLimitedPerMinute() : false,
        },
        sendsPerHour: {
          current: instance.sendHistory1hour?.length || 0,
          max: config.maxSendsPerHour,
          limited: instance.isRateLimitedPerHour ? instance.isRateLimitedPerHour() : false,
        },
      },
      counters: {
        sent24h,
        sent1h,
        failures1h,
        disconnects1h,
        newChats24h: instance.counters.newChats24h.filter(ts => ts > oneDayAgo).length,
      },
      webhook: {
        url: instance.webhookUrl || null,
        events: instance.webhookEvents || [],
      },
    }));
  } catch (error) {
    console.error('Error getting instance status:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * POST /instances/:id/view-session
 * Founder-only: Create short-lived view session (testing/debugging).
 */
router.post('/instances/:id/view-session', (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }
    const dashboardBaseUrl = req.body?.dashboardBaseUrl || req.query?.dashboardBaseUrl || '';
    if (!dashboardBaseUrl || typeof dashboardBaseUrl !== 'string') {
      return res.status(400).json(createErrorResponse('dashboardBaseUrl is required', 400));
    }
    console.log(`[view-session] Request for instance ${instanceId}`);
    const result = instanceManager.createViewSessionToken(instanceId, dashboardBaseUrl);
    if (!result.success) {
      const status = result.error?.includes('disabled') ? 403 : result.error?.includes('not found') ? 404 : 400;
      return res.status(status).json(createErrorResponse(result.error || 'Failed', status));
    }
    instanceManager.cleanupExpiredViewTokens?.();
    res.json(createSuccessResponse({
      viewUrl: result.viewUrl,
      expiresIn: result.expiresIn,
    }));
  } catch (error) {
    console.error('Error creating view session:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * GET /view-session/screenshot
 * Returns PNG screenshot for valid view session token (founder-only, ephemeral).
 */
/**
 * POST /view-session/revoke
 * Revoke view session token (stop polling, free token).
 */
router.post('/view-session/revoke', (req, res) => {
  try {
    const token = req.body?.token || req.query?.token;
    const revoked = instanceManager.revokeViewSessionToken?.(token);
    res.json(createSuccessResponse({ revoked: !!revoked }));
  } catch (error) {
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

router.get('/view-session/screenshot', async (req, res) => {
  try {
    const token = req.query?.token;
    const buffer = await instanceManager.captureViewSessionScreenshot(token);
    if (!buffer) {
      return res.status(404).type('text/plain').send('View session expired or invalid');
    }
    res.type('image/png').send(buffer);
  } catch (error) {
    console.error('Error capturing view session screenshot:', error);
    res.status(500).send();
  }
});

/**
 * POST /view-session/click
 * Inject click at viewport coordinates (interactive view)
 */
router.post('/view-session/click', async (req, res) => {
  try {
    const token = req.body?.token || req.query?.token;
    const x = req.body?.x;
    const y = req.body?.y;
    if (token == null || x == null || y == null) {
      return res.status(400).json(createErrorResponse('token, x, and y are required', 400));
    }
    const result = await instanceManager.injectViewSessionClick?.(token, x, y);
    if (!result) return res.status(500).json(createErrorResponse('Not supported', 500));
    if (!result.success) {
      const status = result.error?.includes('expired') ? 401 : result.error?.includes('not ready') ? 503 : 400;
      return res.status(status).json(createErrorResponse(result.error || 'Click failed', status));
    }
    res.json(createSuccessResponse({ success: true }));
  } catch (error) {
    console.error('Error injecting click:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * POST /view-session/scroll
 * Inject scroll at viewport coordinates (interactive view)
 */
router.post('/view-session/scroll', async (req, res) => {
  try {
    const token = req.body?.token || req.query?.token;
    const x = req.body?.x;
    const y = req.body?.y;
    const deltaY = req.body?.deltaY ?? 0;
    if (token == null || x == null || y == null) {
      return res.status(400).json(createErrorResponse('token, x, and y are required', 400));
    }
    const result = await instanceManager.injectViewSessionScroll?.(token, x, y, deltaY);
    if (!result) return res.status(500).json(createErrorResponse('Not supported', 500));
    if (!result.success) {
      const status = result.error?.includes('expired') ? 401 : result.error?.includes('not ready') ? 503 : 400;
      return res.status(status).json(createErrorResponse(result.error || 'Scroll failed', status));
    }
    res.json(createSuccessResponse({ success: true }));
  } catch (error) {
    console.error('Error injecting scroll:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * POST /instances/:id/restart
 * Manually trigger soft or hard restart (for admin use)
 */
router.post('/instances/:id/restart', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const instance = instanceManager.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    const { type = 'soft' } = req.body; // 'soft' or 'hard'
    
    if (!['soft', 'hard'].includes(type)) {
      return res.status(400).json(createErrorResponse('Restart type must be "soft" or "hard"', 400));
    }

    // Terminal states: cannot restart via ensureReady
    if (instance.state === InstanceState.NEEDS_QR) {
      return res.status(400).json(createErrorResponse(
        'Instance needs QR code scan. Cannot restart. Please scan QR code first.',
        400
      ));
    }
    if (instance.state === InstanceState.FAILED_QR_TIMEOUT) {
      return res.status(400).json(createErrorResponse(
        'Instance failed QR timeout. Delete and recreate or create a new instance.',
        400
      ));
    }

    // Trigger ensureReady (which will do soft then hard restart)
    res.json(createSuccessResponse({
      message: `Restart initiated (type: ${type})`,
      instanceId,
      currentState: instance.state,
    }));

    // Do restart in background
    instanceManager.ensureReady(instanceId).catch(err => {
      console.error(`[${instanceId}] Manual restart failed:`, err);
    });
    
  } catch (error) {
    console.error('Error restarting instance:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * POST /instances/:id/retry
 * Retry initializing an instance in ERROR or FAILED_QR_TIMEOUT (e.g. after "Failed to launch the browser process").
 * Does not require delete + recreate; preserves instance config and auth path.
 */
router.post('/instances/:id/retry', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }
    const result = await instanceManager.retryInstance(instanceId);
    if (!result.ok) {
      const status = result.error?.includes('not found') ? 404 : 400;
      return res.status(status).json(createErrorResponse(result.error || 'Retry failed', status));
    }
    return res.json(createSuccessResponse({ message: result.message, instanceId }));
  } catch (error) {
    console.error('Error retrying instance:', error);
    return res.status(500).json(createErrorResponse(error.message, 500));
  }
});

async function getSystemStatusPayload() {
  const sys = systemMode.getSystemMode();
  const now = Date.now();
  const allInstances = instanceManager.getAllInstances();
  const instances = await Promise.all(
    allInstances.map(async (i) => {
      const needsQrSince = i.needsQrSince ? new Date(i.needsQrSince).getTime() : 0;
      const lastQrAt = i.lastQrAt ? new Date(i.lastQrAt).getTime() : 0;
      const usage =
        typeof instanceManager.getInstanceProcessUsage === 'function'
          ? await instanceManager.getInstanceProcessUsage(i.id)
          : null;
      return {
        id: i.id,
        state: i.state,
        lastError: i.lastError || null,
        lastStateChangeAt: i.lastStateChangeAt ? new Date(i.lastStateChangeAt).toISOString() : null,
        needsQrSince: i.needsQrSince ? new Date(i.needsQrSince).toISOString() : null,
        lastQrAt: i.lastQrAt ? new Date(i.lastQrAt).toISOString() : null,
        qrRecoveryAttempts: i.qrRecoveryAttempts ?? 0,
        restoreAttempts: i.restoreAttempts ?? 0,
        qrAgeSeconds: lastQrAt > 0 ? Math.round((now - lastQrAt) / 1000) : null,
        needsQrAgeSeconds: needsQrSince > 0 ? Math.round((now - needsQrSince) / 1000) : null,
        ...(usage && { cpuPercent: usage.cpuPercent, memoryMB: usage.memoryMB }),
      };
    })
  );
  const restoreState = restoreScheduler.getQueueState ? restoreScheduler.getQueueState() : null;
  return {
    mode: sys.mode,
    since: sys.since?.toISOString?.() ?? sys.since,
    syncingInstanceId: sys.syncingInstanceId ?? null,
    queuedOutboundCount: outboundQueue.getCount(),
    queuedOutboundByInstance: outboundQueue.getCountByInstance?.() ?? {},
    inboundBufferCount: inboundBuffer.getCount(),
    restoreQueue: restoreState,
    instances,
    perInstanceStates: instances,
  };
}

function requireAdminDebug(req, res, next) {
  const secret = process.env.ADMIN_DEBUG_SECRET;
  if (secret && req.headers['x-admin-debug-secret'] !== secret) {
    return res.status(403).json(createErrorResponse('Forbidden', 403));
  }
  next();
}

/**
 * GET /__debug/system
 * System mode, queues, restore queue state, per-instance (state, lastError, restoreAttempts, etc.).
 */
router.get('/__debug/system', requireAdminDebug, async (req, res) => {
  try {
    const payload = await getSystemStatusPayload();
    res.json(createSuccessResponse(payload));
  } catch (error) {
    console.error('Error in /__debug/system:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * GET /__debug/env
 * Safe subset: node version, chosen executable path, exists, free/total mem, shm, disk free /tmp, uid/gid.
 * Protected by ADMIN_DEBUG_SECRET when set.
 */
router.get('/__debug/env', requireAdminDebug, (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const shmBytes = shm.getShmSizeBytes ? shm.getShmSizeBytes() : null;
    const executable = launchOptions.getChosenExecutablePath ? launchOptions.getChosenExecutablePath() : { path: null, exists: false };
    let diskFreeTmp = null;
    let ulimitNofile = null;
    try {
      const { execSync } = require('child_process');
      diskFreeTmp = execSync('df -k /tmp 2>/dev/null | tail -1', { encoding: 'utf8', timeout: 2000 }).trim();
    } catch (_) {}
    try {
      ulimitNofile = process.geteuid ? require('child_process').execSync('ulimit -n 2>/dev/null', { encoding: 'utf8' }).trim() : null;
    } catch (_) {}
    res.json(createSuccessResponse({
      nodeVersion: process.version,
      executablePath: executable.path || null,
      executablePathExists: executable.path ? executable.exists : null,
      totalMemMB: Math.round(totalMem / 1048576),
      freeMemMB: Math.round(freeMem / 1048576),
      shmSizeMB: shmBytes != null ? Math.round(shmBytes / 1048576) : null,
      diskFreeTmp,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      gid: typeof process.getgid === 'function' ? process.getgid() : null,
      ulimitNofile,
    }));
  } catch (error) {
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * POST /__debug/instances/:id/retry
 * Enqueue retry for ERROR/FAILED_QR_TIMEOUT instance; uses sequential scheduler (202 if queued).
 */
router.post('/__debug/instances/:id/retry', requireAdminDebug, (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }
    const instance = instanceManager.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }
    if (instance.state !== InstanceState.ERROR && instance.state !== InstanceState.FAILED_QR_TIMEOUT) {
      return res.status(400).json(createErrorResponse(`Instance not in ERROR/FAILED_QR_TIMEOUT (state: ${instance.state})`, 400));
    }
    restoreScheduler.enqueueRetry(instanceId);
    res.status(202).json(createSuccessResponse({ queued: true, instanceId, message: 'Retry queued; scheduler will process when ready.' }));
  } catch (error) {
    console.error('Error enqueueing retry:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * GET /system/status
 * Same as __debug/system; optional ADMIN_DEBUG_SECRET header when env set.
 */
router.get('/system/status', async (req, res) => {
  const secret = process.env.ADMIN_DEBUG_SECRET;
  if (secret && req.headers['x-admin-debug-secret'] !== secret) {
    return res.status(403).json(createErrorResponse('Forbidden', 403));
  }
  try {
    const payload = await getSystemStatusPayload();
    res.json(createSuccessResponse(payload));
  } catch (error) {
    console.error('Error in /system/status:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

module.exports = router;

