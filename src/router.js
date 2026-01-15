/**
 * API router for wa-hub service
 * Implements all endpoints as described in expectations.md
 */

const express = require('express');
const { Poll } = require('whatsapp-web.js');
const sessionManager = require('./sessions');
const { 
  formatPhoneForWhatsApp, 
  extractPhoneNumber,
  mapToInstanceStatus,
  createSuccessResponse,
  createErrorResponse,
  getInstanceId,
  isValidInstanceId,
  sanitizeInstanceId,
} = require('./utils');

const router = express.Router();

/**
 * GET /instances
 * List all instances
 */
router.get('/instances', (req, res) => {
  try {
    const allSessions = sessionManager.getAllSessions();
    const instances = allSessions.map(session => ({
      id: session.id,
      name: session.name,
      status: mapToInstanceStatus(session.status),
      phoneNumber: session.phoneNumber || undefined,
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
    const existing = sessionManager.getSession(sessionId);
    if (existing) {
      return res.status(400).json(createErrorResponse(
        `Instance with name "${name}" already exists (ID: ${sessionId}). Use the existing instance instead of creating a duplicate.`,
        400
      ));
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

    // Create session
    const session = await sessionManager.createSession(sessionId, name, webhookConfig);

    // Return the sanitized sessionId as the instance ID
    // Note: Dots and other invalid chars are replaced with underscores for LocalAuth compatibility
    res.json(createSuccessResponse({
      instance: {
        id: sessionId,
        name: session.name,
        status: mapToInstanceStatus(session.status),
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

    const session = sessionManager.getSession(instanceId);
    if (!session) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    const { name, webhook } = req.body;

    // Update name if provided
    if (name && typeof name === 'string') {
      session.name = name;
    }

    // Update webhook configuration if provided
    if (webhook) {
      sessionManager.updateWebhookConfig(instanceId, webhook);
    }

    res.json(createSuccessResponse({
      instance: {
        id: session.id,
        name: session.name,
        status: mapToInstanceStatus(session.status),
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

    const session = sessionManager.getSession(instanceId);
    if (!session) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    // Check if QR code is available
    if (!session.qrCode) {
      return res.status(404).json(createErrorResponse('QR code not available yet. Please wait a few seconds.', 404));
    }

    res.json(createSuccessResponse({
      qrCode: {
        data: {
          qr_code: session.qrCode,
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

    const session = sessionManager.getSession(instanceId);
    if (!session) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    // Get client state if available
    let clientState = null;
    if (session.client) {
      clientState = await sessionManager.getClientState(instanceId);
    }

    const instanceStatus = mapToInstanceStatus(session.status);
    const data = {};
    
    if (session.phoneNumber) {
      data.phoneNumber = session.phoneNumber;
      data.formattedNumber = session.phoneNumber;
    }

    res.json(createSuccessResponse({
      clientStatus: {
        instanceStatus,
        instanceId: session.id,
        data,
      },
    }));
  } catch (error) {
    console.error('Error getting status:', error);
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

    const session = sessionManager.getSession(instanceId);
    if (!session) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    // Check if client is ready
    if (session.status !== 'ready' && session.status !== 'authenticated') {
      return res.status(400).json(createErrorResponse(
        `Instance is not connected. Current status: ${session.status}`,
        400
      ));
    }

    // Get client info
    let clientInfo = {};
    if (session.client && session.client.info) {
      const info = session.client.info;
      clientInfo = {
        displayName: info.pushname || null,
        contactId: info.wid?.user || null,
        formattedNumber: info.wid?.user || null,
        profilePicUrl: null, // whatsapp-web.js doesn't provide this directly
      };
    } else {
      // Fallback to session stored data
      clientInfo = {
        displayName: session.displayName || null,
        contactId: session.phoneNumber || null,
        formattedNumber: session.phoneNumber || null,
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

    const session = sessionManager.getSession(instanceId);
    if (!session) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    // Check if client is ready
    if (session.status !== 'ready' && session.status !== 'authenticated') {
      return res.status(400).json(createErrorResponse(
        `Instance is not connected. Current status: ${session.status}`,
        400
      ));
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

    // Create poll
    const poll = new Poll(caption, options, {
      allowMultipleAnswers: multipleAnswers === true,
    });

    // Send poll
    const message = await session.client.sendMessage(
      formattedChatId,
      poll,
      {
        // Avoid calling window.WWebJS.sendSeen to prevent upstream 'markedUnread' errors
        // in current whatsapp-web.js / WhatsApp Web versions.
        // This does not affect WAAPI semantics (we only guarantee that the poll is sent).
        sendSeen: false,
      },
    );

    res.json(createSuccessResponse({
      messageId: message.id?._serialized || message.id || null,
    }));
  } catch (error) {
    console.error('Error sending poll:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
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

    const session = sessionManager.getSession(instanceId);
    if (!session) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    // Check if client is ready
    if (session.status !== 'ready' && session.status !== 'authenticated') {
      return res.status(400).json(createErrorResponse(
        `Instance is not connected. Current status: ${session.status}`,
        400
      ));
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

    // Send message
    const sentMessage = await session.client.sendMessage(
      formattedChatId,
      message,
      {
        // Avoid calling window.WWebJS.sendSeen to prevent upstream 'markedUnread' errors
        // in current whatsapp-web.js / WhatsApp Web versions.
        // This does not affect WAAPI semantics (we only guarantee that the message is sent).
        sendSeen: false,
      },
    );

    res.json(createSuccessResponse({
      messageId: sentMessage.id?._serialized || sentMessage.id || null,
    }));
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * DELETE /instances/:id
 * Delete instance - destroys the instance completely (same as logout)
 * This logs out from WhatsApp, destroys the client, and removes the instance from memory
 */
router.delete('/instances/:id', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const session = sessionManager.getSession(instanceId);
    if (!session) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    // Delete session (logs out WhatsApp, destroys client, and removes from memory)
    await sessionManager.deleteSession(instanceId);

    res.json(createSuccessResponse({
      message: `Instance ${instanceId} deleted and destroyed successfully`,
    }));
  } catch (error) {
    console.error('Error deleting instance:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

/**
 * POST /instances/:id/client/action/logout
 * Logout instance - destroys the instance completely (same as DELETE)
 * This logs out from WhatsApp, destroys the client, and removes the instance from memory
 */
router.post('/instances/:id/client/action/logout', async (req, res) => {
  try {
    const instanceId = sanitizeInstanceId(getInstanceId(req.params));
    
    if (!isValidInstanceId(instanceId)) {
      return res.status(400).json(createErrorResponse('Invalid instance ID', 400));
    }

    const session = sessionManager.getSession(instanceId);
    if (!session) {
      return res.status(404).json(createErrorResponse(`Instance ${instanceId} not found`, 404));
    }

    // Delete session (logs out WhatsApp, destroys client, and removes from memory)
    await sessionManager.deleteSession(instanceId);

    res.json(createSuccessResponse({
      message: `Instance ${instanceId} logged out and destroyed successfully`,
    }));
  } catch (error) {
    console.error('Error logging out instance:', error);
    res.status(500).json(createErrorResponse(error.message, 500));
  }
});

module.exports = router;

