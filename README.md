# Locker Secure

**A personal vault for private keys and secrets, encrypted in your browser.**

The server stores bytes it cannot read — not the files, not even their names.

![Node](https://img.shields.io/badge/node-22-informational)
![Status](https://img.shields.io/badge/status-0.4%20%C2%B7%20pre--1.0-orange)

---

## The premise

> Someone with root on the server sees nothing, and has no way to decrypt it.

This is not an app _with encryption bolted on_. It is an app where **the server
has no key, by design**. There is no "decrypt for the user" endpoint, because
there is nothing on the server that could perform it.

```
Browser                                          Server
-------                                          ------
password ──Argon2id(salt, m=64 MiB)──> KEK       (never sees it)
           └─HKDF─> authKey ────────────────────> verifies login
MK (random 32 B) ──AES-KW(KEK)──> wrapped MK ───> stores the wrapped blob
MK ──AES-KW──> DEK, one per file                 (never sees it)
file    ──AES-256-GCM(DEK)──> blob ────────────> stores opaque bytes
name    ──AES-256-GCM(MK)───> blob ────────────> stores opaque bytes
```

Decryption happens in one place only: the tab you have open, while you are
logged in. The master key lives in a JavaScript variable and is gone when you
reload the page — never in `localStorage`, which survives the tab and is
readable by any injected script.

Here is a 196-byte SSH key as it exists on disk:

```
$ xxd blobs/a3/a3f2c1...
00000000: 4c43 4b52 0100 1000 00e4 aaed 47ab fb08  LCKR........G...
00000010: b06a 05d1 afa0 acda 5469 1cd5 dc0b 2125  .j......Ti....!%
...
$ strings blobs/a3/a3f2c1... | grep -i "private\|BEGIN\|rsa"
$
```

4,129 bytes of noise after a 17-byte header. The filename, the PEM markers and
the original size are all absent.

## ⚠️ Status: 0.4, pre-1.0

This is a personal project, built for one person's own keys, and it is **not
finished**:

- **It has never been audited by anyone.** The cryptography is conventional and
  documented ([`packages/crypto/FORMAT.md`](packages/crypto/FORMAT.md)), the core
  is covered by tests, and it was written carefully — none of which is an audit.
- Account creation, two-factor setup, the trash view and settings still lack
  their screens. The logic behind them is implemented and tested.
- Automated off-site backups are not wired up yet.

**Do not put keys in it that you cannot afford to lose**, and keep them wherever
you keep them today until 1.0.

## What it does

- Browse folders and files. **There is no preview** — the only way to see a file
  is to download it. Rendering a key on screen would put it in the DOM, in the
  browser's memory, and within reach of any XSS, to save one click.
- Upload by dragging onto the window, whole folders included. Two progress bars
  per file: **encrypting** (nothing has left your machine yet) and **uploading**.
- Download a single file, a folder, or a selection as a ZIP. The ZIP is built in
  the browser, because the server cannot compress what it cannot decrypt.
- Trash with a 30-day grace period before permanent deletion.
- TOTP two-factor, verified server-side.
- An offline **Emergency Kit**: a printable recovery passphrase that unwraps your
  master key if you forget your password.

## No password reset

There is no "forgot password" link that can work, and this is not an oversight:
a server that could restore your access is a server that can read your files.

If you lose the master password **and** the Emergency Kit, the files are gone.
Backups do not help — they hold the same encrypted bytes.

## What the server can still see

An honest threat model names its gaps. Encrypted contents are not the same as
encrypted _everything_:

| Protected                          | Visible to the server                       |
| ---------------------------------- | ------------------------------------------- |
| File contents                      | How many files and folders you have         |
| File and folder names              | The shape of the tree                       |
| Exact file sizes (padded to 4 KiB) | Approximate size, to the nearest 4 KiB      |
|                                    | When each file was created, changed or read |
|                                    | Your IP address and login times             |

Names are padded to 64 bytes and contents to 4 KiB before encryption, so
`id_rsa` and a 40-character name are indistinguishable, and an Ed25519 key
(~400 B) looks exactly like an RSA-2048 one (~1.7 KB). Without padding, the
size of a private key is close to a fingerprint of its type.

### The limit of any browser-based E2EE

**The server sends you the code that does the encrypting.** A malicious or
compromised server could serve a modified page that leaks your password, and no
amount of client-side cryptography prevents that. This is inherent to web
delivery, not specific to this project.

What follows from it, and is worth knowing before you trust any such app:

- Anything that can rewrite the JavaScript in transit breaks the guarantee. That
  includes a TLS-terminating CDN or proxy in front of the site — so run it
  without one, or accept that the operator of that proxy is inside your trust
  boundary.
- Self-hosting is the point. Running your own instance means the party who could
  serve you bad code is you.

## Running it

```bash
cp .env.example .env
# Fill in SALT_PEPPER and TOTP_KEY — the server refuses to start without them
# in production. Generate each with: openssl rand -base64 32
docker compose up -d
```

The container listens on `127.0.0.1:4322` and expects a reverse proxy in front
of it terminating TLS. Data lives in two volumes: the SQLite database and the
blob store.

Once it is up, the first visit creates the single account and hands you the
Emergency Kit. **There is no registration after that** — this is a vault for one
person, though the schema has a users table because the idea might grow.

## Development

```bash
npm install
npm run dev     # API on :3000, web on :5173 (proxy /api → :3000)
npm test
npm run build
npm run lint
```

Requires **Node 22+**.

```
locker-for-you/
├── packages/
│   ├── crypto/    # @locker/crypto — all the cryptography, no I/O
│   └── shared/    # types and API contracts
├── apps/
│   ├── api/       # Fastify 5 + SQLite (WAL)
│   └── web/       # React 19 + Vite
└── docker/
```

`packages/crypto` is **shared between client and server** deliberately: the
cryptographic logic is written and tested once, so the two sides cannot drift
apart on the format. The server uses it for key derivation on login; it never
touches a file's contents.

**The crypto tests gate everything.** A bug in that package is not a visible
error — it is silent, irreversible data loss.

> **Note on language:** the code, comments and commit messages are in Spanish.
> The comments explain _why_ each decision was made, which is the interesting
> part, so a translation would be more than cosmetic. If that is a barrier for
> you, open an issue and say so.

_Este README también está [en español](README.es.md)._

## The design

The interface was designed before it was built, and the rule that orders it is
typographic: monospace is
_data_ (filenames, sizes, dates, the recovery passphrase), the serif is _the app
speaking_, and the sans is _interface_. A filename here is an exact identifier,
not a label — hence the monospace.

It states its two oddities in the positive, rather than apologising for them:
_"no preview: a file is only visible once you download it"_ and _"sizes are
multiples of 4 KB — the padding hides each key's real size"_.

## Security

Found a problem? Please **do not open a public issue**. Use GitHub's private
vulnerability reporting (_Security → Report a vulnerability_) and allow a
reasonable window before disclosing.

Cryptographic choices, and why:

| Decision                         | Reason                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Argon2id, 64 MiB / t=3 / p=1     | Memory-hard; the parameters cost ~100 ms in a browser                                  |
| HKDF splits into `authKey` + KEK | What the server learns says nothing about the key that decrypts                        |
| MK is random, wrapped by the KEK | A password change rewraps one key instead of re-encrypting every file                  |
| AES-KW for wrapping              | Built-in integrity: a wrong key fails loudly instead of returning garbage              |
| AES-256-GCM in 1 MiB chunks      | AAD binds header, index and last-chunk flag, so reordering and truncation are detected |
| Padding before encryption        | Applied to plaintext; padding ciphertext would leave the original size showing         |

## License

Not yet chosen — until one is added, default copyright applies. See
[the status section](#️-status-04-pre-10).
