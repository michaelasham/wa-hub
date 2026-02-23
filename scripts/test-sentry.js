#!/usr/bin/env node
/**
 * Call GET /internal/test-sentry to trigger a test error in Sentry.
 * Requires: server running, SENTRY_DSN set, NODE_ENV !== 'production', API_KEY in .env.
 * Usage: npm run test-sentry   (from repo root, with server already running)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const port = process.env.PORT || 3000;
const apiKey = process.env.API_KEY || '';

if (!apiKey) {
  console.error('Set API_KEY in .env');
  process.exit(1);
}

const url = `http://127.0.0.1:${port}/internal/test-sentry`;
const opts = {
  hostname: '127.0.0.1',
  port: Number(port),
  path: '/internal/test-sentry',
  method: 'GET',
  headers: { Authorization: `Bearer ${apiKey}` },
};

const http = require('http');
const req = http.request(opts, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const j = JSON.parse(body);
      console.log('Response:', j.message || body);
    } catch (_) {
      console.log('Body:', body);
    }
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
});

req.on('error', (e) => {
  console.error('Request failed (is the server running on port %s?): %s', port, e.message);
  process.exit(1);
});

req.end();
