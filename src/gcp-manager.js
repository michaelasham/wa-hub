/**
 * GCP Launchpad VM and GCS file transfer.
 * Uses Application Default Credentials (no explicit keys).
 */

const { InstancesClient } = require('@google-cloud/compute').v1;
const { Storage } = require('@google-cloud/storage');
const archiver = require('archiver');
const unzipper = require('unzipper');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const config = require('./config');
const sentry = require('./observability/sentry');

const compute = new InstancesClient();
const storage = new Storage(config.gcpProjectId ? { projectId: config.gcpProjectId } : {});

const POLL_MS = 10000;
const MAX_ATTEMPTS = 2;
/** Wait up to this long for launchpad app to respond on /health after VM is RUNNING */
const LAUNCHPAD_APP_READY_MS = 120000;

function waitForLaunchpadHealth(baseUrl) {
  return new Promise((resolve) => {
    const deadline = Date.now() + LAUNCHPAD_APP_READY_MS;
    const http = require('http');
    const healthUrl = baseUrl.replace(/\/$/, '') + '/health';
    function tryOnce() {
      if (Date.now() >= deadline) return resolve(false);
      const req = http.get(healthUrl, { timeout: 5000 }, (res) => {
        if (res.statusCode === 200) return resolve(true);
        scheduleNext();
      });
      req.on('error', () => scheduleNext());
      req.on('timeout', () => { req.destroy(); scheduleNext(); });
    }
    function scheduleNext() {
      setTimeout(tryOnce, 5000);
    }
    tryOnce();
  });
}

async function startLaunchpad() {
  const project = config.gcpProjectId;
  const zone = config.launchpadZone;
  const instanceName = config.launchpadVmName;
  const timeoutMs = config.launchpadStartTimeoutMs;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      sentry.addBreadcrumb({ category: 'launchpad', message: 'Starting launchpad VM', level: 'info', data: { attempt } });

      const [existing] = await Promise.race([
        compute.get({ project, zone, instance: instanceName }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('get instance timeout')), 15000)),
      ]).catch(() => [null]);

      if (existing) {
        const status = existing.status;
        if (status === 'RUNNING') {
          const internalIp = existing.networkInterfaces?.[0]?.networkIP;
          if (internalIp) {
            sentry.addBreadcrumb({ category: 'launchpad', message: 'Launchpad VM RUNNING', level: 'info', data: { internalIp } });
            const baseUrl = `http://${internalIp}:3000`;
            const appReady = await waitForLaunchpadHealth(baseUrl);
            if (appReady) sentry.addBreadcrumb({ category: 'launchpad', message: 'Launchpad app /health OK', level: 'info' });
            return { internalIp, baseUrl };
          }
        }
        if (status === 'TERMINATED' || status === 'STOPPED') {
          await Promise.race([
            compute.start({ project, zone, instance: instanceName }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('start timeout')), 30000)),
          ]);
          sentry.addBreadcrumb({ category: 'launchpad', message: 'Launchpad VM start requested (was stopped)', level: 'info' });
        }
      } else {
        const startupScript = [
          '#!/bin/bash',
          'set -e',
          `REPO_URL="${config.launchpadRepoUrl}"`,
          'M="http://metadata.google.internal/computeMetadata/v1/instance/attributes"',
          'GCS_BUCKET=$(curl -s -H "Metadata-Flavor: Google" "$M/GCS_BUCKET_NAME" || true)',
          'SECRET=$(curl -s -H "Metadata-Flavor: Google" "$M/LAUNCHPAD_INTERNAL_SECRET" || true)',
          'PROJECT=$(curl -s -H "Metadata-Flavor: Google" "$M/GCP_PROJECT_ID" || true)',
          'export GCS_BUCKET_NAME=$GCS_BUCKET LAUNCHPAD_INTERNAL_SECRET=$SECRET GCP_PROJECT_ID=$PROJECT IS_LAUNCHPAD=true',
          'apt-get update -qq && apt-get install -y -qq git nodejs npm > /dev/null 2>&1 || true',
          'git clone "$REPO_URL" /app 2>/dev/null || (cd /app && git pull)',
          'cd /app && npm install --production',
          'echo "GCS_BUCKET_NAME=$GCS_BUCKET" >> .env',
          'echo "LAUNCHPAD_INTERNAL_SECRET=$SECRET" >> .env',
          'echo "GCP_PROJECT_ID=$PROJECT" >> .env',
          'echo "IS_LAUNCHPAD=true" >> .env',
          'echo "PORT=3000" >> .env',
          'export PORT=3000 && node src/index.js &',
          'sleep 30',
        ].join('\n');

        const instanceResource = {
          name: instanceName,
          machineType: `zones/${zone}/machineTypes/e2-medium`,
          disks: [{
            boot: true,
            initializeParams: {
              sourceImage: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts',
              diskSizeGb: '20',
            },
            autoDelete: true,
          }],
          networkInterfaces: [{
            network: 'global/networks/default',
            accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }],
          }],
          scheduling: config.launchpadUseOnDemand
            ? {}
            : { provisioningModel: 'SPOT', instanceTerminationAction: 'STOP' },
          metadata: {
            items: [
              { key: 'startup-script', value: startupScript },
              { key: 'GCS_BUCKET_NAME', value: config.gcsBucketName },
              { key: 'LAUNCHPAD_INTERNAL_SECRET', value: config.launchpadInternalSecret },
              { key: 'GCP_PROJECT_ID', value: config.gcpProjectId },
            ],
          },
        };

        await Promise.race([
          compute.insert({ project, zone, instanceResource }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('insert instance timeout')), 60000)),
        ]);
        sentry.addBreadcrumb({ category: 'launchpad', message: 'Launchpad VM create requested', level: 'info' });
      }

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const [meta] = await compute.get({ project, zone, instance: instanceName }).catch(() => [null]);
        if (meta && meta.status === 'RUNNING') {
          const internalIp = meta.networkInterfaces?.[0]?.networkIP;
          if (internalIp) {
            sentry.addBreadcrumb({ category: 'launchpad', message: 'Launchpad VM RUNNING', level: 'info', data: { internalIp } });
            const baseUrl = `http://${internalIp}:3000`;
            const appReady = await waitForLaunchpadHealth(baseUrl);
            if (appReady) sentry.addBreadcrumb({ category: 'launchpad', message: 'Launchpad app /health OK', level: 'info' });
            return { internalIp, baseUrl };
          }
        }
      }
      throw new Error(`Launchpad VM did not reach RUNNING within ${timeoutMs}ms`);
    } catch (err) {
      console.error('[gcp-manager] startLaunchpad attempt', attempt, 'failed:', err.message);
      sentry.captureException(err, { phase: 'startLaunchpad', attempt });
      if (attempt === MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error('startLaunchpad failed after retries');
}

async function stopLaunchpad() {
  const project = config.gcpProjectId;
  const zone = config.launchpadZone;
  const instanceName = config.launchpadVmName;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      sentry.addBreadcrumb({ category: 'launchpad', message: 'Stopping launchpad VM', level: 'info' });
      const [meta] = await Promise.race([
        compute.get({ project, zone, instance: instanceName }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('get timeout')), 10000)),
      ]).catch(() => [null]);
      if (meta && meta.status === 'RUNNING') {
        await Promise.race([
          compute.stop({ project, zone, instance: instanceName }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('stop timeout')), 30000)),
        ]);
      }
      return;
    } catch (err) {
      console.error('[gcp-manager] stopLaunchpad attempt', attempt, 'failed:', err.message);
      sentry.captureException(err, { phase: 'stopLaunchpad', attempt });
      if (attempt === MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function uploadZipToGCS(localDirOrFile, gcsPath, archiveRoot = '') {
  const bucket = storage.bucket(config.gcsBucketName);
  const file = bucket.file(gcsPath);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const writeStream = file.createWriteStream({ metadata: { contentType: 'application/zip' } });
    const archive = archiver('zip', { zlib: { level: 5 } });
    try {
      const stat = await fs.stat(localDirOrFile);
      await new Promise((resolve, reject) => {
        archive.pipe(writeStream);
        if (stat.isDirectory()) {
          archive.directory(localDirOrFile, archiveRoot);
        } else {
          archive.file(localDirOrFile, { name: archiveRoot || path.basename(localDirOrFile) });
        }
        archive.finalize();
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        archive.on('error', reject);
      });
      return;
    } catch (err) {
      console.error('[gcp-manager] uploadZipToGCS attempt', attempt, 'failed:', err.message);
      sentry.captureException(err, { phase: 'uploadZipToGCS', attempt, gcsPath });
      if (attempt === MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function downloadZipFromGCS(gcsPath, localExtractPath) {
  const bucket = storage.bucket(config.gcsBucketName);
  const gcsFile = bucket.file(gcsPath);
  const tempZip = path.join(os.tmpdir(), `wa-hub-${Date.now()}-${path.basename(gcsPath)}`);
  const fsSync = require('fs');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await fs.mkdir(localExtractPath, { recursive: true });
      await Promise.race([
        gcsFile.download({ destination: tempZip }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('download timeout')), 120000)),
      ]);
      await new Promise((resolve, reject) => {
        fsSync.createReadStream(tempZip)
          .pipe(unzipper.Extract({ path: localExtractPath }))
          .on('close', resolve)
          .on('error', reject);
      });
      await fs.unlink(tempZip).catch(() => {});
      return;
    } catch (err) {
      console.error('[gcp-manager] downloadZipFromGCS attempt', attempt, 'failed:', err.message);
      sentry.captureException(err, { phase: 'downloadZipFromGCS', attempt, gcsPath });
      await fs.unlink(tempZip).catch(() => {});
      if (attempt === MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function downloadFileFromGCS(gcsPath, localPath) {
  const bucket = storage.bucket(config.gcsBucketName);
  const gcsFile = bucket.file(gcsPath);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await gcsFile.download({ destination: localPath });
}

async function uploadStringToGCS(gcsPath, content) {
  const bucket = storage.bucket(config.gcsBucketName);
  const file = bucket.file(gcsPath);
  await file.save(content, { contentType: 'application/json' });
}

module.exports = {
  startLaunchpad,
  stopLaunchpad,
  uploadZipToGCS,
  downloadZipFromGCS,
  downloadFileFromGCS,
  uploadStringToGCS,
};
