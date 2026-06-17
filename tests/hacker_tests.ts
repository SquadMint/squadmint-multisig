/**
 * hacker_tests.ts — adversarial / red-team suite.
 *
 * Every test here plays the attacker. The goal is to prove that the obvious
 * "drain the money" moves are all rejected on-chain:
 *
 *   - drain ONE person's / fund's vault       (redirect a payout, foreign vault)
 *   - drain the WHOLE program                 (use fund A's signer on fund B)
 *   - bad actors INSIDE a fund                (minority self-pay, sock-puppet,
 *                                              underpaid joins, non-members)
 *   - corrupt the setup                       (fund on a fake mint)
 *
 * Each test builds its own throwaway fund(s) so state never leaks between
 * cases. The mint + fee payer are shared with squad_mint_multi_sig.ts via
 * shared_setup.ts (the program pins a single mint address).
 */
import { SquadMintMultiSig } from "../target/types/squad_mint_multi_sig";
import chai from "chai";
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createMint,
    getAccount,
    getOrCreateAssociatedTokenAccount,
    mintTo,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import {
    addMember,
    amountToSmalletDecimal,
    createWallet,
    decimals,
    findATAForPDAForAuthority,
    findATAForPDAForAuthority2,
    findATAForPDAForJoinCustodialAccount,
    findPDAForAuthority,
    findPDAForJoinCustodialAccount,
    findPDAForMultisigTransaction,
    initializeAccount,
    initiateJoinRequest,
    transferTokens,
    WalletWithAta,
} from "./helper_function";
import { getSharedCtx } from "./shared_setup";

anchor.setProvider(anchor.AnchorProvider.env());

const program = anchor.workspace.SquadMintMultiSig as Program<SquadMintMultiSig>;
const connection = anchor.getProvider().connection;

const tokenProgram = TOKEN_PROGRAM_ID;
const associatedTokenProgram = ASSOCIATED_TOKEN_PROGRAM_ID;
const systemProgram = anchor.web3.SystemProgram.programId;

const JOIN_AMOUNT = () => new BN(amountToSmalletDecimal(1.11));

let feePayer: anchor.web3.Keypair;
let mint: PublicKey;
let treasury: WalletWithAta; // bankrolls test vaults

interface Fund {
    owner: WalletWithAta;
    pda: PublicKey;
    members: WalletWithAta[]; // members[0] is the owner
}

// Spin up a fresh fund and, optionally, add `extraMembers` accepted members
// (each escrows the join amount into the vault as part of joining).
const makeFund = async (handle: string, extraMembers: number): Promise<Fund> => {
    const owner = await createWallet(connection, mint, feePayer, 2);
    const pda = await initializeAccount(program, owner.keyPair, feePayer, mint, handle);
    const members: WalletWithAta[] = [owner];

    for (let i = 0; i < extraMembers; i++) {
        const m = await createWallet(connection, mint, feePayer, 2);
        await initiateJoinRequest(program, pda, m, JOIN_AMOUNT(), feePayer, mint);
        const custodial = await findPDAForJoinCustodialAccount(program.programId, pda, m.keyPair.publicKey);
        await addMember(program, pda, custodial, m, owner, owner, feePayer, mint);
        members.push(m);
    }
    return { owner, pda, members };
};

// Top up a fund's vault with `whole` tokens from the shared treasury.
const fundVault = async (pda: PublicKey, whole: number) => {
    const vaultAta = await findATAForPDAForAuthority2(program.programId, pda);
    await transferTokens(connection, feePayer, treasury.ataAccount.address, vaultAta, treasury.keyPair, whole);
};

// Create an active proposal; the proposer's YES vote is recorded automatically.
const createProposalRaw = async (
    pda: PublicKey,
    proposer: WalletWithAta,
    proposedTo: WalletWithAta,
    amount: BN,
): Promise<PublicKey> => {
    const vaultAta = await findATAForPDAForAuthority2(program.programId, pda);
    const fund = await program.account.squadMintFund.fetch(pda);
    const txPda = await findPDAForMultisigTransaction(program.programId, pda, fund.accountHandle, fund.masterNonce);

    await program.methods
        .createProposal(amount, proposedTo.keyPair.publicKey)
        .accounts({
            transaction: txPda,
            multisig: pda,
            feePayer: feePayer.publicKey,
            proposer: proposer.keyPair.publicKey,
            mint,
            proposedToOwner: proposedTo.keyPair.publicKey,
            multisigAta: vaultAta,
            proposedToAta: proposedTo.ataAccount.address,
            tokenProgram,
            associatedTokenProgram,
            systemProgram,
        })
        .signers([feePayer, proposer.keyPair])
        .rpc();

    return txPda;
};

before(async () => {
    const chaiAsPromised = await import("chai-as-promised");
    chai.use(chaiAsPromised.default);

    const ctx = await getSharedCtx(connection);
    feePayer = ctx.feePayer;
    mint = ctx.testMint.mintPubkey;

    treasury = await createWallet(connection, mint, feePayer, 200);
});

describe("SquadMint — hacker / red-team tests", () => {
    // ============== Bad actors: non-members ==============

    it("non-member cannot propose a payout to themselves", async () => {
        const { pda } = await makeFund("hk_nonmemProp", 0);
        await fundVault(pda, 5);

        const attacker = await createWallet(connection, mint, feePayer, 2);
        const vaultAta = await findATAForPDAForAuthority2(program.programId, pda);
        const fund = await program.account.squadMintFund.fetch(pda);
        const txPda = await findPDAForMultisigTransaction(program.programId, pda, fund.accountHandle, fund.masterNonce);

        const attempt = program.methods
            .createProposal(new BN(amountToSmalletDecimal(1)), attacker.keyPair.publicKey)
            .accounts({
                transaction: txPda,
                multisig: pda,
                feePayer: feePayer.publicKey,
                proposer: attacker.keyPair.publicKey,
                mint,
                proposedToOwner: attacker.keyPair.publicKey,
                multisigAta: vaultAta,
                proposedToAta: attacker.ataAccount.address,
                tokenProgram,
                associatedTokenProgram,
                systemProgram,
            })
            .signers([feePayer, attacker.keyPair])
            .rpc();

        await expect(attempt).to.be.rejected; // MemberNotPartOfFund

        const vault = await getAccount(connection, vaultAta);
        expect(vault.amount).to.equal(BigInt(amountToSmalletDecimal(5)));
    });

    it("non-member cannot vote on an active proposal", async () => {
        const { owner, pda } = await makeFund("hk_nonmemVote", 1);
        await fundVault(pda, 5);

        const proposedTo = await createWallet(connection, mint, feePayer, 2);
        const txPda = await createProposalRaw(pda, owner, proposedTo, new BN(amountToSmalletDecimal(1))); // 1 yes / 2 -> active

        const attacker = await createWallet(connection, mint, feePayer, 2);
        const vaultAta = await findATAForPDAForAuthority2(program.programId, pda);
        const proposedToAta = await findATAForPDAForAuthority(proposedTo.keyPair.publicKey, mint);

        const attempt = program.methods
            .submitAndExecute(true)
            .accounts({
                transaction: txPda,
                multisig: pda,
                feePayer: feePayer.publicKey,
                submitter: attacker.keyPair.publicKey,
                mint,
                proposedToOwner: proposedTo.keyPair.publicKey,
                multisigAta: vaultAta,
                proposedToAta,
                tokenProgram,
                associatedTokenProgram,
                systemProgram,
            })
            .signers([feePayer, attacker.keyPair])
            .rpc();

        await expect(attempt).to.be.rejected; // MemberNotPartOfFund

        const fund = await program.account.squadMintFund.fetch(pda);
        expect(fund.hasActiveVote).to.be.true;
    });

    // ============== Bad actors: a malicious member ==============

    it("a single minority member cannot drain the fund (threshold gate)", async () => {
        const { pda, members } = await makeFund("hk_minority", 2); // 3 members
        await fundVault(pda, 5);

        const attacker = members[1]; // a non-owner member, paying themselves
        const txPda = await createProposalRaw(
            pda,
            attacker,
            attacker,
            new BN(amountToSmalletDecimal(3)),
        ); // proposer auto-votes YES: 1/3 = 33% < 51%

        const vaultAta = await findATAForPDAForAuthority2(program.programId, pda);
        const vaultBefore = await getAccount(connection, vaultAta);

        // Attacker re-submits their own vote to try to force it through. The
        // program treats an already-voted submitter as a no-op re-tally: 1/3
        // never reaches 51%, so the vault is never touched and the vote stays
        // open. (A lone bad actor simply cannot move funds.)
        const proposedToAta = await findATAForPDAForAuthority(attacker.keyPair.publicKey, mint);
        await program.methods
            .submitAndExecute(true)
            .accounts({
                transaction: txPda,
                multisig: pda,
                feePayer: feePayer.publicKey,
                submitter: attacker.keyPair.publicKey,
                mint,
                proposedToOwner: attacker.keyPair.publicKey,
                multisigAta: vaultAta,
                proposedToAta,
                tokenProgram,
                associatedTokenProgram,
                systemProgram,
            })
            .signers([feePayer, attacker.keyPair])
            .rpc();

        const fund = await program.account.squadMintFund.fetch(pda);
        expect(fund.hasActiveVote).to.be.true; // never crossed threshold
        const vaultAfter = await getAccount(connection, vaultAta);
        expect(vaultAfter.amount).to.equal(vaultBefore.amount); // nothing moved
    });

    it("cannot redirect an approved payout to an attacker-controlled ATA", async () => {
        const { owner, pda, members } = await makeFund("hk_redirect", 1); // owner + memberA
        await fundVault(pda, 5);

        const proposedTo = await createWallet(connection, mint, feePayer, 2);
        const txPda = await createProposalRaw(
            pda,
            owner,
            proposedTo,
            new BN(amountToSmalletDecimal(2)),
        ); // owner auto-votes YES: 1/2 -> active

        const attacker = await createWallet(connection, mint, feePayer, 2);
        const memberA = members[1];
        const vaultAta = await findATAForPDAForAuthority2(program.programId, pda);
        const vaultBefore = await getAccount(connection, vaultAta);

        // memberA casts the deciding 2/2 vote but tries to divert the funds to
        // the attacker instead of the recorded recipient.
        const attempt = program.methods
            .submitAndExecute(true)
            .accounts({
                transaction: txPda,
                multisig: pda,
                feePayer: feePayer.publicKey,
                submitter: memberA.keyPair.publicKey,
                mint,
                proposedToOwner: attacker.keyPair.publicKey,
                multisigAta: vaultAta,
                proposedToAta: attacker.ataAccount.address,
                tokenProgram,
                associatedTokenProgram,
                systemProgram,
            })
            .signers([feePayer, memberA.keyPair])
            .rpc();

        await expect(attempt).to.be.rejected; // InvalidDestinationOwner

        const vaultAfter = await getAccount(connection, vaultAta);
        expect(vaultAfter.amount).to.equal(vaultBefore.amount);
        const attackerAta = await getAccount(connection, attacker.ataAccount.address);
        expect(attackerAta.amount).to.equal(BigInt(amountToSmalletDecimal(2))); // untouched
    });

    it("a non-owner member cannot add a colluder to manufacture a majority", async () => {
        const { pda, members } = await makeFund("hk_sockpuppet", 1); // owner + memberA
        const memberA = members[1];

        const colluder = await createWallet(connection, mint, feePayer, 2);
        await initiateJoinRequest(program, pda, colluder, JOIN_AMOUNT(), feePayer, mint);
        const colluderCustodial = await findPDAForJoinCustodialAccount(program.programId, pda, colluder.keyPair.publicKey);

        // memberA is a member but NOT the owner -> acceptance must be rejected.
        const attempt = addMember(program, pda, colluderCustodial, colluder, memberA, memberA, feePayer, mint);
        await expect(attempt).to.be.rejected;

        const fund = await program.account.squadMintFund.fetch(pda);
        expect(fund.members).to.have.lengthOf(2); // owner + memberA only
    });

    it("cannot join by paying less than the required join amount", async () => {
        const { pda } = await makeFund("hk_underpay", 0);

        const attacker = await createWallet(connection, mint, feePayer, 2);
        const tooLittle = new BN(amountToSmalletDecimal(0.5)); // fund requires 1.11

        const attempt = initiateJoinRequest(program, pda, attacker, tooLittle, feePayer, mint);
        await expect(attempt).to.be.rejected; // JoiningAmountShouldMatchTargetWallet
    });

    // ============== Drain the whole program (cross-fund) ==============

    it("cannot drain another fund's vault by swapping in a foreign multisig_ata", async () => {
        const fundA = await makeFund("hk_drainA", 1);
        const fundB = await makeFund("hk_drainB", 0);
        await fundVault(fundA.pda, 5);
        await fundVault(fundB.pda, 5);

        const proposedTo = await createWallet(connection, mint, feePayer, 2);
        const txPda = await createProposalRaw(
            fundA.pda,
            fundA.owner,
            proposedTo,
            new BN(amountToSmalletDecimal(2)),
        );

        const memberA = fundA.members[1];
        const fundBVault = await findATAForPDAForAuthority2(program.programId, fundB.pda);
        const fundBBefore = await getAccount(connection, fundBVault);
        const proposedToAta = await findATAForPDAForAuthority(proposedTo.keyPair.publicKey, mint);

        // Deciding vote on fund A, but point the source vault at fund B.
        const attempt = program.methods
            .submitAndExecute(true)
            .accounts({
                transaction: txPda,
                multisig: fundA.pda,
                feePayer: feePayer.publicKey,
                submitter: memberA.keyPair.publicKey,
                mint,
                proposedToOwner: proposedTo.keyPair.publicKey,
                multisigAta: fundBVault,
                proposedToAta,
                tokenProgram,
                associatedTokenProgram,
                systemProgram,
            })
            .signers([feePayer, memberA.keyPair])
            .rpc();

        await expect(attempt).to.be.rejected; // multisig_ata seeds bound to fund A

        const fundBAfter = await getAccount(connection, fundBVault);
        expect(fundBAfter.amount).to.equal(fundBBefore.amount); // fund B untouched
    });

    // ============== Corrupt the setup ==============

    it("cannot create a fund on a non-USDC mint", async () => {
        // Fresh random mint -> address differs from the pinned USDC_MINT.
        const fakeMint = await createMint(
            connection,
            feePayer,
            feePayer.publicKey,
            feePayer.publicKey,
            decimals,
        );

        const owner = anchor.web3.Keypair.generate();
        const pda = await findPDAForAuthority(program.programId, owner.publicKey, "hk_fakeMint");

        const attempt = program.methods
            .initialize("hk_fakeMint", JOIN_AMOUNT())
            .accounts({
                multisigOwner: owner.publicKey,
                feePayer: feePayer.publicKey,
                multisig: pda,
                mint: fakeMint,
                tokenProgram,
                associatedTokenProgram,
                systemProgram,
            })
            .signers([owner, feePayer])
            .rpc();

        await expect(attempt).to.be.rejectedWith(/InvalidMint/);
    });

    it("cannot escrow a join request with a non-USDC mint (N-5 mint pin)", async () => {
        const { pda } = await makeFund("hk_fakeJoin", 0);

        // Attacker holds a worthless token and tries to use it as the join deposit.
        const fakeMint = await createMint(connection, feePayer, feePayer.publicKey, feePayer.publicKey, decimals);
        const attacker = await createWallet(connection, mint, feePayer, 2);
        const fakeAta = await getOrCreateAssociatedTokenAccount(connection, feePayer, fakeMint, attacker.keyPair.publicKey);
        await mintTo(connection, feePayer, fakeMint, fakeAta.address, feePayer, amountToSmalletDecimal(2));

        const custodialPda = await findPDAForJoinCustodialAccount(program.programId, pda, attacker.keyPair.publicKey);
        const custodialAta = findATAForPDAForJoinCustodialAccount(program.programId, custodialPda);

        const attempt = program.methods
            .initiateJoinRequest(JOIN_AMOUNT())
            .accounts({
                multisig: pda,
                feePayer: feePayer.publicKey,
                mint: fakeMint,
                proposingJoiner: attacker.keyPair.publicKey,
                proposingJoinerAta: fakeAta.address,
                joinCustodialAccount: custodialPda,
                joinCustodialAccountAta: custodialAta,
                tokenProgram,
                associatedTokenProgram,
                systemProgram,
            })
            .signers([feePayer, attacker.keyPair])
            .rpc();

        await expect(attempt).to.be.rejectedWith(/InvalidMint/);
    });
});
