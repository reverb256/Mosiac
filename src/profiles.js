'use strict';

/**
 * Profile Module — MySpace-style sandboxed HTML/CSS/JS profiles.
 *
 * Each Mosiac identity can have one profile manifest, signed by the
 * identity's Ed25519 key. The manifest includes display_name, bio,
 * avatar, background, custom HTML/CSS/JS content, and a widget list.
 *
 * Profile manifests are stored in the identity database alongside
 * identities/passkeys/contacts/sessions.
 */

const identity = require('./identity');

// ─── Schema constants ──────────────────────────────────────────────────────

const MANIFEST_VERSION = 1;

const MANIFEST_KEYS = [
  'version', 'pubkey', 'display_name', 'bio', 'avatar',
  'background', 'theme', 'template', 'content', 'css', 'js',
  'widgets', 'signature',
];

const WIDGET_TYPES = ['music_player', 'about', 'friends', 'custom_html'];

const DEFAULT_MANIFEST = {
  version: MANIFEST_VERSION,
  display_name: '',
  bio: '',
  avatar: '',
  background: '',
  theme: 'mosiac-dark',
  template: 'sandboxed_html',
  content: '',
  css: '',
  js: '',
  widgets: [],
};

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * Validate a profile manifest object.
 * Returns { valid: boolean, errors: string[] }
 */
function validateManifest(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'] };
  }

  if (manifest.version !== MANIFEST_VERSION) {
    errors.push(`Invalid version: expected ${MANIFEST_VERSION}`);
  }

  if (manifest.display_name !== undefined && typeof manifest.display_name !== 'string') {
    errors.push('display_name must be a string');
  } else if (typeof manifest.display_name === 'string' && manifest.display_name.length > 64) {
    errors.push('display_name must be at most 64 characters');
  }

  if (manifest.bio !== undefined && typeof manifest.bio !== 'string') {
    errors.push('bio must be a string');
  } else if (typeof manifest.bio === 'string' && manifest.bio.length > 500) {
    errors.push('bio must be at most 500 characters');
  }

  if (manifest.pubkey && typeof manifest.pubkey !== 'string') {
    errors.push('pubkey must be a string');
  }

  if (manifest.content && typeof manifest.content !== 'string') {
    errors.push('content must be a string');
  }

  if (manifest.css && typeof manifest.css !== 'string') {
    errors.push('css must be a string');
  }

  if (manifest.js && typeof manifest.js !== 'string') {
    errors.push('js must be a string');
  }

  if (manifest.widgets) {
    if (!Array.isArray(manifest.widgets)) {
      errors.push('widgets must be an array');
    } else {
      for (let i = 0; i < manifest.widgets.length; i++) {
        const w = manifest.widgets[i];
        if (!w || typeof w !== 'object') {
          errors.push(`widgets[${i}] must be an object`);
        } else if (!WIDGET_TYPES.includes(w.type)) {
          errors.push(`widgets[${i}].type must be one of: ${WIDGET_TYPES.join(', ')}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── DB helpers (profiles table alongside identity tables) ──────────────────

/**
 * Initialize profiles table (called from database.js init).
 */
function createTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      pubkey       TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      manifest     TEXT NOT NULL DEFAULT '{}',
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Get the profiles DB handle (same identity DB).
 */
function getDb() {
  const database = require('./database');
  return database.getIdentityDb();
}

/**
 * Get a profile manifest by pubkey.
 * @param {string} pubkey - Base64URL-encoded public key
 * @returns {object|null} The parsed manifest, or null
 */
function getProfile(pubkey) {
  if (!pubkey || typeof pubkey !== 'string') return null;
  const row = getDb().prepare(
    'SELECT manifest FROM profiles WHERE pubkey = ?'
  ).get(pubkey);
  if (!row) return null;
  try {
    return JSON.parse(row.manifest);
  } catch {
    return null;
  }
}

/**
 * Get raw profile metadata row (for listings).
 * @param {string} pubkey
 * @returns {object|null} { pubkey, display_name, updated_at }
 */
function getProfileMeta(pubkey) {
  if (!pubkey || typeof pubkey !== 'string') return null;
  return getDb().prepare(
    'SELECT pubkey, display_name, updated_at FROM profiles WHERE pubkey = ?'
  ).get(pubkey) || null;
}

/**
 * Save a profile manifest. Creates or replaces.
 * @param {string} pubkey
 * @param {object} manifest - Validated manifest object
 * @returns {object} { ok: boolean, error?: string }
 */
function saveProfile(pubkey, manifest) {
  if (!pubkey || typeof pubkey !== 'string') {
    return { ok: false, error: 'pubkey is required' };
  }

  // Validate
  const check = validateManifest(manifest);
  if (!check.valid) {
    return { ok: false, error: check.errors.join('; ') };
  }

  // Strip sensitive fields that should not be stored directly
  const store = { ...manifest };
  // Remove signature — it's re-computed by the signProfileManifest call
  delete store.signature;
  // pubkey in manifest should match the key
  store.pubkey = pubkey;

  const db = getDb();
  const displayName = (manifest.display_name || '').slice(0, 64);

  try {
    db.prepare(`
      INSERT INTO profiles (pubkey, display_name, manifest, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(pubkey) DO UPDATE SET
        display_name = excluded.display_name,
        manifest = excluded.manifest,
        updated_at = datetime('now')
    `).run(pubkey, displayName, JSON.stringify(store));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Delete a profile.
 * @param {string} pubkey
 * @returns {boolean}
 */
function deleteProfile(pubkey) {
  if (!pubkey || typeof pubkey !== 'string') return false;
  try {
    getDb().prepare('DELETE FROM profiles WHERE pubkey = ?').run(pubkey);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all profiles (metadata only — no manifest bodies).
 * @returns {Array<{pubkey: string, display_name: string, updated_at: string}>}
 */
function listProfiles() {
  return getDb().prepare(
    'SELECT pubkey, display_name, updated_at FROM profiles ORDER BY updated_at DESC'
  ).all();
}

// ─── Signing ───────────────────────────────────────────────────────────────

/**
 * Sign a profile manifest with an identity key.
 * Returns the manifest with a 'signature' field added.
 *
 * @param {object} manifest - The profile manifest (without signature)
 * @param {string} privkey - Base64URL-encoded private key
 * @param {string} pubkey - Base64URL-encoded public key
 * @returns {object} The signed manifest { ...manifest, signature, pubkey }
 */
function signProfileManifest(manifest, privkey, pubkey) {
  // Create a deterministic copy for signing — sort keys
  const toSign = { ...manifest };
  delete toSign.signature;
  toSign.pubkey = pubkey;

  const signed = identity.signJSON(toSign, privkey, pubkey);
  return {
    ...toSign,
    signature: signed.signature,
  };
}

/**
 * Verify a signed profile manifest.
 *
 * @param {object} manifest - The full manifest including signature
 * @returns {boolean}
 */
function verifyProfileManifest(manifest) {
  if (!manifest || !manifest.signature || !manifest.pubkey) return false;
  const { signature, ...data } = manifest;
  return identity.verifyJSON({
    data,
    signature,
    pubkey: manifest.pubkey,
  });
}

module.exports = {
  MANIFEST_VERSION,
  DEFAULT_MANIFEST,
  WIDGET_TYPES,
  validateManifest,
  createTable,
  getProfile,
  getProfileMeta,
  saveProfile,
  deleteProfile,
  listProfiles,
  signProfileManifest,
  verifyProfileManifest,
};
