# Squad Mint MultiSig

A Solana / Anchor program implementing the multisig voting process that controls
SquadMint's funds. Members pool USDC into a program-owned vault and move funds only
by passing an on-chain vote.

- **Program ID:** `BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz`
- **Asset:** USDC (mint is pinned at compile time — see [Builds](#builds))

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

## Toolchain

| Tool   | Version            |
|--------|--------------------|
| Anchor | `0.31.1`           |
| Solana CLI | `2.x` (≥ 2.0)  |
| Rust   | stable (≥ 1.75)    |

> The toolchain is the source of truth in `Anchor.toml` (`anchor_version = "0.31.1"`)
> and `programs/squad_mint_multi_sig/Cargo.toml` (`anchor-lang = "0.31.1"`). Keep this
> table in sync with those files.

## Builds

The USDC mint is read at **compile time** from `SQUADMINT_USDC_MINT` and enforced at
`initialize`. Use the cluster-specific scripts so the correct mint is pinned:

```sh
anchor run build-devnet   # pins the devnet test mint
anchor run build-prod     # pins mainnet USDC + requires the mint (--features mainnet)
```

A plain `anchor build` (no env var) falls back to a **committed test mint** and is for
local/CI only — never deploy a plain build to mainnet. The `mainnet` cargo feature makes
the mint mandatory: `anchor run build-prod` fails to compile if `SQUADMINT_USDC_MINT` is unset.

## Local development

```sh
# Run a local validator (separate terminal)
solana-test-validator

# Build + run the test suite against an already-running validator
anchor test --skip-local-validator

# Or let Anchor spin up its own validator
anchor test
```

## Deployment

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full mainnet runbook (verifiable builds,
Squads multisig upgrade authority, priority fees, buffer recovery, and the pre-flight
checklist). Quick devnet deploy:

```sh
solana config set --url devnet
anchor build
anchor deploy
```

> Note: `solana config set --keypair <path>` only sets your CLI's **default signer** — it
> does **not** set the program's upgrade authority. Use `solana program set-upgrade-authority`
> for that (covered in DEPLOYMENT.md).

### Program rent

```sh
solana rent $(stat -f%z target/deploy/squad_mint_multi_sig.so)
```

Rent scales with the `.so` size; recompute after code changes rather than trusting a fixed number.

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
- **Not yet audited.** A formal third-party audit (e.g. Zellic, Hacken) is recommended before
  holding real value on mainnet.

## Credits

Design inspired by [coral-xyz/multisig](https://github.com/coral-xyz/multisig).
Reference for test/deploy/layout patterns: [solana-program/subscriptions](https://github.com/solana-program/subscriptions).
