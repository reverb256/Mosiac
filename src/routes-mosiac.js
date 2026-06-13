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
const { getIdentityDb } = require('./database');

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

/* ─── Event Bus (Phase 5) ─── */
const eventLog = require('./event-log');

/**
 * POST /api/events — Publish a signed event.
 * Body: { event: { id, type, pubkey, created_at, data, signature } }
 * Requires authentication. The event must be signed by the authenticated identity.
 */
router.post('/events', passkey.requireAuth, (req, res) => {
  try {
    const { event } = req.body;
    if (!event) return res.status(400).json({ error: 'Missing event in body' });

    // Verify the event is signed by the authenticated identity
    if (event.pubkey !== req.identity.pubkey) {
      return res.status(403).json({ error: 'Event pubkey does not match authenticated identity' });
    }

    const result = eventLog.append(event);
    res.status(result.added ? 201 : 200).json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * GET /api/events/:pubkey — Get events for a pubkey with optional filters.
 * Query params: limit, offset, types (comma-separated), since (ms timestamp)
 */
router.get('/events/:pubkey', (req, res) => {
  try {
    const { limit, offset, types, since } = req.query;
    const options = {};
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);
    if (types) options.types = types.split(',').map(t => t.trim()).filter(Boolean);
    if (since) options.since = parseInt(since, 10);

    const events = eventLog.getEvents(req.params.pubkey, options);
    const count = events.length;
    res.json({ events, count });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * GET /api/events/:pubkey/:eventType — Get latest event of a specific type.
 */
router.get('/events/:pubkey/latest/:eventType', (req, res) => {
  try {
    const event = eventLog.getLatestEvent(req.params.pubkey, req.params.eventType);
    if (!event) return res.json({ event: null });
    res.json({ event });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * GET /api/events/feed — Get feed from multiple pubkeys.
 * Query params: pubkeys (comma-separated), limit, offset, types, since
 */
router.get('/events/feed', (req, res) => {
  try {
    const { pubkeys, limit, offset, types, since } = req.query;
    if (!pubkeys) return res.status(400).json({ error: 'Missing pubkeys query param' });

    const pubkeyList = pubkeys.split(',').map(p => p.trim()).filter(Boolean);
    const options = {};
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);
    if (types) options.types = types.split(',').map(t => t.trim()).filter(Boolean);
    if (since) options.since = parseInt(since, 10);

    const events = eventLog.getFeed(pubkeyList, options);
    const count = events.length;
    res.json({ events, count });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * POST /api/events/verify — Verify an event envelope.
 * Body: { event: { id, type, pubkey, created_at, data, signature } }
 */
router.post('/events/verify', (req, res) => {
  try {
    const { event } = req.body;
    if (!event) return res.status(400).json({ error: 'Missing event in body' });
    const valid = require('./events').verifyEvent(event);
    res.json({ valid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ─── Feeds & Posts (Phase 3) ─── */
const feeds = require('./feeds');

/**
 * POST /mosiac/feed/post — Create a signed post.
 * Body: { content, tags?, replyTo?, channelCode? }
 * Requires authentication.
 */
router.post('/feed/post', passkey.requireAuth, (req, res) => {
  try {
    const { content, tags, replyTo, channelCode } = req.body;
    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'Post content is required' });
    }

    const ident = getIdentityDb().prepare('SELECT * FROM identities WHERE id = ?').get(req.identity.identityId);
    if (!ident) return res.status(404).json({ error: 'Identity not found' });

    const result = feeds.createPost({
      content: content.trim().slice(0, 5000),
      tags,
      replyTo,
      channelCode,
    }, ident.privkey, ident.pubkey);

    res.status(result.added ? 201 : 200).json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * POST /mosiac/feed/like — Like or unlike a post (toggle).
 * Body: { postId }
 * Requires authentication.
 */
router.post('/feed/like', passkey.requireAuth, (req, res) => {
  try {
    const { postId } = req.body;
    if (!postId) return res.status(400).json({ error: 'Missing postId' });

    const ident = getIdentityDb().prepare('SELECT * FROM identities WHERE id = ?').get(req.identity.identityId);
    if (!ident) return res.status(404).json({ error: 'Identity not found' });

    // Verify the post exists
    const post = feeds.getPost(postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const result = feeds.createLike(postId, post.pubkey, ident.privkey, ident.pubkey);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * POST /mosiac/feed/repost — Repost/share a post.
 * Body: { postId, content? }
 * Requires authentication.
 */
router.post('/feed/repost', passkey.requireAuth, (req, res) => {
  try {
    const { postId, content } = req.body;
    if (!postId) return res.status(400).json({ error: 'Missing postId' });

    const ident = getIdentityDb().prepare('SELECT * FROM identities WHERE id = ?').get(req.identity.identityId);
    if (!ident) return res.status(404).json({ error: 'Identity not found' });

    const post = feeds.getPost(postId);
    if (!post) return res.status(404).json({ error: 'Original post not found' });

    const result = feeds.createRepost(postId, post.pubkey, content || '', ident.privkey, ident.pubkey);
    res.status(result.added ? 201 : 200).json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * GET /mosiac/feed/timeline — Get timeline from followed pubkeys.
 * Query: pubkeys (comma-separated), limit, offset, since
 */
router.get('/feed/timeline', (req, res) => {
  try {
    const { pubkeys, limit, offset, since } = req.query;
    if (!pubkeys) return res.status(400).json({ error: 'Missing pubkeys query param' });

    const pubkeyList = pubkeys.split(',').map(p => p.trim()).filter(Boolean);
    const options = {};
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);
    if (since) options.since = parseInt(since, 10);

    const posts = feeds.getTimeline(pubkeyList, options);
    res.json({ posts, count: posts.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * GET /mosiac/feed/channel/:code — Get feed channel timeline.
 * Query: limit, offset, since
 */
router.get('/feed/channel/:code', (req, res) => {
  try {
    const { limit, offset, since } = req.query;
    const options = {};
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);
    if (since) options.since = parseInt(since, 10);

    const posts = feeds.getChannelTimeline(req.params.code, options);
    res.json({ posts, count: posts.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * GET /mosiac/feed/post/:id — Get a single post with stats.
 */
router.get('/feed/post/:id', (req, res) => {
  try {
    const post = feeds.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json({ post });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * GET /mosiac/feed/post/:id/stats — Get post engagement stats.
 */
router.get('/feed/post/:id/stats', (req, res) => {
  try {
    const stats = feeds.getPostStats(req.params.id);
    res.json(stats);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * GET /mosiac/feed/post/:id/replies — Get replies to a post.
 * Query: limit
 */
router.get('/feed/post/:id/replies', (req, res) => {
  try {
    const { limit } = req.query;
    const options = {};
    if (limit) options.limit = parseInt(limit, 10);
    const replies = feeds.getReplies(req.params.id, options);
    res.json({ replies, count: replies.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * GET /mosiac/feed/liked/:postId/:pubkey — Check if a pubkey liked a post.
 */
router.get('/feed/liked/:postId/:pubkey', (req, res) => {
  try {
    const liked = feeds.hasLiked(req.params.postId, req.params.pubkey);
    res.json({ liked });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * POST /mosiac/feed/bookmark — Toggle bookmark on a post.
 * Body: { eventId }
 * Requires authentication.
 */
router.post('/feed/bookmark', passkey.requireAuth, (req, res) => {
  try {
    const { eventId } = req.body;
    if (!eventId) return res.status(400).json({ error: 'Missing eventId' });

    const result = feeds.bookmarkPost(eventId, req.identity.pubkey);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * GET /mosiac/feed/bookmarks — Get bookmarked posts.
 * Query: limit, offset
 * Requires authentication.
 */
router.get('/feed/bookmarks', passkey.requireAuth, (req, res) => {
  try {
    const { limit, offset } = req.query;
    const options = {};
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);
    const posts = feeds.getBookmarks(req.identity.pubkey, options);
    res.json({ posts, count: posts.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * GET /mosiac/feed/bookmarked/:eventId — Check if a post is bookmarked by current user.
 * Requires authentication.
 */
router.get('/feed/bookmarked/:eventId', passkey.requireAuth, (req, res) => {
  try {
    const bookmarked = feeds.isBookmarked(req.params.eventId, req.identity.pubkey);
    res.json({ bookmarked });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
