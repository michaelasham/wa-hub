/**
 * PM2 Ecosystem configuration for wa-hub (backend + dashboard).
 * Run from repo root: pm2 start ecosystem.config.js
 *
 * - wa-hub: backend on PORT 3000
 * - wa-hub-dashboard: Next.js on PORT 3001 (explicit in npm run start)
 *
 * IS_LAUNCHPAD is passed from process.env (e.g. from root .env) so the launchpad VM
 * can run with IS_LAUNCHPAD=true when started via PM2.
 */

const path = require('path');

// Load root .env first so process.env has API_KEY, IS_LAUNCHPAD, etc. when PM2 reads this file
require('dotenv').config({ path: path.join(__dirname, '.env') });
// Load dashboard .env so env vars are available for the dashboard app
require('dotenv').config({ path: path.join(__dirname, 'wa-hub-dashboard', '.env') });

function trim(s) {
  return typeof s === 'string' ? s.trim() : s;
}

module.exports = {
  apps: [
    {
      name: 'wa-hub',
      script: './src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        IS_LAUNCHPAD: process.env.IS_LAUNCHPAD || 'false',
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'wa-hub-dashboard',
      script: 'npm',
      args: 'run start',
      cwd: path.join(__dirname, 'wa-hub-dashboard'),
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        HOSTNAME: '0.0.0.0',
        WA_HUB_BASE_URL: trim(process.env.WA_HUB_BASE_URL),
        WA_HUB_TOKEN: trim(process.env.WA_HUB_TOKEN),
        DASHBOARD_WEBHOOK_PUBLIC_URL: trim(process.env.DASHBOARD_WEBHOOK_PUBLIC_URL),
        DASHBOARD_PASSWORD: trim(process.env.DASHBOARD_PASSWORD),
        DASHBOARD_SESSION_SECRET: trim(process.env.DASHBOARD_SESSION_SECRET),
        DASHBOARD_SECURE_COOKIES: trim(process.env.DASHBOARD_SECURE_COOKIES),
        WA_HUB_WEBHOOK_SIGNATURE_SECRET: trim(process.env.WA_HUB_WEBHOOK_SIGNATURE_SECRET),
        ADMIN_DEBUG_SECRET: trim(process.env.ADMIN_DEBUG_SECRET),
      },
      autorestart: true,
    },
  ],
};
