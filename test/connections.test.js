'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const identity = require('../src/identity');
const connections = require('../src/connections');
const database = require('../src/database');

describe('Connections Module', () => {
  let kp_alice, kp_bob, kp_charlie;

  before(() => {
    const dbPath = path.join(os.tmpdir(), `mosiac-connections-test-${Date.now()}.db`);
    database.init(dbPath);

    // Create test identities (just need pubkeys, no need for passkeys/sessions)
    kp_alice = identity.generateKeyPair();
    kp_bob = identity.generateKeyPair();
    kp_charlie = identity.generateKeyPair();

    // Insert into identities table so pubkeys exist
    database.createIdentity({ pubkey: kp_alice.pubkey, privkey: kp_alice.privkey, label: 'Alice' });
    database.createIdentity({ pubkey: kp_bob.pubkey, privkey: kp_bob.privkey, label: 'Bob' });
    database.createIdentity({ pubkey: kp_charlie.pubkey, privkey: kp_charlie.privkey, label: 'Charlie' });
  });

  after(() => {
    database.close();
  });

  // ─── Follow / Unfollow ─────────────────────────────────────────────────

  describe('follow() and unfollow()', () => {
    it('should follow a pubkey', () => {
      const result = connections.follow(kp_alice.pubkey, kp_bob.pubkey);
      assert.equal(result.followed, true);
    });

    it('should return { followed: false } when already following', () => {
      const result = connections.follow(kp_alice.pubkey, kp_bob.pubkey);
      assert.equal(result.followed, false);
    });

    it('should throw when following yourself', () => {
      assert.throws(() => connections.follow(kp_alice.pubkey, kp_alice.pubkey), /Cannot follow yourself/);
    });

    it('should check isFollowing', () => {
      assert.equal(connections.isFollowing(kp_alice.pubkey, kp_bob.pubkey), true);
      assert.equal(connections.isFollowing(kp_alice.pubkey, kp_charlie.pubkey), false);
    });

    it('should unfollow a pubkey', () => {
      const result = connections.unfollow(kp_alice.pubkey, kp_bob.pubkey);
      assert.equal(result.unfollowed, true);
      assert.equal(connections.isFollowing(kp_alice.pubkey, kp_bob.pubkey), false);
    });

    it('should return { unfollowed: false } when not following', () => {
      const result = connections.unfollow(kp_alice.pubkey, kp_bob.pubkey);
      assert.equal(result.unfollowed, false);
    });

    it('should throw when follower or followee is missing', () => {
      assert.throws(() => connections.follow(null, 'somekey'), /required/);
      assert.throws(() => connections.follow('somekey', null), /required/);
    });
  });

  describe('getFollowing() and getFollowers()', () => {
    before(() => {
      // Alice follows Bob and Charlie
      connections.follow(kp_alice.pubkey, kp_bob.pubkey);
      connections.follow(kp_alice.pubkey, kp_charlie.pubkey);
      // Bob follows Alice
      connections.follow(kp_bob.pubkey, kp_alice.pubkey);
    });

    it('should list who Alice follows', () => {
      const following = connections.getFollowing(kp_alice.pubkey);
      assert.equal(following.length, 2);
      assert.ok(following.includes(kp_bob.pubkey));
      assert.ok(following.includes(kp_charlie.pubkey));
    });

    it('should list Bob\'s followers', () => {
      const followers = connections.getFollowers(kp_bob.pubkey);
      assert.equal(followers.length, 1);
      assert.equal(followers[0].follower, kp_alice.pubkey);
    });

    it('should return counts', () => {
      assert.equal(connections.getFollowerCount(kp_alice.pubkey), 1); // Bob follows Alice
      assert.equal(connections.getFollowingCount(kp_alice.pubkey), 2); // Alice follows Bob + Charlie
    });

    it('should return empty array for pubkey with no followers', () => {
      const fresh = identity.generateKeyPair();
      const followers = connections.getFollowers(fresh.pubkey);
      assert.deepStrictEqual(followers, []);
    });

    it('should find mutual followers', () => {
      // Alice follows Bob, Bob follows Alice = mutual
      const mutuals = connections.getMutuals(kp_alice.pubkey);
      assert.equal(mutuals.length, 1);
      assert.equal(mutuals[0], kp_bob.pubkey);
    });
  });

  // ─── Block / Unblock ───────────────────────────────────────────────────

  describe('block() and unblock()', () => {
    it('should block a pubkey', () => {
      const result = connections.block(kp_alice.pubkey, kp_charlie.pubkey, 'Spam');
      assert.equal(result.blocked, true);
    });

    it('should return { blocked: false } when already blocked', () => {
      const result = connections.block(kp_alice.pubkey, kp_charlie.pubkey);
      assert.equal(result.blocked, false);
    });

    it('should check isBlocked', () => {
      assert.equal(connections.isBlocked(kp_alice.pubkey, kp_charlie.pubkey), true);
      assert.equal(connections.isBlocked(kp_alice.pubkey, kp_bob.pubkey), false);
    });

    it('should throw when blocking yourself', () => {
      assert.throws(() => connections.block(kp_alice.pubkey, kp_alice.pubkey), /Cannot block yourself/);
    });

    it('should return blocklist', () => {
      const blocked = connections.getBlocked(kp_alice.pubkey);
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0].blocked, kp_charlie.pubkey);
      assert.equal(blocked[0].reason, 'Spam');
    });

    it('should detect mutual block', () => {
      // Alice blocked Charlie, but Charlie hasn't blocked Alice yet
      assert.equal(connections.hasMutualBlock(kp_alice.pubkey, kp_charlie.pubkey), true);
      assert.equal(connections.hasMutualBlock(kp_charlie.pubkey, kp_alice.pubkey), true);
      assert.equal(connections.hasMutualBlock(kp_alice.pubkey, kp_bob.pubkey), false);
    });

    it('should remove follow relationship when blocking', () => {
      // Alice followed Charlie before blocking, check that follow was removed
      assert.equal(connections.isFollowing(kp_alice.pubkey, kp_charlie.pubkey), false);
    });

    it('should unblock a pubkey', () => {
      const result = connections.unblock(kp_alice.pubkey, kp_charlie.pubkey);
      assert.equal(result.unblocked, true);
      assert.equal(connections.isBlocked(kp_alice.pubkey, kp_charlie.pubkey), false);
    });

    it('should return { unblocked: false } when not blocked', () => {
      const result = connections.unblock(kp_alice.pubkey, kp_charlie.pubkey);
      assert.equal(result.unblocked, false);
    });
  });

  // ─── Groups ────────────────────────────────────────────────────────────

  describe('Groups', () => {
    let groupId;

    it('should create a group', () => {
      const result = connections.createGroup(kp_alice.pubkey, 'Close Friends');
      assert.ok(result.id);
      assert.equal(result.name, 'Close Friends');
      groupId = result.id;
    });

    it('should throw when creating a group without name', () => {
      assert.throws(() => connections.createGroup(kp_alice.pubkey, ''), /name is required/);
      assert.throws(() => connections.createGroup(kp_alice.pubkey, '   '), /name is required/);
    });

    it('should list groups', () => {
      const groups = connections.listGroups(kp_alice.pubkey);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].name, 'Close Friends');
      assert.ok(groups[0].member_count !== undefined);
    });

    it('should add members to a group', () => {
      const result = connections.addToGroup(groupId, kp_bob.pubkey, kp_alice.pubkey);
      assert.equal(result.added, true);
    });

    it('should return { added: false } for duplicate member', () => {
      const result = connections.addToGroup(groupId, kp_bob.pubkey, kp_alice.pubkey);
      assert.equal(result.added, false);
    });

    it('should get group members', () => {
      const members = connections.getGroupMembers(groupId, kp_alice.pubkey);
      assert.equal(members.length, 1);
      assert.equal(members[0], kp_bob.pubkey);
    });

    it('should remove members from a group', () => {
      const result = connections.removeFromGroup(groupId, kp_bob.pubkey, kp_alice.pubkey);
      assert.equal(result.removed, true);
      const members = connections.getGroupMembers(groupId, kp_alice.pubkey);
      assert.equal(members.length, 0);
    });

    it('should not allow non-owner to modify group', () => {
      assert.throws(() => connections.addToGroup(groupId, kp_charlie.pubkey, kp_bob.pubkey), /Not authorized/);
      assert.throws(() => connections.getGroupMembers(groupId, kp_bob.pubkey), /Not authorized/);
    });

    it('should delete a group', () => {
      const result = connections.deleteGroup(groupId, kp_alice.pubkey);
      assert.equal(result.deleted, true);
      const groups = connections.listGroups(kp_alice.pubkey);
      assert.equal(groups.length, 0);
    });

    it('should return { deleted: false } for non-existent group', () => {
      const result = connections.deleteGroup(99999, kp_alice.pubkey);
      assert.equal(result.deleted, false);
    });

    it('should not allow non-owner to delete group', () => {
      // Recreate group for this test
      const g = connections.createGroup(kp_alice.pubkey, 'Test');
      assert.throws(() => connections.deleteGroup(g.id, kp_bob.pubkey), /Not authorized/);
      // Cleanup
      connections.deleteGroup(g.id, kp_alice.pubkey);
    });
  });

  // ─── Feed Discovery ────────────────────────────────────────────────────

  describe('getFeedPubkeys()', () => {
    before(() => {
      // Set up:
      // - Alice follows Bob
      // - Alice created a group with Charlie
      // - Alice blocked a fourth pubkey (Dennis)
      connections.follow(kp_alice.pubkey, kp_bob.pubkey);
      const g = connections.createGroup(kp_alice.pubkey, 'Dev Team');
      connections.addToGroup(g.id, kp_charlie.pubkey, kp_alice.pubkey);

      const kp_dennis = identity.generateKeyPair();
      database.createIdentity({ pubkey: kp_dennis.pubkey, privkey: kp_dennis.privkey });
      connections.block(kp_alice.pubkey, kp_dennis.pubkey);
      connections.follow(kp_alice.pubkey, kp_dennis.pubkey); // Follow but also blocked — block wins
    });

    it('should return union of following and group members, minus blocked', () => {
      const feed = connections.getFeedPubkeys(kp_alice.pubkey);
      // Should include Bob (followed) and Charlie (group member)
      // Should NOT include Dennis (blocked)
      // Should NOT include Alice herself
      assert.ok(feed.includes(kp_bob.pubkey), 'followed pubkey should be in feed');
      assert.ok(feed.includes(kp_charlie.pubkey), 'group member should be in feed');
      assert.ok(!feed.includes(kp_alice.pubkey), 'self should not be in feed');
      // Dennis was followed but also blocked — block wins
      // We need to check if Dennis is in feed - since he's blocked, he shouldn't be
      // But we don't have Dennis's pubkey in scope, let's check the total doesn't include blocked
      assert.equal(feed.length, 2, 'feed should have exactly 2 pubkeys (Bob + Charlie)');
    });

    it('should return empty feed for pubkey with no follows or groups', () => {
      const noIdentity = identity.generateKeyPair();
      const feed = connections.getFeedPubkeys(noIdentity.pubkey);
      assert.deepStrictEqual(feed, []);
    });
  });
});

// ─── Server Integration Tests ─────────────────────────────────────────────

const http = require('http');
const express = require('express');

describe('Connections API', () => {
  let server;
  let baseUrl;
  let sessionToken;
  let alicePubkey;
  let bobPubkey;
  let bobIdent;

  before(async () => {
    // Re-initialize a fresh database for server tests
    const database = require('../src/database');
    const dbPath = path.join(os.tmpdir(), `mosiac-connections-api-test-${Date.now()}.db`);
    database.init(dbPath);

    // Create a minimal Express app with the mosiac routes
    const app = express();
    app.use(express.json());
    const mosiacRoutes = require('../src/routes-mosiac');
    app.use('/mosiac', mosiacRoutes);

    // Start on a random port
    const PORT = 0; // let OS assign
    server = app.listen(PORT);
    await new Promise(resolve => server.on('listening', resolve));
    const addr = server.address();
    baseUrl = `http://localhost:${addr.port}`;

    // Generate an identity and create a session for auth
    const identityMod = require('../src/identity');
    const db = require('../src/database');
    const kp = identityMod.generateKeyPair();
    alicePubkey = kp.pubkey;
    db.createIdentity({ pubkey: kp.pubkey, privkey: kp.privkey, label: 'Alice' });

    // Generate Bob's identity
    const bobKp = identityMod.generateKeyPair();
    bobPubkey = bobKp.pubkey;
    bobIdent = db.createIdentity({ pubkey: bobKp.pubkey, privkey: bobKp.privkey, label: 'Bob' });

    // Create a session token manually
    const crypto = require('crypto');
    sessionToken = crypto.randomBytes(48).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    db.createSession({
      tokenHash,
      identityId: db.getIdentityByPubkey(alicePubkey).id,
      pubkey: alicePubkey,
      ttlSeconds: 3600,
    });
  });

  after(() => {
    if (server) server.close();
  });

  // HTTP helpers
  function authedHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`,
    };
  }

  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const payload = body ? JSON.stringify(body) : null;
      const opts = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {},
      };
      if (sessionToken) opts.headers['Authorization'] = `Bearer ${sessionToken}`;

      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      if (payload) req.end(payload);
      else req.end();
    });
  }

  it('GET /mosiac/connections/following returns empty list initially', async () => {
    const res = await request('GET', '/mosiac/connections/following');
    assert.equal(res.status, 200);
    assert.equal(res.body.pubkey, alicePubkey);
    assert.deepStrictEqual(res.body.following, []);
  });

  it('POST /mosiac/connections/follow requires auth', async () => {
    // Make request without auth
    const url = new URL('/mosiac/connections/follow', baseUrl);
    const res = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.end(JSON.stringify({ followee: bobPubkey }));
    });
    assert.equal(res.status, 401);
  });

  it('POST /mosiac/connections/follow follows a pubkey', async () => {
    const res = await request('POST', '/mosiac/connections/follow', { followee: bobPubkey });
    assert.equal(res.status, 200);
    assert.equal(res.body.followed, true);
  });

  it('POST /mosiac/connections/follow returns followed:false for duplicate', async () => {
    const res = await request('POST', '/mosiac/connections/follow', { followee: bobPubkey });
    assert.equal(res.status, 200);
    assert.equal(res.body.followed, false);
  });

  it('GET /mosiac/connections/following shows followed pubkeys', async () => {
    const res = await request('GET', '/mosiac/connections/following');
    assert.equal(res.status, 200);
    assert.ok(res.body.following.includes(bobPubkey));
    assert.equal(res.body.counts.following, 1);
  });

  it('GET /mosiac/connections/followers/:pubkey shows followers', async () => {
    const res = await request('GET', `/mosiac/connections/followers/${alicePubkey}`);
    // Bob hasn't followed Alice back, so Alice should have 0 followers from this endpoint
    // The endpoint is public (no auth required)
    assert.equal(res.status, 200);
    assert.equal(res.body.pubkey, alicePubkey);
  });

  it('POST /mosiac/connections/unfollow unfollows a pubkey', async () => {
    const res = await request('POST', '/mosiac/connections/unfollow', { followee: bobPubkey });
    assert.equal(res.status, 200);
    assert.equal(res.body.unfollowed, true);
  });

  it('POST /mosiac/connections/block blocks a pubkey', async () => {
    const res = await request('POST', '/mosiac/connections/block', { blocked: bobPubkey, reason: 'Testing' });
    assert.equal(res.status, 200);
    assert.equal(res.body.blocked, true);
  });

  it('GET /mosiac/connections/blocked returns blocklist', async () => {
    const res = await request('GET', '/mosiac/connections/blocked');
    assert.equal(res.status, 200);
    assert.equal(res.body.pubkey, alicePubkey);
    assert.equal(res.body.blocked.length, 1);
    assert.equal(res.body.blocked[0].blocked, bobPubkey);
    assert.equal(res.body.blocked[0].reason, 'Testing');
  });

  it('POST /mosiac/connections/unblock unblocks a pubkey', async () => {
    const res = await request('POST', '/mosiac/connections/unblock', { blocked: bobPubkey });
    assert.equal(res.status, 200);
    assert.equal(res.body.unblocked, true);
  });

  it('POST /mosiac/connections/groups creates a group', async () => {
    const res = await request('POST', '/mosiac/connections/groups', { name: 'Dev Team' });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.name, 'Dev Team');
  });

  it('GET /mosiac/connections/groups lists groups', async () => {
    const res = await request('GET', '/mosiac/connections/groups');
    assert.equal(res.status, 200);
    assert.equal(res.body.pubkey, alicePubkey);
    assert.equal(res.body.groups.length, 1);
    assert.equal(res.body.groups[0].name, 'Dev Team');
  });

  it('GET /mosiac/connections/feed returns feed pubkeys', async () => {
    // Alice followed Bob earlier (before unfollow), let's re-follow
    await request('POST', '/mosiac/connections/follow', { followee: bobPubkey });
    const res = await request('GET', '/mosiac/connections/feed');
    assert.equal(res.status, 200);
    assert.equal(res.body.pubkey, alicePubkey);
    assert.ok(Array.isArray(res.body.feed));
  });
});
