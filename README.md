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
