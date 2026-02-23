#!/usr/bin/env node
/**
 * Stop the launchpad VM from the CLI.
 * Loads .env from repo root; uses GCP Application Default Credentials.
 *
 * Usage (from repo root):
 *   node scripts/stop-launchpad.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  let config;
  let gcpManager;
  try {
    config = require('../src/config');
    gcpManager = require('../src/gcp-manager');
  } catch (err) {
    console.error('Failed to load config or gcp-manager:', err.message);
    process.exit(1);
  }
  if (!config.gcpProjectId || !config.gcpProjectId.trim()) {
    console.error('GCP_PROJECT_ID is not set in .env');
    process.exit(1);
  }
  console.log('Stopping launchpad VM...');
  try {
    await gcpManager.stopLaunchpad();
    console.log('Launchpad VM stopped.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
