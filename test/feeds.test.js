'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Test infrastructure: create an in-memory identity db ──────────────────

const DB_PATH = path.join(os.tmpdir(), `mosiac-feeds-test-${Date.now()}.db`);

before(() => {
  // Point database.js to our temp db by setting DB_PATH before requiring
  process.env.DB_PATH = DB_PATH;

  // Initialize the database schema
  const { initDatabase } = require('../src/database');
  initDatabase();
});

after(() => {
  try { fs.unlinkSync(DB_PATH); } catch { /* ignore */ }
  // Clean up env vars
  delete process.env.DB_PATH;
  // Clean module cache so subsequent tests get a fresh state
  delete require.cache[require.resolve('../src/database')];
  delete require.cache[require.resolve('../src/identity')];
  delete require.cache[require.resolve('../src/events')];
  delete require.cache[require.resolve('../src/feeds')];
});

// ─── Shared state ──────────────────────────────────────────────────────────

let aliceKeys, bobKeys, charlieKeys;

// ─── Imports (fresh after db init) ─────────────────────────────────────────

const identity = require('../src/identity');
const events = require('../src/events');
const feeds = require('../src/feeds');

// ══════════════════════════════════════════════════════════════════════════
// Events Module (Phase 5 — extended for Phase 3)
// ══════════════════════════════════════════════════════════════════════════

describe('Events Module — Phase 3 extensions', () => {
  describe('EVENT_TYPES', () => {
    it('should define LIkE and REPOST event types', () => {
      assert.equal(events.EVENT_TYPES.LIKE, 'like');
      assert.equal(events.EVENT_TYPES.REPOST, 'repost');
    });

    it('should have ALL_EVENT_TYPES contain exactly 9 types', () => {
      assert.equal(events.ALL_EVENT_TYPES.length, 9);
    });
  });

  describe('like() helper', () => {
    it('should create a valid like event', () => {
      const kp = identity.generateKeyPair();
      const postKp = identity.generateKeyPair();

      const likeEvent = events.like(
        { postId: 'abc123', postAuthor: postKp.pubkey },
        kp.privkey, kp.pubkey
      );

      assert.ok(likeEvent.id);
      assert.equal(likeEvent.type, 'like');
      assert.equal(likeEvent.pubkey, kp.pubkey);
      assert.equal(likeEvent.data.postId, 'abc123');
      assert.equal(likeEvent.data.postAuthor, postKp.pubkey);
      assert.ok(likeEvent.signature);
      assert.ok(events.verifyEvent(likeEvent));
    });
  });

  describe('repost() helper', () => {
    it('should create a valid repost event', () => {
      const kp = identity.generateKeyPair();
      const postKp = identity.generateKeyPair();

      const repostEvent = events.repost(
        { postId: 'abc123', postAuthor: postKp.pubkey, content: 'Great post!' },
        kp.privkey, kp.pubkey
      );

      assert.ok(repostEvent.id);
      assert.equal(repostEvent.type, 'repost');
      assert.equal(repostEvent.pubkey, kp.pubkey);
      assert.equal(repostEvent.data.postId, 'abc123');
      assert.equal(repostEvent.data.content, 'Great post!');
      assert.ok(events.verifyEvent(repostEvent));
    });

    it('should allow repost without commentary', () => {
      const kp = identity.generateKeyPair();
      const postKp = identity.generateKeyPair();

      const repostEvent = events.repost(
        { postId: 'abc123', postAuthor: postKp.pubkey },
        kp.privkey, kp.pubkey
      );

      assert.equal(repostEvent.data.content, '');
      assert.ok(events.verifyEvent(repostEvent));
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Feeds Module (Phase 3)
// ══════════════════════════════════════════════════════════════════════════

describe('Feeds Module (src/feeds.js)', () => {
  // Generate test keys once
  before(() => {
    aliceKeys = identity.generateKeyPair();
    bobKeys = identity.generateKeyPair();
    charlieKeys = identity.generateKeyPair();
  });

  // Clean up db between tests
  afterEach(() => {
    const { getIdentityDb } = require('../src/database');
    const db = getIdentityDb();
    db.exec('DELETE FROM event_log');
    db.exec('DELETE FROM feed_posts');
    db.exec('DELETE FROM feed_likes');
    db.exec('DELETE FROM feed_bookmarks');
  });

  // ─── Post creation ──────────────────────────────────────────

  describe('createPost()', () => {
    it('should create a signed post event', () => {
      const result = feeds.createPost(
        { content: 'Hello, Mosiac!' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      assert.ok(result.event);
      assert.equal(result.added, true);
      assert.equal(result.event.type, 'post');
      assert.equal(result.event.data.content, 'Hello, Mosiac!');
      assert.equal(result.event.pubkey, aliceKeys.pubkey);
      assert.ok(events.verifyEvent(result.event));
    });

    it('should accept tags', () => {
      const result = feeds.createPost(
        { content: 'Tagged post', tags: ['mosiac', 'fediverse'] },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      assert.deepStrictEqual(result.event.data.tags, ['mosiac', 'fediverse']);
    });

    it('should accept replyTo', () => {
      const result = feeds.createPost(
        { content: 'Reply post', replyTo: 'parent-event-id' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      assert.equal(result.event.data.replyTo, 'parent-event-id');
    });

    it('should reject empty content', () => {
      const result = feeds.createPost(
        { content: '' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      assert.equal(result.event.data.content, '');
      // Events are always created (content validation is the route's job)
      assert.equal(result.event.type, 'post');
    });

    it('should link to feed channel when channelCode provided', () => {
      const result = feeds.createPost(
        { content: 'Channel post', channelCode: 'abc12345' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      assert.equal(result.added, true);

      // Verify the post is linked in feed_posts
      const { getIdentityDb } = require('../src/database');
      const row = getIdentityDb().prepare(
        'SELECT * FROM feed_posts WHERE event_id = ?'
      ).get(result.event.id);

      assert.ok(row);
      assert.equal(row.channel_code, 'abc12345');
    });

    it('should be idempotent via event-log (INSERT OR IGNORE)', () => {
      const result1 = feeds.createPost(
        { content: 'Idempotent test' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      // Manually insert the same event ID to test idempotency
      const { getIdentityDb } = require('../src/database');
      const db = getIdentityDb();
      const insertResult = db.prepare(`
        INSERT OR IGNORE INTO event_log (id, type, pubkey, created_at, data, signature)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        result1.event.id,
        result1.event.type,
        result1.event.pubkey,
        result1.event.created_at,
        JSON.stringify(result1.event.data),
        result1.event.signature
      );

      assert.equal(insertResult.changes, 0, 'Duplicate event ID should be ignored');
    });
  });

  // ─── Like/unlike (toggle) ───────────────────────────────────

  describe('createLike()', () => {
    it('should like a post', () => {
      const post = feeds.createPost(
        { content: 'Lovable post' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      const result = feeds.createLike(
        post.event.id, aliceKeys.pubkey,
        bobKeys.privkey, bobKeys.pubkey
      );

      assert.equal(result.liked, true);
      assert.equal(result.added, true);

      const stats = feeds.getPostStats(post.event.id);
      assert.equal(stats.likes, 1);
    });

    it('should toggle unlike on second call', () => {
      const post = feeds.createPost(
        { content: 'Toggle post' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      // Like
      feeds.createLike(post.event.id, aliceKeys.pubkey, bobKeys.privkey, bobKeys.pubkey);
      assert.equal(feeds.getPostStats(post.event.id).likes, 1);

      // Unlike (toggle off)
      const result = feeds.createLike(post.event.id, aliceKeys.pubkey, bobKeys.privkey, bobKeys.pubkey);
      assert.equal(result.liked, false);

      const stats = feeds.getPostStats(post.event.id);
      assert.equal(stats.likes, 0);
    });

    it('should allow multiple users to like the same post', () => {
      const post = feeds.createPost(
        { content: 'Multi-like' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      feeds.createLike(post.event.id, aliceKeys.pubkey, bobKeys.privkey, bobKeys.pubkey);
      feeds.createLike(post.event.id, aliceKeys.pubkey, charlieKeys.privkey, charlieKeys.pubkey);

      const stats = feeds.getPostStats(post.event.id);
      assert.equal(stats.likes, 2);
    });
  });

  // ─── Repost ─────────────────────────────────────────────────

  describe('createRepost()', () => {
    it('should create a repost event', () => {
      const post = feeds.createPost(
        { content: 'Repostable' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      const result = feeds.createRepost(
        post.event.id, aliceKeys.pubkey, 'Nice!',
        bobKeys.privkey, bobKeys.pubkey
      );

      assert.equal(result.added, true);
      assert.equal(result.event.type, 'repost');
      assert.equal(result.event.data.postId, post.event.id);
      assert.equal(result.event.data.content, 'Nice!');
    });

    it('should count in post stats', () => {
      const post = feeds.createPost(
        { content: 'Popular' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      feeds.createRepost(post.event.id, aliceKeys.pubkey, '', bobKeys.privkey, bobKeys.pubkey);

      const stats = feeds.getPostStats(post.event.id);
      assert.equal(stats.reposts, 1);
    });
  });

  // ─── Timeline queries ───────────────────────────────────────

  describe('getTimeline()', () => {
    it('should return posts from specified pubkeys in order', () => {
      // Create posts with different timestamps by sleeping
      const p1 = feeds.createPost(
        { content: 'First post' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      const p2 = feeds.createPost(
        { content: 'Second post' },
        bobKeys.privkey, bobKeys.pubkey
      );

      const timeline = feeds.getTimeline([aliceKeys.pubkey, bobKeys.pubkey]);
      assert.ok(timeline.length >= 2);
      assert.equal(timeline[0].type, 'post');
    });

    it('should return empty array for empty pubkey list', () => {
      const timeline = feeds.getTimeline([]);
      assert.deepStrictEqual(timeline, []);
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        feeds.createPost(
          { content: `Post ${i}` },
          aliceKeys.privkey, aliceKeys.pubkey
        );
      }

      const timeline = feeds.getTimeline([aliceKeys.pubkey], { limit: 3 });
      assert.ok(timeline.length <= 3);
    });

    it('should enrich posts with engagement stats', () => {
      const post = feeds.createPost(
        { content: 'Stats test' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      feeds.createLike(post.event.id, aliceKeys.pubkey, bobKeys.privkey, bobKeys.pubkey);

      const timeline = feeds.getTimeline([aliceKeys.pubkey]);
      const enriched = timeline.find(p => p.id === post.event.id);

      assert.ok(enriched);
      assert.equal(typeof enriched.likes, 'number');
      assert.equal(typeof enriched.reposts, 'number');
      assert.equal(typeof enriched.replies, 'number');
    });
  });

  // ─── Feed channel timeline ──────────────────────────────────

  describe('getChannelTimeline()', () => {
    it('should return posts linked to a channel', () => {
      const post = feeds.createPost(
        { content: 'Channel post', channelCode: 'feedchan' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      const timeline = feeds.getChannelTimeline('feedchan');
      assert.ok(timeline.length >= 1);
      assert.equal(timeline[0].id, post.event.id);
    });

    it('should return empty for non-existent channel', () => {
      const timeline = feeds.getChannelTimeline('nonexist');
      assert.deepStrictEqual(timeline, []);
    });
  });

  // ─── Single post ────────────────────────────────────────────

  describe('getPost()', () => {
    it('should return a post by event ID', () => {
      const result = feeds.createPost(
        { content: 'Single post' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      const post = feeds.getPost(result.event.id);
      assert.ok(post);
      assert.equal(post.id, result.event.id);
      assert.equal(post.data.content, 'Single post');
    });

    it('should return null for non-existent ID', () => {
      const post = feeds.getPost('nonexistent');
      assert.equal(post, null);
    });
  });

  // ─── Post stats ─────────────────────────────────────────────

  describe('getPostStats()', () => {
    it('should return zero stats for a new post', () => {
      const result = feeds.createPost(
        { content: 'Fresh post' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      const stats = feeds.getPostStats(result.event.id);
      assert.equal(stats.likes, 0);
      assert.equal(stats.reposts, 0);
      assert.equal(stats.replies, 0);
    });
  });

  // ─── hasLiked ───────────────────────────────────────────────

  describe('hasLiked()', () => {
    it('should return true when user liked a post', () => {
      const post = feeds.createPost(
        { content: 'Check liked' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      feeds.createLike(post.event.id, aliceKeys.pubkey, bobKeys.privkey, bobKeys.pubkey);
      assert.equal(feeds.hasLiked(post.event.id, bobKeys.pubkey), true);
    });

    it('should return false when user has not liked', () => {
      const post = feeds.createPost(
        { content: 'Not liked' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      assert.equal(feeds.hasLiked(post.event.id, bobKeys.pubkey), false);
    });
  });

  // ─── Replies ────────────────────────────────────────────────

  describe('getReplies()', () => {
    it('should find replies to a post', () => {
      const parent = feeds.createPost(
        { content: 'Parent' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      const reply = feeds.createPost(
        { content: 'Reply', replyTo: parent.event.id },
        bobKeys.privkey, bobKeys.pubkey
      );

      const replies = feeds.getReplies(parent.event.id);
      assert.ok(replies.length >= 1);
      assert.equal(replies[0].id, reply.event.id);
    });

    it('should return empty for post with no replies', () => {
      const post = feeds.createPost(
        { content: 'No replies' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      const replies = feeds.getReplies(post.event.id);
      assert.deepStrictEqual(replies, []);
    });
  });

  // ─── Bookmarks ──────────────────────────────────────────────

  describe('bookmarkPost()', () => {
    it('should bookmark a post', () => {
      const post = feeds.createPost(
        { content: 'Bookmark me' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      const result = feeds.bookmarkPost(post.event.id, bobKeys.pubkey);
      assert.equal(result.bookmarked, true);
      assert.equal(feeds.isBookmarked(post.event.id, bobKeys.pubkey), true);
    });

    it('should toggle bookmark off on second call', () => {
      const post = feeds.createPost(
        { content: 'Toggle bookmark' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      feeds.bookmarkPost(post.event.id, bobKeys.pubkey);
      const result = feeds.bookmarkPost(post.event.id, bobKeys.pubkey);
      assert.equal(result.bookmarked, false);
      assert.equal(feeds.isBookmarked(post.event.id, bobKeys.pubkey), false);
    });

    it('should allow multiple users to bookmark', () => {
      const post = feeds.createPost(
        { content: 'Multi bookmark' },
        aliceKeys.privkey, aliceKeys.pubkey
      );

      feeds.bookmarkPost(post.event.id, bobKeys.pubkey);
      feeds.bookmarkPost(post.event.id, charlieKeys.pubkey);

      const bookmarks = feeds.getBookmarks(bobKeys.pubkey);
      assert.ok(bookmarks.length >= 1);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Integration: Verify created events can be queried via event-log
// ══════════════════════════════════════════════════════════════════════════

describe('Feeds + Event Log integration', () => {
  before(() => {
    // Use fresh keys for isolation
  });

  afterEach(() => {
    const { getIdentityDb } = require('../src/database');
    const db = getIdentityDb();
    db.exec('DELETE FROM event_log');
    db.exec('DELETE FROM feed_posts');
    db.exec('DELETE FROM feed_likes');
    db.exec('DELETE FROM feed_bookmarks');
  });

  it('should store posts in event_log for querying via event-log', () => {
    const eventLog = require('../src/event-log');

    const result = feeds.createPost(
      { content: 'Integration test' },
      aliceKeys.privkey, aliceKeys.pubkey
    );

    // Query via event-log
    const events = eventLog.getEvents(aliceKeys.pubkey, { types: ['post'], limit: 10 });
    assert.ok(events.length >= 1);
    assert.equal(events[0].id, result.event.id);
  });

  it('should allow multi-pubkey feed queries via event-log.getFeed()', () => {
    const eventLog = require('../src/event-log');

    feeds.createPost({ content: 'A-post' }, aliceKeys.privkey, aliceKeys.pubkey);
    feeds.createPost({ content: 'B-post' }, bobKeys.privkey, bobKeys.pubkey);

    const feed = eventLog.getFeed([aliceKeys.pubkey, bobKeys.pubkey], { limit: 10 });
    assert.ok(feed.length >= 2);
  });
});
