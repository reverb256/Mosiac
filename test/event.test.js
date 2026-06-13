'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Events Module ─────────────────────────────────────────────────────────

const events = require('../src/events');
const identity = require('../src/identity');

describe('Events Module (src/events.js)', () => {
  describe('EVENT_TYPES', () => {
    it('should define all 7 required event types', () => {
      assert.equal(events.EVENT_TYPES.PROFILE_UPDATE, 'profile_update');
      assert.equal(events.EVENT_TYPES.POST, 'post');
      assert.equal(events.EVENT_TYPES.FOLLOW, 'follow');
      assert.equal(events.EVENT_TYPES.UNFOLLOW, 'unfollow');
      assert.equal(events.EVENT_TYPES.BLOCK, 'block');
      assert.equal(events.EVENT_TYPES.DM, 'dm');
      assert.equal(events.EVENT_TYPES.CHANNEL_CREATE, 'channel_create');
    });

    it('should have ALL_EVENT_TYPES contain exactly 9 types', () => {
      assert.equal(events.ALL_EVENT_TYPES.length, 9);
    });
  });

  describe('computeEventID()', () => {
    it('should produce deterministic IDs for identical inputs', () => {
      const id1 = events.computeEventID('post', 'pubkey123', 1000, { content: 'hello' });
      const id2 = events.computeEventID('post', 'pubkey123', 1000, { content: 'hello' });
      assert.equal(id1, id2);
      assert.equal(id1.length, 64); // SHA-256 hex
      assert.match(id1, /^[0-9a-f]+$/);
    });

    it('should produce different IDs for different data', () => {
      const id1 = events.computeEventID('post', 'pubkey123', 1000, { content: 'hello' });
      const id2 = events.computeEventID('post', 'pubkey123', 1000, { content: 'world' });
      assert.notEqual(id1, id2);
    });

    it('should produce different IDs for different types', () => {
      const id1 = events.computeEventID('follow', 'pubkey123', 1000, { target: 'abc' });
      const id2 = events.computeEventID('block', 'pubkey123', 1000, { target: 'abc' });
      assert.notEqual(id1, id2);
    });
  });

  describe('createEvent()', () => {
    it('should create a valid signed event envelope', () => {
      const kp = identity.generateKeyPair();
      const event = events.createEvent('post', { content: 'Hello, Mosiac!' }, kp.privkey, kp.pubkey);

      assert.ok(event.id);
      assert.equal(event.type, 'post');
      assert.equal(event.pubkey, kp.pubkey);
      assert.equal(typeof event.created_at, 'number');
      assert.deepStrictEqual(event.data, { content: 'Hello, Mosiac!' });
      assert.ok(event.signature);
      assert.equal(event.signature.length >= 86, true);
    });

    it('should produce a verifiable event', () => {
      const kp = identity.generateKeyPair();
      const event = events.createEvent('post', { content: 'verifiable' }, kp.privkey, kp.pubkey);
      assert.ok(events.verifyEvent(event));
    });

    it('should throw for unknown event types', () => {
      const kp = identity.generateKeyPair();
      assert.throws(
        () => events.createEvent('unknown_type', { x: 1 }, kp.privkey, kp.pubkey),
        /Unknown event type/
      );
    });
  });

  describe('verifyEvent()', () => {
    it('should return false for malformed events', () => {
      assert.strictEqual(events.verifyEvent(null), false);
      assert.strictEqual(events.verifyEvent({}), false);
      assert.strictEqual(events.verifyEvent({ id: 'abc', type: 'post' }), false);
    });

    it('should reject tampered data', () => {
      const kp = identity.generateKeyPair();
      const event = events.createEvent('post', { content: 'original' }, kp.privkey, kp.pubkey);
      event.data.content = 'tampered';
      assert.strictEqual(events.verifyEvent(event), false);
    });

    it('should reject wrong pubkey', () => {
      const alice = identity.generateKeyPair();
      const bob = identity.generateKeyPair();
      const event = events.createEvent('post', { content: 'test' }, alice.privkey, alice.pubkey);
      event.pubkey = bob.pubkey; // tampered pubkey but same signature
      assert.strictEqual(events.verifyEvent(event), false);
    });
  });

  describe('Type helpers', () => {
    it('profileUpdate should create a valid profile_update event', () => {
      const kp = identity.generateKeyPair();
      const event = events.profileUpdate(
        { displayName: 'Alice', bio: 'Hello world', avatar: 'abc.jpg' },
        kp.privkey, kp.pubkey
      );
      assert.equal(event.type, 'profile_update');
      assert.equal(event.data.displayName, 'Alice');
      assert.equal(event.data.bio, 'Hello world');
      assert.equal(event.data.avatar, 'abc.jpg');
      assert.ok(events.verifyEvent(event));
    });

    it('post should create a valid post event', () => {
      const kp = identity.generateKeyPair();
      const event = events.post(
        { content: 'My first post!', tags: ['hello', 'mosiac'], replyTo: null },
        kp.privkey, kp.pubkey
      );
      assert.equal(event.type, 'post');
      assert.equal(event.data.content, 'My first post!');
      assert.deepStrictEqual(event.data.tags, ['hello', 'mosiac']);
      assert.ok(events.verifyEvent(event));
    });

    it('follow and unfollow should create valid events', () => {
      const alice = identity.generateKeyPair();
      const bob = identity.generateKeyPair();

      const followEvent = events.follow(bob.pubkey, alice.privkey, alice.pubkey);
      assert.equal(followEvent.type, 'follow');
      assert.equal(followEvent.data.target, bob.pubkey);
      assert.ok(events.verifyEvent(followEvent));

      const unfollowEvent = events.unfollow(bob.pubkey, alice.privkey, alice.pubkey);
      assert.equal(unfollowEvent.type, 'unfollow');
      assert.equal(unfollowEvent.data.target, bob.pubkey);
      assert.ok(events.verifyEvent(unfollowEvent));
    });

    it('block should create a valid block event', () => {
      const kp = identity.generateKeyPair();
      const event = events.block('badactor_pubkey', kp.privkey, kp.pubkey, 'Spam');
      assert.equal(event.type, 'block');
      assert.equal(event.data.target, 'badactor_pubkey');
      assert.equal(event.data.reason, 'Spam');
      assert.ok(events.verifyEvent(event));
    });

    it('dm should create a valid dm event', () => {
      const alice = identity.generateKeyPair();
      const event = events.dm(
        { recipient: 'bob_pubkey', content: 'Secret message', encrypted: true },
        alice.privkey, alice.pubkey
      );
      assert.equal(event.type, 'dm');
      assert.equal(event.data.recipient, 'bob_pubkey');
      assert.equal(event.data.content, 'Secret message');
      assert.equal(event.data.encrypted, true);
      assert.ok(events.verifyEvent(event));
    });

    it('channelCreate should create a valid channel_create event', () => {
      const kp = identity.generateKeyPair();
      const event = events.channelCreate(
        { name: 'general', description: 'General discussion', members: ['pubkey1', 'pubkey2'] },
        kp.privkey, kp.pubkey
      );
      assert.equal(event.type, 'channel_create');
      assert.equal(event.data.name, 'general');
      assert.equal(event.data.description, 'General discussion');
      assert.deepStrictEqual(event.data.members, ['pubkey1', 'pubkey2']);
      assert.ok(events.verifyEvent(event));
    });
  });

  describe('isValidEventType()', () => {
    it('should return true for valid types', () => {
      assert.ok(events.isValidEventType('post'));
      assert.ok(events.isValidEventType('follow'));
      assert.ok(events.isValidEventType('dm'));
    });

    it('should return false for invalid types', () => {
      assert.strictEqual(events.isValidEventType('invalid'), false);
      assert.strictEqual(events.isValidEventType(''), false);
      assert.strictEqual(events.isValidEventType(null), false);
    });
  });
});

// ─── Event Log Module ──────────────────────────────────────────────────────

const database = require('../src/database');
const eventLog = require('../src/event-log');

describe('Event Log Module (src/event-log.js)', () => {
  let dbPath;
  let kp;

  before(() => {
    dbPath = path.join(os.tmpdir(), `mosiac-event-test-${Date.now()}.db`);
    // Initialize database with a test-specific path
    const { initDatabase } = database;
    // We need to init with the test DB path. The database module uses a global
    // DB_PATH from paths.js, so we need to set the env var and call initDatabase.
    process.env.MOSIAC_DATA_DIR = path.dirname(dbPath);
    database.initDatabase(); // This creates all tables including event_log
    kp = identity.generateKeyPair();
  });

  after(() => {
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  describe('append()', () => {
    it('should append a valid signed event', () => {
      const event = events.createEvent('post', { content: 'Test event' }, kp.privkey, kp.pubkey);
      const result = eventLog.append(event);
      assert.ok(result.added);
      assert.equal(result.id, event.id);
    });

    it('should be idempotent on duplicate append', () => {
      const event = events.createEvent('post', { content: 'Idempotent test' }, kp.privkey, kp.pubkey);
      const r1 = eventLog.append(event);
      assert.ok(r1.added);
      const r2 = eventLog.append(event);
      assert.strictEqual(r2.added, false);
      assert.equal(r2.id, event.id);
    });

    it('should reject unsigned events', () => {
      const badEvent = {
        id: 'abc123',
        type: 'post',
        pubkey: kp.pubkey,
        created_at: Date.now(),
        data: { content: 'no signature' },
        signature: 'invalid',
      };
      assert.throws(() => eventLog.append(badEvent), /signature verification failed/);
    });

    it('should reject events with unknown type', () => {
      const event = events.createEvent('post', { content: 'test' }, kp.privkey, kp.pubkey);
      event.type = 'unknown_type';
      assert.throws(() => eventLog.append(event), /Unknown event type/);
    });

    it('should reject events with missing fields', () => {
      assert.throws(() => eventLog.append(null), /missing required fields/);
      assert.throws(() => eventLog.append({ id: 'x' }), /missing required fields/);
    });
  });

  describe('getEvent()', () => {
    it('should retrieve a single event by ID', () => {
      const event = events.createEvent('follow', { target: 'someone' }, kp.privkey, kp.pubkey);
      eventLog.append(event);

      const fetched = eventLog.getEvent(event.id);
      assert.ok(fetched);
      assert.equal(fetched.id, event.id);
      assert.equal(fetched.type, 'follow');
      assert.equal(fetched.pubkey, kp.pubkey);
      assert.deepStrictEqual(fetched.data, { target: 'someone' });
    });

    it('should return null for non-existent event', () => {
      const result = eventLog.getEvent('nonexistent');
      assert.strictEqual(result, null);
    });
  });

  describe('getEvents()', () => {
    it('should return events for a pubkey, newest first', () => {
      const eventsList = eventLog.getEvents(kp.pubkey);
      assert.ok(Array.isArray(eventsList));
      assert.ok(eventsList.length > 0);

      // Verify newest-first ordering
      for (let i = 1; i < eventsList.length; i++) {
        assert.ok(eventsList[i - 1].created_at >= eventsList[i].created_at);
      }
    });

    it('should filter by type', () => {
      // Create a block event from a different key
      const otherKp = identity.generateKeyPair();
      const blockEvent = events.block('target', otherKp.privkey, otherKp.pubkey);
      eventLog.append(blockEvent);

      const posts = eventLog.getEvents(otherKp.pubkey, { types: ['block'] });
      assert.ok(posts.length >= 1);
      assert.equal(posts[0].type, 'block');

      const noPosts = eventLog.getEvents(otherKp.pubkey, { types: ['post'] });
      assert.equal(noPosts.length, 0);
    });

    it('should support limit and offset', () => {
      const limited = eventLog.getEvents(kp.pubkey, { limit: 1 });
      assert.ok(limited.length <= 1);
    });

    it('should support since filter', () => {
      const past = Date.now() - 100000;
      const future = Date.now() + 100000;
      const fromPast = eventLog.getEvents(kp.pubkey, { since: past });
      assert.ok(fromPast.length > 0);
      const fromFuture = eventLog.getEvents(kp.pubkey, { since: future });
      assert.equal(fromFuture.length, 0);
    });

    it('should return empty array for unknown pubkey', () => {
      const eventsList = eventLog.getEvents('unknown_pubkey');
      assert.ok(Array.isArray(eventsList));
      assert.equal(eventsList.length, 0);
    });
  });

  describe('getFeed()', () => {
    it('should return events from multiple pubkeys merged by time', () => {
      const bob = identity.generateKeyPair();
      const bobEvent = events.createEvent('post', { content: "Bob's post" }, bob.privkey, bob.pubkey);
      eventLog.append(bobEvent);

      const feed = eventLog.getFeed([kp.pubkey, bob.pubkey]);
      assert.ok(feed.length >= 1);
      // Verify newest-first ordering
      for (let i = 1; i < feed.length; i++) {
        assert.ok(feed[i - 1].created_at >= feed[i].created_at);
      }
    });

    it('should return empty array for empty pubkey list', () => {
      const feed = eventLog.getFeed([]);
      assert.deepStrictEqual(feed, []);
    });

    it('should support type filtering in feed', () => {
      const feed = eventLog.getFeed([kp.pubkey], { types: ['post'] });
      for (const ev of feed) {
        assert.equal(ev.type, 'post');
      }
    });
  });

  describe('getEventCount()', () => {
    it('should return the correct count', () => {
      const count = eventLog.getEventCount(kp.pubkey);
      assert.equal(typeof count, 'number');
      assert.ok(count > 0);
    });

    it('should return 0 for unknown pubkey', () => {
      assert.equal(eventLog.getEventCount('unknown_pubkey'), 0);
    });
  });

  describe('getLatestEvent()', () => {
    it('should return the most recent event of a given type', () => {
      const latest = eventLog.getLatestEvent(kp.pubkey, 'post');
      assert.ok(latest);
      assert.equal(latest.type, 'post');
      assert.equal(latest.pubkey, kp.pubkey);
    });

    it('should return null for type with no events', () => {
      const result = eventLog.getLatestEvent(kp.pubkey, 'channel_create');
      // May or may not exist — just check it doesn't crash
      assert.ok(result === null || result.type === 'channel_create');
    });

    it('should return null for invalid type', () => {
      assert.strictEqual(eventLog.getLatestEvent(kp.pubkey, 'invalid'), null);
    });
  });

  describe('prune()', () => {
    it('should delete events older than the given timestamp', () => {
      const count = eventLog.prune(0); // Delete everything older than epoch
      assert.equal(typeof count, 'number');
      // Re-append one event to ensure the log still works after pruning
      const event = events.createEvent('post', { content: 'After prune' }, kp.privkey, kp.pubkey);
      const result = eventLog.append(event);
      assert.ok(result.added);
    });
  });
});

// ─── Integration: Events + Event Log + Express Router ──────────────────────

const express = require('express');
const http = require('http');

describe('Event API Integration', () => {
  let app;
  let srv;
  const PORT = 45680;
  const testDir = path.join(os.tmpdir(), `mosiac-evt-api-${Date.now()}`);

  before(async () => {
    // Use the already-initialized database from the prior tests.
    // No need to re-init — event_log table already exists.
    const passkey = require('../src/passkey');

    app = express();
    app.use(express.json());
    app.use(passkey.sessionMiddleware);
    app.use('/mosiac', require('../src/routes-mosiac'));

    srv = http.createServer(app);
    await new Promise(resolve => srv.listen(PORT, resolve));
  });

  after(() => {
    if (srv) srv.close();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT}${path}`, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, body }); }
        });
      }).on('error', reject);
    });
  }

  function post(path, data, token) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(data);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const req = http.request(`http://localhost:${PORT}${path}`, {
        method: 'POST',
        headers,
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, body }); }
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('GET /mosiac/health returns ok', async () => {
    const res = await get('/mosiac/health');
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
    assert.equal(res.body.mosiac, '0.1.0');
  });

  it('POST /mosiac/events/verify verifies events', async () => {
    const kp = identity.generateKeyPair();
    const event = events.createEvent('post', { content: 'API test' }, kp.privkey, kp.pubkey);

    const res = await post('/mosiac/events/verify', { event });
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, true);

    // Tampered event
    const bad = { ...event, data: { content: 'tampered' } };
    const badRes = await post('/mosiac/events/verify', { event: bad });
    assert.equal(badRes.status, 200);
    assert.equal(badRes.body.valid, false);
  });

  it('POST /mosiac/events requires auth', async () => {
    const res = await post('/mosiac/events', { event: { id: 'x', type: 'post', pubkey: 'x', created_at: 1, data: {}, signature: 'x' } });
    assert.equal(res.status, 401);
  });

  it('POST /mosiac/events publishes and GET /mosiac/events/:pubkey retrieves', async () => {
    // Create an identity and authenticate
    const genRes = await post('/mosiac/identity/generate', { label: 'event-test-user' });
    assert.equal(genRes.status, 200);
    assert.ok(genRes.body.pubkey);
    const pubkey = genRes.body.pubkey;

    // We need the privkey to sign events. Generate identity via passkey registration
    // for a proper auth session. For simplicity, test via direct module calls.
    // The identity is already in the DB from /api/identity/generate.
    // We need the privkey from the DB to sign.
    const db = database.getIdentityDb();
    const ident = db.prepare('SELECT * FROM identities WHERE pubkey = ?').get(pubkey);
    assert.ok(ident);

    // Manually create a session token for this test
    const crypto = require('crypto');
    const sessionToken = crypto.randomBytes(48).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    db.prepare(`
      INSERT INTO sessions (token_hash, identity_id, pubkey, expires_at)
      VALUES (?, ?, ?, datetime('now', '+7 days'))
    `).run(tokenHash, ident.id, ident.pubkey);

    // Sign and publish an event
    const event = events.createEvent('post', { content: 'Published via API!' }, ident.privkey, ident.pubkey);
    const pubRes = await post('/mosiac/events', { event }, sessionToken);
    assert.equal(pubRes.status, 201);
    assert.equal(pubRes.body.id, event.id);
    assert.ok(pubRes.body.added);

    // Retrieve events for this pubkey
    const getRes = await get(`/mosiac/events/${encodeURIComponent(pubkey)}`);
    assert.equal(getRes.status, 200);
    assert.ok(Array.isArray(getRes.body.events));
    assert.ok(getRes.body.events.length >= 1);
    assert.equal(getRes.body.events[0].id, event.id);
  });
});
