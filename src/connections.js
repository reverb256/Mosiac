'use strict';

/**
 * Connections Module — pubkey-based social graph.
 *
 * Follow/unfollow, blocklists, and groups for feed filtering.
 * All operations are pubkey-based (identity layer from Phase 1).
 */

const { getIdentityDb } = require('./database');

// ─── Follow / Unfollow ────────────────────────────────────────────────────

/**
 * Follow a pubkey.
 * @param {string} follower - Your pubkey
 * @param {string} followee - Pubkey to follow
 * @returns {{ followed: boolean }}
 */
function follow(follower, followee) {
  if (!follower || !followee) throw new Error('follower and followee are required');
  if (follower === followee) throw new Error('Cannot follow yourself');

  const db = getIdentityDb();

  // Check if already following
  const existing = db.prepare(
    'SELECT id FROM follows WHERE follower = ? AND followee = ?'
  ).get(follower, followee);

  if (existing) return { followed: false }; // already following

  db.prepare(
    'INSERT INTO follows (follower, followee) VALUES (?, ?)'
  ).run(follower, followee);

  return { followed: true };
}

/**
 * Unfollow a pubkey.
 * @param {string} follower - Your pubkey
 * @param {string} followee - Pubkey to unfollow
 * @returns {{ unfollowed: boolean }}
 */
function unfollow(follower, followee) {
  if (!follower || !followee) throw new Error('follower and followee are required');

  const db = getIdentityDb();
  const result = db.prepare(
    'DELETE FROM follows WHERE follower = ? AND followee = ?'
  ).run(follower, followee);

  return { unfollowed: result.changes > 0 };
}

/**
 * Check if follower follows followee.
 */
function isFollowing(follower, followee) {
  const db = getIdentityDb();
  const row = db.prepare(
    'SELECT id FROM follows WHERE follower = ? AND followee = ?'
  ).get(follower, followee);
  return !!row;
}

/**
 * Get the list of pubkeys that a given pubkey follows.
 * @param {string} pubkey
 * @returns {string[]}
 */
function getFollowing(pubkey) {
  const db = getIdentityDb();
  const rows = db.prepare(
    'SELECT followee FROM follows WHERE follower = ? ORDER BY created_at DESC'
  ).all(pubkey);
  return rows.map(r => r.followee);
}

/**
 * Get the list of pubkeys that follow a given pubkey.
 * @param {string} pubkey
 * @returns {Array<{ follower: string, created_at: string }>}
 */
function getFollowers(pubkey) {
  const db = getIdentityDb();
  return db.prepare(
    'SELECT follower, created_at FROM follows WHERE followee = ? ORDER BY created_at DESC'
  ).all(pubkey);
}

/**
 * Get follower count for a pubkey.
 * @param {string} pubkey
 * @returns {number}
 */
function getFollowerCount(pubkey) {
  const db = getIdentityDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS count FROM follows WHERE followee = ?'
  ).get(pubkey);
  return row.count;
}

/**
 * Get following count for a pubkey.
 * @param {string} pubkey
 * @returns {number}
 */
function getFollowingCount(pubkey) {
  const db = getIdentityDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS count FROM follows WHERE follower = ?'
  ).get(pubkey);
  return row.count;
}

// ─── Block / Unblock ──────────────────────────────────────────────────────

/**
 * Block a pubkey. Also removes any follow relationship both ways.
 * @param {string} blocker - Your pubkey
 * @param {string} blockedPubkey - Pubkey to block
 * @param {string} [reason] - Optional reason
 * @returns {{ blocked: boolean }}
 */
function block(blocker, blockedPubkey, reason = '') {
  if (!blocker || !blockedPubkey) throw new Error('blocker and blocked are required');
  if (blocker === blockedPubkey) throw new Error('Cannot block yourself');

  const db = getIdentityDb();

  // Check if already blocked
  const existing = db.prepare(
    'SELECT id FROM blocked WHERE blocker = ? AND blocked = ?'
  ).get(blocker, blockedPubkey);

  if (existing) return { blocked: false };

  // Remove any follow relationship both ways
  db.prepare(
    'DELETE FROM follows WHERE (follower = ? AND followee = ?) OR (follower = ? AND followee = ?)'
  ).run(blocker, blockedPubkey, blockedPubkey, blocker);

  // Add to blocklist
  db.prepare(
    'INSERT INTO blocked (blocker, blocked, reason) VALUES (?, ?, ?)'
  ).run(blocker, blockedPubkey, reason || '');

  return { blocked: true };
}

/**
 * Unblock a pubkey.
 * @param {string} blocker - Your pubkey
 * @param {string} blockedPubkey - Pubkey to unblock
 * @returns {{ unblocked: boolean }}
 */
function unblock(blocker, blockedPubkey) {
  if (!blocker || !blockedPubkey) throw new Error('blocker and blocked are required');

  const db = getIdentityDb();
  const result = db.prepare(
    'DELETE FROM blocked WHERE blocker = ? AND blocked = ?'
  ).run(blocker, blockedPubkey);

  return { unblocked: result.changes > 0 };
}

/**
 * Check if blocker has blocked blockedPubkey.
 */
function isBlocked(blocker, blockedPubkey) {
  const db = getIdentityDb();
  const row = db.prepare(
    'SELECT id FROM blocked WHERE blocker = ? AND blocked = ?'
  ).get(blocker, blockedPubkey);
  return !!row;
}

/**
 * Get all pubkeys blocked by a given pubkey.
 * @param {string} pubkey
 * @returns {Array<{ blocked: string, reason: string, created_at: string }>}
 */
function getBlocked(pubkey) {
  const db = getIdentityDb();
  return db.prepare(
    'SELECT blocked, reason, created_at FROM blocked WHERE blocker = ? ORDER BY created_at DESC'
  ).all(pubkey);
}

/**
 * Check if there's a block in either direction between two pubkeys.
 * Useful for filtering content — if A blocked B or B blocked A,
 * A shouldn't see B's content and vice versa.
 */
function hasMutualBlock(a, b) {
  const db = getIdentityDb();
  const row = db.prepare(
    "SELECT id FROM blocked WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?) LIMIT 1"
  ).get(a, b, b, a);
  return !!row;
}

// ─── Groups ────────────────────────────────────────────────────────────────

/**
 * Create a new group for collecting pubkeys.
 * @param {string} owner - Your pubkey
 * @param {string} name - Group name
 * @returns {{ id: number, name: string }}
 */
function createGroup(owner, name) {
  if (!owner) throw new Error('owner is required');
  if (!name || typeof name !== 'string' || !name.trim()) throw new Error('Group name is required');

  const db = getIdentityDb();
  const result = db.prepare(
    'INSERT INTO groups (owner, name) VALUES (?, ?)'
  ).run(owner, name.trim());

  return { id: result.lastInsertRowid, name: name.trim() };
}

/**
 * Delete a group.
 * @param {number} groupId
 * @param {string} owner - Must match group owner
 * @returns {{ deleted: boolean }}
 */
function deleteGroup(groupId, owner) {
  const db = getIdentityDb();
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) return { deleted: false };
  if (group.owner !== owner) throw new Error('Not authorized — you do not own this group');

  db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
  return { deleted: true };
}

/**
 * Add a pubkey to a group.
 * @param {number} groupId
 * @param {string} pubkey - Pubkey to add
 * @param {string} owner - Must match group owner
 * @returns {{ added: boolean }}
 */
function addToGroup(groupId, pubkey, owner) {
  if (!pubkey) throw new Error('pubkey is required');

  const db = getIdentityDb();
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) throw new Error('Group not found');
  if (group.owner !== owner) throw new Error('Not authorized — you do not own this group');

  try {
    db.prepare('INSERT INTO group_members (group_id, pubkey) VALUES (?, ?)').run(groupId, pubkey);
    return { added: true };
  } catch {
    // Already a member (unique constraint)
    return { added: false };
  }
}

/**
 * Remove a pubkey from a group.
 * @param {number} groupId
 * @param {string} pubkey
 * @param {string} owner - Must match group owner
 * @returns {{ removed: boolean }}
 */
function removeFromGroup(groupId, pubkey, owner) {
  const db = getIdentityDb();
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) throw new Error('Group not found');
  if (group.owner !== owner) throw new Error('Not authorized — you do not own this group');

  const result = db.prepare(
    'DELETE FROM group_members WHERE group_id = ? AND pubkey = ?'
  ).run(groupId, pubkey);

  return { removed: result.changes > 0 };
}

/**
 * List groups owned by a pubkey.
 * @param {string} owner
 * @returns {Array<{ id: number, name: string, member_count: number, created_at: string }>}
 */
function listGroups(owner) {
  const db = getIdentityDb();
  return db.prepare(`
    SELECT g.id, g.name, g.created_at,
           (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count
    FROM groups g
    WHERE g.owner = ?
    ORDER BY g.created_at DESC
  `).all(owner);
}

/**
 * Get members of a group.
 * @param {number} groupId
 * @param {string} owner - For authorization check
 * @returns {string[]}
 */
function getGroupMembers(groupId, owner) {
  const db = getIdentityDb();
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) throw new Error('Group not found');
  if (group.owner !== owner) throw new Error('Not authorized');

  const rows = db.prepare(
    'SELECT pubkey FROM group_members WHERE group_id = ? ORDER BY added_at ASC'
  ).all(groupId);
  return rows.map(r => r.pubkey);
}

// ─── Discovery helpers ────────────────────────────────────────────────────

/**
 * Get all pubkeys whose content should appear in the feed of a given user.
 * This is the union of:
 *   1. Pubkeys the user directly follows
 *   2. Pubkeys in groups owned by the user
 * minus any pubkeys the user has blocked.
 *
 * @param {string} pubkey
 * @returns {string[]} Deduplicated list of pubkeys
 */
function getFeedPubkeys(pubkey) {
  const db = getIdentityDb();

  // Pubkeys the user follows
  const following = db.prepare(
    'SELECT followee FROM follows WHERE follower = ?'
  ).all(pubkey).map(r => r.followee);

  // Pubkeys in groups owned by the user
  const groupMembers = db.prepare(`
    SELECT DISTINCT gm.pubkey
    FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    WHERE g.owner = ?
  `).all(pubkey).map(r => r.pubkey);

  // Pubkeys the user has blocked
  const blocked = new Set(
    db.prepare('SELECT blocked FROM blocked WHERE blocker = ?')
      .all(pubkey)
      .map(r => r.blocked)
  );

  // Union, dedup, minus blocked
  const seen = new Set();
  const feed = [];

  for (const pk of [...following, ...groupMembers]) {
    if (!seen.has(pk) && !blocked.has(pk) && pk !== pubkey) {
      seen.add(pk);
      feed.push(pk);
    }
  }

  return feed;
}

/**
 * Get mutual followers (people who follow each other) with a pubkey.
 * @param {string} pubkey
 * @returns {string[]}
 */
function getMutuals(pubkey) {
  const db = getIdentityDb();
  const rows = db.prepare(`
    SELECT a.followee AS mutual
    FROM follows a
    JOIN follows b ON a.follower = b.followee AND a.followee = b.follower
    WHERE a.follower = ?
  `).all(pubkey);
  return rows.map(r => r.mutual);
}

module.exports = {
  // Follow
  follow, unfollow, isFollowing,
  getFollowing, getFollowers,
  getFollowerCount, getFollowingCount,
  // Block
  block, unblock, isBlocked, getBlocked, hasMutualBlock,
  // Groups
  createGroup, deleteGroup,
  addToGroup, removeFromGroup,
  listGroups, getGroupMembers,
  // Discovery
  getFeedPubkeys, getMutuals,
};
