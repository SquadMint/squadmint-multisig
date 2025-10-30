# Squad Mint MultiSig

The multi sig app that controls SquadMints apps voting process

# Devs

## Commands

set authority
```sh
 solana config set --keypair ~/keypair-dev-1.json
```

Deploy
```sh
 anchor deploy
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

### Credits

Design inspired by https://github.com/coral-xyz/multisig
