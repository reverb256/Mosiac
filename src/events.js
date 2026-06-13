'use strict';

/**
 * Signed Event Bus — Event types, envelope creation, and signature verification.
 *
 * Every Mosiac user action produces a signed event envelope:
 *   { id, type, pubkey, created_at, data, signature }
 *
 * The event ID is a SHA-256 hash of the canonical JSON representation of
 * { type, pubkey, created_at, data }, providing deterministic content-addressed IDs.
 *
 * Signatures use Ed25519 detached signatures via the identity module (tweetnacl).
 */

const crypto = require('crypto');
const identity = require('./identity');

// ─── Event type constants ──────────────────────────────────────────────────

const EVENT_TYPES = Object.freeze({
  PROFILE_UPDATE: 'profile_update',
  POST: 'post',
  LIKE: 'like',
  REPOST: 'repost',
  FOLLOW: 'follow',
  UNFOLLOW: 'unfollow',
  BLOCK: 'block',
  DM: 'dm',
  CHANNEL_CREATE: 'channel_create',
});

const ALL_EVENT_TYPES = Object.freeze(Object.values(EVENT_TYPES));

// ─── Event ID computation ──────────────────────────────────────────────────

/**
 * Compute a deterministic event ID from the event content.
 *
 * @param {string} type
 * @param {string} pubkey  - Base64URL-encoded Ed25519 public key
 * @param {number} created_at - Unix timestamp in milliseconds
 * @param {object} data   - Event payload
 * @returns {string} hex-encoded SHA-256 hash
 */
function computeEventID(type, pubkey, created_at, data) {
  const canonical = JSON.stringify({ type, pubkey, created_at, data });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ─── Event creation ────────────────────────────────────────────────────────

/**
 * Create a signed event envelope.
 *
 * Signs the canonical JSON of { id, type, pubkey, created_at, data } with the
 * given Ed25519 private key, producing a detached signature stored alongside
 * the event.
 *
 * @param {string} type   - One of EVENT_TYPES values
 * @param {object} data   - Event payload (JSON-serializable)
 * @param {string} privkey - Signer's Ed25519 private key (Base64URL)
 * @param {string} pubkey - Signer's Ed25519 public key (Base64URL)
 * @returns {{ id: string, type: string, pubkey: string, created_at: number, data: object, signature: string }}
 * @throws {Error} If type is unknown
 */
function createEvent(type, data, privkey, pubkey) {
  if (!ALL_EVENT_TYPES.includes(type)) {
    throw new Error(`Unknown event type: "${type}". Valid types: ${ALL_EVENT_TYPES.join(', ')}`);
  }

  const created_at = Date.now();
  const id = computeEventID(type, pubkey, created_at, data);

  // The signed payload is the canonical representation of the full event content
  // (excluding the signature itself — it signs everything else).
  const toSign = JSON.stringify({ id, type, pubkey, created_at, data });
  const signature = identity.sign(toSign, privkey);

  return { id, type, pubkey, created_at, data, signature };
}

// ─── Event verification ────────────────────────────────────────────────────

/**
 * Verify a signed event envelope.
 *
 * Checks:
 *   1. All required fields are present
 *   2. Event ID matches re-computed hash
 *   3. Ed25519 signature verifies against the canonical content
 *
 * @param {{ id, type, pubkey, created_at, data, signature }} event
 * @returns {boolean}
 */
function verifyEvent(event) {
  if (!event || !event.id || !event.type || !event.pubkey || !event.signature) {
    return false;
  }

  if (typeof event.created_at !== 'number') {
    return false;
  }

  // Recompute expected ID
  const expectedId = computeEventID(event.type, event.pubkey, event.created_at, event.data);
  if (event.id !== expectedId) {
    return false;
  }

  // Verify the signature over the canonical content
  const toVerify = JSON.stringify({
    id: event.id,
    type: event.type,
    pubkey: event.pubkey,
    created_at: event.created_at,
    data: event.data,
  });

  return identity.verify(toVerify, event.signature, event.pubkey);
}

// ─── Event type helpers ────────────────────────────────────────────────────

/**
 * Create a profile_update event.
 */
function profileUpdate(data, privkey, pubkey) {
  return createEvent(EVENT_TYPES.PROFILE_UPDATE, {
    displayName: data.displayName || '',
    bio: data.bio || '',
    avatar: data.avatar || '',
  }, privkey, pubkey);
}

/**
 * Create a post event.
 */
function post(data, privkey, pubkey) {
  return createEvent(EVENT_TYPES.POST, {
    content: data.content,
    tags: data.tags || [],
    replyTo: data.replyTo || null,
  }, privkey, pubkey);
}

/**
 * Create a like event.
 */
function like(data, privkey, pubkey) {
  return createEvent(EVENT_TYPES.LIKE, {
    postId: data.postId,
    postAuthor: data.postAuthor,
  }, privkey, pubkey);
}

/**
 * Create a repost event.
 */
function repost(data, privkey, pubkey) {
  return createEvent(EVENT_TYPES.REPOST, {
    postId: data.postId,
    postAuthor: data.postAuthor,
    content: data.content || '',
  }, privkey, pubkey);
}

/**
 * Create a follow event.
 */
function follow(targetPubkey, privkey, pubkey) {
  return createEvent(EVENT_TYPES.FOLLOW, { target: targetPubkey }, privkey, pubkey);
}

/**
 * Create an unfollow event.
 */
function unfollow(targetPubkey, privkey, pubkey) {
  return createEvent(EVENT_TYPES.UNFOLLOW, { target: targetPubkey }, privkey, pubkey);
}

/**
 * Create a block event.
 */
function block(targetPubkey, privkey, pubkey, reason) {
  return createEvent(EVENT_TYPES.BLOCK, {
    target: targetPubkey,
    reason: reason || '',
  }, privkey, pubkey);
}

/**
 * Create a dm event (direct message).
 */
function dm(data, privkey, pubkey) {
  return createEvent(EVENT_TYPES.DM, {
    recipient: data.recipient,
    content: data.content,
    encrypted: data.encrypted !== false,
  }, privkey, pubkey);
}

/**
 * Create a channel_create event.
 */
function channelCreate(data, privkey, pubkey) {
  return createEvent(EVENT_TYPES.CHANNEL_CREATE, {
    name: data.name,
    description: data.description || '',
    members: data.members || [],
  }, privkey, pubkey);
}

// ─── Type validation ───────────────────────────────────────────────────────

/**
 * Check if a string is a valid event type.
 *
 * @param {string} type
 * @returns {boolean}
 */
function isValidEventType(type) {
  return ALL_EVENT_TYPES.includes(type);
}

module.exports = {
  EVENT_TYPES,
  ALL_EVENT_TYPES,
  computeEventID,
  createEvent,
  verifyEvent,
  profileUpdate,
  post,
  like,
  repost,
  follow,
  unfollow,
  block,
  dm,
  channelCreate,
  isValidEventType,
};
