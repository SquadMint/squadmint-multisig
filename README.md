# Squad Mint MultiSig

The multi sig app that controls SquadMints apps voting process

# Devs
- Anchor:  `anchor-0.32.1` 
- Cargo:   `cargo 1.90.0 (840b83a10 2025-07-30)`
- Rust:    `rustc 1.90.0 (1159e78c4 2025-09-14)`
## Commands

set authority
```sh
 solana config set --keypair ~/keypair-dev-1.json
```

Deploy
devnet
```sh
 anchor deploy
 
```
localnet 
```sh
anchor deploy --provider.cluster localnet
```

Run Local Validator

```sh
solana-test-validator
```

## Test using solana-test-validator 

```sh
anchor test  --skip-local-validator
```

## Get Program Rent

```sh
solana rent $(stat -f%z target/deploy/squad_mint_multi_sig.so)
```
// Rent-exempt minimum: 3.11727488 SOL
### Credits

Design inspired by https://github.com/coral-xyz/multisig

### Audits

https://softment.com/code-audit
https://hacken6551.activehosted.com/f/25?utm_source=hackenclub&utm_medium=post&utm_campaign=sc-checklist
https://www.zellic.io/

Checkout Kani:: https://model-checking.github.io/kani/getting-started.html


```sh 
Minor: Asymmetric Threshold
The "no" threshold is >= 50% while "yes" is >= 51%. With 2 members, a 1-1 split means the proposal is rejected (50% no triggers close, but 50% yes does not reach 51%). This might be intentional, but worth verifying.
```

### add Sonarscan and add a rust linter could this be Kani

## we need to add test to see if they can withdraw more than whats in the group

###

init_if_needed on proposed_to_ata
rust#[account(
init_if_needed,
payer = fee_payer,
associated_token::mint = mint,
associated_token::authority = proposed_to_owner,
)]
pub proposed_to_ata: InterfaceAccount<'info, TokenAccount>,
This appears in both CreateProposal and SubmitAndExecute. The risk here is that proposed_to_owner is an UncheckedAccount validated only against transaction.message_data.proposed_to_account. A carefully crafted account substitution during SubmitAndExecute could potentially redirect the ATA initialization — though this is harder to exploit with Anchor's constraints.


### Example program, look at how they tests and deployment and read me as well

https://github.com/solana-program/subscriptions