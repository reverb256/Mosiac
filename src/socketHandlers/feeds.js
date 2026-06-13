'use strict';

/**
 * Mosiac Feeds — Real-time feed channel socket events.
 *
 * Provides:
 *   - feed:subscribe   — Subscribe a socket to a feed channel room
 *   - feed:unsubscribe — Unsubscribe from a feed channel room
 *   - feed:post        — Publish a post (creates event, broadcasts to room)
 *   - feed:like        — Like/unlike a post (broadcasts update)
 *   - feed:repost      — Repost a post (broadcasts update)
 */

const feeds = require('../feeds');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, getUserEffectiveLevel } = ctx;

  // Track which feed channels each socket is subscribed to
  const subscribedFeeds = new Map(); // socketId → Set<channelCode>

  // ── Subscribe to a feed channel ────────────────────────────
  socket.on('feed:subscribe', (data) => {
    if (!data || typeof data.channelCode !== 'string') return;
    const code = data.channelCode.trim();
    if (!code) return;

    const room = `feed:${code}`;
    socket.join(room);

    // Track subscription
    if (!subscribedFeeds.has(socket.id)) {
      subscribedFeeds.set(socket.id, new Set());
    }
    subscribedFeeds.get(socket.id).add(code);
  });

  // ── Unsubscribe from a feed channel ────────────────────────
  socket.on('feed:unsubscribe', (data) => {
    if (!data || typeof data.channelCode !== 'string') return;
    const code = data.channelCode.trim();
    if (!code) return;

    const room = `feed:${code}`;
    socket.leave(room);

    const subs = subscribedFeeds.get(socket.id);
    if (subs) subs.delete(code);
  });

  // ── Create a post and broadcast to feed subscribers ────────
  socket.on('feed:post', (data) => {
    if (!socket.user || !socket.identity) return;
    if (!data || typeof data.content !== 'string' || !data.content.trim()) return;

    try {
      const ident = db.prepare('SELECT * FROM identities WHERE id = ?').get(socket.identity.identityId);
      if (!ident) return socket.emit('error-msg', 'Identity not found');

      const result = feeds.createPost({
        content: data.content.trim().slice(0, 5000),
        tags: data.tags,
        replyTo: data.replyTo,
        channelCode: data.channelCode,
      }, ident.privkey, ident.pubkey);

      // If posted to a feed channel, broadcast to subscribers
      if (data.channelCode) {
        const room = `feed:${data.channelCode}`;
        io.to(room).emit('feed:new-post', {
          post: result.event,
          channelCode: data.channelCode,
          author: {
            pubkey: ident.pubkey,
            label: ident.label,
          },
        });
      }

      socket.emit('feed:post-created', result);
    } catch (e) {
      socket.emit('error-msg', `Failed to create post: ${e.message}`);
    }
  });

  // ── Like/unlike a post ────────────────────────────────────
  socket.on('feed:like', (data) => {
    if (!socket.user || !socket.identity) return;
    if (!data || typeof data.postId !== 'string') return;

    try {
      const ident = db.prepare('SELECT * FROM identities WHERE id = ?').get(socket.identity.identityId);
      if (!ident) return socket.emit('error-msg', 'Identity not found');

      const post = feeds.getPost(data.postId);
      if (!post) return socket.emit('error-msg', 'Post not found');

      const result = feeds.createLike(data.postId, post.pubkey, ident.privkey, ident.pubkey);
      const stats = feeds.getPostStats(data.postId);

      // Broadcast like update to feed channel subscribers if applicable
      if (data.channelCode) {
        io.to(`feed:${data.channelCode}`).emit('feed:like-update', {
          postId: data.postId,
          liked: result.liked,
          liker: ident.pubkey,
          stats,
        });
      }

      socket.emit('feed:like-result', { ...result, stats });
    } catch (e) {
      socket.emit('error-msg', `Failed to like post: ${e.message}`);
    }
  });

  // ── Repost a post ──────────────────────────────────────────
  socket.on('feed:repost', (data) => {
    if (!socket.user || !socket.identity) return;
    if (!data || typeof data.postId !== 'string') return;

    try {
      const ident = db.prepare('SELECT * FROM identities WHERE id = ?').get(socket.identity.identityId);
      if (!ident) return socket.emit('error-msg', 'Identity not found');

      const post = feeds.getPost(data.postId);
      if (!post) return socket.emit('error-msg', 'Original post not found');

      const result = feeds.createRepost(data.postId, post.pubkey, data.content || '', ident.privkey, ident.pubkey);

      // Broadcast to feed channel subscribers
      if (data.channelCode) {
        io.to(`feed:${data.channelCode}`).emit('feed:repost-update', {
          postId: data.postId,
          repost: result.event,
          reposter: ident.pubkey,
        });
      }

      socket.emit('feed:repost-result', result);
    } catch (e) {
      socket.emit('error-msg', `Failed to repost: ${e.message}`);
    }
  });

  // ── Cleanup subscriptions on disconnect ──────────────────
  socket.on('disconnect', () => {
    const subs = subscribedFeeds.get(socket.id);
    if (subs) {
      for (const code of subs) {
        socket.leave(`feed:${code}`);
      }
      subscribedFeeds.delete(socket.id);
    }
  });
};
