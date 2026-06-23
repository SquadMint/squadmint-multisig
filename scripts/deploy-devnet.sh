#!/usr/bin/env bash
#
# Strict devnet deploy/upgrade.
#
# Replaces bare `anchor deploy` (which deploys to whatever pubkey happens to be
# in target/deploy/<prog>-keypair.json — that's how a devnet upgrade once landed
# at a brand-new address JC38P1y… instead of upgrading BW1dtKf…).
#
# What this does differently:
#   1. Hard-pins the program id (PROGRAM_ID) and asserts declare_id! + Anchor.toml agree.
#   2. Refuses to run unless the configured wallet IS the on-chain upgrade authority.
#   3. Writes the new bytes to a BUFFER and runs `solana program show` on it
#      (smoke test: buffer exists, authority correct, data length >= the .so)
#      BEFORE touching the live program.
#   4. Upgrades FROM that buffer with --program-id pinned (cannot drift).
#   5. Post-upgrade smoke test: re-reads the program and asserts the deploy slot advanced.
#
# Usage:
#   SOLANA_URL="https://devnet.helius-rpc.com/?api-key=…" \
#   DEPLOY_WALLET="$HOME/keypair-dev-1.json" \
#   bash scripts/deploy-devnet.sh
set -euo pipefail

# ---- Pinned constants (single source of truth) ----------------------------
PROGRAM_ID="BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz"
DEVNET_USDC_MINT="GHCrkDPkTDigsEXMctzEsWc48nWPufcgaqqK4vexQX1f"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SO="$ROOT/target/deploy/squad_mint_multi_sig.so"
WALLET="${DEPLOY_WALLET:-$HOME/keypair-dev-1.json}"
URL="${SOLANA_URL:-https://api.devnet.solana.com}"
# Hide any ?api-key=… in logs.
SAFE_URL="${URL%%\?*}"

show() { solana program show "$1" --url "$URL"; }
field() { awk -v k="$1" -F: '$0 ~ k {gsub(/^[ \t]+/,"",$2); print $2; exit}'; }

echo "▶ Strict devnet deploy"
echo "  program id : $PROGRAM_ID  (pinned)"
echo "  wallet     : $WALLET"
echo "  rpc        : $SAFE_URL"

# ---- 0. id-consistency guard ----------------------------------------------
bash "$ROOT/scripts/check-program-id.sh"

# ---- 1. build with the devnet mint pinned ---------------------------------
echo "▶ Building (SQUADMINT_USDC_MINT=$DEVNET_USDC_MINT)…"
SQUADMINT_USDC_MINT="$DEVNET_USDC_MINT" anchor build
[[ -f "$SO" ]] || { echo "::error::built artifact missing: $SO"; exit 1; }
SO_LEN="$(wc -c < "$SO" | tr -d ' ')"

# ---- 2. pre-flight: program exists, is upgradeable, wallet IS the authority -
echo "▶ Pre-flight…"
WALLET_PUB="$(solana-keygen pubkey "$WALLET")"
PROG_INFO="$(show "$PROGRAM_ID")" || { echo "::error::program $PROGRAM_ID not found on $SAFE_URL"; exit 1; }
ONCHAIN_AUTH="$(printf '%s\n' "$PROG_INFO" | field 'Authority')"
BEFORE_SLOT="$(printf '%s\n' "$PROG_INFO" | field 'Last Deployed In Slot')"
echo "  on-chain authority : $ONCHAIN_AUTH"
echo "  wallet pubkey      : $WALLET_PUB"
echo "  slot before        : $BEFORE_SLOT"
if [[ "$ONCHAIN_AUTH" != "$WALLET_PUB" ]]; then
  echo "::error::wallet ($WALLET_PUB) is NOT the upgrade authority ($ONCHAIN_AUTH) — refusing."
  exit 1
fi

# ---- 3. write a buffer + SMOKE TEST it before touching the live program ----
BUFFER_KP="$(mktemp -t sqm-buffer-XXXXXX.json)"
cleanup() { rm -f "$BUFFER_KP"; }
trap cleanup EXIT
solana-keygen new --no-bip39-passphrase --silent --force -o "$BUFFER_KP" >/dev/null
BUFFER="$(solana-keygen pubkey "$BUFFER_KP")"

echo "▶ Writing buffer $BUFFER…"
solana program write-buffer "$SO" \
  --buffer "$BUFFER_KP" --url "$URL" --fee-payer "$WALLET" --keypair "$WALLET"

echo "▶ SMOKE TEST — solana program show $BUFFER"
BUF_INFO="$(show "$BUFFER")" || { echo "::error::buffer $BUFFER not found after write"; exit 1; }
printf '%s\n' "$BUF_INFO"
BUF_AUTH="$(printf '%s\n' "$BUF_INFO" | field 'Authority')"
BUF_LEN="$(printf '%s\n' "$BUF_INFO" | awk '/Data Length:/{print $3; exit}')"
if [[ "$BUF_AUTH" != "$WALLET_PUB" ]]; then
  echo "::error::buffer authority $BUF_AUTH != wallet $WALLET_PUB — aborting before upgrade."; exit 1
fi
if [[ -z "$BUF_LEN" || "$BUF_LEN" -lt "$SO_LEN" ]]; then
  echo "::error::buffer data length ($BUF_LEN) < .so size ($SO_LEN) — incomplete upload, aborting."; exit 1
fi
echo "  buffer ok (authority $BUF_AUTH, len $BUF_LEN ≥ .so $SO_LEN)"

# ---- 4. upgrade the PINNED program from the verified buffer ----------------
echo "▶ Upgrading $PROGRAM_ID from buffer $BUFFER (program id pinned)…"
solana program deploy "$SO" \
  --program-id "$PROGRAM_ID" \
  --buffer "$BUFFER_KP" \
  --upgrade-authority "$WALLET" \
  --fee-payer "$WALLET" \
  --keypair "$WALLET" \
  --url "$URL"

# ---- 5. post-upgrade smoke test: slot MUST advance ------------------------
AFTER_SLOT="$(show "$PROGRAM_ID" | field 'Last Deployed In Slot')"
echo "▶ slot after: $AFTER_SLOT (before $BEFORE_SLOT)"
if [[ "$AFTER_SLOT" == "$BEFORE_SLOT" ]]; then
  echo "::error::deploy slot did not advance — the upgrade did NOT take. Investigate."; exit 1
fi
echo "✅ Upgraded $PROGRAM_ID in place: slot $BEFORE_SLOT → $AFTER_SLOT"
