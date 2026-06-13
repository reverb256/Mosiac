'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Identity Module ───────────────────────────────────────────────────────

const identity = require('../src/identity');

describe('Identity Module', () => {
  describe('generateKeyPair()', () => {
    it('should generate a valid Ed25519 key pair', () => {
      const kp = identity.generateKeyPair();

      // Pubkey: 32 bytes → 44 chars Base64URL (no padding if cleanly divisible)
      assert.ok(kp.pubkey.length >= 43, `pubkey length: ${kp.pubkey.length}`);
      assert.ok(kp.pubkey.length <= 44);
      assert.match(kp.pubkey, /^[A-Za-z0-9\-_]+$/);

      // Privkey: 64 bytes → 87 or 88 chars Base64URL
      assert.ok(kp.privkey.length >= 86, `privkey length: ${kp.privkey.length}`);
      assert.ok(kp.privkey.length <= 88);

      // Hex: 64 hex chars
      assert.equal(kp.pubkeyHex.length, 64);
      assert.match(kp.pubkeyHex, /^[0-9a-f]+$/);
    });

    it('should generate unique keys each call', () => {
      const a = identity.generateKeyPair();
      const b = identity.generateKeyPair();
      assert.notEqual(a.pubkey, b.pubkey);
      assert.notEqual(a.privkey, b.privkey);
    });
  });

  describe('derivePublicKey()', () => {
    it('should recover the public key from a private key', () => {
      const kp = identity.generateKeyPair();
      const derived = identity.derivePublicKey(kp.privkey);
      assert.equal(derived.pubkey, kp.pubkey);
      assert.equal(derived.pubkeyHex, kp.pubkeyHex);
    });

    it('should throw on invalid private key length', () => {
      assert.throws(() => identity.derivePublicKey('too-short'), /Invalid private key length/);
    });
  });

  describe('sign() and verify()', () => {
    it('should sign and verify a string message', () => {
      const kp = identity.generateKeyPair();
      const msg = 'Hello, Mosiac!';
      const sig = identity.sign(msg, kp.privkey);

      assert.ok(sig.length >= 86); // 64 bytes → ~88 chars Base64URL
      assert.ok(identity.verify(msg, sig, kp.pubkey));
    });

    it('should reject tampered messages', () => {
      const kp = identity.generateKeyPair();
      const sig = identity.sign('original message', kp.privkey);
      assert.strictEqual(identity.verify('tampered message', sig, kp.pubkey), false);
    });

    it('should reject signature from different key', () => {
      const alice = identity.generateKeyPair();
      const bob = identity.generateKeyPair();
      const sig = identity.sign('hello', alice.privkey);
      assert.strictEqual(identity.verify('hello', sig, bob.pubkey), false);
    });

    it('should sign and verify Buffer messages', () => {
      const kp = identity.generateKeyPair();
      const msg = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
      const sig = identity.sign(msg, kp.privkey);
      assert.ok(identity.verify(msg, sig, kp.pubkey));
    });
  });

  describe('signJSON() and verifyJSON()', () => {
    it('should create a verifiable signed envelope', () => {
      const kp = identity.generateKeyPair();
      const payload = { type: 'post', content: 'hello', ts: Date.now() };

      const envelope = identity.signJSON(payload, kp.privkey, kp.pubkey);
      assert.deepStrictEqual(envelope.data, payload);
      assert.equal(envelope.pubkey, kp.pubkey);
      assert.ok(identity.verifyJSON(envelope));
    });

    it('should reject tampered envelope', () => {
      const kp = identity.generateKeyPair();
      const envelope = identity.signJSON({ a: 1 }, kp.privkey, kp.pubkey);
      envelope.data.a = 2;
      assert.strictEqual(identity.verifyJSON(envelope), false);
    });
  });

  describe('fingerprint() and pubkeyURI()', () => {
    it('should generate consistent fingerprints', () => {
      const kp = identity.generateKeyPair();
      const fp1 = identity.fingerprint(kp.pubkey);
      const fp2 = identity.fingerprint(kp.pubkey);
      assert.equal(fp1, fp2);
      assert.equal(fp1.length, 8);
    });

    it('should generate and parse URIs', () => {
      const kp = identity.generateKeyPair();
      const uri = identity.pubkeyURI(kp.pubkey);
      assert.ok(uri.startsWith('mosiac://'));

      const parsed = identity.parsePubkeyURI(uri);
      assert.ok(parsed);
      assert.equal(parsed.pubkey, kp.pubkey);
    });

    it('should return null for invalid URIs', () => {
      assert.strictEqual(identity.parsePubkeyURI('https://example.com'), null);
      assert.strictEqual(identity.parsePubkeyURI('mosiac://'), null); // empty pubkey
    });
  });
});

// ─── Database Module ───────────────────────────────────────────────────────

const database = require('../src/database');

describe('Database Module', () => {
  let dbPath;

  before(() => {
    dbPath = path.join(os.tmpdir(), `mosiac-test-${Date.now()}.db`);
    database.init(dbPath);
  });

  after(() => {
    database.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  describe('Identity CRUD', () => {
    it('should create and retrieve an identity', () => {
      const kp = identity.generateKeyPair();
      const result = database.createIdentity({ pubkey: kp.pubkey, privkey: kp.privkey, label: 'test' });

      assert.ok(result.id);
      assert.equal(result.pubkey, kp.pubkey);

      const fetched = database.getIdentity(result.id);
      assert.ok(fetched);
      assert.equal(fetched.pubkey, kp.pubkey);
      assert.equal(fetched.label, 'test');
    });

    it('should get identity by pubkey', () => {
      const kp = identity.generateKeyPair();
      database.createIdentity({ pubkey: kp.pubkey, privkey: kp.privkey });
      const fetched = database.getIdentityByPubkey(kp.pubkey);
      assert.ok(fetched);
      assert.equal(fetched.pubkey, kp.pubkey);
    });

    it('should list all identities', () => {
      const list = database.listIdentities();
      assert.ok(Array.isArray(list));
      assert.ok(list.length >= 2); // we created at least 2
    });

    it('should have the first created identity as current', () => {
      const current = database.getCurrentIdentity();
      assert.ok(current);
      assert.equal(current.is_current, 1);
    });

    it('should switch current identity', () => {
      const list = database.listIdentities();
      const target = list[list.length - 1];
      database.setCurrentIdentity(target.id);

      const current = database.getCurrentIdentity();
      assert.equal(current.id, target.id);
    });
  });

  describe('Passkey CRUD', () => {
    it('should save and retrieve a passkey', () => {
      const ident = database.getCurrentIdentity();
      const cred = { credentialID: 'test-id', credentialPublicKey: 'test-pk', counter: 0 };

      database.savePasskey({
        id: 'test-passkey-1',
        identityId: ident.id,
        credential: cred,
        transports: ['internal', 'usb'],
        nickname: 'My Key',
      });

      const fetched = database.getPasskey('test-passkey-1');
      assert.ok(fetched);
      assert.equal(fetched.identity_id, ident.id);
      assert.deepStrictEqual(fetched.credential, cred);
      assert.deepStrictEqual(fetched.transports, ['internal', 'usb']);
    });

    it('should list passkeys for an identity', () => {
      const ident = database.getCurrentIdentity();
      const keys = database.listPasskeys(ident.id);
      assert.ok(keys.length >= 1);
    });

    it('should update passkey counter', () => {
      database.updatePasskeyCounter('test-passkey-1', 42);
      const fetched = database.getPasskey('test-passkey-1');
      assert.equal(fetched.counter, 42);
    });

    it('should delete a passkey', () => {
      database.deletePasskey('test-passkey-1');
      assert.strictEqual(database.getPasskey('test-passkey-1'), null);
    });
  });

  describe('Contact CRUD', () => {
    it('should add and retrieve contacts', () => {
      const kp = identity.generateKeyPair();
      database.addContact({ pubkey: kp.pubkey, label: 'Alice', discoveredVia: 'qr' });

      const contact = database.getContact(kp.pubkey);
      assert.ok(contact);
      assert.equal(contact.label, 'Alice');
    });

    it('should upsert contacts (update label)', () => {
      const kp = identity.generateKeyPair();
      database.addContact({ pubkey: kp.pubkey, label: 'Original' });
      database.addContact({ pubkey: kp.pubkey, label: 'Updated' });

      const contact = database.getContact(kp.pubkey);
      assert.equal(contact.label, 'Updated');
    });

    it('should list all contacts', () => {
      const list = database.listContacts();
      assert.ok(Array.isArray(list));
    });

    it('should delete a contact', () => {
      const kp = identity.generateKeyPair();
      database.addContact({ pubkey: kp.pubkey });
      database.deleteContact(kp.pubkey);
      assert.strictEqual(database.getContact(kp.pubkey), null);
    });
  });

  describe('Session CRUD', () => {
    it('should create and retrieve valid sessions', () => {
      const ident = database.getCurrentIdentity();
      database.createSession({
        tokenHash: 'test-token-hash',
        identityId: ident.id,
        pubkey: ident.pubkey,
        ttlSeconds: 3600,
      });

      const session = database.getSession('test-token-hash');
      assert.ok(session);
      assert.equal(session.identity_id, ident.id);
    });

    it('should delete sessions', () => {
      database.deleteSession('test-token-hash');
      assert.strictEqual(database.getSession('test-token-hash'), null);
    });
  });
});

// ─── QR Module ─────────────────────────────────────────────────────────────

const qr = require('../src/qr');

describe('QR Module', () => {
  describe('parseQR()', () => {
    it('should parse a mosiac:// URI', () => {
      const kp = identity.generateKeyPair();
      const uri = identity.pubkeyURI(kp.pubkey);
      const parsed = qr.parseQR(uri);
      assert.ok(parsed);
      assert.equal(parsed.pubkey, kp.pubkey);
    });

    it('should parse a raw Base64URL pubkey', () => {
      const kp = identity.generateKeyPair();
      const parsed = qr.parseQR(kp.pubkey);
      assert.ok(parsed);
      assert.equal(parsed.pubkey, kp.pubkey);
    });

    it('should return null for garbage', () => {
      assert.strictEqual(qr.parseQR('not-a-key'), null);
      assert.strictEqual(qr.parseQR(''), null);
      assert.strictEqual(qr.parseQR(null), null);
    });
  });

  describe('generatePubkeyQR()', () => {
    it('should generate an SVG QR code', async () => {
      const kp = identity.generateKeyPair();
      const svg = await qr.generatePubkeyQR_SVG(kp.pubkey);
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('</svg>'));
    });

    it('should generate a PNG data URL', async () => {
      const kp = identity.generateKeyPair();
      const dataUrl = await qr.generatePubkeyQR_PNG(kp.pubkey);
      assert.ok(dataUrl.startsWith('data:image/png;base64,'));
    });
  });
});

// ─── Server Smoke Test ─────────────────────────────────────────────────────

const http = require('http');

describe('Server', () => {
  let server;
  let app;
  let testDbPath;
  const PORT = 45678;

  before(async () => {
    // Use a unique DB for server tests — clean up any leftover default DB
    const tmpDir = path.join(os.tmpdir(), `mosiac-server-test-${Date.now()}`);
    testDbPath = path.join(tmpDir, 'mosiac.db');
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.MOSIAC_DATA_DIR = tmpDir;
    process.env.MOSIAC_RP_ID = 'localhost';
    process.env.MOSIAC_ORIGIN = `http://localhost:${PORT}`;
    process.env.PORT = String(PORT);

    // Close the DB from prior test to avoid conflicts
    database.close();

    // Start server (it will init its own db)
    app = require('../server');

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  after(() => {
    if (app?.server) app.server.close();
    try { fs.rmSync(path.dirname(testDbPath), { recursive: true, force: true }); } catch { /* ok */ }
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT}${path}`, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }).on('error', reject);
    });
  }

  function post(path, data) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(data);
      const req = http.request(`http://localhost:${PORT}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
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

  it('GET /api/health returns ok', async () => {
    const res = await get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.phase, 1);
  });

  it('GET /api/identity/current returns 404 when no identity', async () => {
    const res = await get('/api/identity/current');
    assert.equal(res.status, 404);
  });

  it('POST /api/identity/generate creates a key pair', async () => {
    const res = await post('/api/identity/generate', { label: 'server-test' });
    assert.equal(res.status, 201);
    assert.ok(res.body.identity.pubkey);
    assert.ok(res.body.identity.pubkeyHex);
    assert.ok(res.body.identity.fingerprint);
    assert.ok(res.body.identity.uri.startsWith('mosiac://'));
  });

  it('GET /api/identity returns list', async () => {
    const res = await get('/api/identity');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.identities));
    assert.ok(res.body.identities.length >= 1);
  });

  it('GET /api/identity/current returns the identity after creation', async () => {
    const res = await get('/api/identity/current');
    assert.equal(res.status, 200);
    assert.ok(res.body.identity.pubkey);
    assert.ok(res.body.identity.uri);
  });

  it('GET /api/qr/:pubkey returns SVG', async () => {
    const idRes = await get('/api/identity/current');
    const pubkey = idRes.body.identity.pubkey;

    const res = await fetch(`http://localhost:${PORT}/api/qr/${encodeURIComponent(pubkey)}`);
    assert.equal(res.status, 200);
    const svg = await res.text();
    assert.ok(svg.startsWith('<svg'));
  });

  it('POST /api/sign requires auth', async () => {
    const res = await post('/api/sign', { data: { hello: 'world' } });
    assert.equal(res.status, 401);
  });

  it('POST /api/qr/scan processes a URI', async () => {
    const kp = identity.generateKeyPair();
    const uri = identity.pubkeyURI(kp.pubkey);
    const res = await post('/api/qr/scan', { data: uri, label: 'QR Test' });
    assert.equal(res.status, 200);
    assert.ok(res.body.success);
    assert.equal(res.body.pubkey, kp.pubkey);
  });

  it('POST /api/qr/scan with raw pubkey', async () => {
    const kp = identity.generateKeyPair();
    const res = await post('/api/qr/scan', { data: kp.pubkey });
    assert.equal(res.status, 200);
    assert.ok(res.body.success);
  });

  it('GET /api/contacts returns contacts', async () => {
    const res = await get('/api/contacts');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.contacts));
  });

  it('POST /api/verify verifies a signature', async () => {
    const kp = identity.generateKeyPair();
    // Build envelope manually
    const envelope = identity.signJSON({ test: true }, kp.privkey, kp.pubkey);
    const res = await post('/api/verify', { envelope });
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);

    // Tampered envelope
    const bad = { ...envelope, data: { test: false } };
    const badRes = await post('/api/verify', { envelope: bad });
    assert.equal(badRes.status, 200);
    assert.equal(badRes.body.verified, false);
  });
});
