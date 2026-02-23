#!/usr/bin/env node
/**
 * Start the launchpad VM from the CLI.
 * Loads .env from repo root; uses GCP Application Default Credentials.
 *
 * Usage (from repo root):
 *   node scripts/start-launchpad.js
 *
 * Required in .env when using launchpad:
 *   GCP_PROJECT_ID, LAUNCHPAD_INTERNAL_SECRET
 * Optional: GCS_BUCKET_NAME, LAUNCHPAD_VM_NAME, LAUNCHPAD_ZONE, LAUNCHPAD_START_TIMEOUT_MS
 */

const path = require('path');

// Load .env from repo root so config and gcp-manager see launchpad vars
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  let config;
  let gcpManager;
  try {
    config = require('../src/config');
    gcpManager = require('../src/gcp-manager');
  } catch (err) {
    if (err.message && (err.message.includes('GCP_PROJECT_ID') || err.message.includes('LAUNCHPAD_INTERNAL_SECRET'))) {
      console.error('Missing required launchpad env vars. Set in .env:');
      console.error('  GCP_PROJECT_ID=your-gcp-project-id');
      console.error('  LAUNCHPAD_INTERNAL_SECRET=<strong-random-string>');
      console.error('See .env.example and docs/LAUNCHPAD.md');
    } else {
      console.error('Failed to load config or gcp-manager:', err.message);
    }
    process.exit(1);
  }

  if (!config.gcpProjectId || !config.gcpProjectId.trim()) {
    console.error('GCP_PROJECT_ID is not set in .env');
    process.exit(1);
  }

  console.log('Starting launchpad VM...');
  console.log('  Project:', config.gcpProjectId);
  console.log('  Zone:', config.launchpadZone);
  console.log('  VM:', config.launchpadVmName);
  console.log('  Timeout (ms):', config.launchpadStartTimeoutMs);
  console.log('');

  try {
    const result = await gcpManager.startLaunchpad();
    console.log('Launchpad VM is RUNNING');
    console.log('  Internal IP:', result.internalIp);
    console.log('  Base URL:', result.baseUrl);
    console.log('');
    console.log('Example: curl -H "X-Launchpad-Secret: YOUR_SECRET"', result.baseUrl + '/status/some-id');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
