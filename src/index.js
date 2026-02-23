/**
 * Main entry point for wa-hub service
 * Express-based HTTP API for managing WhatsApp Web sessions
 */

const express = require('express');
const os = require('os');
const config = require('./config');
const router = require('./router');
const { authenticateApiKey } = require('./auth');
const instanceManager = require('./instance-manager');
const sentry = require('./observability/sentry');
const Sentry = require('@sentry/node');
const { logStartupSystemInfo } = require('./system/shm');
const systemMode = require('./systemMode');
const outboundQueue = require('./queues/outboundQueue');
const inboundBuffer = require('./queues/inboundBuffer');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Health check endpoint (no authentication required)
app.get('/health', (req, res) => {
  const loadavg = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuPercent = cpuCount > 0 ? Math.min(100, (loadavg[0] / cpuCount) * 100) : 0;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMemMB = Math.round((totalMem - freeMem) / 1048576);
  const totalMemMB = Math.round(totalMem / 1048576);
  const memPercent = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0;
  const processRssMB = Math.round(process.memoryUsage().rss / 1048576);
  res.json({
    status: 'ok',
    service: 'wa-hub',
    instanceCount: instanceManager.getInstanceCount ? instanceManager.getInstanceCount() : 0,
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    loadavg: loadavg.map((l) => Math.round(l * 100) / 100),
    memoryUsedMB: usedMemMB,
    memoryTotalMB: totalMemMB,
    memoryPercent: memPercent,
    processRssMB,
  });
});

// API key authentication (applied to all routes after this point)
app.use(authenticateApiKey);

// Optional: trigger a test exception in Sentry (dev only; 404 in production)
app.get('/internal/test-sentry', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    // eslint-disable-next-line no-undef -- intentional: triggers ReferenceError for Sentry test
    foo();
  } catch (e) {
    Sentry.captureException(e);
  }
  res.status(200).json({ ok: true, message: 'Test error sent to Sentry (ReferenceError)' });
});

// API routes (all require authentication)
app.use('/', router);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    status: 404,
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  sentry.captureException(err, { path: req.path, method: req.method });

  // Don't leak error details in production
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  res.status(err.status || 500).json({
    error: message,
    status: err.status || 500,
  });
});

const port = config.port;
let server;

async function main() {
  await sentry.initSentry();

  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    sentry.captureException(err);
    sentry.close(2000).then(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)), {
      unhandledRejection: true,
    });
  });

  process.on('SIGTERM', () => {
    sentry.addBreadcrumb({ category: 'process', message: 'SIGTERM received', level: 'info' });
    console.log('SIGTERM received, shutting down gracefully');
    sentry.close(2000).then(() => {
      if (server) server.close(() => process.exit(0));
      else process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    sentry.addBreadcrumb({ category: 'process', message: 'SIGINT received', level: 'info' });
    console.log('\nSIGINT received, shutting down gracefully');
    sentry.close(2000).then(() => {
      if (server) server.close(() => process.exit(0));
      else process.exit(0);
    });
  });

  server = app.listen(port, () => {
    console.log(`wa-hub service started on port ${port}`);
    console.log(`Health check: http://localhost:${port}/health`);
    console.log('Webhook: Each instance must provide its own webhook URL');
    console.log('Press Ctrl+C to stop the server');

    if (sentry.isEnabled()) {
      sentry.captureMessage('WA-Hub started', 'info', { instanceId: sentry.getInstanceId() });
    }

    const instanceCount = instanceManager.getInstanceCount ? instanceManager.getInstanceCount() : 0;
    const startInfo = {
      ts: new Date().toISOString(),
      event: 'process_start',
      pid: process.pid,
      memoryLimit: process.env.PM2_MAX_MEMORY_RESTART || process.env.NODE_OPTIONS?.match(/max-old-space-size=(\d+)/)?.[1] || 'not set',
      instanceCount,
      pm2Instances: process.env.PM2_INSTANCES || '1',
      execMode: process.env.PM2_PROCESS_ID !== undefined ? 'pm2' : 'direct',
    };
    console.log(JSON.stringify(startInfo));
    console.log(`[Startup] Process pid=${process.pid} (PM2 instances=${startInfo.pm2Instances}, exec_mode=fork - single worker)`);
    logStartupSystemInfo();

    if (instanceManager.startNeedsQrWatchdog) {
      instanceManager.startNeedsQrWatchdog();
    }
    console.log('[Startup] Restoring instances from disk (background)...');
    instanceManager.loadInstancesFromDisk().then(() => {
      const count = instanceManager.getInstanceCount ? instanceManager.getInstanceCount() : 0;
      console.log(`[Startup] Restoration completed. instanceCount=${count}`);
    }).catch((error) => {
      console.error('[Startup] Error restoring instances:', error);
      sentry.captureException(error, { phase: 'loadInstancesFromDisk' });
    });

    systemMode.on('mode', async (m) => {
      if (m.mode !== 'normal') return;
      const outCount = outboundQueue.getCount();
      const inCount = inboundBuffer.getCount();
      if (outCount > 0 || inCount > 0) {
        console.log(`[SystemMode] NORMAL: draining outbound (${outCount}) and flushing inbound (${inCount})`);
      }
      if (outCount > 0) {
        const { processed, failed } = await outboundQueue.drain((item) => instanceManager.runOutboundAction(item));
        console.log(`[SystemMode] Outbound drain done: processed=${processed} failed=${failed}`);
      }
      if (inCount > 0) {
        const { sent, failed } = await inboundBuffer.flushAll((entry) => instanceManager.deliverBufferedInbound(entry));
        console.log(`[SystemMode] Inbound flush done: sent=${sent} failed=${failed}`);
      }
    });
  });
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});

module.exports = app;

