/**
 * Idempotency Store - File-based persistence for outbound message idempotency
 * Prevents duplicate sends using idempotency keys
 */

const fs = require('fs').promises;
const path = require('path');

class IdempotencyStore {
  constructor(dataPath = './.wwebjs_idempotency.json') {
    this.dataPath = dataPath;
    this.cache = new Map(); // In-memory cache
    this.loading = null; // Loading promise
  }

  /**
   * Load idempotency data from disk
   */
  async load() {
    if (this.loading) {
      return this.loading;
    }

    this.loading = (async () => {
      try {
        const data = await fs.readFile(this.dataPath, 'utf8');
        
        // Check if file is empty or just whitespace
        const trimmed = data.trim();
        if (!trimmed) {
          console.warn(`[IdempotencyStore] File is empty, starting fresh`);
          this.cache.clear();
          return [];
        }
        
        // Parse JSON with error handling
        let records;
        try {
          records = JSON.parse(data);
        } catch (parseError) {
          // File exists but is corrupted - back it up and start fresh
          const backupPath = `${this.dataPath}.corrupted.${Date.now()}`;
          console.error(`[IdempotencyStore] JSON parse error, backing up corrupted file to ${backupPath}:`, parseError.message);
          
          try {
            await fs.copyFile(this.dataPath, backupPath);
            console.log(`[IdempotencyStore] Corrupted file backed up to ${backupPath}`);
          } catch (backupError) {
            console.error(`[IdempotencyStore] Failed to backup corrupted file:`, backupError.message);
          }
          
          // Start fresh
          this.cache.clear();
          return [];
        }
        
        // Validate records is an array
        if (!Array.isArray(records)) {
          console.warn(`[IdempotencyStore] Data is not an array, starting fresh`);
          this.cache.clear();
          return [];
        }
        
        // Clear cache and reload
        this.cache.clear();
        for (const record of records) {
          // Validate record structure
          if (record && record.idempotencyKey) {
            this.cache.set(record.idempotencyKey, record);
          }
        }
        
        console.log(`[IdempotencyStore] Loaded ${records.length} records`);
        return records;
      } catch (error) {
        if (error.code === 'ENOENT') {
          // File doesn't exist yet, start fresh
          this.cache.clear();
          return [];
        }
        // For other errors, log and start fresh to avoid blocking
        console.error(`[IdempotencyStore] Load error:`, error.message);
        this.cache.clear();
        return [];
      } finally {
        this.loading = null;
      }
    })();

    return this.loading;
  }

  /**
   * Save idempotency data to disk
   */
  async save() {
    const records = Array.from(this.cache.values());
    const dataDir = path.dirname(this.dataPath);
    
    try {
      await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
      await fs.writeFile(this.dataPath, JSON.stringify(records, null, 2));
    } catch (error) {
      console.error('[IdempotencyStore] Save error:', error.message);
      // Don't throw - idempotency is best-effort
    }
  }

  /**
   * Get record by idempotency key
   */
  async get(idempotencyKey) {
    try {
      await this.load();
      return this.cache.get(idempotencyKey) || null;
    } catch (error) {
      // Defensive: if load fails, return null to avoid crashing callers
      console.error(`[IdempotencyStore] get() error for key ${idempotencyKey}:`, error.message);
      return null;
    }
  }

  /**
   * Check if idempotency key exists and is sent
   */
  async isSent(idempotencyKey) {
    try {
      const record = await this.get(idempotencyKey);
      return record && record.status === 'SENT';
    } catch (error) {
      // Defensive: if get fails, assume not sent to avoid blocking
      console.error(`[IdempotencyStore] isSent() error for key ${idempotencyKey}:`, error.message);
      return false;
    }
  }

  /**
   * Check if idempotency key exists and is queued (and not stale)
   */
  async isQueued(idempotencyKey, staleThresholdMs = 3600000) { // 1 hour default
    try {
      const record = await this.get(idempotencyKey);
      if (!record || record.status !== 'QUEUED') {
        return false;
      }
      
      // Check if stale
      const age = Date.now() - new Date(record.createdAt).getTime();
      return age < staleThresholdMs;
    } catch (error) {
      // Defensive: if get fails, assume not queued to avoid blocking
      console.error(`[IdempotencyStore] isQueued() error for key ${idempotencyKey}:`, error.message);
      return false;
    }
  }

  /**
   * Create or update idempotency record
   */
  async upsert(record) {
    await this.load();
    
    const now = new Date().toISOString();
    const existing = this.cache.get(record.idempotencyKey);
    
    if (existing) {
      // Update existing
      Object.assign(existing, record, { updatedAt: now });
    } else {
      // Create new
      const newRecord = {
        idempotencyKey: record.idempotencyKey,
        instanceName: record.instanceName,
        queueItemId: record.queueItemId || null,
        status: record.status || 'QUEUED',
        createdAt: now,
        updatedAt: now,
        sentAt: record.sentAt || null,
        providerMessageId: record.providerMessageId || null,
        error: record.error || null,
      };
      this.cache.set(record.idempotencyKey, newRecord);
    }
    
    // Async save (don't wait)
    this.save().catch(err => {
      console.error('[IdempotencyStore] Async save failed:', err.message);
    });
    
    return this.cache.get(record.idempotencyKey);
  }

  /**
   * Mark as SENT
   */
  async markSent(idempotencyKey, providerMessageId) {
    return this.upsert({
      idempotencyKey,
      status: 'SENT',
      sentAt: new Date().toISOString(),
      providerMessageId,
    });
  }

  /**
   * Mark as FAILED
   */
  async markFailed(idempotencyKey, error) {
    return this.upsert({
      idempotencyKey,
      status: 'FAILED',
      error: typeof error === 'string' ? error : (error?.message || String(error)),
    });
  }

  /**
   * Mark as SKIPPED (duplicate detected)
   */
  async markSkipped(idempotencyKey, reason) {
    return this.upsert({
      idempotencyKey,
      status: 'SKIPPED',
      error: reason,
    });
  }

  /**
   * Clean up old records (older than maxAgeMs)
   */
  async cleanup(maxAgeMs = 7 * 24 * 60 * 60 * 1000) { // 7 days default
    await this.load();
    
    const now = Date.now();
    const cutoff = now - maxAgeMs;
    
    let cleaned = 0;
    for (const [key, record] of this.cache.entries()) {
      const createdAt = new Date(record.createdAt).getTime();
      if (createdAt < cutoff) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      await this.save();
      console.log(`[IdempotencyStore] Cleaned up ${cleaned} old records`);
    }
    
    return cleaned;
  }

  /**
   * Get all records for an instance (for debugging)
   */
  async getByInstance(instanceName, limit = 100) {
    await this.load();

    const records = Array.from(this.cache.values())
      .filter(r => r.instanceName === instanceName)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);

    return records;
  }

  /**
   * Remove all idempotency records for an instance (call when instance is deleted).
   * @param {string} instanceName - Instance name (stored in record.instanceName)
   * @returns {Promise<number>} Number of records removed
   */
  async deleteByInstanceName(instanceName) {
    if (!instanceName) return 0;
    await this.load();
    let removed = 0;
    for (const [key, record] of this.cache.entries()) {
      if (record.instanceName === instanceName) {
        this.cache.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      await this.save();
      console.log(`[IdempotencyStore] Removed ${removed} record(s) for instance "${instanceName}"`);
    }
    return removed;
  }
}

// Singleton instance
const store = new IdempotencyStore(
  process.env.IDEMPOTENCY_DATA_PATH || './.wwebjs_idempotency.json'
);

// Auto-cleanup on startup (async, don't wait)
store.cleanup().catch(err => {
  console.error('[IdempotencyStore] Startup cleanup failed:', err.message);
});

module.exports = store;
