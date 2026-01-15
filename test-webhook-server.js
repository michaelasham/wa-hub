/**
 * Fake main app webhook server for testing wa-hub locally
 * Receives and logs webhook events from wa-hub
 */

const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.WEBHOOK_PORT || 3001;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-shared-secret-here';

app.use(express.json());

// Middleware to log all requests
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

/**
 * Verify webhook signature
 */
function verifySignature(payload, signature, secret) {
  if (!signature || !secret) return true; // Skip verification if not configured
  
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = hmac.update(JSON.stringify(payload)).digest('hex');
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    return false;
  }
}

/**
 * Webhook endpoint - receives events from wa-hub
 */
app.post('/webhooks/waapi', (req, res) => {
  const signature = req.headers['x-wa-hub-signature'];
  const payload = req.body;

  // Verify signature if secret is configured
  if (WEBHOOK_SECRET && WEBHOOK_SECRET !== 'your-shared-secret-here') {
    if (!verifySignature(payload, signature, WEBHOOK_SECRET)) {
      console.error('⚠️  Webhook signature verification failed!');
      // Still return 200 to prevent retries
      return res.status(200).json({ error: 'Invalid signature', received: true });
    }
  }

  // Log the webhook event
  console.log('\n📨 WEBHOOK RECEIVED:');
  console.log('─'.repeat(60));
  console.log(`Event: ${payload.event}`);
  console.log(`Instance ID: ${payload.instanceId}`);
  console.log('Data:', JSON.stringify(payload.data, null, 2));
  console.log('─'.repeat(60));
  console.log('');

  // Always return 200 OK to prevent wa-hub from retrying
  res.status(200).json({ 
    received: true, 
    event: payload.event,
    instanceId: payload.instanceId,
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'test-webhook-server' });
});

// Start server
app.listen(PORT, () => {
  console.log('🚀 Fake Main App Webhook Server Started');
  console.log(`📡 Listening on http://localhost:${PORT}`);
  console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhooks/waapi`);
  console.log(`🔐 Webhook Secret: ${WEBHOOK_SECRET}`);
  console.log('');
  console.log('Ready to receive webhooks from wa-hub...\n');
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down webhook server...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down webhook server...');
  process.exit(0);
});


