#!/usr/bin/env bash
#
# Program-id consistency guard.
#
# A regenerated `target/deploy/<prog>-keypair.json` silently makes
# `anchor deploy` ship to a BRAND-NEW address (this is how a devnet "upgrade"
# once landed at JC38P1y… instead of upgrading BW1dtKf…). This check fails the
# build the moment the id drifts, so the deploy can pin a single source of truth.
#
# Asserts that the on-chain program id is identical in all three places:
#   - declare_id!(...) in the program source
#   - every [programs.*] entry in Anchor.toml
#   - (when present) the local target/deploy keypair used by `anchor deploy`
#
# Exit non-zero on any mismatch. Safe to run in CI (no secrets, no network).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/programs/squad_mint_multi_sig/src/lib.rs"
TOML="$ROOT/Anchor.toml"
DEPLOY_KEYPAIR="$ROOT/target/deploy/squad_mint_multi_sig-keypair.json"

# The ONE program id this repo is allowed to build/deploy. Asserting against a
# hard-pinned value (not just internal consistency) means even editing both
# declare_id! AND Anchor.toml together fails here — flipping the program id has
# to be a deliberate change to this constant. Override only when you genuinely
# mean to (e.g. a new cluster) via: EXPECTED_PROGRAM_ID=… anchor run id-check
EXPECTED_PROGRAM_ID="${EXPECTED_PROGRAM_ID:-BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz}"

declared="$(grep -oE 'declare_id!\("[^"]+"\)' "$LIB" | sed -E 's/.*"([^"]+)".*/\1/')"
if [[ -z "$declared" ]]; then
  echo "::error::could not find declare_id!() in $LIB"; exit 1
fi

echo "Expected (pinned)        = $EXPECTED_PROGRAM_ID"

# All program ids declared in Anchor.toml ([programs.localnet], [programs.devnet], …).
mapfile -t toml_ids < <(grep -E '^[[:space:]]*squad_mint_multi_sig[[:space:]]*=' "$TOML" \
  | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/')

echo "declare_id!()            = $declared"
printf 'Anchor.toml [programs]  = %s\n' "${toml_ids[*]}"

status=0

# Hard lock: declare_id! must equal the pinned program id.
if [[ "$declared" != "$EXPECTED_PROGRAM_ID" ]]; then
  echo "::error::declare_id! ($declared) != pinned EXPECTED_PROGRAM_ID ($EXPECTED_PROGRAM_ID)."
  echo "::error::If this id change is intentional, update EXPECTED_PROGRAM_ID in scripts/check-program-id.sh."
  status=1
fi

for id in "${toml_ids[@]}"; do
  if [[ "$id" != "$EXPECTED_PROGRAM_ID" ]]; then
    echo "::error::Anchor.toml program id '$id' != pinned program id '$EXPECTED_PROGRAM_ID'"
    status=1
  fi
done

# Optional: if the local deploy keypair exists, it MUST match too — this is the
# exact file `anchor deploy` uses to pick the target address.
if [[ -f "$DEPLOY_KEYPAIR" ]] && command -v solana-keygen >/dev/null 2>&1; then
  kp_pub="$(solana-keygen pubkey "$DEPLOY_KEYPAIR")"
  echo "target/deploy keypair    = $kp_pub"
  if [[ "$kp_pub" != "$declared" ]]; then
    echo "::error::target/deploy/squad_mint_multi_sig-keypair.json ($kp_pub) != declare_id! ($declared)."
    echo "::error::\`anchor deploy\` would ship to $kp_pub, NOT $declared. Restore the real program keypair."
    status=1
  fi
fi

if [[ "$status" -eq 0 ]]; then
  echo "✅ program id is pinned consistently ($declared)"
else
  echo "❌ program id mismatch — refusing. See errors above."
fi
exit "$status"
