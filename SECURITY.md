# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in the Squadmint multisig program,
please report it **privately** to:

**divine@squadmint.com**

Please do **not** open a public issue, pull request, or disclose the issue
publicly until it has been investigated and a fix is available.

When reporting, it helps to include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a failing test, transaction signature, or PoC if possible).
- The affected program ID / version or commit, and the cluster (mainnet/devnet).
- Any suggested remediation.

We aim to acknowledge reports promptly and will keep you updated on progress
toward a fix.

## Scope

In scope: the on-chain Anchor program in this repository
(`programs/squad_mint_multi_sig`) and its release artifacts (the verifiable
`.so` and the published IDL).

The deployed program ID and the verifiable build checksum for the current
mainnet release are recorded in the README's release block.

## Disclosure

We follow coordinated disclosure: report privately, give us reasonable time to
remediate, and we'll credit reporters who wish to be acknowledged once a fix
has shipped.

This policy is mirrored at <https://squadmint.com/.well-known/security.txt>
(RFC 9116).
