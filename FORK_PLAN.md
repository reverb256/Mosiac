# Mosiac Fork Plan

**From Haven (Discord-alike) → Mosiac (Discord + MySpace + Facebook + Matrix)**

Mosiac is a fork of [Haven](https://github.com/ancsemi/Haven) (AGPL-3.0) that adds sovereign identity,
customizable profiles, activity feeds, and P2P federation on top of Haven's realtime chat/voice/screenshare
foundation. No domain required. No KYC. No Big Tech.

---

## Architecture

```
┌─────────────────────────────────────────┐
│  Mosiac (new layers)                     │
│  ├─ Identity (Ed25519 + Passkey + QR)    │
│  ├─ Profiles (sandboxed HTML/CSS/JS)     │
│  ├─ Feeds / Bulletins                    │
│  ├─ Connections / Following              │
│  └─ Signed Event Bus                     │
├─────────────────────────────────────────┤
│  Haven (existing, minimally modified)     │
│  ├─ Chat / Voice / Screenshare           │
│  ├─ Channels / Roles / Permissions        │
│  ├─ E2EE DMs / Music / File Share        │
│  ├─ Auth (bcrypt+JWT, co-exists)         │
│  └─ SQLite / Express / Socket.IO         │
└─────────────────────────────────────────┘
```

**Key design decisions:**
- Haven's auth (bcrypt+JWT) co-exists alongside pubkey auth during migration
- No domain required — discovery via QR, IP, onion addresses
- All new features are additive; Haven code is modified as little as possible
- Client-side plugin system (`plugins/`) extended for profile rendering

---

## Phase 1: Identity Layer (MVP)

Replace/supplement Haven's bcrypt auth with Ed25519 keypair + Passkey + QR.

### Files to add

| File | Purpose |
|------|---------|
| `src/identity.js` | Ed25519 key generation, signing, verification, pubkey fingerprinting |
| `src/keychain.js` | Seed phrase generation (BIP39), key storage/encryption at rest, social recovery scheme |
| `src/qr.js` | QR code encoding/decoding for pubkey+node info exchange |
| `src/passkey.js` | WebAuthn registration and authentication endpoints |
| `public/js/modules/app-identity.js` | Client-side identity UI (keygen wizard, QR scan/display, Passkey prompts) |
| `public/identity.html` or route | Identity management page |

### Files to modify

| File | Change |
|------|--------|
| `src/auth.js` | Add `/api/pubkey/register`, `/api/pubkey/login`, `/api/identity/info` routes alongside existing auth |
| `src/database.js` | Add `identities`, `passkeys`, `connections` tables to schema |
| `server.js` | Mount new routes; initialize identity module at boot |
| `public/sw.js` | Add identity page to precache |
| `package.json` | Add `@noble/ed25519`, `@noble/hashes`, `@simplewebauthn/server`, `qrcode` (already present) |

### Auth flow

1. First boot: keygen wizard generates Ed25519 keypair + BIP39 seed phrase
2. User registers a Passkey (WebAuthn) — the credential is bound to the pubkey
3. On login: Passkey biometric → signs challenge → JWT issued
4. QR code encodes `{pubkey, display_name, node_url, proto_version}`
5. Scanning a QR adds a "connection" (pubkey-based follow)

### QR payload schema

```json
{
  "v": 1,
  "pk": "ed25519:<base64_pubkey>",
  "n": "display_name",
  "u": "http://10.1.1.120:3000",
  "h": "onion_address.onion"  // optional
}
```

---

## Phase 2: Profiles (MySpace Layer)

Customizable per-user profile pages alongside the chat UI.

### Files to add

| File | Purpose |
|------|---------|
| `src/profiles.js` | Profile manifest CRUD, template engine, media reference resolution |
| `src/profiles-sandbox.js` | CSP sandbox configuration for user-supplied HTML/CSS/JS |
| `public/js/modules/app-profile.js` | Client-side profile editor and viewer |
| `public/js/modules/app-profile-widgets.js` | Widget system (music player, about, recent posts, friends) |
| `themes/mosiac-default/` | Default Mosiac profile theme |

### Files to modify

| File | Change |
|------|--------|
| `src/auth.js` | Add profile endpoint, profile manifest is signed by identity key |
| `src/database.js` | Add `profiles` table with manifest JSON blob |
| `server.js` | Mount `/profile/:pubkey` route |
| `public/sw.js` | Profile caching strategy |

### Profile manifest schema

```json
{
  "version": 1,
  "pubkey": "ed25519:<base64>",
  "display_name": "cooluser",
  "bio": "building sovereign social",
  "avatar": "ipfs://Qm...",
  "background": "ipfs://Qm...",
  "theme": "mosiac-dark",
  "template": "html",  // or "sandboxed_html"
  "content": "<div>my custom profile HTML</div>",
  "widgets": [
    {"type": "music_player", "src": "ipfs://Qm..."},
    {"type": "friends", "limit": 10},
    {"type": "recent_posts", "limit": 5}
  ],
  "links": [
    {"label": "website", "url": "http://..."},
    {"label": "nostr", "url": "nostr:..."}
  ],
  "signature": "<ed25519_sig_of_above>"
}
```

---

## Phase 3: Feeds & Posts (Facebook/Matrix Layer)

Broadcast-style content alongside chat channels.

### Files to add

| File | Purpose |
|------|---------|
| `src/feeds.js` | Signed post creation, feed aggregation, bulletins |
| `public/js/modules/app-feeds.js` | Feed UI component (timeline view, composer) |

### Files to modify

| File | Change |
|------|--------|
| `src/socketHandlers/channels.js` | Add "feed" channel type |
| `src/database.js` | Add `posts`, `reactions`, `bulletins` tables |
| `public/js/modules/app-channels.js` | Feed renderer alongside chat renderer |

### Signed event envelope

```json
{
  "type": "post",
  "pubkey": "ed25519:<base64>",
  "payload": {
    "content": "hello world",
    "media": ["ipfs://Qm..."],
    "reply_to": null,
    "channel": null  // or pubkey for DMs
  },
  "timestamp": 1700000000,
  "signature": "<ed25519_sig>"
}
```

---

## Phase 4: Connections & Following

Pubkey-based social graph.

### Files to add

| File | Purpose |
|------|---------|
| `src/connections.js` | Follow/unfollow, blocklists, connection discovery |

### Files to modify

| File | Change |
|------|--------|
| `src/database.js` | Add `follows`, `blocked`, `groups` tables |
| `src/socketHandlers/users.js` | Add follow/unfollow events |

---

## Phase 5: Signed Event Bus (Federation Foundation)

All user actions produce signed events, laying groundwork for P2P gossip.

### Files to add

| File | Purpose |
|------|---------|
| `src/events.js` | Signed event creation, verification, appending to per-user log |
| `src/event-log.js` | Append-only per-pubkey event log, configurable pruning |

### Files to modify

| File | Change |
|------|--------|
| `src/database.js` | Add `event_log` table |
| `server.js` | Wrap all write operations in event signing |

---

## Phase 6: Federation (P2P Gossip)

Gossip protocol between Mosiac nodes.

### Files to add

| File | Purpose |
|------|---------|
| `src/gossip.js` | P2P gossip protocol over WebSocket |
| `src/ipfs.js` | IPFS client for content-addressed media |
| `src/transport-tor.js` | Tor hidden service discovery |
| `src/transport-lan.js` | LAN discovery via mDNS |

### Files to modify

| File | Change |
|------|--------|
| `server.js` | Initialize gossip module on boot |

---

## Dependencies to Add (by phase)

```
Phase 1:
  @noble/ed25519       — fast Ed25519 operations (no native deps)
  @noble/hashes        — SHA-256, HMAC, etc.
  @simplewebauthn/server — WebAuthn server-side
  bip39                — BIP39 mnemonics (optional, for seed phrases)
  caniuse              — already have qrcode

Phase 2:
  (pure CSS/JS — no new npm deps needed)

Phase 3:
  (uses existing EventEmitter pattern)

Phase 4:
  (uses existing database patterns)

Phase 5:
  (uses existing crypto)

Phase 6:
  libp2p               — P2P networking (or lighter alternative)
  kubo-rpc-client      — IPFS HTTP API client
```

---

## Deployment (K3s)

Already running: `ghcr.io/ancsemi/haven:3.1.1` on nexus, `haven` namespace.

Mosiac will ship as:
- `ghcr.io/reverb256/mosiac:<tag>` (or nexus registry mirror)
- Single OCI container, same pattern as Haven
- Persistent volumes: `/data` for keys, db, media
- No domain needed — FORCE_HTTP=true, expose via NodePort or ClusterIP + Tailscale funnel

---

## Git Strategy

- `main` branch tracks upstream `ancsemi/Haven` (git pull to merge upstream fixes)
- `mosiac` branch is our divergence point
- Feature branches off `mosiac`: `mosiac/phase-1-identity`, `mosiac/phase-2-profiles`, etc.
- Upstream changes merged into `main`, then cherry-pick or rebase `mosiac` onto `main`

---

## Deployment Philosophy: Domain-Free by Default

Mosiac must **never require** a domain name. It is designed to work on bare IP addresses, LAN hostnames, Tor onion addresses, or Tailscale IPs — whatever the user has. This is a hard architectural constraint, not a preference.

### The Stack

| Layer | Mechanism | Domain Required? |
|-------|-----------|------------------|
| **Identity** | `mosiac://<pubkey>` URI scheme | Never |
| **Authentication** | WebAuthn RP_ID defaults to IP/hostname | Never — configurable via env |
| **Transport** | Direct TCP, WebRTC, or Tor | Never |
| **Discovery** | QR codes, LAN mDNS, DHT, manual pubkey | Never |
| **Media** | Content-addressed (IPFS CIDs) | Never |

### Convenience Layer (Optional, Post-Deployment)

After deployment, users may optionally add local hostnames:

```bash
# /etc/hosts entry for LAN convenience
echo '<ip> mosiac.lan' >> /etc/hosts

# mDNS broadcast (Avahi)
avahi-publish -a -R mosiac.lan <ip>

# LAN DNS (unbound/dnsmasq)
local-data: "mosiac.lan A <ip>"
```

These are **never referenced in code**. They are post-deployment niceties that the deployment script may offer but the architecture never depends on.

### The Deployment Contract

When someone installs Mosiac (OCI, npm, Nix, K8s), the output says:

```
Your Mosiac node is running at http://<this-ip>:3000
Your pubkey is: ed25519:<base64>
Share this QR code to let others connect.
```

No domain. No DNS. No certificate authority. Just an IP, a port, and a cryptographic identity.

---

## Current Status

- [x] Repo cloned and rebranded to Mosiac (package.json, Dockerfile, paths.js)
- [x] `mosiac` branch created
- [x] Phase 1: Identity layer — Ed25519 keys, Passkeys, QR, signing
- [x] `reverb256/mosiac-identity` — standalone sidecar (multi-platform OCI + Nix + direct)
- [x] sql.js WASM fallback for exotic platforms (Termux, Wii Linux, etc.)
- [ ] Phase 2: Profiles
- [ ] Phase 3: Feeds & posts
- [ ] Phase 4: Connections & following
- [ ] Phase 5: Signed event bus
- [ ] Phase 6: Federation

### Multi-Platform Targets

| Platform | Method | Status |
|----------|--------|--------|
| Linux (x86_64, aarch64) | npm install, OCI, Nix | ✓ |
| macOS (Intel, Apple Silicon) | npm install, OCI | ✓ |
| Docker/Podman (amd64, arm64, arm/v7) | OCI multi-arch | ✓ |
| NixOS | buildNpmPackage | ✓ |
| Termux (Android) | npm start (sql.js fallback) | ✓ documented |
| Raspberry Pi (arm64) | npm install, OCI | ✓ |
| Windows (WSL, Git Bash) | npm install, OCI | ✓ |
| Nintendo Wii Linux | npm start (sql.js, zero native deps) | ✓ in principle |
