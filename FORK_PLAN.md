# Mosiac Fork Plan

**From Haven (Discord-alike) → Mosiac (Discord + MySpace + Facebook + Matrix)**

Mosiac is a fork of [Haven](https://github.com/ancsemi/Haven) (AGPL-3.0) that adds sovereign identity,
customizable profiles, activity feeds, and P2P federation on top of Haven's realtime chat/voice/screenshare
foundation. No domain required. No KYC. No Big Tech.

---

## Architecture

```
┌─────────────────────────────────────────┐
│  Mosiac Core (always runs)              │
│  ├─ Identity (Ed25519 + Passkey + QR)   │
│  ├─ Profiles (optional external)        │
│  ├─ Feeds / Bulletins (optional)        │
│  ├─ Connections (optional)              │
│  └─ Signed Event Bus (optional)         │
├─────────────────────────────────────────┤
│  Mosiac Plugins (modular, swappable)    │
│  ├─ Chat/Discord (Haven, external)      │ ← can skip or delegate
│  ├─ Voice/Video (Haven WebRTC)          │
│  ├─ Music (Haven music system)          │
│  └─ Federation (P2P gossip)            │
└─────────────────────────────────────────┘
```

**Key design decisions:**
- Haven's auth (bcrypt+JWT) co-exists alongside pubkey auth during migration
- No domain required — discovery via QR, IP, onion addresses
- All new features are additive; Haven code is modified as little as possible
- Client-side plugin system (`plugins/`) extended for profile rendering
- **Every feature is a module: optional, skippable, delegatable**

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

## Compatibility Guarantee: Total Haven Backward Compatibility

Mosiac is an **additive layer** over Haven. Haven must continue working exactly as it did before Mosiac existed — no behavioral changes, no config migration, no database migration, no frontend changes.

### The Rules

| Rule | Example |
|------|---------|
| **Zero modifications to existing Haven routes** | New Mosiac routes are mounted separately (`/mosiac/*`) or appended to route files (`/api/auth/passkey/*`) |
| **Zero modifications to existing Haven database schema** | Mosiac tables use `CREATE TABLE IF NOT EXISTS` and are added after Haven's existing tables |
| **Zero modifications to existing Haven frontend** | Mosiac UI is in separate files (`identity.html`, `app-identity.js`, `mosiac-identity.css`) |
| **Zero new required dependencies for Haven users** | New npm packages (`tweetnacl`, `@simplewebauthn/server`) are only required if Mosiac features are used |
| **Zero config changes for existing Haven installs** | Mosiac reads its config from env vars that default to non-domain localhost values |
| **Zero migration for existing Haven databases** | Identity tables are new — they don't touch users, channels, messages, etc. |

### The One Database Rule

Haven's database contains user chat data. Mosiac's database contains identity keys, passkeys, and contacts. **They coexist in the same SQLite file** but are completely independent. A query against Haven's tables never touches Mosiac's tables and vice versa.

```sql
-- Haven tables (untouched):
CREATE TABLE users (...);
CREATE TABLE channels (...);
CREATE TABLE messages (...);

-- Mosiac tables (added alongside, never modified):
CREATE TABLE identities (...);
CREATE TABLE passkeys (...);
CREATE TABLE contacts (...);
CREATE TABLE sessions (...);
```

### What This Means

- `git pull` upstream Haven changes merge cleanly — Mosiac additions don't conflict
- A fresh install of upstream Haven works identically with or without Mosiac code
- Users who only want chat see no difference
- Users who discover `/identity.html` get the Mosiac layer

---

## Modularity Principle: Every Feature Is Optional, Skippable, Delegatable

Every Mosiac feature is a **module**. You can run it, skip it, self-host it, or delegate it to someone else's server. The system degrades gracefully when a module is absent.

### The Module Contract

Each module:
1. Has a **standalone entry point** (e.g. `node server.js` for identity)
2. Has **zero runtime dependencies** on other Mosiac modules
3. Can **point to an external service** instead of running its own
4. When unavailable, the **frontend hides or degrades** the feature

### Concrete Examples

| Module | Run It | Skip It | Delegate It |
|--------|--------|---------|-------------|
| **Identity** | `docker run reverb256/mosiac-identity` | — (core) | Not delegatable |
| **Chat** | Run Haven locally | Remove chat tab from UI | Point to `https://friend.haven.lan` |
| **Profiles** | `node src/profiles.js` | Profile tab hidden | Use external profile service |
| **Feeds** | `node src/feeds.js` | Feed tab hidden | Use external feed service |
| **Music** | Run Haven's music bot | Music widget hidden | Use external streaming |
| **Federation** | `node src/gossip.js` | No P2P (REST only) | Relay through public gateway |

### Implementation Pattern

```javascript
// In the frontend, each module checks if its backend is available:
const features = {
  chat:     await checkEndpoint('/api/auth/me'),
  identity: await checkEndpoint('/mosiac/identity'),
  feeds:    await checkEndpoint('/mosiac/feed/posts'),
  music:    await checkEndpoint('/api/music/status'),
};

// Features not available are hidden from the UI
if (!features.chat)  document.getElementById('chat-tab').style.display = 'none';
if (!features.feeds) document.getElementById('feed-tab').style.display = 'none';
```

### What This Enables

- **Chat-only users**: Run just Haven. No Mosiac code needed.
- **Identity-only users**: Run `mosiac-identity` container. No chat server. Use Mosiac for profiles/feeds/auth, link to a friend's Haven for chat.
- **Experienced users**: Self-host everything. Maximum sovereignty.
- **Resource-constrained users**: Delegate chat/music/federation to trusted peers. Run only identity locally.

---

## Composability Principle: Mix and Match Features from Any Servers

Modularity means each feature *can* run independently. Composability means they *do* — a user's Mosiac node pulls features from multiple backends simultaneously, and the system treats this as the normal case, not an edge case.

### The Composability Model

```
User's Mosiac Frontend
│
├─ Identity  ← self-hosted on Raspberry Pi (mosiac-identity)
├─ Chat      ← friend's Haven server (haven.lan)
├─ Profiles  ← self-hosted alongside identity
├─ Feeds     ← community hub (feeds.mosiac.lan)
├─ Music     ← different friend's Haven (music.haven.lan)
└─ Media     ← IPFS (distributed, no server)
```

Each feature resolves to a different backend. The frontend discovers which backend serves which feature through a **capabilities endpoint**.

### The Capabilities Endpoint

Every Mosiac module exposes:

```http
GET /capabilities
→ {
  "features": ["identity", "profiles", "feeds", "chat", "music"],
  "identity": { "pubkey": "ed25519:...", "auth_methods": ["passkey", "jwt"] },
  "chat": { "type": "haven", "version": "3.24.0" },
  "feeds": { "max_post_length": 5000, "supports_sockets": true }
}
```

The frontend discovers available features at boot:

```javascript
const backends = {
  identity: 'http://my-pi:3002',
  chat:     'https://friend.haven.lan',
  feeds:    'http://community-hub:3003',
  music:    'https://music.haven.lan',
};

async function discover() {
  const available = {};
  for (const [feature, url] of Object.entries(backends)) {
    try {
      const res = await fetch(`${url}/capabilities`);
      if (res.ok) available[feature] = await res.json();
    } catch { /* service unavailable, degrade gracefully */ }
  }
  return available;
}
```

### Auth Across Backends

Since identity is self-hosted but chat may be on a friend's server, auth tokens must be portable:

1. User authenticates to **their own identity server** (Passkey → JWT)
2. JWT is presented to **external services** (chat, feeds, music)
3. External services validate the JWT signature using the user's pubkey
4. No shared database needed — trust is cryptographic

```
User → Identity Server (Passkey login)
  → JWT signed with user's Ed25519 keypair
  → JWT presented to Friend's Haven Server
  → Friend's server verifies signature against pubkey (stored or fetched)
  → Access granted (guest role or mapped to local user)
```

### What Composability Enables That Modularity Alone Doesn't

| Scenario | Modularity | + Composability |
|----------|-----------|----------------|
| I want chat but not to host it | Skip chat module | Point chat to friend's server |
| I want to try different profile hosts | Skip profiles module | Swap profile backend URL |
| I want to aggregate feeds from multiple communities | Run feeds module | Pull from multiple feed servers |
| My friend runs better music infrastructure | Skip music module | Point music to friend's server |
| I want to migrate my social graph to a new server | — | Change backend URLs, keep identity key |

### Implementation Rule

**No Mosiac module may assume it is the only backend.** Every API call must be made against a configurable base URL, not a hardcoded path. The frontend must never assume all features share an origin.

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
