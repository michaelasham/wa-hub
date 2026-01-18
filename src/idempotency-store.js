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
        const records = JSON.parse(data);
        
        // Clear cache and reload
        this.cache.clear();
        for (const record of records) {
          this.cache.set(record.idempotencyKey, record);
        }
        
        console.log(`[IdempotencyStore] Loaded ${records.length} records`);
        return records;
      } catch (error) {
        if (error.code === 'ENOENT') {
          // File doesn't exist yet, start fresh
          this.cache.clear();
          return [];
        }
        throw error;
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
    await this.load();
    return this.cache.get(idempotencyKey) || null;
  }

  /**
   * Check if idempotency key exists and is sent
   */
  async isSent(idempotencyKey) {
    const record = await this.get(idempotencyKey);
    return record && record.status === 'SENT';
  }

  /**
   * Check if idempotency key exists and is queued (and not stale)
   */
  async isQueued(idempotencyKey, staleThresholdMs = 3600000) { // 1 hour default
    const record = await this.get(idempotencyKey);
    if (!record || record.status !== 'QUEUED') {
      return false;
    }
    
    // Check if stale
    const age = Date.now() - new Date(record.createdAt).getTime();
    return age < staleThresholdMs;
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
