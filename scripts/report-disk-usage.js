#!/usr/bin/env node
/**
 * Disk Usage Diagnostic Script for WA-Hub
 * 
 * Reports disk usage for tenant directories and identifies cache-heavy subdirectories.
 * Outputs both human-readable and JSON formats.
 * 
 * Usage:
 *   node scripts/report-disk-usage.js [--json] [--tenants-dir=/path]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Load config to get default auth base directory
let config;
try {
  // Try to load config (may fail if not in project root)
  process.chdir(path.join(__dirname, '..'));
  config = require('../src/config');
} catch (error) {
  // Fallback to defaults if config can't be loaded
  config = {
    authBaseDir: process.env.AUTH_BASE_DIR || process.env.SESSION_DATA_PATH || './.wwebjs_auth',
  };
}

const TENANTS_DIR = process.env.WA_HUB_TENANTS_DIR || 
                    process.env.AUTH_BASE_DIR || 
                    process.env.SESSION_DATA_PATH || 
                    config.authBaseDir || 
                    './.wwebjs_auth';

const OUTPUT_JSON = process.argv.includes('--json') || process.argv.includes('-j');

/**
 * Get directory size in bytes using du command (more reliable than Node.js recursive walk)
 */
function getDirSize(dirPath) {
  try {
    const result = execSync(`du -sb "${dirPath}" 2>/dev/null`, { encoding: 'utf8' });
    return parseInt(result.split('\t')[0], 10) || 0;
  } catch (error) {
    return 0;
  }
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Find Chromium profile directories within a tenant directory
 */
function findProfileDirs(tenantDir) {
  const profiles = [];
  
  try {
    const entries = fs.readdirSync(tenantDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = path.join(tenantDir, entry.name);
        
        // Check if this looks like a Chromium profile directory
        // Profiles are typically: Default, Profile 1, Profile 2, etc.
        if (entry.name === 'Default' || entry.name.match(/^Profile \d+$/)) {
          profiles.push({
            name: entry.name,
            path: dirPath,
            size: getDirSize(dirPath),
          });
        }
      }
    }
  } catch (error) {
    // Directory doesn't exist or can't be read
  }
  
  return profiles;
}

/**
 * Find cache directories within a profile directory
 */
function findCacheDirs(profileDir) {
  const cacheDirs = [
    'Cache',
    'Code Cache',
    'GPUCache',
    'Service Worker/CacheStorage',
    'Service Worker/ScriptCache',
    'Media Cache',
    'ShaderCache',
  ];
  
  const found = [];
  
  for (const cacheName of cacheDirs) {
    const cachePath = path.join(profileDir, cacheName);
    try {
      if (fs.existsSync(cachePath)) {
        const stats = fs.statSync(cachePath);
        if (stats.isDirectory()) {
          found.push({
            name: cacheName,
            path: cachePath,
            size: getDirSize(cachePath),
          });
        }
      }
    } catch (error) {
      // Skip if can't access
    }
  }
  
  return found;
}

/**
 * Scan tenant directory and report usage
 */
function scanTenantsDir() {
  const tenantsDir = path.resolve(TENANTS_DIR);
  
  if (!fs.existsSync(tenantsDir)) {
    if (OUTPUT_JSON) {
      console.log(JSON.stringify({ error: `Tenants directory does not exist: ${tenantsDir}` }, null, 2));
    } else {
      console.error(`Error: Tenants directory does not exist: ${tenantsDir}`);
      console.error(`Set WA_HUB_TENANTS_DIR environment variable to override.`);
    }
    process.exit(1);
  }
  
  const report = {
    tenantsDir,
    scannedAt: new Date().toISOString(),
    tenants: [],
    totalSize: 0,
  };
  
  try {
    const entries = fs.readdirSync(tenantsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const tenantPath = path.join(tenantsDir, entry.name);
        const tenantSize = getDirSize(tenantPath);
        
        const tenantInfo = {
          name: entry.name,
          path: tenantPath,
          totalSize: tenantSize,
          totalSizeFormatted: formatBytes(tenantSize),
          profiles: [],
        };
        
        // Find Chromium profiles
        const profiles = findProfileDirs(tenantPath);
        
        for (const profile of profiles) {
          const profileInfo = {
            name: profile.name,
            path: profile.path,
            size: profile.size,
            sizeFormatted: formatBytes(profile.size),
            cacheDirs: [],
          };
          
          // Find cache directories within profile
          const cacheDirs = findCacheDirs(profile.path);
          let cacheTotal = 0;
          
          for (const cache of cacheDirs) {
            cacheTotal += cache.size;
            profileInfo.cacheDirs.push({
              name: cache.name,
              path: cache.path,
              size: cache.size,
              sizeFormatted: formatBytes(cache.size),
            });
          }
          
          profileInfo.cacheTotal = cacheTotal;
          profileInfo.cacheTotalFormatted = formatBytes(cacheTotal);
          
          tenantInfo.profiles.push(profileInfo);
        }
        
        // Also check for .wwebjs_cache directory
        const cacheDir = path.join(tenantPath, '.wwebjs_cache');
        if (fs.existsSync(cacheDir)) {
          const cacheSize = getDirSize(cacheDir);
          tenantInfo.wwebjsCacheSize = cacheSize;
          tenantInfo.wwebjsCacheSizeFormatted = formatBytes(cacheSize);
        }
        
        report.tenants.push(tenantInfo);
        report.totalSize += tenantSize;
      }
    }
    
    // Sort tenants by size (descending)
    report.tenants.sort((a, b) => b.totalSize - a.totalSize);
    report.totalSizeFormatted = formatBytes(report.totalSize);
    
  } catch (error) {
    if (OUTPUT_JSON) {
      console.log(JSON.stringify({ error: error.message }, null, 2));
    } else {
      console.error(`Error scanning tenants directory: ${error.message}`);
    }
    process.exit(1);
  }
  
  if (OUTPUT_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    // Human-readable output
    console.log('='.repeat(80));
    console.log(`WA-Hub Disk Usage Report`);
    console.log(`Tenants Directory: ${tenantsDir}`);
    console.log(`Scanned At: ${report.scannedAt}`);
    console.log('='.repeat(80));
    console.log();
    
    if (report.tenants.length === 0) {
      console.log('No tenant directories found.');
    } else {
      console.log(`Total Tenants: ${report.tenants.length}`);
      console.log(`Total Size: ${report.totalSizeFormatted}`);
      console.log();
      
      for (const tenant of report.tenants) {
        console.log(`Tenant: ${tenant.name}`);
        console.log(`  Total Size: ${tenant.totalSizeFormatted}`);
        console.log(`  Path: ${tenant.path}`);
        
        if (tenant.wwebjsCacheSize) {
          console.log(`  .wwebjs_cache: ${tenant.wwebjsCacheSizeFormatted}`);
        }
        
        if (tenant.profiles.length > 0) {
          console.log(`  Profiles:`);
          for (const profile of tenant.profiles) {
            console.log(`    ${profile.name}: ${profile.sizeFormatted} (cache: ${profile.cacheTotalFormatted})`);
            if (profile.cacheDirs.length > 0) {
              for (const cache of profile.cacheDirs) {
                console.log(`      - ${cache.name}: ${cache.sizeFormatted}`);
              }
            }
          }
        }
        console.log();
      }
    }
  }
}

// Run the scan
scanTenantsDir();
