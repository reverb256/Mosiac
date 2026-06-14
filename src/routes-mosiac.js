'use strict';

/**
 * Mosiac Routes — non-auth endpoints that don't fit in auth.js.
 * Auth endpoints (WebAuthn, identity CRUD) now live in src/auth.js
 * under /api/auth/passkey/* and /api/auth/identity/*.
 */
const express = require('express');
const router = express.Router();

const identity = require('./identity');
const qr = require('./qr');
const { getDb } = require('./database');

/* ─── Health ─── */
router.get('/health', (req, res) => res.json({ ok: true, mosiac: '0.1.0' }));

/* ─── Identity query (read-only — CRUD is in auth.js under /api/auth/identity/*) ─── */
router.get('/identity/current', (req, res) => {
  try {
    const row = getDb().prepare('SELECT * FROM identities WHERE is_current = 1').get();
    if (!row) return res.json({ identity: null });
    res.json({ identity: { id: row.id, pubkey: row.pubkey, label: row.label, pubkeyHex: identity.toHex(identity.fromBase64URL(row.pubkey)) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─── QR ─── */
router.get('/qr/:pubkey', async (req, res) => {
  try {
    const svg = await qr.generatePubkeyQR_SVG(req.params.pubkey);
    res.type('image/svg+xml').send(svg);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/qr/scan', (req, res) => {
  try {
    const result = qr.processQRScan(req.body.scanned, req.body.label);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ─── Contacts ─── */
router.get('/contacts', (req, res) => {
  try {
    const rows = getDb().prepare('SELECT * FROM contacts ORDER BY first_seen_at DESC').all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/contacts/:pubkey', (req, res) => {
  try {
    getDb().prepare('DELETE FROM contacts WHERE pubkey = ?').run(req.params.pubkey);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─── Signing (event bus foundation) ─── */
router.post('/sign', (req, res) => {
  try {
    const { pubkey, data } = req.body;
    const row = getDb().prepare('SELECT * FROM identities WHERE pubkey = ?').get(pubkey);
    if (!row) return res.status(404).json({ error: 'Identity not found' });
    const signed = identity.signJSON(data, row.privkey, row.pubkey);
    res.json(signed);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/verify', (req, res) => {
  try {
    const valid = identity.verifyJSON(req.body);
    res.json({ valid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
