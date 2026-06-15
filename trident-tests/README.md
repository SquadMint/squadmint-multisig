# Fuzzing with Trident

[Trident](https://github.com/Ackee-Blockchain/trident) (Ackee Blockchain, Solana
Foundation–backed) is a stateful, coverage-guided fuzzer for Anchor programs. It runs
your instructions with random/guided inputs and checks invariants after each step — the
right tool to answer this repo's open question: **can anyone move more USDC out of the
vault than was deposited?**

> Trident generates a version-matched harness from your program's IDL via `trident init`,
> so the concrete bindings (instruction builders, account structs) are produced for you.
> This folder documents the setup and the invariants to assert; run `trident init` to
> generate the actual `fuzz_0` target, then paste the invariant logic below into it.

## Setup

```sh
# Install (honggfuzz backend needs build tools: binutils, libunwind on Linux)
cargo install trident-cli

# From the repo root, after a successful `anchor build`
trident init

# Run the generated target
trident fuzz run fuzz_0

# Reproduce a crash from the artifacts Trident writes on failure
trident fuzz run-debug fuzz_0 <CRASH_FILE_PATH>
```

Trident writes config to `Trident.toml`; tune iterations/timeout there or via the
`HFUZZ_RUN_ARGS` env (honggfuzz). Docs: <https://ackee.xyz/trident/docs/latest/>

## Invariants to assert

These are the properties that matter for this program. Implement them in the generated
target's `check` / invariant hook (compare account state before vs. after each executed
instruction).

### 1. Solvency — the vault never pays out more than it holds (the README question)

Track the cumulative USDC that has *entered* the vault (member join deposits accepted via
`add_member`) vs. what has *left* (executed proposal payouts). At all times:

```text
sum(deposits_into_vault) - sum(executed_payouts) == multisig_ata.amount   (no shortfall)
multisig_ata.amount      >= 0                                             (never negative)
```

Equivalently: any single `submit_and_execute` that transfers `amount` must have had
`multisig_ata.amount >= amount` immediately before the transfer (the program enforces
`InsufficientFunds`, so a fuzz failure here means that check was bypassed).

### 2. Authorization — only members move funds

```text
A payout executes  ⇒  the deciding voters were all in multisig.members
A vote is recorded ⇒  the submitter ∈ multisig.members and had not already voted
```

### 3. Threshold integrity

```text
A YES payout executes  ⇒  yes_votes * 100 >= 51 * members.len()
master_nonce is monotonically non-decreasing and only increments on resolution
did_meet_threshold, once a proposal is decided, is never re-opened (no replay)
```

### 4. Conservation across join/reject

```text
reject_member refunds exactly join_amount to the joiner (no more, no less)
add_member moves exactly join_amount into the vault
```

## Example invariant hook (adapt to the generated bindings)

Pseudocode to drop into the Trident invariant check — names follow the generated
snapshot API (`pre`/`post` account states):

```rust
fn check(&self, pre: &FuzzAccounts, post: &FuzzAccounts) -> Result<(), FuzzingError> {
    // 1. Solvency: vault balance must equal tracked deposits minus tracked payouts.
    let expected = self.total_deposited.saturating_sub(self.total_paid_out);
    if post.multisig_ata.amount != expected {
        return Err(FuzzingError::with_message(
            "vault balance diverged from deposits - payouts (insolvency / leak)",
        ));
    }

    // 3. Nonce never goes backwards.
    if post.multisig.master_nonce < pre.multisig.master_nonce {
        return Err(FuzzingError::with_message("master_nonce decreased"));
    }

    Ok(())
}
```

Update `total_deposited` / `total_paid_out` in the per-instruction post-hook for
`add_member` (+join_amount) and `submit_and_execute` (+amount only when a YES executes).

## CI

Fuzzing is long-running, so run it on a schedule rather than every push, e.g. a nightly
GitHub Actions job:

```yaml
on:
  schedule:
    - cron: "0 3 * * *"   # nightly
jobs:
  fuzz:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: sudo apt-get update && sudo apt-get install -y binutils-dev libunwind-dev
      - run: cargo install trident-cli
      - run: anchor build
      - run: trident fuzz run fuzz_0
        env:
          HFUZZ_RUN_ARGS: "--run_time 1800"   # 30 min campaign
```
