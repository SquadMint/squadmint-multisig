import * as anchor from "@coral-xyz/anchor";
import {Program, Wallet} from "@coral-xyz/anchor";
import { SquadMintMultiSig } from "../target/types/squad_mint_multi_sig";

const { utf8 } = anchor.utils.bytes
/// Creates wallet and adds this blockchain.
const createWallet = async (connection: anchor.web3.Connection, funds: number): Promise<anchor.web3.Keypair> => {
    const wallet = anchor.web3.Keypair.generate();
    const tx = await connection.requestAirdrop(wallet.publicKey, anchor.web3.LAMPORTS_PER_SOL * funds);
    console.log(tx)
    console.log("TX Logged tx:" + tx)
    // wait for confirmation
    const latestBlockHash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: tx
    });

    const balance = await connection.getBalance(wallet.publicKey);
    if (balance < funds) {
        throw new Error('Balance amount exceeds ' + "target network airdrop limit");
    }
    return wallet
}

const findPDAForAuthority = async (programId: anchor.web3.PublicKey, authority: anchor.web3.PublicKey, walletHandle: string) : Promise<anchor.web3.PublicKey> => {
    const [pda, _canonicalBump] = await anchor.web3.PublicKey.findProgramAddressSync([utf8.encode(walletHandle), authority.toBytes()], programId);
    return pda;
}

const initializeAccount = async (program: Program<SquadMintMultiSig>, owner: anchor.web3.Keypair, squadMintFeePayer: anchor.web3.Keypair, walletHandle: string): Promise<anchor.web3.PublicKey> => {
    // const accountKeypair = anchor.web3.Keypair.generate();
    const pda = await findPDAForAuthority(program.programId, owner.publicKey, walletHandle);
    console.log(owner.publicKey.toBase58())

    console.log("Authority")
    await program.methods.initialize("", true)
        .accounts({
            multisig: pda,
            multisigOwner: owner.publicKey,
            feePayer: squadMintFeePayer.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([owner, squadMintFeePayer])
        .rpc()

    return pda;
}

const getAllAccountsByAuthority = async (
    accounts: anchor.AccountClient<SquadMintMultiSig>,
    authority: anchor.web3.PublicKey) => {
    return await accounts.all([{memcmp: { offset: 8, bytes: authority.toBase58() }}
    ]);
}

// const fetchAccount = async (program: Program<HelloWorld>, authority: anchor.web3.PublicKey) => {
//     return await program.account.myAccount.fetch(await findPDAForAuthority(program.programId, authority))
// }

export {createWallet, initializeAccount, getAllAccountsByAuthority, findPDAForAuthority};