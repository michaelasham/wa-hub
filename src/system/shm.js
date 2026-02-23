/**
 * Shared memory and container detection for Chromium stability.
 * Used at startup to log /dev/shm size and warn in Docker when shm is small.
 */

const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const SHM_WARN_THRESHOLD_BYTES = 512 * 1024 * 1024; // 512MB

/**
 * Get /dev/shm size in bytes, or null if unavailable.
 * Uses df -B1 for portability (no statfs binding).
 * @returns {number | null}
 */
function getShmSizeBytes() {
  try {
    const out = execSync('df -B1 /dev/shm 2>/dev/null | tail -1', { encoding: 'utf8', timeout: 2000 });
    const parts = out.trim().split(/\s+/);
    // df output: Filesystem 1K-blocks Used Available Use% Mounted
    // -B1: blocks are 1-byte, so "Available" or total size is in column index 1 or 2
    const totalBlocks = parseInt(parts[1], 10);
    if (Number.isNaN(totalBlocks) || totalBlocks <= 0) return null;
    return totalBlocks; // -B1 means blocks are 1 byte
  } catch (_) {
    return null;
  }
}

/**
 * Detect if we are running inside a Docker container.
 * @returns {boolean}
 */
function isDocker() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    if (fs.existsSync('/run/.containerenv')) return true;
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    if (cgroup && (cgroup.includes('docker') || cgroup.includes('containerd'))) return true;
  } catch (_) {
    // ignore
  }
  return false;
}

/**
 * Log system memory and shm at startup; warn if Docker and shm < 512MB.
 */
function logStartupSystemInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const docker = isDocker();
  const shmBytes = getShmSizeBytes();

  const line = {
    isDocker: docker,
    totalMemoryMB: Math.round(totalMem / 1048576),
    freeMemoryMB: Math.round(freeMem / 1048576),
    shmSizeMB: shmBytes != null ? Math.round(shmBytes / 1048576) : null,
    shmSizeBytes: shmBytes,
  };
  console.log(`[Startup] system: ${JSON.stringify(line)}`);

  if (docker && shmBytes !== null && shmBytes < SHM_WARN_THRESHOLD_BYTES) {
    console.warn(
      `[Startup] WARN: Running in Docker with /dev/shm=${Math.round(shmBytes / 1048576)}MB. ` +
      'Recommend --shm-size=1g (or more) to avoid Chromium crashes. See README.'
    );
  }
}

module.exports = {
  getShmSizeBytes,
  isDocker,
  logStartupSystemInfo,
  SHM_WARN_THRESHOLD_BYTES,
};
