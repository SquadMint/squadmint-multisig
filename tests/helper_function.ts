import * as anchor from "@coral-xyz/anchor";
import {BN, Program, Wallet} from "@coral-xyz/anchor";
import { SquadMintMultiSig } from "../target/types/squad_mint_multi_sig";
import {expect} from "chai";
import {
    Account,
    ASSOCIATED_TOKEN_PROGRAM_ID, createMint, getAccount, getAssociatedTokenAddress, getAssociatedTokenAddressSync,
    getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID, transfer
} from "@solana/spl-token";
import {Connection, Keypair, PublicKey} from "@solana/web3.js";
import {min} from "bn.js";

const { utf8 } = anchor.utils.bytes
const decimals = 6
/// Creates wallet and adds this blockchain.

class WalletWithAta {
    keyPair: anchor.web3.Keypair;
    ataAccount: Account;

    constructor(keyPair: anchor.web3.Keypair, ataAccount: Account) {
        this.keyPair = keyPair;
        this.ataAccount = ataAccount;
    }
}
const createWallet = async (connection: anchor.web3.Connection, mintPubkey: anchor.web3.PublicKey, mintAuthority: anchor.web3.Keypair,  funds: number): Promise<WalletWithAta> => {
    const wallet = anchor.web3.Keypair.generate();
    // wait for confirmation

    const userATA: Account = await getOrCreateAssociatedTokenAccount(
        connection,
        mintAuthority,
        mintPubkey,
        wallet.publicKey
    );

    await mintTo(
        connection,
        mintAuthority,         // payer for transaction
        mintPubkey,            // existing mint
        userATA.address,       // destination
        mintAuthority,         // mint authority
        10 ** decimals * funds
    );

    const userTokenAccount = await getAccount(connection, userATA.address);
    const balance = Number(userTokenAccount.amount) / 10 ** decimals;

    if (balance < funds) {
        throw new Error(`Token mint failed — balance is ${balance}, expected ${funds}`);
    }
    const result = new WalletWithAta(wallet, userATA)
    console.log("EXIT CREATE AND FUND ATA ACCOUNT 🔥: " + result.keyPair.publicKey.toBase58() + " ATA: " + result.ataAccount.address + " Mint " + mintPubkey.toBase58());
    return result
}

const createFeePayerWallet = async (connection: anchor.web3.Connection, funds: number): Promise<anchor.web3.Keypair> => {
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

    console.log("EXIT CREATE AND Fee Payer FUND ACCOUNT 🔥")
    return wallet
}

const findPDAForAuthority = async (programId: anchor.web3.PublicKey,
                                   authority: anchor.web3.PublicKey,
                                   walletHandle: string) : Promise<anchor.web3.PublicKey> => {
    const [pda, _canonicalBump] = await anchor.web3.PublicKey.findProgramAddressSync([utf8.encode(walletHandle), authority.toBytes()], programId);
    return pda;
}

const findATAForPDAForAuthority = async (
    pda: anchor.web3.PublicKey,
    mint: anchor.web3.PublicKey,
): Promise<anchor.web3.PublicKey> => {
    const ata = await getAssociatedTokenAddress(
        mint,
        pda,
        true,
    );

    return ata;
};

const findATAForPDAForAuthority2 = async (
    programId: anchor.web3.PublicKey,
    pda: anchor.web3.PublicKey,
): Promise<anchor.web3.PublicKey> => {
    const [pda2, _canonicalBump] = await anchor.web3.PublicKey.findProgramAddressSync([utf8.encode("token_vault"), pda.toBytes()], programId);
    return pda2;
};



const findPDAForMultisigTransaction = async (
    programId: anchor.web3.PublicKey,
    multisigAuthority: anchor.web3.PublicKey,
    multisigWalletHandle: string,
    multisigCurrentMasterNonce: BN
): Promise<anchor.web3.PublicKey> => {
    const masterNonceBuffer = multisigCurrentMasterNonce.toArrayLike(Buffer, 'le', 8);
    const [pda, _canonicalBump] = anchor.web3.PublicKey.findProgramAddressSync(
        [
            utf8.encode("proposal_tx_data"),
            multisigAuthority.toBytes(),
            masterNonceBuffer
        ],
        programId
    );

    return pda;
};

const findPDAForJoinCustodialAccount = async (
    programId: anchor.web3.PublicKey,
    multisigAuthority: anchor.web3.PublicKey,
    proposingJoinerKey: anchor.web3.PublicKey,
): Promise<anchor.web3.PublicKey> => {
    const [pda, _canonicalBump] = anchor.web3.PublicKey.findProgramAddressSync(
        [
            utf8.encode("join_custodial_account"),
            multisigAuthority.toBytes(),
            proposingJoinerKey.toBytes(),
        ],
        programId
    );

    return pda;
};

const findATAForPDAForJoinCustodialAccount = (
    programId: anchor.web3.PublicKey,
    joinCustodialAccountPDA: anchor.web3.PublicKey,
): anchor.web3.PublicKey => {
    const [pda2, _canonicalBump] = anchor.web3.PublicKey.findProgramAddressSync(
        [
            utf8.encode("join_custodial_account_ata"),
            joinCustodialAccountPDA.toBytes()
        ], programId
    );
    return pda2;
};

const initializeAccount = async (program: Program<SquadMintMultiSig>,
                                 owner: anchor.web3.Keypair,
                                 squadMintFeePayer: anchor.web3.Keypair,
                                 mint: anchor.web3.PublicKey,
                                 walletHandle: string): Promise<anchor.web3.PublicKey> => {
    // const accountKeypair = anchor.web3.Keypair.generate();
    const pda = await findPDAForAuthority(program.programId, owner.publicKey, walletHandle);
    // const pdaATA = await findATAForPDAForAuthority(pda, mint)
    const pdaATA = await findATAForPDAForAuthority2(program.programId, pda)
    console.log("🦾️ Found PDA on our Client for Wallet:  \n" + walletHandle + " PDA: \n"  + pda.toBase58() + "  Authority: \n" + owner.publicKey.toBase58() + " PDA ATA: \n" + pdaATA + " mint \n" + mint.toBase58() + "And fee payer:  \n" + squadMintFeePayer.publicKey.toBase58())
    await program.methods.initialize(walletHandle, new BN(amountToSmalletDecimal(1.11)))
        .accounts({
            multisigOwner: owner.publicKey,
            feePayer: squadMintFeePayer.publicKey,
            multisig: pda,
            mint: mint,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
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

const amountToSmalletDecimal = (
    amount: number) => {
    return 10 ** decimals * amount;
}

// Helper function with callback
const checkAccountFieldsAreInitializedCorrectly = async (
    program: Program<SquadMintMultiSig>,
    connection: Connection,
    walletOwner: anchor.web3.PublicKey,
    accountHandle: string,
    expectedMasterNonce: number = 0
) => {
    const pda = await findPDAForAuthority(program.programId, walletOwner, accountHandle);
    const ata = await findATAForPDAForAuthority2(program.programId, pda);
    const fund = await program.account.squadMintFund.fetch(pda);

    expect(fund.owner.toBase58()).to.equal(walletOwner.toBase58());
    expect(fund.accountHandle).to.equal(accountHandle);
    expect(fund.hasActiveVote).to.be.false;
    expect(fund.isPrivateGroup).to.be.true;
    expect(fund.members).to.have.lengthOf(1);
    expect(fund.members[0].toBase58()).to.equal(walletOwner.toBase58());
    expect(fund.masterNonce.eq(new BN(expectedMasterNonce))).to.be.true;

    const userTokenAccount = await getAccount(connection, ata);
    expect(userTokenAccount.amount).to.equal(BigInt(0));

    return fund;
};
 async function createTestMint(
    connection: anchor.web3.Connection,
    payer: anchor.web3.Keypair,
) {
    // Create a new mint
    const mintPubkey = await createMint(
        connection,
        payer,        // payer for transaction & rent
        payer.publicKey,        // mint authority
        payer.publicKey,        // freeze authority (optional)
        decimals
    );

    const tokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mintPubkey,
        payer.publicKey
    );

    console.log("Test Mint:", mintPubkey.toBase58());
    console.log("Token Account:", tokenAccount.address.toBase58());

    return {
        mintPubkey,
        tokenAccountPubkey: tokenAccount.address
    };
}

 const transferTokens = async (
    connection: anchor.web3.Connection,
    payer: anchor.web3.Keypair,
    sourceATA: anchor.web3.PublicKey,
    destinationATA: anchor.web3.PublicKey,
    owner: anchor.web3.Keypair,
    amount: number
) => {
    const txSignature = await transfer(
        connection,
        payer,           // payer for transaction
        sourceATA,       // source token account
        destinationATA,  // destination token account
        owner,           // owner of source ATA
        10 ** decimals * amount
    );

    console.log(`✅ Transferred ${amount} tokens`);
    console.log(`Transaction signature: ${txSignature}`);
    return txSignature;
};
 const initiateJoinRequest = async (
    program: Program<SquadMintMultiSig>,
    multisigPda: anchor.web3.PublicKey,
    requestToJoinMember: WalletWithAta,
    amount: BN,
    feePayer: anchor.web3.Keypair,
    mint: anchor.web3.PublicKey
) => {
    // 2. Multisig ATA
    const multisigAta = await findATAForPDAForAuthority2(program.programId, multisigPda);

    // 3. Join Custodial PDA
    const joinCustodialPda = await findPDAForJoinCustodialAccount(
        program.programId,
        multisigPda,
        requestToJoinMember.keyPair.publicKey
    );

    // 4. Join Custodial ATA (PDA)
    const joinCustodialAta = findATAForPDAForJoinCustodialAccount(
        program.programId,
        joinCustodialPda
    );

    // 5. Execute
    const sig = await program.methods
        .initiateJoinRequest(amount)
        .accounts({
            multisig: multisigPda,
            feePayer: feePayer.publicKey,
            mint: mint,
            proposingJoiner: requestToJoinMember.keyPair.publicKey,
            proposingJoinerAta: requestToJoinMember.ataAccount.address,
            joinCustodialAccount: joinCustodialPda,
            joinCustodialAccountAta: joinCustodialAta,
            multisigAta: multisigAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram:  anchor.web3.SystemProgram.programId
        })
        .signers([feePayer, requestToJoinMember.keyPair])
        .rpc();

    console.log("Join request initiated:", sig);
    return {
        sig,
        multisigPda,
        joinCustodialPda,
        joinCustodialAta
    };
};
 const addMember = async (
    program: Program<SquadMintMultiSig>,
    multisigPda: PublicKey,
    joinCustodialPda: PublicKey,
    requestToJoinMember: WalletWithAta,
    multisigOwner: WalletWithAta,
    signer: WalletWithAta,
    feePayer: Keypair,
    mint: PublicKey
) => {
    const multisigAta = await findATAForPDAForAuthority2(program.programId, multisigPda);

    const joinCustodialAta = findATAForPDAForJoinCustodialAccount(
        program.programId,
        joinCustodialPda
    );

    const sig = await program.methods
        .addMember(requestToJoinMember.keyPair.publicKey)
        .accounts({
            multisig: multisigPda,
            feePayer: feePayer.publicKey,
            multisigOwner: multisigOwner.keyPair.publicKey,
            mint: mint,
            proposingJoiner: requestToJoinMember.keyPair.publicKey,
            proposingJoinerAta: requestToJoinMember.ataAccount.address,
            joinCustodialAccount: joinCustodialPda,
            joinCustodialAccountAta: joinCustodialAta,
            multisigAta: multisigAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([feePayer, signer.keyPair])
        .rpc();

    console.log("Member added:", sig);
    return { sig, multisigPda, joinCustodialPda };
};

const rejectMember = async (
    program: Program<SquadMintMultiSig>,
    multisigPda: PublicKey,
    joinCustodialPda: PublicKey,
    requestToJoinMember: WalletWithAta,
    multisigOwner: WalletWithAta,
    signer: WalletWithAta,
    feePayer: Keypair,
    mint: PublicKey
) => {
    const multisigAta = await findATAForPDAForAuthority2(program.programId, multisigPda);

    const joinCustodialAta = findATAForPDAForJoinCustodialAccount(
        program.programId,
        joinCustodialPda
    );

    const sig = await program.methods
        .rejectMember(requestToJoinMember.keyPair.publicKey)
        .accounts({
            multisig: multisigPda,
            feePayer: feePayer.publicKey,
            multisigOwner: multisigOwner.keyPair.publicKey,
            mint: mint,
            proposingJoiner: requestToJoinMember.keyPair.publicKey,
            proposingJoinerAta: requestToJoinMember.ataAccount.address,
            joinCustodialAccount: joinCustodialPda,
            joinCustodialAccountAta: joinCustodialAta,
            multisigAta: multisigAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([feePayer, signer.keyPair])
        .rpc();

    console.log("Member added:", sig);
    return { sig, multisigPda, joinCustodialPda };
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
    findPDAForMultisigTransaction,
    createTestMint,
    createFeePayerWallet,
    transferTokens,
    findATAForPDAForAuthority2,
    decimals,
    findATAForPDAForAuthority,
    amountToSmalletDecimal,
    findPDAForJoinCustodialAccount,
    findATAForPDAForJoinCustodialAccount,
    initiateJoinRequest,
    addMember,
    WalletWithAta, rejectMember
};