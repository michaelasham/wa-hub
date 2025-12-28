/**
 * Main entry point for wa-hub service
 * Express-based HTTP API for managing WhatsApp Web sessions
 */

const express = require('express');
const config = require('./config');
const router = require('./router');
const { authenticateApiKey } = require('./auth');

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
  res.json({ status: 'ok', service: 'wa-hub' });
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

// Start server
const port = config.port;
const server = app.listen(port, () => {
  console.log(`wa-hub service started on port ${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
  console.log('Webhook: Each instance must provide its own webhook URL');
  console.log('Press Ctrl+C to stop the server');
});

// Graceful shutdown
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

