# Security Audit — Squad Mint MultiSig

**Program:** `squad_mint_multi_sig` (`BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz`)
**Framework:** Anchor 0.31.1 · Solana · `anchor-spl` token-interface
**Scope:** `programs/squad_mint_multi_sig/src/lib.rs` (680 lines, current working tree incl. uncommitted changes), CI, build config.
**Date:** 2026-06-07
**Method:** Manual line-by-line review of all 6 instructions, account contexts, PDA seeds, vote math, and fund-flow CPIs. Cross-checked against the existing `tests/hacker_tests.ts` red-team suite.

> This is an internal review, not a substitute for a professional third-party audit (Zellic / Hacken / etc.) before holding real value on mainnet.

---

## Summary of findings

| # | Severity | Finding |
|---|----------|---------|
| H-1 | High | Owner can manipulate or freeze a live vote by changing membership mid-vote (no `has_active_vote` guard on `add_member`/`reject_member`) |
| H-2 | High | No proposal cancellation / timeout → treasury permanently frozen if quorum is never reached |
| H-3 | High | Owner is sole gatekeeper of membership → sybil majority / griefing of join deposits |
| M-1 | Medium | Default build pins a **test** USDC mint; a plain `anchor build` deploy makes the mint check meaningless |
| M-2 | Medium | Joiner cannot self-reclaim an escrowed join deposit; funds held at owner's discretion |
| M-3 | Medium | Asymmetric threshold (yes ≥ 51%, no ≥ 50%) produces counterintuitive outcomes in even-sized groups |
| L-1 | Low | Rent reclaim on close goes to the *caller's* `fee_payer`, not the original payer |
| L-2 | Low | `create_proposal` pays to `init_if_needed` the recipient ATA before any approval (rent griefing) |
| L-3 | Low | Zero-amount / dust proposals can be created and occupy the single active-vote slot |
| I-1 | Info | `TokenInterface` permits Token-2022; transfer-hook reentrancy is only mitigated by the USDC mint pin |
| I-2 | Info | Defensive `belongs_to_squad_mint_fund` field is set but never asserted (relies on PDA seeds) |

What the code already gets right is noted in [Positive observations](#positive-observations).

---

## High severity

### H-1 — Membership can change while a vote is active (vote manipulation / freeze)

`add_member` and `reject_member` (the `UpdateFund` context) do **not** check `multisig.has_active_vote`. Threshold in `submit_and_execute` is computed against `multisig.members.len()` *at execution time*:

```rust
let total_members = multisig.members.len() as u64;
let yes_meets = yes_votes * 100 >= threshold * total_members; // 51%
let no_meets  = no_votes  * 100 >= 50 * total_members;
```

Because the denominator is read live and the owner can add members at any moment, the owner can change the outcome of an in-flight proposal:

- A proposal sitting at a passing majority (e.g. 2 yes of 3 → `200 >= 153`) can be neutralized by the owner adding sybil members (now 5 members → `200 >= 255` fails). The newly added members can then vote *no* to force rejection.
- Conversely, removing the ability to participate (members can never be removed, but the denominator shift alone) lets the owner veto a decision a real majority already reached.

**Impact:** The owner unilaterally overrides majority governance — the core security property of a multisig. Combined with H-3 this is a direct integrity break.

**Fix:** Reject `add_member`/`reject_member` while `has_active_vote == true` (`require!(!multisig.has_active_vote, ...)`), and/or snapshot the member count and eligible-voter set into the `Transaction` account at `create_proposal` time and compute the threshold against that snapshot rather than the live list.

### H-2 — No cancellation or timeout: treasury can be frozen forever

`has_active_vote` is set `true` in `create_proposal` and only ever cleared inside `submit_and_execute` *when a threshold is reached*. There is no instruction to cancel or expire a proposal. If members simply stop voting and neither `yes_meets` nor `no_meets` becomes true, the proposal never resolves:

- `master_nonce` is never incremented, the `Transaction` PDA is never closed.
- `create_proposal` is blocked by `require!(!multisig.has_active_vote, CanOnlyInitOneVoteAtATime)`.

The result is a permanent denial of service on the treasury: no new proposals can ever be created, so pooled USDC can never be moved again. This is reachable through ordinary member non-participation (no attacker needed) and is also a griefing lever for any single member who creates a dust proposal and then everyone abstains.

**Fix:** Add a `cancel_proposal` instruction (gated to the proposer and/or owner, or to any member after the active vote has stood unresolved) that closes the `Transaction`, increments the nonce, and clears `has_active_vote`. Consider a slot/timestamp deadline stored on the `Transaction` so anyone can expire a stale vote.

### H-3 — Owner-controlled membership enables sybil majority and deposit griefing

Only the owner can approve (`add_member`) or refund (`reject_member`) a join request; both are gated solely by `multisig_owner == multisig.owner`. The existing test "a non-owner member cannot add a colluder" confirms non-owners are blocked, but **the owner itself is unconstrained**:

- **Sybil majority:** The owner can spin up arbitrary wallets, have each call `initiate_join_request` (depositing `join_amount` into the pool), then `add_member` them all. Each deposit lands in the shared vault, so the owner funds the pool temporarily — but with a controlled majority they can then pass a proposal paying the *entire* vault (including honest members' contributions) to a wallet they own, netting a profit at honest members' expense.
- **Deposit griefing:** A legitimate joiner's `join_amount` sits in the `join_custodial_account_ata` after `initiate_join_request`. Only the owner can release it (add) or refund it (reject). A malicious or absent owner can strand the deposit indefinitely (see also M-2).

**Impact:** The "multi-sig" trust model collapses to "trust the owner." For a fund holding others' money this is the most consequential design risk.

**Fix:** Require member admission to be a *vote* of existing members rather than an owner-only action; cap or rate-limit additions; and give joiners a unilateral refund path (M-2). At minimum, document loudly that the owner is fully trusted.

---

## Medium severity

### M-1 — Default build pins a test mint

```rust
pub const USDC_MINT: Pubkey = Pubkey::from_str_const(
    match option_env!("SQUADMINT_USDC_MINT") {
        Some(value) => value,
        None => "37KQMrbBtkNFYJvDKW3tGxEs1WuvqcEeu44JGrjPkYsz", // test mint
    },
);
```

A plain `anchor build` (which is exactly what CI runs) compiles with the hard-coded test mint. The `mint == USDC_MINT` check in `initialize` then enforces a worthless test token, and every downstream `token::mint = mint` constraint follows from it. If a default build is ever promoted to mainnet, the program is not operating on real USDC and the mint guard provides no protection. Mainnet USDC is `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (set via `build-prod`).

**Fix:** Fail the build when the env var is unset for non-test profiles (e.g. `compile_error!` behind a `mainnet` feature), or make the prod mint the default and require an override for tests. Add a CI job that asserts the deployed `.so` embeds the expected mint.

### M-2 — Joiner cannot reclaim an escrowed join deposit

After `initiate_join_request`, the deposit lives in a PDA-owned custodial ATA whose authority is `join_custodial_account`. The only instructions that move it (`add_member`, `reject_member`) are owner-gated. The joiner has no self-service exit. If the owner never acts, the deposit is locked.

**Fix:** Add a joiner-signed `withdraw_join_request` that closes the custodial account/ATA and refunds the joiner, ideally after a timeout. The custodial PDA seeds already include the joiner key, so authorization is straightforward.

### M-3 — Asymmetric yes/no threshold

```rust
let yes_meets = yes_votes * 100 >= 51 * total_members;
let no_meets  = no_votes  * 100 >= 50 * total_members;
```

The "no" bar (50%) is lower than the "yes" bar (51%) and uses a hard-coded `50` rather than a named constant. In a 2-member fund a 1–1 split rejects (no reaches 50%, yes never reaches 51% without both). In even-sized groups this lets a tie or even a plurality block spending. This is flagged in the README as "possibly intentional" — it should be made an explicit, documented policy and the `50` replaced with a named constant for auditability.

**Fix:** Decide the intended quorum rule deliberately, encode both thresholds as named constants, and add tests asserting the exact pass/reject boundary for group sizes 1–8.

---

## Low / informational

- **L-1 — Rent reclaim recipient.** `transaction.close(fee_payer)` and the `CloseAccount`/`close = fee_payer` paths send reclaimed rent to whichever `fee_payer` signs the *closing* call, not the account's original funder. A member who didn't pay can harvest the rent by being the one to submit the deciding vote. Economic only; consider routing rent back to the original payer.
- **L-2 — Premature recipient ATA creation.** `create_proposal` runs `init_if_needed` on `proposed_to_ata` (paid by `fee_payer`) even though no transfer happens until execution. A proposer can make the fund's fee_payer pay rent to materialize ATAs for arbitrary recipients on proposals that may never pass. Defer ATA creation to `submit_and_execute` (where it already exists).
- **L-3 — Dust / zero-amount proposals.** `create_proposal` permits `amount = 0` (the `multisig_ata.amount >= amount` check is trivially satisfied). Combined with H-2, a single member can occupy the lone active-vote slot with a meaningless proposal. Enforce a minimum amount and/or rely on the H-2 cancellation fix.
- **I-1 — Token-2022 / transfer hooks.** The program uses `TokenInterface`, which would accept Token-2022 mints with transfer hooks (a reentrancy surface). This is currently neutralized only because the mint is pinned to USDC (legacy SPL Token, no hooks). If the mint constant ever changes to a Token-2022 asset, re-review the CPI ordering. State changes are committed before the transfer CPI in `submit_and_execute` (good), but `add_member` pushes the member before the close CPI — fine for USDC, worth noting otherwise.
- **I-2 — Unused integrity field.** `Transaction.belongs_to_squad_mint_fund` is written but never asserted against `multisig.key()`. Binding is currently provided by PDA seeds (`[b"proposal_tx_data", multisig.key(), nonce]`), so this is safe, but an explicit `require_keys_eq!` would be cheap defense-in-depth.

---

## Positive observations

The program gets several important things right, and the existing `hacker_tests.ts` already covers the obvious attacks:

- **Vault authority** is the multisig PDA; treasury can only move via `transfer_checked` signed with the program's seeds. Non-members cannot propose or vote (signer + `members.contains` checks on both `create_proposal` and `submit_and_execute`).
- **Destination integrity:** payout recipient is validated both as the owner (`proposed_to_owner == message_data.proposed_to_account`) and as the canonical ATA (`get_associated_token_address`), closing the "redirect to attacker ATA" vector the README worried about. Tests confirm this.
- **Replay protection:** the `Transaction` PDA is keyed by `master_nonce`, the nonce is `checked_add`-incremented and the account is closed on resolution, so a decided proposal cannot be replayed.
- **Vault binding:** `multisig_ata` is a seed-derived `[b"token_vault", multisig.key()]` PDA with `token::mint`/`token::authority` constraints, blocking the "swap in a foreign vault" attack (tested).
- **Vote hygiene:** double-voting is blocked (`CannotVoteTwice` / `executors.contains`), and threshold math uses small integers with no overflow risk.

---

## Recommended next steps (priority order)

1. **H-1 / H-2:** add `require!(!has_active_vote)` to membership changes **and** ship a `cancel_proposal`/timeout. These two together restore the multisig's core guarantees and remove the treasury-freeze.
2. **H-3 / M-2:** move member admission to a member vote and give joiners a self-refund path, or explicitly document the owner as a fully trusted party.
3. **M-1:** make the production mint impossible to omit at build time; assert it in CI.
4. Encode the quorum rule deliberately (M-3) and add boundary tests for group sizes 1–8, plus a test for the "stop voting → fund frozen" scenario and the "owner adds members mid-vote" scenario — neither is currently covered.
5. Engage one of the listed third-party auditors before mainnet value.

---

## Addendum — second review (2026-06-09)

New findings from a follow-up pass, with resolution status:

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| N-1 | Medium | `add_member`/`reject_member` required the joiner's personal USDC ATA to exist; a closed ATA stranded the escrow (no accept *or* reject possible) | **Fixed** — `UpdateFund` split into `AddMember` (no joiner ATA) and `RejectMember` (joiner ATA `init_if_needed`) |
| N-2 | Medium | `initiate_join_request` ignored the 8-member cap, escrowing deposits into funds that could never accept them | **Fixed** — cap enforced at request time (`MaxMembersReached`) |
| N-3 | Low | Members added mid-vote can vote on the in-flight proposal | **Accepted risk** — owner-discretion by design; no snapshot |
| N-4 | Info | Misleading error codes (`DuplicateMember`/`InvalidDestinationOwner` reused for unrelated checks) | **Fixed** — `ProposingJoinerMismatch`, `JoinRequestUserMismatch`, `JoinRequestFundMismatch`, `JoinAmountMismatch` |
| N-5 | Info | Dead double-vote re-check in `submit_and_execute`; unused `multisig_ata` in `CreateJoinRequestProposal` | **Fixed** — dead check removed; `multisig_ata` dropped and replaced with an explicit `mint == USDC_MINT` constraint (the old account was silently load-bearing as the only mint pin in that instruction) |

Policy decisions recorded: **M-2 is by design** — join escrows are released only by owner accept/reject; no joiner self-refund will be added. N-3 likewise accepted (membership is the owner's call even during a live vote).
