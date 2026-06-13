'use strict';

/**
 * Event Log — Append-only, per-pubkey event persistence layer.
 *
 * Stores verified signed events in SQLite. Events are content-addressed by
 * their SHA-256 ID for idempotent insertion (INSERT OR IGNORE).
 *
 * Tables live in the same SQLite database alongside Haven/Mosiac tables
 * (created in database.js initDatabase).
 *
 * Usage:
 *   const eventLog = require('./event-log');
 *   eventLog.append(signedEvent);
 *   const events = eventLog.getEvents(pubkey, { limit: 20 });
 *   const feed = eventLog.getFeed([alicePubkey, bobPubkey], { since: 1234567890000 });
 */

const { getIdentityDb } = require('./database');
const { verifyEvent, isValidEventType } = require('./events');

// ─── Append event ──────────────────────────────────────────────────────────

/**
 * Append a verified event to the log.
 *
 * The event is signature-verified before insertion. Duplicate event IDs are
 * silently skipped (idempotent via INSERT OR IGNORE), making replay safe.
 *
 * @param {{ id, type, pubkey, created_at, data, signature }} event
 * @returns {{ added: boolean, id: string }}
 * @throws {Error} If event is malformed, has unknown type, or signature fails
 */
function append(event) {
  if (!event || !event.id || !event.type || !event.pubkey || !event.signature) {
    throw new Error('Invalid event: missing required fields (id, type, pubkey, signature)');
  }

  if (typeof event.created_at !== 'number') {
    throw new Error('Invalid event: created_at must be a number (ms timestamp)');
  }

  if (!isValidEventType(event.type)) {
    throw new Error(`Unknown event type: "${event.type}"`);
  }

  if (!verifyEvent(event)) {
    throw new Error('Event signature verification failed');
  }

  const db = getIdentityDb();

  const result = db.prepare(`
    INSERT OR IGNORE INTO event_log (id, type, pubkey, created_at, data, signature)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.type,
    event.pubkey,
    event.created_at,
    JSON.stringify(event.data),
    event.signature
  );

  return { added: result.changes > 0, id: event.id };
}

// ─── Query by pubkey ───────────────────────────────────────────────────────

/**
 * Get events authored by a specific pubkey, most recent first.
 *
 * @param {string} pubkey - Author's Ed25519 public key (Base64URL)
 * @param {object} [options]
 * @param {number} [options.limit=50]   - Max events to return
 * @param {number} [options.offset=0]   - Pagination offset
 * @param {string[]} [options.types]    - Filter to specific event types
 * @param {number} [options.since]      - Only events after this ms timestamp
 * @returns {object[]} Array of event objects (latest first)
 */
function getEvents(pubkey, options = {}) {
  const { limit = 50, offset = 0, types, since } = options;
  const db = getIdentityDb();

  const conditions = ['pubkey = ?'];
  const params = [pubkey];

  if (types && types.length > 0) {
    const validTypes = types.filter(t => isValidEventType(t));
    if (validTypes.length > 0) {
      conditions.push(`type IN (${validTypes.map(() => '?').join(',')})`);
      params.push(...validTypes);
    }
  }

  if (since) {
    conditions.push('created_at > ?');
    params.push(since);
  }

  const sql = `SELECT * FROM event_log WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(sql).all(...params).map(rowToEvent);
}

/**
 * Get a single event by its content-addressed ID.
 *
 * @param {string} id - SHA-256 event ID (hex string)
 * @returns {object|null}
 */
function getEvent(id) {
  const db = getIdentityDb();
  const row = db.prepare('SELECT * FROM event_log WHERE id = ?').get(id);
  return row ? rowToEvent(row) : null;
}

// ─── Feed queries (multi-pubkey) ───────────────────────────────────────────

/**
 * Get events from multiple pubkeys, merged into a single time-ordered feed.
 * Useful for building a home feed from followed identities.
 *
 * @param {string[]} pubkeys - Array of public keys to include
 * @param {object} [options]
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @param {string[]} [options.types] - Filter to specific event types
 * @param {number} [options.since]   - Only events after this ms timestamp
 * @returns {object[]} Events sorted newest-first
 */
function getFeed(pubkeys, options = {}) {
  if (!pubkeys || pubkeys.length === 0) return [];

  const { limit = 50, offset = 0, types, since } = options;
  const db = getIdentityDb();

  const conditions = [`pubkey IN (${pubkeys.map(() => '?').join(',')})`];
  const params = [...pubkeys];

  if (types && types.length > 0) {
    const validTypes = types.filter(t => isValidEventType(t));
    if (validTypes.length > 0) {
      conditions.push(`type IN (${validTypes.map(() => '?').join(',')})`);
      params.push(...validTypes);
    }
  }

  if (since) {
    conditions.push('created_at > ?');
    params.push(since);
  }

  const sql = `SELECT * FROM event_log WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(sql).all(...params).map(rowToEvent);
}

// ─── Aggregates ────────────────────────────────────────────────────────────

/**
 * Get total event count for a pubkey.
 *
 * @param {string} pubkey
 * @returns {number}
 */
function getEventCount(pubkey) {
  const db = getIdentityDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM event_log WHERE pubkey = ?').get(pubkey);
  return row ? row.count : 0;
}

/**
 * Get the latest event of a specific type for a pubkey.
 * Useful for resolving the current state (e.g. latest profile_update).
 *
 * @param {string} pubkey
 * @param {string} type - Event type to look up
 * @returns {object|null}
 */
function getLatestEvent(pubkey, type) {
  if (!isValidEventType(type)) return null;
  const db = getIdentityDb();
  const row = db.prepare(
    'SELECT * FROM event_log WHERE pubkey = ? AND type = ? ORDER BY created_at DESC LIMIT 1'
  ).get(pubkey, type);
  return row ? rowToEvent(row) : null;
}

/**
 * Delete events older than a given timestamp.
 * Useful for cleanup / compaction.
 *
 * @param {number} olderThan - Unix ms timestamp
 * @returns {number} Number of deleted rows
 */
function prune(olderThan) {
  const db = getIdentityDb();
  const result = db.prepare('DELETE FROM event_log WHERE created_at < ?').run(olderThan);
  return result.changes;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function rowToEvent(row) {
  return {
    id: row.id,
    type: row.type,
    pubkey: row.pubkey,
    created_at: row.created_at,
    data: JSON.parse(row.data),
    signature: row.signature,
  };
}

module.exports = {
  append,
  getEvents,
  getEvent,
  getFeed,
  getEventCount,
  getLatestEvent,
  prune,
};
