/**
 * Mosiac Profile Widget System — Frontend
 *
 * Provides a widget registry, built-in widget types, and a UI for
 * configuring widgets on a profile. Designed to be extensible so
 * custom widget types can be added.
 *
 * Built-in widget types:
 *   - music_player: embed an audio player
 *   - about: a block of text
 *   - friends: a list of friends/contacts
 *   - custom_html: raw HTML (sandboxed)
 */

// ─── Widget Registry ───────────────────────────────────────────────────────

const widgetRegistry = {};

/**
 * Register a widget type.
 * @param {string} type - Unique widget type identifier
 * @param {object} config
 * @param {string} config.label - Human-readable label
 * @param {Function} config.render - Function(widget) => HTML string
 * @param {Function} config.renderEditor - Function(widget, index) => HTML string for the editor
 * @param {Function} [config.defaults] - Function() => default widget object
 */
function registerWidgetType(type, config) {
  widgetRegistry[type] = config;
}

/**
 * Get registered widget type config.
 * @param {string} type
 * @returns {object|null}
 */
function getWidgetType(type) {
  return widgetRegistry[type] || null;
}

/**
 * List all registered widget types.
 * @returns {Array<{type: string, label: string}>}
 */
function listWidgetTypes() {
  return Object.entries(widgetRegistry).map(([type, cfg]) => ({
    type,
    label: cfg.label,
  }));
}

// ─── Built-in Widgets ──────────────────────────────────────────────────────

// Music Player widget
registerWidgetType('music_player', {
  label: 'Music Player',
  defaults: () => ({
    type: 'music_player',
    title: 'My Music',
    src: '',
  }),
  render: (w) => {
    return w.src
      ? `<audio controls src="${escapeAttr(w.src)}" style="width:100%"></audio>`
      : '<p class="widget-empty">No audio source configured</p>';
  },
  renderEditor: (w, index) => `
    <div class="widget-editor" data-widget-index="${index}">
      <div class="widget-editor-header">
        <strong>🎵 Music Player</strong>
        <button type="button" class="widget-remove-btn" data-index="${index}">&times;</button>
      </div>
      <div class="widget-editor-body">
        <label>Title: <input type="text" class="widget-field-title" value="${escapeAttr(w.title || 'My Music')}" placeholder="My Music"></label>
        <label>Audio URL: <input type="url" class="widget-field-src" value="${escapeAttr(w.src || '')}" placeholder="https://example.com/song.mp3"></label>
      </div>
    </div>`,
});

// About Me widget
registerWidgetType('about', {
  label: 'About Me',
  defaults: () => ({
    type: 'about',
    title: 'About',
    text: '',
  }),
  render: (w) => `<p>${escapeHtml(w.text || '')}</p>`,
  renderEditor: (w, index) => `
    <div class="widget-editor" data-widget-index="${index}">
      <div class="widget-editor-header">
        <strong>📝 About Me</strong>
        <button type="button" class="widget-remove-btn" data-index="${index}">&times;</button>
      </div>
      <div class="widget-editor-body">
        <label>Title: <input type="text" class="widget-field-title" value="${escapeAttr(w.title || 'About')}" placeholder="About"></label>
        <label>Text:
          <textarea class="widget-field-text" rows="3" placeholder="Tell us about yourself...">${escapeHtml(w.text || '')}</textarea>
        </label>
      </div>
    </div>`,
});

// Friends widget
registerWidgetType('friends', {
  label: 'Friends',
  defaults: () => ({
    type: 'friends',
    title: 'Friends',
    items: [],
  }),
  render: (w) => {
    const items = Array.isArray(w.items) ? w.items : [];
    if (items.length === 0) return '<p class="widget-empty">No friends listed</p>';
    return `<ul>${items.map(f => `<li>${escapeHtml(f.display_name || f.pubkey || 'Unknown')}</li>`).join('')}</ul>`;
  },
  renderEditor: (w, index) => {
    const items = Array.isArray(w.items) ? w.items : [];
    return `
    <div class="widget-editor" data-widget-index="${index}">
      <div class="widget-editor-header">
        <strong>👥 Friends</strong>
        <button type="button" class="widget-remove-btn" data-index="${index}">&times;</button>
      </div>
      <div class="widget-editor-body">
        <label>Title: <input type="text" class="widget-field-title" value="${escapeAttr(w.title || 'Friends')}" placeholder="Friends"></label>
        <div class="widget-friends-list">
          ${items.map((f, fi) => `
            <div class="widget-friend-row">
              <input type="text" class="widget-field-friend-name" value="${escapeAttr(f.display_name || '')}" placeholder="Name">
              <button type="button" class="widget-friend-remove-btn" data-widget-index="${index}" data-friend-index="${fi}">&times;</button>
            </div>`).join('')}
          <button type="button" class="widget-friend-add-btn" data-widget-index="${index}">+ Add Friend</button>
        </div>
      </div>
    </div>`;
  },
});

// Custom HTML widget
registerWidgetType('custom_html', {
  label: 'Custom HTML',
  defaults: () => ({
    type: 'custom_html',
    title: 'Custom',
    html: '',
  }),
  render: (w) => w.html || '',
  renderEditor: (w, index) => `
    <div class="widget-editor" data-widget-index="${index}">
      <div class="widget-editor-header">
        <strong>🔧 Custom HTML</strong>
        <button type="button" class="widget-remove-btn" data-index="${index}">&times;</button>
      </div>
      <div class="widget-editor-body">
        <label>Title: <input type="text" class="widget-field-title" value="${escapeAttr(w.title || 'Custom')}" placeholder="Custom"></label>
        <label>HTML:
          <textarea class="widget-field-html" rows="4" placeholder="<div>Your custom HTML here</div>">${escapeHtml(w.html || '')}</textarea>
        </label>
      </div>
    </div>`,
});

// ─── Widget Editor UI ──────────────────────────────────────────────────────

let _widgets = [];

/**
 * Initialize the widget editor UI.
 * @param {object} identity - { pubkey, privkey }
 */
function initWidgetEditor(identity) {
  const container = $('profile-widgets-editor');
  if (!container) return;

  // Load existing widgets from the current profile
  if (identity._profileWidgets) {
    _widgets = JSON.parse(JSON.stringify(identity._profileWidgets));
  }

  renderWidgetEditor(container);

  // Bind add widget button
  const addBtn = $('widget-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => showWidgetPicker());
  }

  // Expose widget getter for profile save
  window.getWidgetManifest = () => JSON.parse(JSON.stringify(_widgets));
}

/**
 * Render the widget editor panel.
 * @param {HTMLElement} container
 */
function renderWidgetEditor(container) {
  if (!container) return;

  if (_widgets.length === 0) {
    container.innerHTML = '<p class="widget-empty-state">No widgets yet. Click "Add Widget" to get started.</p>';
    return;
  }

  container.innerHTML = _widgets.map((w, i) => {
    const config = getWidgetType(w.type);
    if (!config || !config.renderEditor) {
      return `<div class="widget-editor error" data-widget-index="${i}">
        <p>Unknown widget type: ${escapeHtml(w.type)}</p>
        <button type="button" class="widget-remove-btn" data-index="${i}">&times;</button>
      </div>`;
    }
    return config.renderEditor(w, i);
  }).join('');

  // Bind remove buttons
  container.querySelectorAll('.widget-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      removeWidget(idx);
    });
  });

  // Bind friend remove buttons
  container.querySelectorAll('.widget-friend-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const wIdx = parseInt(btn.getAttribute('data-widget-index'));
      const fIdx = parseInt(btn.getAttribute('data-friend-index'));
      removeFriend(wIdx, fIdx);
    });
  });

  // Bind friend add buttons
  container.querySelectorAll('.widget-friend-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const wIdx = parseInt(btn.getAttribute('data-widget-index'));
      addFriend(wIdx);
    });
  });
}

/**
 * Show a widget type picker modal.
 */
function showWidgetPicker() {
  const types = listWidgetTypes();
  const picker = $('widget-picker');
  if (!picker) return;

  picker.innerHTML = `
    <div class="widget-picker-overlay" id="widget-picker-overlay">
      <div class="widget-picker-modal">
        <h3>Add Widget</h3>
        <p class="text-muted">Choose a widget type to add to your profile:</p>
        <div class="widget-picker-types">
          ${types.map(t => `
            <button type="button" class="widget-type-btn" data-type="${t.type}">
              <span class="widget-type-label">${escapeHtml(t.label)}</span>
            </button>`).join('')}
        </div>
        <button type="button" id="widget-picker-cancel" class="btn-secondary">Cancel</button>
      </div>
    </div>`;

  picker.classList.remove('hidden');

  // Bind type buttons
  picker.querySelectorAll('.widget-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-type');
      addWidget(type);
      picker.classList.add('hidden');
    });
  });

  const cancelBtn = $('widget-picker-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => picker.classList.add('hidden'));
  }

  // Click overlay to close
  const overlay = $('widget-picker-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) picker.classList.add('hidden');
    });
  }
}

/**
 * Add a widget of the given type.
 * @param {string} type
 */
function addWidget(type) {
  const config = getWidgetType(type);
  if (!config || !config.defaults) return;

  const widget = config.defaults();
  _widgets.push(widget);
  renderWidgetEditor($('profile-widgets-editor'));
}

/**
 * Remove a widget by index.
 * @param {number} index
 */
function removeWidget(index) {
  _widgets.splice(index, 1);
  renderWidgetEditor($('profile-widgets-editor'));
}

/**
 * Add a friend entry to a friends widget.
 * @param {number} widgetIndex
 */
function addFriend(widgetIndex) {
  const widget = _widgets[widgetIndex];
  if (!widget || widget.type !== 'friends') return;
  if (!Array.isArray(widget.items)) widget.items = [];
  widget.items.push({ display_name: '', pubkey: '' });
  renderWidgetEditor($('profile-widgets-editor'));
}

/**
 * Remove a friend from a friends widget.
 * @param {number} widgetIndex
 * @param {number} friendIndex
 */
function removeFriend(widgetIndex, friendIndex) {
  const widget = _widgets[widgetIndex];
  if (!widget || !Array.isArray(widget.items)) return;
  widget.items.splice(friendIndex, 1);
  renderWidgetEditor($('profile-widgets-editor'));
}

/**
 * Collect current widget state from the editor fields.
 * Called before saving.
 * @returns {Array}
 */
function collectWidgetData() {
  const container = $('profile-widgets-editor');
  if (!container) return _widgets;

  const editors = container.querySelectorAll('.widget-editor');
  const result = [];

  editors.forEach((el, i) => {
    const type = _widgets[i]?.type;
    if (!type) return;

    const title = el.querySelector('.widget-field-title')?.value || '';

    switch (type) {
      case 'music_player':
        result.push({
          type,
          title,
          src: el.querySelector('.widget-field-src')?.value || '',
        });
        break;
      case 'about':
        result.push({
          type,
          title,
          text: el.querySelector('.widget-field-text')?.value || '',
        });
        break;
      case 'friends': {
        const nameFields = el.querySelectorAll('.widget-field-friend-name');
        const items = [];
        nameFields.forEach(nf => {
          const name = nf.value.trim();
          if (name) items.push({ display_name: name });
        });
        result.push({ type, title, items });
        break;
      }
      case 'custom_html':
        result.push({
          type,
          title,
          html: el.querySelector('.widget-field-html')?.value || '',
        });
        break;
      default:
        result.push({ ..._widgets[i] });
    }
  });

  _widgets = result;
  return result;
}

// ─── Exports ───────────────────────────────────────────────────────────────

window.MosiacWidgets = {
  registerWidgetType,
  getWidgetType,
  listWidgetTypes,
  initWidgetEditor,
  collectWidgetData,
};

// Set up alias so app-profile can call initWidgetEditor
window.initProfileWidgets = initWidgetEditor;

// ─── Internal helpers ──────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
