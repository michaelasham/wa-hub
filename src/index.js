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
  res.json({
    status: 'ok',
    service: 'wa-hub',
    instanceCount: instanceManager.getInstanceCount ? instanceManager.getInstanceCount() : 0,
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    loadavg: loadavg.map((l) => Math.round(l * 100) / 100),
  });
});

// API key authentication (applied to all routes after this point)
app.use(authenticateApiKey);

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
  
  // Don't leak error details in production
  const message = process.env.NODE_ENV === 'production' 
    ? 'Internal server error' 
    : err.message;

  res.status(err.status || 500).json({
    error: message,
    status: err.status || 500,
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server first (so /health and API are available immediately), then restore instances in background
const port = config.port;

const server = app.listen(port, () => {
  console.log(`wa-hub service started on port ${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
  console.log('Webhook: Each instance must provide its own webhook URL');
  console.log('Press Ctrl+C to stop the server');

  // Restore instances in background - do NOT block server startup
  // Restoration can take 2+ min per instance; server must be reachable for dashboard/health
  console.log('[Startup] Restoring instances from disk (background)...');
  instanceManager.loadInstancesFromDisk().then(() => {
    const instanceCount = instanceManager.getInstanceCount ? instanceManager.getInstanceCount() : 0;
    console.log(`[Startup] Restoration completed. instanceCount=${instanceCount}`);
  }).catch((error) => {
    console.error('[Startup] Error restoring instances:', error);
  });
});

// Debug patch: process restart visibility
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

// Setup graceful shutdown handlers
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});


module.exports = app;

