# Security policy

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability
reporting on this repository (_Security → Report a vulnerability_).

Include what you found, how to reproduce it, and what you think the impact is.
Expect a first reply within a few days — this is a one-person project, not a
staffed product. Please allow a reasonable window to fix before disclosing.

## Supported versions

Only the latest release. There are no backports.

## Scope

In scope, and the things worth your time:

- Anything that lets the server, or someone with access to it, recover
  plaintext: file contents, filenames, the master key, the recovery passphrase.
- Flaws in the blob format (see [`packages/crypto/FORMAT.md`](packages/crypto/FORMAT.md)):
  nonce reuse, chunk reordering or truncation that goes undetected, padding that
  leaks the original size.
- Authentication and session handling: bypassing the second factor, the rate
  limiter, or the account lockout.
- Anything that reaches another user's data. There is one account per instance
  today, but the schema is multi-user and the endpoints are written as if it
  already were.

Known and already documented in the README, so not findings:

- **The server serves the JavaScript that does the encryption.** A malicious
  server, or anything that can rewrite the page in transit (a TLS-terminating
  CDN, for instance), defeats the whole scheme. This is inherent to delivering
  cryptography over the web.
- The server sees metadata: how many files exist, the shape of the tree, sizes
  rounded to 4 KiB, and access times.
- There is no password recovery beyond the Emergency Kit, on purpose.
