'use strict';

/**
 * Mosiac Feeds & Posts — Broadcast-style signed posts alongside chat.
 *
 * Built on top of the signed event bus (Phase 5). Posts are Ed25519-signed
 * events stored in the append-only event_log, with auxiliary tables for
 * likes, reposts, bookmarks, and feed channel membership.
 *
 * A "feed channel" is a broadcast channel type — any identity subscribed to it
 * can publish signed posts, and subscribers see them in a timeline.
 */

const { getIdentityDb } = require('./database');
const {
  createEvent, verifyEvent, getLatestEvent,
  EVENT_TYPES, ALL_EVENT_TYPES, isValidEventType,
} = require('./events');

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_TIMELINE_LIMIT = 50;
const MAX_TIMELINE_LIMIT = 200;

// ─── Post creation ────────────────────────────────────────────────────────

/**
 * Create a signed post event and optionally link it to a feed channel.
 *
 * @param {object} data - Post data
 * @param {string} data.content - Post body text
 * @param {string[]} [data.tags] - Optional tags/hashtags
 * @param {string|null} [data.replyTo] - Event ID this post replies to
 * @param {string} [data.channelCode] - Feed channel to publish in
 * @param {string} privkey - Signer's Ed25519 private key
 * @param {string} pubkey - Signer's Ed25519 public key
 * @returns {{ event: object, added: boolean }}
 */
function createPost(data, privkey, pubkey) {
  const event = createEvent(EVENT_TYPES.POST, {
    content: String(data.content || '').trim(),
    tags: Array.isArray(data.tags) ? data.tags.filter(t => typeof t === 'string') : [],
    replyTo: data.replyTo || null,
  }, privkey, pubkey);

  const db = getIdentityDb();
  const result = appendEventToLog(db, event);

  // Link to feed channel if specified
  if (data.channelCode && result.added) {
    linkPostToChannel(db, event.id, data.channelCode, event.created_at);
  }

  return { event, added: result.added };
}

/**
 * Create a signed like event and denormalize to feed_likes table.
 *
 * @param {string} postId - Event ID of the post being liked
 * @param {string} postAuthor - Pubkey of the post author
 * @param {string} privkey - Liker's Ed25519 private key
 * @param {string} pubkey - Liker's Ed25519 public key
 * @returns {{ event: object, added: boolean, liked: boolean }}
 */
function createLike(postId, postAuthor, privkey, pubkey) {
  const event = createEvent(EVENT_TYPES.LIKE, {
    postId,
    postAuthor,
  }, privkey, pubkey);

  const db = getIdentityDb();

  // Check if already liked — toggle behavior
  const existing = db.prepare(
    'SELECT 1 FROM feed_likes WHERE post_id = ? AND liker = ?'
  ).get(postId, pubkey);

  if (existing) {
    // Unlike: remove the like
    db.prepare('DELETE FROM feed_likes WHERE post_id = ? AND liker = ?').run(postId, pubkey);
    return { event, added: false, liked: false };
  }

  // Append the event and denormalize
  const result = appendEventToLog(db, event);
  if (result.added) {
    db.prepare(
      'INSERT OR IGNORE INTO feed_likes (post_id, liker, created_at) VALUES (?, ?, ?)'
    ).run(postId, pubkey, event.created_at);
  }

  return { event, added: result.added, liked: true };
}

/**
 * Create a signed repost (share) event.
 *
 * @param {string} postId - Event ID of the original post
 * @param {string} postAuthor - Pubkey of the original post author
 * @param {string} [content] - Optional commentary
 * @param {string} privkey - Reposter's Ed25519 private key
 * @param {string} pubkey - Reposter's Ed25519 public key
 * @returns {{ event: object, added: boolean }}
 */
function createRepost(postId, postAuthor, content, privkey, pubkey) {
  const event = createEvent(EVENT_TYPES.REPOST, {
    postId,
    postAuthor,
    content: content || '',
  }, privkey, pubkey);

  const db = getIdentityDb();
  const result = appendEventToLog(db, event);

  return { event, added: result.added };
}

// ─── Timeline queries ─────────────────────────────────────────────────────

/**
 * Get a timeline of posts from specified pubkeys.
 *
 * @param {string[]} pubkeys - Array of pubkeys to include
 * @param {object} [options]
 * @param {number} [options.limit=50] - Max posts
 * @param {number} [options.offset=0] - Pagination offset
 * @param {number} [options.since] - Only posts after this ms timestamp
 * @returns {object[]} Array of enriched post objects
 */
function getTimeline(pubkeys, options = {}) {
  if (!pubkeys || pubkeys.length === 0) return [];

  const { limit = DEFAULT_TIMELINE_LIMIT, offset = 0, since } = options;
  const effectiveLimit = Math.min(limit, MAX_TIMELINE_LIMIT);
  const db = getIdentityDb();

  const conditions = ['type = ?'];
  const params = [EVENT_TYPES.POST];

  if (pubkeys.length > 0) {
    conditions.push(`pubkey IN (${pubkeys.map(() => '?').join(',')})`);
    params.push(...pubkeys);
  }

  if (since) {
    conditions.push('created_at > ?');
    params.push(since);
  }

  const sql = `SELECT * FROM event_log WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(effectiveLimit, offset);

  const rows = db.prepare(sql).all(...params);
  return rows.map(row => enrichPost(row, db));
}

/**
 * Get a feed channel's post timeline.
 *
 * @param {string} channelCode - Feed channel code
 * @param {object} [options]
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @param {number} [options.since] - Only posts after this ms timestamp
 * @returns {object[]} Array of enriched post objects
 */
function getChannelTimeline(channelCode, options = {}) {
  const { limit = DEFAULT_TIMELINE_LIMIT, offset = 0, since } = options;
  const effectiveLimit = Math.min(limit, MAX_TIMELINE_LIMIT);
  const db = getIdentityDb();

  const conditions = ['fp.channel_code = ?'];
  const params = [channelCode];

  if (since) {
    conditions.push('el.created_at > ?');
    params.push(since);
  }

  const sql = `
    SELECT el.*, fp.pinned
    FROM feed_posts fp
    JOIN event_log el ON el.id = fp.event_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY fp.pinned DESC, el.created_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(effectiveLimit, offset);

  const rows = db.prepare(sql).all(...params);
  return rows.map(row => enrichPost(row, db));
}

/**
 * Get a single post by event ID with stats.
 *
 * @param {string} eventId - Event ID (SHA-256 hex)
 * @returns {object|null} Enriched post or null
 */
function getPost(eventId) {
  const db = getIdentityDb();
  const row = db.prepare('SELECT * FROM event_log WHERE id = ? AND type = ?').get(eventId, EVENT_TYPES.POST);
  if (!row) return null;
  return enrichPost(row, db);
}

/**
 * Get post engagement stats.
 *
 * @param {string} postId - Event ID
 * @returns {{ likes: number, reposts: number, replies: number, liked_by_me: boolean|null }}
 */
function getPostStats(postId) {
  const db = getIdentityDb();

  const likes = db.prepare(
    'SELECT COUNT(*) as count FROM feed_likes WHERE post_id = ?'
  ).get(postId);

  const reposts = db.prepare(
    'SELECT COUNT(*) as count FROM event_log WHERE type = ? AND data LIKE ?'
  ).get(EVENT_TYPES.REPOST, `%"postId":"${postId}"%`);

  const replies = db.prepare(
    'SELECT COUNT(*) as count FROM event_log WHERE type = ? AND data LIKE ?'
  ).get(EVENT_TYPES.POST, `%"replyTo":"${postId}"%`);

  return {
    likes: likes ? likes.count : 0,
    reposts: reposts ? reposts.count : 0,
    replies: replies ? replies.count : 0,
  };
}

/**
 * Check if a pubkey has liked a post.
 *
 * @param {string} postId
 * @param {string} pubkey
 * @returns {boolean}
 */
function hasLiked(postId, pubkey) {
  const db = getIdentityDb();
  const row = db.prepare(
    'SELECT 1 FROM feed_likes WHERE post_id = ? AND liker = ?'
  ).get(postId, pubkey);
  return !!row;
}

/**
 * Get replies to a specific post.
 *
 * @param {string} postId - Event ID of the parent post
 * @param {object} [options]
 * @param {number} [options.limit=50]
 * @returns {object[]}
 */
function getReplies(postId, options = {}) {
  const { limit = DEFAULT_TIMELINE_LIMIT } = options;
  const effectiveLimit = Math.min(limit, MAX_TIMELINE_LIMIT);
  const db = getIdentityDb();

  // Use LIKE to find posts whose data contains replyTo matching the postId
  const rows = db.prepare(
    `SELECT * FROM event_log
     WHERE type = ? AND data LIKE ?
     ORDER BY created_at ASC
     LIMIT ?`
  ).all(EVENT_TYPES.POST, `%"replyTo":"${postId}"%`, effectiveLimit);

  return rows.map(row => enrichPost(row, db));
}

// ─── Bookmarks ────────────────────────────────────────────────────────────

/**
 * Bookmark a post for a user.
 *
 * @param {string} eventId
 * @param {string} pubkey
 * @returns {{ bookmarked: boolean }}
 */
function bookmarkPost(eventId, pubkey) {
  const db = getIdentityDb();

  const existing = db.prepare(
    'SELECT 1 FROM feed_bookmarks WHERE event_id = ? AND user_pubkey = ?'
  ).get(eventId, pubkey);

  if (existing) {
    // Toggle off
    db.prepare('DELETE FROM feed_bookmarks WHERE event_id = ? AND user_pubkey = ?').run(eventId, pubkey);
    return { bookmarked: false };
  }

  db.prepare(
    'INSERT OR IGNORE INTO feed_bookmarks (event_id, user_pubkey, created_at) VALUES (?, ?, ?)'
  ).run(eventId, pubkey, Date.now());

  return { bookmarked: true };
}

/**
 * Get a user's bookmarked posts.
 *
 * @param {string} pubkey
 * @param {object} [options]
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @returns {object[]}
 */
function getBookmarks(pubkey, options = {}) {
  const { limit = DEFAULT_TIMELINE_LIMIT, offset = 0 } = options;
  const effectiveLimit = Math.min(limit, MAX_TIMELINE_LIMIT);
  const db = getIdentityDb();

  const rows = db.prepare(
    `SELECT el.*, 1 as bookmarked
     FROM feed_bookmarks fb
     JOIN event_log el ON el.id = fb.event_id
     WHERE fb.user_pubkey = ?
     ORDER BY fb.created_at DESC
     LIMIT ? OFFSET ?`
  ).all(pubkey, effectiveLimit, offset);

  return rows.map(row => enrichPost(row, db));
}

/**
 * Check if a post is bookmarked by a user.
 *
 * @param {string} eventId
 * @param {string} pubkey
 * @returns {boolean}
 */
function isBookmarked(eventId, pubkey) {
  const db = getIdentityDb();
  const row = db.prepare(
    'SELECT 1 FROM feed_bookmarks WHERE event_id = ? AND user_pubkey = ?'
  ).get(eventId, pubkey);
  return !!row;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Append an event to the event_log (idempotent).
 */
function appendEventToLog(db, event) {
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

/**
 * Link an event to a feed channel.
 */
function linkPostToChannel(db, eventId, channelCode, createdAt) {
  db.prepare(`
    INSERT OR IGNORE INTO feed_posts (event_id, channel_code, created_at)
    VALUES (?, ?, ?)
  `).run(eventId, channelCode, createdAt);
}

/**
 * Enrich a raw event_log row with feed-specific metadata.
 */
function enrichPost(row, db) {
  const post = {
    id: row.id,
    type: row.type,
    pubkey: row.pubkey,
    created_at: row.created_at,
    data: (typeof row.data === 'string' ? JSON.parse(row.data) : row.data),
    signature: row.signature,
    pinned: !!row.pinned,
    bookmarked: !!row.bookmarked,
  };

  // Attach engagement stats for post events
  if (row.type === EVENT_TYPES.POST) {
    const stats = getPostStats(row.id);
    post.likes = stats.likes;
    post.reposts = stats.reposts;
    post.replies = stats.replies;
  }

  return post;
}

module.exports = {
  // Constants
  EVENT_TYPES,
  DEFAULT_TIMELINE_LIMIT,
  MAX_TIMELINE_LIMIT,

  // Post operations
  createPost,
  createLike,
  createRepost,

  // Timeline queries
  getTimeline,
  getChannelTimeline,
  getPost,
  getPostStats,
  hasLiked,
  getReplies,

  // Bookmarks
  bookmarkPost,
  getBookmarks,
  isBookmarked,
};
