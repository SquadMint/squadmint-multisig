# Mainnet Deployment Runbook

This is the real, current (2026) workflow for shipping `squad_mint_multi_sig` to
mainnet-beta. It favours correctness and recoverability over speed. Commands that
don't exist in the real CLI (and that some online guides invent) are called out at
the bottom.

- **Program ID:** `BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz`
- **Binary:** `target/deploy/squad_mint_multi_sig.so`
- **Toolchain:** Anchor `0.31.1`, Solana CLI `≥ 2.0`, Rust stable `≥ 1.75`

---

## 0. Pre-flight (do not skip)

- [ ] `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` clean
- [ ] Radar / Sec3 X-Ray static analysis reviewed (see CI)
- [ ] `anchor test` passes locally; integration tests updated for the latest account changes
- [ ] Trident fuzz campaign run at least once (see `trident-tests/`)
- [ ] Devnet deploy exercised end-to-end with a real wallet
- [ ] Deployer wallet funded — budget ~2× the program rent (a buffer is allocated during deploy/upgrade)
- [ ] Production RPC endpoint ready (Helius / Triton / QuickNode) — public RPC will rate-limit and fail mid-deploy
- [ ] Upgrade authority destination decided (Squads multisig — see §5)

Check the rent you'll need:

```sh
solana rent $(stat -f%z target/deploy/squad_mint_multi_sig.so)
```

---

## 1. Build for production (pinned mint, deterministic)

The mint is compiled in. For mainnet you MUST pin real USDC, and the `mainnet` feature
makes that mandatory (the build fails if the env var is missing):

```sh
anchor run build-prod
# = SQUADMINT_USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v anchor build -- --features mainnet
```

### Verifiable build (recommended for anything holding value)

A normal `anchor build` is **not** byte-for-byte reproducible, so you cannot prove the
on-chain bytecode matches your source by diffing a dump. Use a verifiable build instead
(Docker, pinned deps), maintained by Ellipsis Labs / OtterSec:

```sh
# Install once
cargo install solana-verify

# Reproducible build (output in target/verifiable/)
anchor build --verifiable
# or: solana-verify build
```

After deploy you (or anyone) can verify against your public repo:

```sh
solana-verify verify-from-repo \
  --program-id BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz \
  https://github.com/<you>/squadmint-multisig
```

Docs: <https://solana.com/docs/programs/verified-builds>, <https://www.anchor-lang.com/docs/references/verifiable-builds>

---

## 2. Sync program ID

Make sure `declare_id!` and `Anchor.toml` agree with the deployed keypair:

```sh
anchor keys list      # shows the program ID derived from target/deploy/<program>-keypair.json
anchor keys sync      # writes it into declare_id! and Anchor.toml
```

> The program keypair (`target/deploy/squad_mint_multi_sig-keypair.json`) **defines the
> program ID**. Keep it secret and backed up — losing it means you can never upgrade;
> leaking it is dangerous. Never commit it.

---

## 3. Point the CLI at mainnet

```sh
solana config set --url mainnet-beta
solana config set --keypair <deployer-keypair>   # default signer ONLY (not the upgrade authority)
solana balance
```

---

## 4. Deploy

Use priority fees and resilient settings — mainnet deploys routinely fail on default
settings during congestion:

```sh
anchor deploy --provider.cluster mainnet -- \
  --with-compute-unit-price 50000 \
  --max-sign-attempts 100 \
  --use-rpc
```

(Everything after `--` is forwarded to `solana program deploy`. Tune the compute-unit
price from a live source such as the Helius priority-fee API; 50000 µlamports is just a
starting point.)

### If the deploy fails partway (buffer recovery)

Large-program deploys upload to a temporary **buffer account** first. A failed/interrupted
deploy can leave that buffer allocated and holding your rent. Recover it:

```sh
# List buffers you own and reclaim their rent
solana program show --buffers
solana program close --buffers

# Or resume the deploy into the existing buffer instead of starting over
solana program deploy target/deploy/squad_mint_multi_sig.so \
  --program-id target/deploy/squad_mint_multi_sig-keypair.json \
  --buffer <BUFFER_ADDRESS>
```

---

## 5. Hand upgrade authority to a multisig

A single-key (EOA) upgrade authority is the single largest production risk: one leaked
key lets an attacker redeploy your program and drain funds. The ecosystem standard is
**Squads v4** (time locks, spending limits, roles).

```sh
# Transfer upgrade authority to the Squads multisig "vault" PDA
solana program set-upgrade-authority BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz \
  --new-upgrade-authority <SQUADS_VAULT_PUBKEY>

# Confirm
solana program show BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz | grep "Authority"
```

Future upgrades are then proposed/approved inside Squads. Docs:
<https://squads.so/blog/solana-multisig-program-upgrades-management>, <https://github.com/Squads-Protocol/v4>

### Making it immutable instead (irreversible)

Only if the program should never change again:

```sh
solana program set-upgrade-authority <PROGRAM_ID> --final
```

Once final, it can never be upgraded — confirm there are no known issues first.

---

## 6. Post-deploy verification

```sh
# Authority + slot
solana program show BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz

# Explorers
open "https://explorer.solana.com/address/BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz"
open "https://solana.fm/address/BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz"
```

- [ ] Upgrade authority is the Squads vault (or `--final`), not your deployer EOA
- [ ] Verifiable build registered (`solana-verify verify-from-repo`)
- [ ] Frontend/clients updated with the program ID
- [ ] Git tagged: `git tag v1.0.0 && git push --tags`
- [ ] Monitor logs for the first 24h

---

## Upgrading later

```sh
anchor run build-prod          # rebuild with the pinned mint + mainnet feature
anchor keys sync               # ensure ID unchanged
# Propose the upgrade through Squads (the multisig is the upgrade authority).
```

If migrating account layouts, ship an explicit migration instruction and run it as a
separate transaction batch before relying on the new layout — do not assume Anchor
reinterprets old accounts.

---

## Things online guides get wrong (ignore these)

These commands/claims appear in some 2025 blog posts and are **not real**:

- `solana transaction apply-signature` — not a command.
- `solana migrate-account` — not a command; account migration is your own instruction.
- "Ledger Live CI signing endpoint" / a REST API that signs deploy txns — does not exist; use Squads for delegated signing.
- `anchor deploy --program-name <x>` — not a real flag; Anchor deploys per `Anchor.toml`.
- "Atomic zero-downtime swap in 0.38s via dual buffers" — upgrades replace the program; there is no dual-buffer atomic-swap feature.
- Diffing `solana program dump` against a non-verifiable local `.so` to "prove" they match — non-verifiable builds aren't deterministic, so this won't match. Use verifiable builds.
- Fixed deploy-cost numbers — rent is a function of `.so` size; compute it with `solana rent`.
