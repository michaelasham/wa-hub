/**
 * GCP metadata fetcher for instance identification (no external libs).
 * Used when running on GCP Compute Engine to tag Sentry events with instance_id/name.
 * Timeout and cache so boot never hangs.
 */

const http = require('http');

const METADATA_HOST = 'metadata.google.internal';
const METADATA_TIMEOUT_MS = 1200;
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' };

let cachedInstanceId = null;
let cachedInstanceName = null;
let cachedZone = null;

/**
 * Fetch a single metadata path. Returns null on timeout or non-200.
 * @param {string} path - e.g. /computeMetadata/v1/instance/id
 * @returns {Promise<string|null>}
 */
function fetchMetadata(path) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: METADATA_HOST,
        path,
        headers: METADATA_HEADERS,
        timeout: METADATA_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data.trim()));
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.setTimeout(METADATA_TIMEOUT_MS);
  });
}

/**
 * Get GCP Compute Engine instance ID (numeric). Cached after first success.
 * @returns {Promise<string|null>}
 */
async function getGcpInstanceId() {
  if (cachedInstanceId !== null) return cachedInstanceId;
  const id = await fetchMetadata('/computeMetadata/v1/instance/id');
  if (id != null && id.length > 0) cachedInstanceId = id;
  return cachedInstanceId;
}

/**
 * Get GCP instance name (e.g. vm-name). Cached after first success.
 * @returns {Promise<string|null>}
 */
async function getGcpInstanceName() {
  if (cachedInstanceName !== null) return cachedInstanceName;
  const name = await fetchMetadata('/computeMetadata/v1/instance/name');
  if (name != null && name.length > 0) cachedInstanceName = name;
  return cachedInstanceName;
}

/**
 * Get GCP zone (e.g. projects/123456/zones/us-central1-a). Cached after first success.
 * @returns {Promise<string|null>}
 */
async function getGcpZone() {
  if (cachedZone !== null) return cachedZone;
  const zone = await fetchMetadata('/computeMetadata/v1/instance/zone');
  if (zone != null && zone.length > 0) cachedZone = zone;
  return cachedZone;
}

module.exports = {
  getGcpInstanceId,
  getGcpInstanceName,
  getGcpZone,
};
