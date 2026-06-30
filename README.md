# Squadmint MultiSig

A Solana / Anchor program implementing the multisig voting process that controls
SquadMint's funds. Members pool USDC into a program-owned vault and move funds only
by passing an on-chain vote.

- **Program ID:** `BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz`
- **Network:** Solana mainnet-beta (live)
- **Asset:** USDC (mint pinned at compile time — see [Builds](#builds))
- **Governance:** 2-of-3 [Squads v4](https://squads.so) multisig (see [Governance](#governance))

## Latest mainnet release

<!-- RELEASE-INFO:START -->
- **Version:** v1.0.3
- **Program ID:** BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz
- **Verifiable .so SHA-256:** `998e5188347bcf738ea98fda4a009c917566e9a8fb906117cec7a77a406d1830`
- **Upgrade buffer:** 6DidfeyyADAiBsM9eEBuCSd7fRVTRUqLJhLDDqxC1dXr
- **Prepared:** 2026-06-30
<!-- RELEASE-INFO:END -->

> This block is maintained automatically by the release workflow — see [Releases](#releases).

## How it works

- **`initialize`** — creates a fund (`SquadMintFund` PDA) and its USDC vault; the creator becomes the owner and first member.
- **`initiate_join_request`** — a prospective member escrows the `join_amount` into a per-request custodial account.
- **`add_member` / `reject_member`** — the owner accepts (deposit moves into the vault) or rejects (deposit refunded) a join request.
- **`create_proposal`** — a member proposes a USDC payout to a destination; auto-counts as one "yes".
- **`submit_and_execute`** — members vote; once the threshold is met the payout executes (or the proposal is rejected) and the proposal account is closed.

### Voting thresholds (intentionally asymmetric)

Spending requires a **51% "yes" supermajority** (`SQUAD_MINT_YES_THRESHOLD_PERCENTAGE`),
while a **50% "no"** can reject (`SQUAD_MINT_NO_THRESHOLD_PERCENTAGE`). This is deliberate:
withdrawing funds should be harder than blocking a withdrawal. Consequence: in a 2-member
fund a 1–1 split rejects the proposal. Both values are named constants in
`programs/squad_mint_multi_sig/src/lib.rs`.

## Governance

The program's **upgrade authority is a 2-of-3 Squads v4 multisig**, so no single key can
ship new bytecode — an upgrade requires two of three members to approve and execute. One
member key is held offline (air-gapped) and signs only through a restricted, temporary
egress path.

| Role                            | Address                                          |
|---------------------------------|--------------------------------------------------|
| Upgrade authority (Squad Vault) | `ANNvGaawEDSatXvzMnz1Tr6HrKHaFebo8UrPprAvxAvL`   |
| Threshold                       | 2 of 3                                           |
| Buffer refund                   | `213ho2JipFkUEvio4CeLehku3cVBs2eqAW18mv7TTSXY`   |

Upgrades are never applied directly. They flow through a buffer + multisig proposal: build
verifiably → `solana program write-buffer` → set the buffer's authority to the vault →
create the upgrade proposal in Squads → members vote → execute. See [Releases](#releases)
for the automated path and [DEPLOYMENT.md](./DEPLOYMENT.md) for the manual runbook.

## Toolchain

| Tool        | Version  | Pinned in                        |
|-------------|----------|----------------------------------|
| Anchor      | `0.31.1` | `Anchor.toml`                    |
| Solana CLI  | `2.1.21` | `Anchor.toml` (`solana_version`) |
| Rust (host) | `1.86.0` | `rust-toolchain.toml`            |

`Cargo.lock` is committed and is the source of truth for transitive dependency versions —
notably `indexmap` / `hashbrown`, which are pinned **below** the MSRV bumps that the Solana
2.1 SBF toolchain (rustc 1.79) cannot compile. Do not regenerate it casually; a stray
`cargo update` will re-break the SBF build and CI.

## Builds

The USDC mint is read at **compile time** from `SQUADMINT_USDC_MINT` and enforced at
`initialize`. Use the cluster-specific scripts so the correct mint is pinned:

```sh
anchor run build-devnet           # pins the devnet test mint
anchor run build-prod             # pins mainnet USDC + requires the mint (--features mainnet)
anchor run build-prod-verifiable  # reproducible mainnet build (Docker) -> target/verifiable/
```

A plain `anchor build` (no env var) falls back to a **committed test mint** and is for
local/CI only — never deploy a plain build to mainnet. The `mainnet` cargo feature makes
the mint mandatory: the prod builds fail to compile if `SQUADMINT_USDC_MINT` is unset.

The **verifiable** build compiles inside the pinned `anchor:0.31.1` Docker image, producing
a byte-reproducible `.so` (verifiable on-chain via `solana-verify`). That artifact —
`target/verifiable/squad_mint_multi_sig.so` — is what gets deployed to mainnet.

## Local development

```sh
# Run a local validator (separate terminal)
solana-test-validator

# Build + run the test suite against an already-running validator
anchor test --skip-local-validator

# Or let Anchor spin up its own fresh validator each run
anchor test
```

> The suite creates a fixed-keypair test mint, so it is **not** idempotent against a
> persistent validator — use a fresh `anchor test` (or `solana-test-validator --reset`),
> not `--skip-local-validator` against a long-lived ledger.

## Releases

Mainnet releases are automated by
[`.github/workflows/release-request.yml`](./.github/workflows/release-request.yml),
triggered when a maintainer **publishes a GitHub Release** tagged `vX.Y.Z` (release
creation requires repo write access, so the trigger is maintainer-gated):

1. **Tests** run as a gate — nothing proceeds if they fail.
2. The **verifiable prod `.so`** is built and attached (with its SHA-256) to the release.
3. An **upgrade buffer** is written on mainnet and its authority assigned to the Squad Vault.
4. The release block above is updated and a **PR to `main`** is opened whose body carries
   every field needed to create the Squads upgrade proposal — name, buffer address, buffer
   refund, commit link, and authority address.

A maintainer creates the upgrade proposal in the Squads app from the PR body; the multisig
members then vote and execute. **The pipeline never executes an upgrade itself.**

## Deployment

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full mainnet runbook (verifiable builds,
Squads upgrade authority, priority fees, buffer recovery, and the pre-flight checklist).
Quick devnet deploy:

```sh
solana config set --url devnet
anchor run build-devnet
anchor deploy
```

> **Mainnet is governed by the multisig.** A direct `anchor deploy` / upgrade no longer
> works against mainnet — that requires your wallet to *be* the upgrade authority, which is
> now the Squad Vault. Mainnet upgrades go through the buffer + Squads proposal flow above.
> Also note: `solana config set --keypair <path>` only sets your CLI's **default signer**,
> not the program's upgrade authority — use `solana program set-upgrade-authority` for that.

### Program rent

```sh
solana rent $(stat -f%z target/verifiable/squad_mint_multi_sig.so)
```

Rent scales with the `.so` size; recompute after code changes rather than trusting a fixed
number. The program-data rent is a refundable deposit, reclaimed if the program is closed.

## Security

- A standalone review lives in [SECURITY_AUDIT.md](./SECURITY_AUDIT.md).
- Static analysis and fuzzing run in CI — see [.github/workflows/ci.yml](./.github/workflows/ci.yml)
  (clippy + rustfmt + [Radar](https://github.com/Auditware/radar)) and
  [trident-tests/README.md](./trident-tests/README.md) for the [Trident](https://github.com/Ackee-Blockchain/trident) fuzz setup.
- **Linters vs. verification:** `cargo clippy` is the Rust linter; Radar / Sec3 X-Ray are
  Solana-specific security scanners; [Kani](https://model-checking.github.io/kani/) is a
  *model checker* (formal verification of invariants), not a linter. They are complementary.
- The `init_if_needed` destination ATA is constrained: `proposed_to_owner` is checked against
  the stored `proposed_to_account` and the ATA against `get_associated_token_address`, so the
  destination cannot be substituted.
- **Upgrade authority** is held by a 2-of-3 multisig with one air-gapped member; no single
  key can upgrade the program.
- **Not yet audited.** A formal third-party audit (e.g. Zellic, Hacken) is recommended before
  holding real value on mainnet.

## Credits

Design inspired by [coral-xyz/multisig](https://github.com/coral-xyz/multisig).
Reference for test/deploy/layout patterns: [solana-program/subscriptions](https://github.com/solana-program/subscriptions).
