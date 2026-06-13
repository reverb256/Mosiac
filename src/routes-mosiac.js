'use strict';

/**
 * Mosiac Identity Routes — mounted alongside Haven's existing routes.
 * All identity/auth/QR/contact/signing endpoints in one place.
 */
const express = require('express');
const router = express.Router();
const path = require('path');

const identity = require('./identity');
const qr = require('./qr');
const passkey = require('./passkey');
const connections = require('./connections');
const { getIdentityDb } = require('./database');

// Apply session middleware to all routes so requireAuth works
router.use(passkey.sessionMiddleware);

/* ─── Health ─── */
router.get('/health', (req, res) => res.json({ ok: true, mosiac: '0.1.0' }));

/* ─── Identity ─── */
router.get('/identity', (req, res) => {
  try {
    const rows = getIdentityDb().prepare('SELECT id, pubkey, label, is_current, created_at FROM identities ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/identity/current', (req, res) => {
  try {
    const row = getIdentityDb().prepare('SELECT * FROM identities WHERE is_current = 1').get();
    if (!row) return res.json({ identity: null });
    res.json({ identity: { id: row.id, pubkey: row.pubkey, label: row.label, pubkeyHex: identity.toHex(identity.fromBase64URL(row.pubkey)) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/identity/generate', (req, res) => {
  try {
    const kp = identity.generateKeyPair();
    const ident = getIdentityDb().prepare(`
      INSERT INTO identities (pubkey, privkey, label, is_current)
      VALUES (?, ?, ?, (SELECT COUNT(*) = 0 FROM identities))
    `).run(kp.pubkey, kp.privkey, req.body?.label || null);
    res.json({ identityId: ident.lastInsertRowid, pubkey: kp.pubkey, pubkeyHex: kp.pubkeyHex });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─── WebAuthn Registration ─── */
router.post('/auth/register/begin', async (req, res) => {
  try {
    const result = passkey.beginRegistration({ label: req.body?.label });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/auth/register/complete', async (req, res) => {
  try {
    const result = await passkey.completeRegistration({
      challenge: req.body.challenge,
      credential: req.body.credential,
      nickname: req.body.nickname,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ─── WebAuthn Authentication ─── */
router.post('/auth/login/begin', async (req, res) => {
  try {
    const result = passkey.beginAuthentication();
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/auth/login/complete', async (req, res) => {
  try {
    const result = await passkey.completeAuthentication({ credential: req.body.credential });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/auth/logout', (req, res) => {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  if (token) passkey.invalidateSession(token);
  res.json({ ok: true });
});

router.get('/auth/me', passkey.requireAuth, (req, res) => {
  const ident = getIdentityDb().prepare('SELECT * FROM identities WHERE id = ?').get(req.identity.identityId);
  if (!ident) return res.status(404).json({ error: 'Identity not found' });
  res.json({ identityId: ident.id, pubkey: ident.pubkey, label: ident.label });
});

/* ─── QR ─── */
router.get('/qr/:pubkey', async (req, res) => {
  try {
    const svg = await qr.generatePubkeyQR_SVG(req.params.pubkey);
    res.type('image/svg+xml').send(svg);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/qr/scan', (req, res) => {
  try {
    const result = qr.processQRScan(req.body.scanned, req.body.label);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ─── Contacts ─── */
router.get('/contacts', (req, res) => {
  try {
    const rows = getIdentityDb().prepare('SELECT * FROM contacts ORDER BY first_seen_at DESC').all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/contacts/:pubkey', (req, res) => {
  try {
    getIdentityDb().prepare('DELETE FROM contacts WHERE pubkey = ?').run(req.params.pubkey);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─── Signing (event bus foundation) ─── */
router.post('/sign', passkey.requireAuth, (req, res) => {
  try {
    const ident = getIdentityDb().prepare('SELECT * FROM identities WHERE id = ?').get(req.identity.identityId);
    if (!ident) return res.status(404).json({ error: 'Identity not found' });
    const signed = identity.signJSON(req.body.data, ident.privkey, ident.pubkey);
    res.json(signed);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/verify', (req, res) => {
  try {
    const valid = identity.verifyJSON(req.body);
    res.json({ valid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ─── Connections (Phase 4) ─── */

// Follow / Unfollow

router.post('/connections/follow', passkey.requireAuth, (req, res) => {
  try {
    const { followee } = req.body;
    if (!followee) return res.status(400).json({ error: 'followee is required' });
    const result = connections.follow(req.identity.pubkey, followee);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/connections/unfollow', passkey.requireAuth, (req, res) => {
  try {
    const { followee } = req.body;
    if (!followee) return res.status(400).json({ error: 'followee is required' });
    const result = connections.unfollow(req.identity.pubkey, followee);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/connections/following', passkey.requireAuth, (req, res) => {
  try {
    const following = connections.getFollowing(req.identity.pubkey);
    const counts = {
      following: following.length,
      followers: connections.getFollowerCount(req.identity.pubkey),
    };
    res.json({ pubkey: req.identity.pubkey, following, counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/connections/followers', passkey.requireAuth, (req, res) => {
  try {
    const followers = connections.getFollowers(req.identity.pubkey);
    const counts = {
      followers: followers.length,
      following: connections.getFollowingCount(req.identity.pubkey),
    };
    res.json({ pubkey: req.identity.pubkey, followers, counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/connections/followers/:pubkey', (req, res) => {
  try {
    const followers = connections.getFollowers(req.params.pubkey);
    res.json({ pubkey: req.params.pubkey, followers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/connections/following/:pubkey', (req, res) => {
  try {
    const following = connections.getFollowing(req.params.pubkey);
    res.json({ pubkey: req.params.pubkey, following });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Check follow relationship
router.get('/connections/is-following/:followee', passkey.requireAuth, (req, res) => {
  try {
    const result = connections.isFollowing(req.identity.pubkey, req.params.followee);
    res.json({ following: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mututal followers
router.get('/connections/mutuals', passkey.requireAuth, (req, res) => {
  try {
    const mutuals = connections.getMutuals(req.identity.pubkey);
    res.json({ pubkey: req.identity.pubkey, mutuals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Block / Unblock

router.post('/connections/block', passkey.requireAuth, (req, res) => {
  try {
    const { blocked, reason } = req.body;
    if (!blocked) return res.status(400).json({ error: 'blocked is required' });
    const result = connections.block(req.identity.pubkey, blocked, reason);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/connections/unblock', passkey.requireAuth, (req, res) => {
  try {
    const { blocked } = req.body;
    if (!blocked) return res.status(400).json({ error: 'blocked is required' });
    const result = connections.unblock(req.identity.pubkey, blocked);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/connections/blocked', passkey.requireAuth, (req, res) => {
  try {
    const blocked = connections.getBlocked(req.identity.pubkey);
    res.json({ pubkey: req.identity.pubkey, blocked });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Groups

router.post('/connections/groups', passkey.requireAuth, (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = connections.createGroup(req.identity.pubkey, name);
    res.status(201).json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/connections/groups', passkey.requireAuth, (req, res) => {
  try {
    const groups = connections.listGroups(req.identity.pubkey);
    res.json({ pubkey: req.identity.pubkey, groups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/connections/groups/:id', passkey.requireAuth, (req, res) => {
  try {
    const result = connections.deleteGroup(Number(req.params.id), req.identity.pubkey);
    if (!result.deleted) return res.status(404).json({ error: 'Group not found' });
    res.json(result);
  } catch (e) {
    const status = e.message.includes('Not authorized') ? 403 : 400;
    res.status(status).json({ error: e.message });
  }
});

router.post('/connections/groups/:id/add', passkey.requireAuth, (req, res) => {
  try {
    const { pubkey } = req.body;
    if (!pubkey) return res.status(400).json({ error: 'pubkey is required' });
    const result = connections.addToGroup(Number(req.params.id), pubkey, req.identity.pubkey);
    res.json(result);
  } catch (e) {
    const status = e.message.includes('Not authorized') ? 403 : e.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

router.post('/connections/groups/:id/remove', passkey.requireAuth, (req, res) => {
  try {
    const { pubkey } = req.body;
    if (!pubkey) return res.status(400).json({ error: 'pubkey is required' });
    const result = connections.removeFromGroup(Number(req.params.id), pubkey, req.identity.pubkey);
    res.json(result);
  } catch (e) {
    const status = e.message.includes('Not authorized') ? 403 : e.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

// Feed

router.get('/connections/feed', passkey.requireAuth, (req, res) => {
  try {
    const feedPubkeys = connections.getFeedPubkeys(req.identity.pubkey);
    res.json({ pubkey: req.identity.pubkey, feed: feedPubkeys });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
