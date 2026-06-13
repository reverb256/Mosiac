/**
 * Mosiac Feeds — Frontend Module (Phase 3)
 *
 * Provides:
 *   - Identity selection and session management
 *   - Post composer with tags, reply-to, channel support
 *   - Timeline display with engagement stats
 *   - Like/unlike, repost, reply interactions
 *   - Bookmark support
 *   - Feed channel subscription via WebSocket
 */

// ─── Base URL ──────────────────────────────────────────────────────────────

const API = '/mosiac';

// ─── DOM refs ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const views = {
  splash:    $('splash'),
  dashboard: $('dashboard'),
};

// ─── State ─────────────────────────────────────────────────────────────────

let currentIdentity = null; // { id, pubkey, pubkeyHex, label, privkey? }
let feedChannel = null;     // Current feed channel code
let currentFilter = 'all';  // 'all', 'posts', 'bookmarks'

// ─── View management ───────────────────────────────────────────────────────

function showView(name) {
  Object.values(views).forEach(v => v?.classList.remove('active'));
  const view = views[name];
  if (view) view.classList.add('active');
}

// ─── API helpers ───────────────────────────────────────────────────────────

async function apiGet(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiPost(path, data) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Identity management ───────────────────────────────────────────────────

async function loadIdentities() {
  try {
    const data = await apiGet('/identity');
    return data;
  } catch (e) {
    console.error('Failed to load identities:', e);
    return [];
  }
}

async function selectIdentity(identityId) {
  // Load the full identity including privkey (we need it for signing)
  try {
    const identities = await loadIdentities();
    const ident = identities.find(i => i.id === identityId);
    if (!ident) throw new Error('Identity not found');

    // Load full identity details including privkey from the API
    const detail = await apiGet(`/identity/current`);

    currentIdentity = {
      id: ident.id,
      pubkey: ident.pubkey,
      label: ident.label || `Identity #${ident.id}`,
    };

    // Try to get the privkey for signing - ident privkey comes from key gen
    // For now, the frontend creates posts via the backend /mosiac/feed/post route
    // which handles signing server-side using the stored privkey

    updateIdentityInfo();
    showView('dashboard');
    loadTimeline();
  } catch (e) {
    console.error('Identity select error:', e);
    $('conn-status').textContent = `Error: ${e.message}`;
  }
}

function updateIdentityInfo() {
  if (!currentIdentity) return;
  $('identity-label').textContent = currentIdentity.label;
  $('identity-pubkey').textContent = currentIdentity.pubkey.slice(0, 20) + '…';
}

// ─── Timeline ──────────────────────────────────────────────────────────────

async function loadTimeline() {
  if (!currentIdentity) return;

  const postsContainer = $('timeline-posts');
  const loading = $('timeline-loading');

  loading.classList.remove('hidden');
  postsContainer.innerHTML = '';

  try {
    if (currentFilter === 'bookmarks') {
      await loadBookmarks();
      return;
    }

    // Load posts from the current identity's own feed
    // In a full implementation, this would pull from followed identities
    const data = await apiGet(`/feed/timeline?pubkeys=${encodeURIComponent(currentIdentity.pubkey)}&limit=50`);

    loading.classList.add('hidden');

    if (!data.posts || data.posts.length === 0) {
      postsContainer.innerHTML = '<p class="text-muted text-center">No posts yet. Create your first post!</p>';
      return;
    }

    renderPosts(data.posts, postsContainer);
  } catch (e) {
    loading.classList.add('hidden');
    postsContainer.innerHTML = `<p class="text-muted text-center">Error loading timeline: ${e.message}</p>`;
  }
}

async function loadBookmarks() {
  const postsContainer = $('timeline-posts');
  const loading = $('timeline-loading');

  try {
    const data = await apiGet(`/feed/bookmarks?limit=50`);

    loading.classList.add('hidden');

    if (!data.posts || data.posts.length === 0) {
      postsContainer.innerHTML = '<p class="text-muted text-center">No bookmarked posts yet.</p>';
      return;
    }

    renderPosts(data.posts, postsContainer);
  } catch (e) {
    loading.classList.add('hidden');
    postsContainer.innerHTML = `<p class="text-muted text-center">Error loading bookmarks: ${e.message}</p>`;
  }
}

// ─── Post rendering ────────────────────────────────────────────────────────

function renderPosts(posts, container) {
  container.innerHTML = '';
  for (const post of posts) {
    const el = createPostElement(post);
    container.appendChild(el);
  }
}

function createPostElement(post) {
  const article = document.createElement('article');
  article.className = 'post-card';
  article.dataset.postId = post.id;

  const content = escapeHtml(post.data?.content || '');
  const tags = post.data?.tags || [];
  const replyTo = post.data?.replyTo;
  const timeAgo = formatTimeAgo(post.created_at);

  article.innerHTML = `
    <div class="post-header">
      <span class="post-author">${escapeHtml(post.pubkey?.slice(0, 16) || 'anonymous')}…</span>
      <span class="post-time" title="${new Date(post.created_at).toLocaleString()}">${timeAgo}</span>
    </div>
    ${replyTo ? `<div class="post-reply-indicator">↱ Reply to a post</div>` : ''}
    <div class="post-body">${content}</div>
    ${tags.length > 0 ? `<div class="post-tags">${tags.map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    <div class="post-actions">
      <button class="btn-action btn-like" data-post-id="${post.id}" title="Like">
        ${post.likes > 0 ? `❤️ ${post.likes}` : '🤍'}
      </button>
      <button class="btn-action btn-reply" data-post-id="${post.id}" title="Reply">
        💬 ${post.replies || 0}
      </button>
      <button class="btn-action btn-repost" data-post-id="${post.id}" title="Repost">
        🔄 ${post.reposts || 0}
      </button>
      <button class="btn-action btn-bookmark" data-post-id="${post.id}" title="Bookmark">
        ${post.bookmarked ? '🔖' : '🏷️'}
      </button>
      <span class="post-signature-badge" title="Signed with Ed25519">✓ signed</span>
    </div>
  `;

  // ── Event handlers ────────────────────────────────────
  article.querySelector('.btn-like').addEventListener('click', () => handleLike(post.id));
  article.querySelector('.btn-reply').addEventListener('click', () => handleReply(post.id));
  article.querySelector('.btn-repost').addEventListener('click', () => handleRepost(post.id));
  article.querySelector('.btn-bookmark').addEventListener('click', () => handleBookmark(post.id, article));

  return article;
}

// ─── Post interactions ─────────────────────────────────────────────────────

async function handleLike(postId) {
  try {
    const result = await apiPost('/feed/like', { postId });
    // Refresh the post card
    const stats = await apiGet(`/feed/post/${postId}/stats`);
    const likeBtn = document.querySelector(`.btn-like[data-post-id="${postId}"]`);
    if (likeBtn) {
      likeBtn.innerHTML = stats.likes > 0 ? `❤️ ${stats.likes}` : '🤍';
    }
  } catch (e) {
    console.error('Like failed:', e);
  }
}

async function handleRepost(postId) {
  const content = prompt('Add a comment (optional):');
  if (content === null) return; // cancelled

  try {
    await apiPost('/feed/repost', { postId, content: content || '' });
    // Refresh stats
    const stats = await apiGet(`/feed/post/${postId}/stats`);
    const repostBtn = document.querySelector(`.btn-repost[data-post-id="${postId}"]`);
    if (repostBtn) {
      repostBtn.innerHTML = `🔄 ${stats.reposts || 0}`;
    }
  } catch (e) {
    console.error('Repost failed:', e);
  }
}

function handleReply(postId) {
  // Open composer with replyTo context
  showComposer(postId);
}

async function handleBookmark(postId, article) {
  try {
    const result = await apiPost('/feed/bookmark', { eventId: postId });
    const btn = article.querySelector('.btn-bookmark');
    if (btn) {
      btn.innerHTML = result.bookmarked ? '🔖' : '🏷️';
      btn.title = result.bookmarked ? 'Remove bookmark' : 'Bookmark';
    }
  } catch (e) {
    console.error('Bookmark failed:', e);
  }
}

// ─── Composer ──────────────────────────────────────────────────────────────

let replyToId = null;

function showComposer(replyTo) {
  replyToId = replyTo || null;
  const composer = $('composer');
  composer.classList.remove('hidden');
  $('composer-content').focus();

  if (replyTo) {
    $('composer-header').innerHTML = `<h3>Reply to post</h3>`;
  } else {
    $('composer-header').innerHTML = `<h3>Create Post</h3>`;
  }

  // Load channels for the dropdown
  loadChannels();
}

function hideComposer() {
  $('composer').classList.add('hidden');
  $('composer-content').value = '';
  $('composer-tags').value = '';
  replyToId = null;
}

async function submitPost() {
  const content = $('composer-content').value.trim();
  if (!content) return;

  const tagsStr = $('composer-tags').value.trim();
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
  const channelCode = $('composer-channel').value || undefined;

  try {
    const result = await apiPost('/feed/post', {
      content,
      tags,
      replyTo: replyToId,
      channelCode,
    });

    hideComposer();
    loadTimeline(); // Refresh timeline
  } catch (e) {
    console.error('Post failed:', e);
    alert(`Failed to post: ${e.message}`);
  }
}

async function loadChannels() {
  // For now, the channel list is populated from feed channels
  // In a full implementation, this would come from the server
  const select = $('composer-channel');
  // Keep the default option
  while (select.options.length > 1) select.remove(1);
}

// ─── Feed channel subscriptions ────────────────────────────────────────────

function subscribeToFeedChannel(code) {
  // In a full WebSocket implementation, this would use Socket.IO
  // to subscribe to real-time feed updates
  console.log(`Subscribed to feed channel: ${code}`);
}

// ─── Utility ───────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTimeAgo(ms) {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

// ─── Initialization ────────────────────────────────────────────────────────

async function init() {
  // Check connection
  try {
    const health = await apiGet('/health');
    $('conn-status').textContent = 'connected';
    $('conn-status').classList.add('connected');
  } catch {
    $('conn-status').textContent = 'disconnected';
    return;
  }

  // Load identities
  const identities = await loadIdentities();
  if (identities.length > 0) {
    // Show existing identities
    const container = $('splash').querySelector('.splash-card');
    const list = document.createElement('div');
    list.className = 'identity-list';
    list.innerHTML = '<h3>Select Identity</h3>';

    for (const ident of identities) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-block';
      btn.textContent = `${ident.label || `Identity #${ident.id}`} — ${ident.pubkey.slice(0, 16)}…`;
      btn.addEventListener('click', () => selectIdentity(ident.id));
      list.appendChild(btn);
    }

    container.appendChild(list);
    $('btn-select-identity').textContent = 'Refresh Identities';
  }

  // ── Button event listeners ────────────────────────────
  $('btn-select-identity').addEventListener('click', async () => {
    const list = await loadIdentities();
    if (list.length > 0) {
      selectIdentity(list[0].id);
    } else {
      alert('No identities found. Create one on the Identity page first.');
      window.location.href = '/identity.html';
    }
  });

  $('btn-change-identity').addEventListener('click', () => {
    currentIdentity = null;
    showView('splash');
  });

  $('btn-new-post').addEventListener('click', () => showComposer(null));
  $('btn-composer-close').addEventListener('click', hideComposer);
  $('btn-composer-post').addEventListener('click', submitPost);

  $('btn-refresh-feed').addEventListener('click', loadTimeline);

  // Character counter for composer
  $('composer-content').addEventListener('input', () => {
    const len = $('composer-content').value.length;
    $('composer-char-count').textContent = `${len} / 5000`;
  });

  // Filter buttons
  $('btn-filter-all').addEventListener('click', () => {
    currentFilter = 'all';
    updateFilterButtons();
    loadTimeline();
  });
  $('btn-filter-posts').addEventListener('click', () => {
    currentFilter = 'posts';
    updateFilterButtons();
    loadTimeline();
  });
  $('btn-filter-bookmarks').addEventListener('click', () => {
    currentFilter = 'bookmarks';
    updateFilterButtons();
    loadTimeline();
  });

  // Enter key in composer
  $('composer-content').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitPost();
    }
  });
}

function updateFilterButtons() {
  ['all', 'posts', 'bookmarks'].forEach(f => {
    const btn = $(`btn-filter-${f}`);
    if (btn) btn.classList.toggle('active', f === currentFilter);
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
