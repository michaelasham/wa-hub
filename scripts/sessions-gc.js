#!/usr/bin/env node
/**
 * sessions-gc.js - Safe garbage collection for orphaned LocalAuth session directories
 *
 * Drift between wa-hub's instance list and LocalAuth dirs is expected:
 * - LocalAuth dirs remain after instance delete (wa-hub does not remove them)
 * - Instances may exist without session dir (never started)
 *
 * Run with --dry-run (default) to report only. Use --delete-orphans --confirm
 * to remove orphan dirs when wa-hub is stopped.
 *
 * Usage:
 *   node scripts/sessions-gc.js [options]
 *   node scripts/sessions-gc.js --dry-run
 *   node scripts/sessions-gc.js --delete-orphans --confirm --require-stopped
 */

const fs = require('fs').promises;
const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config();

const DEFAULT_INSTANCES_PATH = process.env.INSTANCES_DATA_PATH || '.wwebjs_instances.json';
const DEFAULT_AUTH_BASE = process.env.AUTH_BASE_DIR || process.env.SESSION_DATA_PATH || '.wwebjs_auth';

function sanitizeInstanceId(id) {
  if (!id) return id;
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun: true,
    deleteOrphans: false,
    confirm: false,
    requireStopped: true,
    json: false,
    instancesPath: process.env.INSTANCES_DATA_PATH || DEFAULT_INSTANCES_PATH,
    authBaseDir: process.env.AUTH_BASE_DIR || process.env.SESSION_DATA_PATH || DEFAULT_AUTH_BASE,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--no-dry-run':
        opts.dryRun = false;
        break;
      case '--delete-orphans':
        opts.deleteOrphans = true;
        break;
      case '--confirm':
        opts.confirm = true;
        break;
      case '--require-stopped':
        opts.requireStopped = true;
        break;
      case '--no-require-stopped':
        opts.requireStopped = false;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--instances-path':
        opts.instancesPath = args[++i];
        break;
      case '--auth-base':
        opts.authBaseDir = args[++i];
        break;
      case '--help':
      case '-h':
        return { help: true, opts };
      default:
        if (args[i].startsWith('-')) {
          console.error(`Unknown option: ${args[i]}`);
          process.exit(1);
        }
    }
  }

  return { help: false, opts };
}

function printHelp() {
  console.log(`
sessions-gc.js - Safe GC for orphaned LocalAuth session directories

Options:
  --dry-run           Report only, no deletions (default: true)
  --no-dry-run        Disable dry-run when using --delete-orphans
  --delete-orphans    Delete orphan directories (requires --confirm)
  --confirm           Required for deletions
  --require-stopped   Refuse delete if wa-hub process is running (default: true)
  --no-require-stopped  Allow delete even if wa-hub may be running (DANGEROUS)
  --json              Output report as JSON
  --instances-path P  Path to instances JSON (default: INSTANCES_DATA_PATH or .wwebjs_instances.json)
  --auth-base D       LocalAuth base directory (default: AUTH_BASE_DIR or .wwebjs_auth)
  --help, -h          Show this help

Examples:
  node scripts/sessions-gc.js                    # Dry-run report
  node scripts/sessions-gc.js --json             # JSON report
  node scripts/sessions-gc.js --delete-orphans --confirm  # Delete orphans (wa-hub must be stopped)
`);
}

async function loadInstanceIds(instancesPath) {
  let data;
  try {
    const raw = await fs.readFile(instancesPath, 'utf8');
    data = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  if (!Array.isArray(data)) return [];
  return data.map((x) => (x && x.id ? String(x.id) : null)).filter(Boolean);
}

async function listLocalAuthDirs(authBaseDir) {
  let entries;
  try {
    entries = await fs.readdir(authBaseDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // LocalAuth uses session-{clientId} or just "session" for default
    let clientId = null;
    if (entry.name.startsWith('session-')) {
      clientId = entry.name.replace(/^session-/, '');
    } else if (entry.name === 'session') {
      clientId = '';
    }
    if (clientId !== null) {
      result.push({
        dirName: entry.name,
        clientId: clientId || '(default)',
        path: path.join(authBaseDir, entry.name),
      });
    }
  }
  return result;
}

async function getDirSizeKb(dirPath) {
  try {
    const out = spawnSync('du', ['-sk', dirPath], { encoding: 'utf8' });
    if (out.status !== 0) return null;
    const match = out.stdout.trim().match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function isWaHubRunning() {
  try {
    const result = spawnSync('pgrep', ['-f', 'wa-hub'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result.status === 0 && !!result.stdout.trim();
  } catch {
    return false;
  }
}

async function safeRmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true });
}

async function main() {
  const { help, opts } = parseArgs();
  if (help) {
    printHelp();
    process.exit(0);
  }

  const {
    dryRun,
    deleteOrphans,
    confirm,
    requireStopped,
    json: jsonMode,
    instancesPath,
    authBaseDir,
  } = opts;

  const instanceIdsRaw = await loadInstanceIds(path.resolve(instancesPath));
  const instanceClientIds = new Set(instanceIdsRaw.map(sanitizeInstanceId));

  const localAuthDirs = await listLocalAuthDirs(path.resolve(authBaseDir));
  const localAuthById = new Map();
  for (const d of localAuthDirs) {
    if (d.clientId === '(default)') continue;
    localAuthById.set(d.clientId, d);
  }

  const localAuthClientIds = new Set(localAuthById.keys());
  const orphans = [...localAuthClientIds].filter((id) => !instanceClientIds.has(id));
  const missing = [...instanceClientIds].filter((id) => !localAuthClientIds.has(id));

  const orphanDirs = orphans.map((id) => localAuthById.get(id)).filter(Boolean);
  let totalOrphanSizeKb = 0;
  const sizes = [];
  for (const d of orphanDirs) {
    const kb = await getDirSizeKb(d.path);
    sizes.push({ clientId: d.clientId, path: d.path, sizeKb: kb });
    if (kb) totalOrphanSizeKb += kb;
  }

  const report = {
    instancesPath: path.resolve(instancesPath),
    authBaseDir: path.resolve(authBaseDir),
    instanceCount: instanceIdsRaw.length,
    localAuthDirCount: localAuthDirs.length,
    orphanCount: orphans.length,
    missingCount: missing.length,
    totalOrphanSizeKb,
    orphans,
    missing,
    orphanDetails: sizes,
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Session drift report');
    console.log('===================');
    console.log(`Instances file: ${report.instancesPath}`);
    console.log(`Auth base dir:  ${report.authBaseDir}`);
    console.log(`Instance count (wa-hub):  ${report.instanceCount}`);
    console.log(`LocalAuth dirs:           ${report.localAuthDirCount}`);
    console.log(`Orphans (can delete):     ${report.orphanCount}`);
    console.log(`Missing (instance has no session dir): ${report.missingCount}`);
    console.log(`Total orphan size:        ${(report.totalOrphanSizeKb / 1024).toFixed(2)} MB`);
    if (orphans.length > 0) {
      console.log('\nOrphan session dirs:');
      for (const s of sizes) {
        const sizeStr = s.sizeKb != null ? `${(s.sizeKb / 1024).toFixed(2)} MB` : '?';
        console.log(`  - ${s.clientId}  ${sizeStr}  ${s.path}`);
      }
    }
    if (missing.length > 0) {
      console.log('\nInstances without session dir (never started or migrated):');
      missing.forEach((id) => console.log(`  - ${id}`));
    }
    console.log('');
  }

  if (deleteOrphans && !dryRun && confirm && orphans.length > 0) {
    if (requireStopped && isWaHubRunning()) {
      console.error('ERROR: wa-hub process appears to be running. Stop it first (pm2 stop wa-hub) or use --no-require-stopped (dangerous).');
      process.exit(1);
    }
    console.log('Deleting orphan directories...');
    for (const d of orphanDirs) {
      try {
        await safeRmDir(d.path);
        console.log(`  Deleted: ${d.path}`);
      } catch (err) {
        console.error(`  Failed to delete ${d.path}: ${err.message}`);
        process.exit(1);
      }
    }
    console.log('Done.');
  } else if (deleteOrphans && !confirm) {
    console.error('ERROR: --confirm is required for --delete-orphans');
    process.exit(1);
  } else if (deleteOrphans && dryRun) {
    console.log('Dry-run: no deletions. Use --no-dry-run --confirm to delete orphans.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
