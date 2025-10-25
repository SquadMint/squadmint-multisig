import * as anchor from "@coral-xyz/anchor";
import {BN, Program, Wallet} from "@coral-xyz/anchor";
import { SquadMintMultiSig } from "../target/types/squad_mint_multi_sig";
import {expect} from "chai";

const { utf8 } = anchor.utils.bytes
/// Creates wallet and adds this blockchain.
const createWallet = async (connection: anchor.web3.Connection, funds: number): Promise<anchor.web3.Keypair> => {
    const wallet = anchor.web3.Keypair.generate();
    const tx = await connection.requestAirdrop(wallet.publicKey, anchor.web3.LAMPORTS_PER_SOL * funds);
    console.log("✅ Airdrop"+ " wallet: " + wallet.publicKey.toBase58() + " TX:" + tx)
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

    console.log("EXIT CREATE AND FUND ACCOUNT 🔥")
    return wallet
}

const findPDAForAuthority = async (programId: anchor.web3.PublicKey,
                                   authority: anchor.web3.PublicKey,
                                   walletHandle: string) : Promise<anchor.web3.PublicKey> => {
    const [pda, _canonicalBump] = await anchor.web3.PublicKey.findProgramAddressSync([utf8.encode(walletHandle), authority.toBytes()], programId);
    return pda;
}

const findPDAForMultisigTransaction = async (
    programId: anchor.web3.PublicKey,
    multisigAuthority: anchor.web3.PublicKey,
    multisigWalletHandle: string,
    multisigCurrentMasterNonce: BN
): Promise<anchor.web3.PublicKey> => {
    const masterNonceBuffer = multisigCurrentMasterNonce.toArrayLike(Buffer, 'le', 8);
    const [pda, _canonicalBump] = anchor.web3.PublicKey.findProgramAddressSync(
        [
            utf8.encode(multisigWalletHandle),
            multisigAuthority.toBytes(),
            masterNonceBuffer
        ],
        programId
    );

    return pda;
};

const initializeAccount = async (program: Program<SquadMintMultiSig>,
                                 owner: anchor.web3.Keypair,
                                 squadMintFeePayer: anchor.web3.Keypair,
                                 walletHandle: string): Promise<anchor.web3.PublicKey> => {
    // const accountKeypair = anchor.web3.Keypair.generate();
    const pda = await findPDAForAuthority(program.programId, owner.publicKey, walletHandle);
    console.log("🦾️ Found PDA on our Client for Wallet:  " + walletHandle + " PDA: "  + pda.toBase58() + "  Authority: " + owner.publicKey.toBase58())

    await program.methods.initialize(walletHandle)
        .accounts({
            multisig: pda,
            multisigOwner: owner.publicKey,
            feePayer: squadMintFeePayer.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
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

// Helper function with callback
const checkAccountFieldsAreInitializedCorrectly = async (
    program: Program<SquadMintMultiSig>,
    walletOwner: anchor.web3.PublicKey,
    accountHandle: string,
    expectedMasterNonce: number = 0
) => {
    const pda = await findPDAForAuthority(program.programId, walletOwner, accountHandle);
    const fund = await program.account.squadMintFund.fetch(pda);

    expect(fund.owner.toBase58()).to.equal(walletOwner.toBase58());
    expect(fund.accountHandle).to.equal(accountHandle);
    expect(fund.hasActiveVote).to.be.false;
    expect(fund.isPrivateGroup).to.be.true;
    expect(fund.members).to.have.lengthOf(1);
    expect(fund.members[0].toBase58()).to.equal(walletOwner.toBase58());
    expect(fund.masterNonce.eq(new BN(expectedMasterNonce))).to.be.true;

    return fund;
};

// const fetchAccount = async (program: Program<HelloWorld>, authority: anchor.web3.PublicKey) => {
//     return await program.account.myAccount.fetch(await findPDAForAuthority(program.programId, authority))
// }

export {
    createWallet,
    initializeAccount,
    getAllAccountsByAuthority,
    findPDAForAuthority,
    checkAccountFieldsAreInitializedCorrectly,
    findPDAForMultisigTransaction
};