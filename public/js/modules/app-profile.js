/**
 * Mosiac Profile Module — Frontend
 *
 * Handles:
 *   - Profile editor UI (display_name, bio, avatar, background, theme)
 *   - Custom HTML/CSS/JS editor
 *   - Widget configuration
 *   - Manifest signing with identity key
 *   - Profile viewer rendering
 *   - Integration with identity.js (Phase 1)
 */

// ─── Base URL ──────────────────────────────────────────────────────────────

const PROFILE_API = '/api/profile';
const MOSIAC_API = '/mosiac';

// ─── DOM helpers ───────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

// ─── Profile Editor ────────────────────────────────────────────────────────

/**
 * Initialize the profile editor UI.
 * Call after DOM is ready and identity is loaded.
 * @param {object} identity - { pubkey, privkey, identityId } from identity module
 */
function initProfileEditor(identity) {
  if (!identity || !identity.pubkey) {
    console.warn('[app-profile] No identity loaded, cannot init editor');
    return;
  }

  const editorEl = $('profile-editor');
  if (!editorEl) {
    console.warn('[app-profile] #profile-editor element not found in DOM');
    return;
  }

  editorEl.classList.remove('hidden');
  $('profile-editor-identity').textContent = identity.pubkey;

  // Load existing profile
  loadProfile(identity.pubkey).then(profile => {
    populateEditor(profile);
  });

  // Bind save button
  const saveBtn = $('profile-save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveProfile(identity));
  }

  // Bind preview button
  const previewBtn = $('profile-preview-btn');
  if (previewBtn) {
    previewBtn.addEventListener('click', () => previewProfile());
  }

  // Bind tab switching
  const tabs = editorEl.querySelectorAll('.editor-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.getAttribute('data-tab');
      editorEl.querySelectorAll('.editor-pane').forEach(p => p.classList.remove('active'));
      const pane = $(`editor-pane-${target}`);
      if (pane) pane.classList.add('active');
    });
  });

  // Init widget system
  if (window.initProfileWidgets) {
    window.initProfileWidgets(identity);
  }
}

/**
 * Load a profile from the server.
 * @param {string} pubkey
 * @returns {Promise<object|null>}
 */
async function loadProfile(pubkey) {
  try {
    const res = await fetch(`${PROFILE_API}/${encodeURIComponent(pubkey)}`);
    const data = await res.json();
    return data.profile || null;
  } catch (e) {
    console.error('[app-profile] Failed to load profile:', e);
    return null;
  }
}

/**
 * Populate the editor form fields from a profile manifest.
 * @param {object|null} profile
 */
function populateEditor(profile) {
  if (!profile) profile = {};

  const setVal = (id, val) => {
    const el = $(id);
    if (el) el.value = val || '';
  };

  setVal('profile-display-name', profile.display_name);
  setVal('profile-bio', profile.bio);
  setVal('profile-avatar', profile.avatar);
  setVal('profile-background', profile.background);
  setVal('profile-theme', profile.theme || 'mosiac-dark');
  setVal('profile-custom-html', profile.content || '');
  setVal('profile-custom-css', profile.css || '');
  setVal('profile-custom-js', profile.js || '');

  // Update preview
  updatePreview(profile);
}

/**
 * Gather form data into a manifest object.
 * @returns {object}
 */
function gatherFormData() {
  return {
    display_name: ($('profile-display-name')?.value || '').trim(),
    bio: ($('profile-bio')?.value || '').trim(),
    avatar: ($('profile-avatar')?.value || '').trim(),
    background: ($('profile-background')?.value || '').trim(),
    theme: ($('profile-theme')?.value || 'mosiac-dark').trim(),
    content: ($('profile-custom-html')?.value || '').trim(),
    css: ($('profile-custom-css')?.value || '').trim(),
    js: ($('profile-custom-js')?.value || '').trim(),
  };
}

/**
 * Save the profile by signing the manifest and PUTting to the server.
 * @param {object} identity - { pubkey, privkey }
 */
async function saveProfile(identity) {
  const saveBtn = $('profile-save-btn');
  const statusEl = $('profile-status');

  if (saveBtn) saveBtn.disabled = true;
  if (statusEl) {
    statusEl.textContent = 'Signing and saving...';
    statusEl.className = 'profile-status info';
  }

  try {
    // Gather form data
    const data = gatherFormData();
    data.version = 1;

    // Build the manifest (without signature initially)
    const manifest = {
      version: 1,
      pubkey: identity.pubkey,
      display_name: data.display_name,
      bio: data.bio,
      avatar: data.avatar,
      background: data.background,
      theme: data.theme || 'mosiac-dark',
      template: 'sandboxed_html',
      content: data.content,
      css: data.css,
      js: data.js,
      widgets: window.getWidgetManifest ? window.getWidgetManifest() : [],
    };

    // Sign the manifest using the signing endpoint
    const signRes = await fetch(`${MOSIAC_API}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: manifest }),
    });

    if (!signRes.ok) {
      const err = await signRes.json();
      throw new Error(err.error || 'Failed to sign manifest');
    }

    const signed = await signRes.json();

    // PUT signed manifest to profile API
    const putRes = await fetch(PROFILE_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: signed,
        pubkey: identity.pubkey,
      }),
    });

    const result = await putRes.json();

    if (!putRes.ok) {
      throw new Error(result.error || 'Failed to save profile');
    }

    if (statusEl) {
      statusEl.textContent = 'Profile saved successfully!';
      statusEl.className = 'profile-status success';
    }

    // Update preview
    updatePreview(signed);

    console.log('[app-profile] Profile saved:', identity.pubkey);
  } catch (e) {
    console.error('[app-profile] Save failed:', e);
    if (statusEl) {
      statusEl.textContent = `Error: ${e.message}`;
      statusEl.className = 'profile-status error';
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * Preview the profile in a sandboxed iframe.
 */
function previewProfile() {
  const previewEl = $('profile-preview');
  if (!previewEl) return;

  const data = gatherFormData();

  const sandboxContent = generateSandboxHTML(data.content, data.css);

  previewEl.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
  iframe.style.width = '100%';
  iframe.style.height = '500px';
  iframe.style.border = '1px solid var(--border-color, #333)';
  iframe.style.borderRadius = '8px';
  iframe.srcdoc = sandboxContent;
  previewEl.appendChild(iframe);
}

/**
 * Update the live preview from a profile manifest.
 * @param {object} profile
 */
function updatePreview(profile) {
  if (!profile) return;

  const previewName = $('profile-preview-name');
  const previewBio = $('profile-preview-bio');
  const previewBanner = $('profile-preview-banner');

  if (previewName) previewName.textContent = profile.display_name || 'Unnamed Profile';
  if (previewBio) previewBio.textContent = profile.bio || '';
  if (previewBanner && profile.background) {
    previewBanner.style.backgroundImage = `url('${escapeAttr(profile.background)}')`;
  }

  // Update custom content preview
  previewProfile();
}

/**
 * Generate sandboxed HTML for preview/render.
 */
function generateSandboxHTML(html, css) {
  const styleTag = css ? `<style>${css}</style>` : '';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${styleTag}
</head>
<body>
${html || ''}
</body>
</html>`;
}

/**
 * Escape an attribute value for safe HTML injection.
 */
function escapeAttr(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// ─── Profile Viewer (standalone) ────────────────────────────────────────────

/**
 * Render a profile viewer on a page.
 * @param {string} pubkey - The public key to view
 * @param {HTMLElement} container - DOM element to render into
 */
async function renderProfileViewer(pubkey, container) {
  if (!container) return;

  container.innerHTML = '<div class="loading">Loading profile...</div>';

  try {
    const res = await fetch(`${PROFILE_API}/${encodeURIComponent(pubkey)}`);
    const data = await res.json();

    if (!data.profile) {
      container.innerHTML = '<div class="error">Profile not found</div>';
      return;
    }

    const p = data.profile;

    container.innerHTML = `
      <div class="profile-viewer">
        <div class="viewer-header" style="background: ${p.background ? `url('${escapeAttr(p.background)}') center/cover` : 'linear-gradient(135deg, #667eea, #764ba2)'}">
          <div class="viewer-avatar">
            ${p.avatar ? `<img src="${escapeAttr(p.avatar)}" alt="${escapeAttr(p.display_name)}">` : '<div class="viewer-avatar-placeholder">' + (p.display_name || '?')[0] + '</div>'}
          </div>
        </div>
        <div class="viewer-info">
          <h2>${escapeHtml(p.display_name || 'Unknown User')}</h2>
          <p class="viewer-bio">${escapeHtml(p.bio || '')}</p>
          <p class="viewer-pubkey"><small>${escapeHtml(pubkey)}</small></p>
        </div>
        ${p.content ? `
        <div class="viewer-custom">
          <iframe sandbox="allow-same-origin allow-scripts" srcdoc="${escapeAttr(generateSandboxHTML(p.content, p.css))}" style="width:100%;height:400px;border:1px solid #333;border-radius:8px;"></iframe>
        </div>` : ''}
        ${Array.isArray(p.widgets) && p.widgets.length > 0 ? `
        <div class="viewer-widgets">
          ${p.widgets.map((w, i) => renderWidgetView(w, i)).join('')}
        </div>` : ''}
      </div>
    `;
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load profile: ${escapeHtml(e.message)}</div>`;
  }
}

/**
 * Render a single widget in the viewer.
 */
function renderWidgetView(widget, index) {
  const title = widget.title || widget.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  let content = '';

  switch (widget.type) {
    case 'music_player':
      content = widget.src ? `<audio controls src="${escapeAttr(widget.src)}" style="width:100%"></audio>` : '<p>No source</p>';
      break;
    case 'about':
      content = `<p>${escapeHtml(widget.text || '')}</p>`;
      break;
    case 'friends':
      const items = Array.isArray(widget.items) ? widget.items : [];
      content = items.length ? `<ul>${items.map(f => `<li>${escapeHtml(f.display_name || f.pubkey || 'Unknown')}</li>`).join('')}</ul>` : '<p>No friends listed</p>';
      break;
    case 'custom_html':
      content = widget.html || '';
      break;
    default:
      content = '<p>Unknown widget type</p>';
  }

  return `<div class="viewer-widget" data-index="${index}">
    <h4>${escapeHtml(title)}</h4>
    <div class="viewer-widget-content">${content}</div>
  </div>`;
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Exports ───────────────────────────────────────────────────────────────

window.MosiacProfile = {
  initProfileEditor,
  loadProfile,
  saveProfile,
  previewProfile,
  renderProfileViewer,
  loadProfile,
};
