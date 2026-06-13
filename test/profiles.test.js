'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Profile Modules ───────────────────────────────────────────────────────

const profiles = require('../src/profiles');
const sandbox = require('../src/profiles-sandbox');
const identity = require('../src/identity');

describe('Profile Module', () => {
  describe('validateManifest()', () => {
    it('should reject invalid manifests', () => {
      assert.strictEqual(profiles.validateManifest(null).valid, false);
      assert.strictEqual(profiles.validateManifest('string').valid, false);
      assert.strictEqual(profiles.validateManifest({}).valid, false); // missing version
    });

    it('should accept a valid manifest', () => {
      const manifest = {
        version: 1,
        display_name: 'cooluser',
        bio: 'building sovereign social',
        content: '<div>hello</div>',
        widgets: [],
      };
      const result = profiles.validateManifest(manifest);
      assert.ok(result.valid, JSON.stringify(result.errors));
      assert.deepStrictEqual(result.errors, []);
    });

    it('should reject widgets with invalid types', () => {
      const manifest = {
        version: 1,
        display_name: 'test',
        widgets: [{ type: 'invalid_type' }],
      };
      const result = profiles.validateManifest(manifest);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors[0].includes('widgets[0].type'));
    });

    it('should reject long display_name', () => {
      const manifest = {
        version: 1,
        display_name: 'a'.repeat(65),
      };
      const result = profiles.validateManifest(manifest);
      assert.strictEqual(result.valid, false);
    });

    it('should reject long bio', () => {
      const manifest = {
        version: 1,
        display_name: 'test',
        bio: 'a'.repeat(501),
      };
      const result = profiles.validateManifest(manifest);
      assert.strictEqual(result.valid, false);
    });

    it('should accept manifest without optional fields', () => {
      const manifest = { version: 1 };
      const result = profiles.validateManifest(manifest);
      assert.ok(result.valid, JSON.stringify(result.errors));
    });
  });

  describe('sign and verify profile manifest', () => {
    it('should sign and verify a profile manifest', () => {
      const kp = identity.generateKeyPair();
      const manifest = {
        version: 1,
        display_name: 'cooluser',
        bio: 'sovereign social',
        widgets: [],
      };

      const signed = profiles.signProfileManifest(manifest, kp.privkey, kp.pubkey);
      assert.ok(signed.signature);
      assert.strictEqual(signed.pubkey, kp.pubkey);

      const valid = profiles.verifyProfileManifest(signed);
      assert.strictEqual(valid, true);
    });

    it('should reject tampered manifest', () => {
      const kp = identity.generateKeyPair();
      const manifest = { version: 1, display_name: 'alice' };

      const signed = profiles.signProfileManifest(manifest, kp.privkey, kp.pubkey);
      signed.display_name = 'mallory';

      const valid = profiles.verifyProfileManifest(signed);
      assert.strictEqual(valid, false);
    });

    it('should reject mismatched pubkey', () => {
      const alice = identity.generateKeyPair();
      const bob = identity.generateKeyPair();
      const manifest = { version: 1, display_name: 'alice' };

      const signed = profiles.signProfileManifest(manifest, alice.privkey, alice.pubkey);
      signed.pubkey = bob.pubkey;

      const valid = profiles.verifyProfileManifest(signed);
      assert.strictEqual(valid, false);
    });
  });

  describe('saveProfile() and getProfile()', () => {
    // Initialize the database before DB-dependent tests
    before(() => {
      const database = require('../src/database');
      database.initDatabase();
    });

    it('should save and retrieve a profile', () => {
      const kp = identity.generateKeyPair();
      const manifest = {
        version: 1,
        display_name: 'testuser',
        bio: 'testing profiles',
        pubkey: kp.pubkey,
        widgets: [{ type: 'about', title: 'About', text: 'Hello!' }],
      };

      const result = profiles.saveProfile(kp.pubkey, manifest);
      assert.ok(result.ok, result.error);

      const fetched = profiles.getProfile(kp.pubkey);
      assert.ok(fetched);
      assert.strictEqual(fetched.display_name, 'testuser');
      assert.strictEqual(fetched.bio, 'testing profiles');
      assert.strictEqual(fetched.pubkey, kp.pubkey);
    });

    it('should get profile metadata', () => {
      const kp = identity.generateKeyPair();
      const manifest = {
        version: 1,
        display_name: 'metatest',
        bio: 'metadata',
        pubkey: kp.pubkey,
      };

      profiles.saveProfile(kp.pubkey, manifest);
      const meta = profiles.getProfileMeta(kp.pubkey);
      assert.ok(meta);
      assert.strictEqual(meta.display_name, 'metatest');
      assert.strictEqual(meta.pubkey, kp.pubkey);
      assert.ok(meta.updated_at);
    });

    it('should update an existing profile', () => {
      const kp = identity.generateKeyPair();
      const m1 = { version: 1, display_name: 'original', pubkey: kp.pubkey };
      const m2 = { version: 1, display_name: 'updated', pubkey: kp.pubkey };

      profiles.saveProfile(kp.pubkey, m1);
      profiles.saveProfile(kp.pubkey, m2);

      const fetched = profiles.getProfile(kp.pubkey);
      assert.strictEqual(fetched.display_name, 'updated');
    });

    it('should return null for unknown pubkey', () => {
      const result = profiles.getProfile('nonexistent-pubkey');
      assert.strictEqual(result, null);
    });

    it('should list all profiles', () => {
      const list = profiles.listProfiles();
      assert.ok(Array.isArray(list));
    });

    it('should delete a profile', () => {
      const kp = identity.generateKeyPair();
      profiles.saveProfile(kp.pubkey, { version: 1, display_name: 'delete-me', pubkey: kp.pubkey });
      assert.ok(profiles.getProfile(kp.pubkey));

      const deleted = profiles.deleteProfile(kp.pubkey);
      assert.strictEqual(deleted, true);
      assert.strictEqual(profiles.getProfile(kp.pubkey), null);
    });
  });
});

// ─── Sandbox Module Tests ─────────────────────────────────────────────────

describe('Profile Sandbox Module', () => {
  describe('sanitizeHTML()', () => {
    it('should allow safe HTML', () => {
      const html = '<div>Hello</div><p>World</p>';
      const result = sandbox.sanitizeHTML(html);
      assert.ok(result.includes('Hello'));
      assert.ok(result.includes('World'));
    });

    it('should strip script tags', () => {
      const html = '<div>safe</div><script>alert("xss")</script>';
      const result = sandbox.sanitizeHTML(html);
      assert.ok(result.includes('safe'));
      assert.ok(!result.includes('<script>'));
      assert.ok(!result.includes('alert'));
    });

    it('should strip event handlers', () => {
      const html = '<div onclick="alert(1)">click me</div>';
      const result = sandbox.sanitizeHTML(html);
      assert.ok(result.includes('click me'));
      assert.ok(!result.includes('onclick'));
    });

    it('should strip javascript: URLs', () => {
      const html = '<a href="javascript:alert(1)">link</a>';
      const result = sandbox.sanitizeHTML(html);
      assert.ok(!result.includes('javascript:'));
    });

    it('should strip disallowed tags but keep content', () => {
      const html = '<article><button>Click</button></article>';
      const result = sandbox.sanitizeHTML(html);
      assert.ok(result.includes('Click'));
      assert.ok(!result.includes('<button>'));
      assert.ok(!result.includes('</button>'));
    });

    it('should allow data: URLs in img src', () => {
      const html = '<img src="data:image/png;base64,abc123">';
      const result = sandbox.sanitizeHTML(html);
      assert.ok(result.includes('data:image/png'));
    });

    it('should strip iframes', () => {
      const html = '<div>content</div><iframe src="https://evil.com"></iframe>';
      const result = sandbox.sanitizeHTML(html);
      assert.ok(result.includes('content'));
      assert.ok(!result.includes('<iframe'));
    });

    it('should handle empty/edge inputs', () => {
      assert.strictEqual(sandbox.sanitizeHTML(''), '');
      assert.strictEqual(sandbox.sanitizeHTML(null), '');
      assert.strictEqual(sandbox.sanitizeHTML(undefined), '');
    });
  });

  describe('sandboxCSP()', () => {
    it('should return CSP directives', () => {
      const csp = sandbox.sandboxCSP();
      assert.ok(csp.defaultSrc);
      assert.ok(csp.scriptSrc);
      assert.ok(csp.styleSrc);
      assert.ok(csp.imgSrc);
    });

    it('should block scripts by default', () => {
      const csp = sandbox.sandboxCSP();
      assert.deepStrictEqual(csp.scriptSrc, ["'none'"]);
    });

    it('should allow inline styles', () => {
      const csp = sandbox.sandboxCSP();
      assert.deepStrictEqual(csp.styleSrc, ["'unsafe-inline'"]);
    });
  });
});

// ─── Integration: Profile creation + signing + DB round-trip ──────────────

describe('Profile Integration', () => {
  before(() => {
    const database = require('../src/database');
    database.initDatabase();
  });

  it('should create, sign, save, and verify a profile end-to-end', () => {
    const kp = identity.generateKeyPair();

    // 1. Build a profile manifest
    const manifest = {
      version: 1,
      display_name: 'integrated_user',
      bio: 'end-to-end test',
      avatar: '',
      background: '',
      theme: 'mosiac-dark',
      template: 'sandboxed_html',
      content: '<div style="color: hotpink;">Welcome to my profile!</div>',
      widgets: [
        { type: 'music_player', title: 'My Song', src: 'https://example.com/song.mp3' },
        { type: 'about', title: 'About', text: 'I build things.' },
      ],
    };

    // 2. Sign the manifest
    const signed = profiles.signProfileManifest(manifest, kp.privkey, kp.pubkey);
    assert.ok(signed.signature);
    assert.strictEqual(signed.pubkey, kp.pubkey);

    // 3. Verify before saving
    const valid = profiles.verifyProfileManifest(signed);
    assert.strictEqual(valid, true);

    // 4. Save to DB
    const saveResult = profiles.saveProfile(kp.pubkey, signed);
    assert.ok(saveResult.ok, saveResult.error);

    // 5. Retrieve from DB
    const fetched = profiles.getProfile(kp.pubkey);
    assert.ok(fetched);
    assert.strictEqual(fetched.display_name, 'integrated_user');
    assert.strictEqual(fetched.bio, 'end-to-end test');
    assert.strictEqual(fetched.widgets.length, 2);
    assert.strictEqual(fetched.widgets[0].type, 'music_player');

    // 6. Verify data integrity
    assert.strictEqual(fetched.content, manifest.content);
    assert.strictEqual(fetched.pubkey, kp.pubkey);
  });

  it('should validate manifest with all widget types', () => {
    const manifest = {
      version: 1,
      display_name: 'widget_user',
      bio: 'Widgets are fun!',
      widgets: [
        { type: 'music_player', src: 'https://example.com/music.mp3' },
        { type: 'about', text: 'Hello world' },
        { type: 'friends', items: [{ display_name: 'Alice' }, { display_name: 'Bob' }] },
        { type: 'custom_html', html: '<div>Custom!</div>' },
      ],
    };

    const result = profiles.validateManifest(manifest);
    assert.ok(result.valid, JSON.stringify(result.errors));
  });
});
