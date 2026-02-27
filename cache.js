'use strict';

/**
 * In-memory TTL cache — stores parsed email maps per file ID.
 * Each entry holds: { data: Map<email, {...}>, loadedAt: Date, expiresAt: Date }
 */
class CacheStore {
  constructor() {
    this._store = new Map();
  }

  /** @returns {Map|null} the cached email Map, or null if missing/expired */
  get(fileId) {
    const entry = this._store.get(fileId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(fileId);
      return null;
    }
    return entry.data;
  }

  /** @param {string} fileId @param {Map} data @param {number} ttlSecs */
  set(fileId, data, ttlSecs) {
    const now = Date.now();
    this._store.set(fileId, {
      data,
      loadedAt:  now,
      expiresAt: now + ttlSecs * 1000,
    });
  }

  invalidate(fileId) {
    this._store.delete(fileId);
  }

  invalidateAll() {
    this._store.clear();
  }

  /** Evict all expired entries — called periodically by the cleanup interval. */
  _evictExpired() {
    const now = Date.now();
    for (const [fileId, entry] of this._store.entries()) {
      if (now > entry.expiresAt) this._store.delete(fileId);
    }
  }

  /** @returns {{ fileId, rowCount, loadedAt, expiresAt }[]} */
  stats() {
    const now = Date.now();
    const result = [];
    for (const [fileId, entry] of this._store.entries()) {
      if (now <= entry.expiresAt) {
        result.push({
          fileId,
          rowCount:  entry.data.size,
          loadedAt:  new Date(entry.loadedAt).toISOString(),
          expiresAt: new Date(entry.expiresAt).toISOString(),
        });
      } else {
        this._store.delete(fileId);
      }
    }
    return result;
  }
}

module.exports = new CacheStore();

// Evict expired entries every 5 minutes to prevent unbounded memory growth.
const _cacheInstance = module.exports;
setInterval(() => _cacheInstance._evictExpired(), 5 * 60 * 1000).unref();
