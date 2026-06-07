import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createTestMint } from "./helper_function";

export interface SharedCtx {
    feePayer: anchor.web3.Keypair;
    testMint: { mintPubkey: PublicKey; tokenAccountPubkey: PublicKey };
}

let _ctx: SharedCtx | undefined;

// Request SOL in small chunks so this works on devnet (per-request airdrop
// caps) as well as localnet. Tolerant: stops early if an airdrop is refused.
const fundedPayer = async (
    connection: anchor.web3.Connection,
    targetSol = 20,
): Promise<anchor.web3.Keypair> => {
    const kp = anchor.web3.Keypair.generate();
    let total = 0;
    for (let i = 0; i < 12 && total < targetSol; i++) {
        try {
            const sig = await connection.requestAirdrop(
                kp.publicKey,
                anchor.web3.LAMPORTS_PER_SOL * 2,
            );
            const bh = await connection.getLatestBlockhash();
            await connection.confirmTransaction({
                signature: sig,
                blockhash: bh.blockhash,
                lastValidBlockHeight: bh.lastValidBlockHeight,
            });
            total += 2;
        } catch (_e) {
            break;
        }
    }
    if (total === 0) {
        throw new Error("Could not airdrop any SOL to the shared fee payer");
    }
    return kp;
};

/**
 * Both test files (squad_mint_multi_sig.ts + hacker_tests.ts) run in a single
 * mocha process against one ledger, and the program pins a SINGLE mint address
 * (USDC_MINT). That mint can therefore only be created once, by one authority.
 *
 * This memoizes one fee payer (which doubles as the mint authority) plus the
 * pinned mint so whichever file's `before()` runs first creates them and the
 * other reuses the exact same instances. Order-independent.
 */
export async function getSharedCtx(
    connection: anchor.web3.Connection,
): Promise<SharedCtx> {
    if (_ctx) return _ctx;
    const feePayer = await fundedPayer(connection);
    const testMint = await createTestMint(connection, feePayer);
    _ctx = { feePayer, testMint };
    return _ctx;
}
