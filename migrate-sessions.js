#!/usr/bin/env node
/**
 * Utility script to migrate old LocalAuth session data to new per-instance directories
 * Run this on the server if instances are not finding their old session data
 */

const fs = require('fs').promises;
const path = require('path');
const config = require('./src/config');

async function copyDirectory(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function migrateSession(instanceId) {
  const oldAuthBase = config.sessionDataPath || './.wwebjs_auth';
  const sanitizedId = instanceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const newAuthPath = path.join(config.authBaseDir, sanitizedId);
  const newSessionPath = path.join(newAuthPath, `session-${sanitizedId}`);
  
  const possibleOldPaths = [
    path.join(oldAuthBase, `session-${sanitizedId}`),
    path.join(oldAuthBase, sanitizedId),
    path.join(oldAuthBase, `Default-${sanitizedId}`),
  ];
  
  console.log(`\n[Migration] Checking instance: ${instanceId} (sanitized: ${sanitizedId})`);
  
  for (const oldPath of possibleOldPaths) {
    try {
      const stat = await fs.stat(oldPath);
      if (stat.isDirectory()) {
        console.log(`[Migration] Found old session data at: ${oldPath}`);
        
        // Check if new path already exists
        try {
          await fs.access(newSessionPath);
          console.log(`[Migration] New session path already exists, skipping: ${newSessionPath}`);
          return true;
        } catch {
          // New path doesn't exist, proceed with migration
        }
        
        console.log(`[Migration] Copying to: ${newSessionPath}`);
        await fs.mkdir(newSessionPath, { recursive: true });
        
        const entries = await fs.readdir(oldPath, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(oldPath, entry.name);
          const destPath = path.join(newSessionPath, entry.name);
          
          if (entry.isDirectory()) {
            await copyDirectory(srcPath, destPath);
          } else {
            await fs.copyFile(srcPath, destPath);
          }
        }
        
        console.log(`[Migration] ✓ Successfully migrated ${instanceId}`);
        return true;
      }
    } catch (error) {
      // Old path doesn't exist, try next one
      continue;
    }
  }
  
  console.log(`[Migration] ✗ No old session data found for ${instanceId}`);
  return false;
}

async function main() {
  console.log('Session Migration Utility');
  console.log('=========================\n');
  console.log(`Old auth base: ${config.sessionDataPath || './.wwebjs_auth'}`);
  console.log(`New auth base: ${config.authBaseDir}`);
  console.log('');
  
  // Get instances from command line args or try common ones
  const instanceIds = process.argv.slice(2);
  
  if (instanceIds.length === 0) {
    console.log('Usage: node migrate-sessions.js <instanceId1> [instanceId2] ...');
    console.log('Example: node migrate-sessions.js WASP-fatatyeg_myshopify_com WASP-blesscurls_myshopify_com\n');
    console.log('Or check all instances in .wwebjs_auth directory...\n');
    
    // Try to find all old sessions
    const oldAuthBase = config.sessionDataPath || './.wwebjs_auth';
    try {
      const entries = await fs.readdir(oldAuthBase, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('session-')) {
          const instanceId = entry.name.replace(/^session-/, '');
          await migrateSession(instanceId);
        }
      }
    } catch (error) {
      console.log(`Could not read old auth directory: ${error.message}`);
    }
  } else {
    for (const instanceId of instanceIds) {
      await migrateSession(instanceId);
    }
  }
  
  console.log('\n[Migration] Done!');
  console.log('[Migration] Restart wa-hub service: pm2 restart wa-hub');
}

main().catch(error => {
  console.error('Migration error:', error);
  process.exit(1);
});
