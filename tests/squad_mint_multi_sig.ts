import {SquadMintMultiSig} from "../target/types/squad_mint_multi_sig";
import chai from "chai";
import {expect} from "chai";
import * as anchor from "@coral-xyz/anchor";
import {AnchorError, BN, Program} from "@coral-xyz/anchor";

// Initialize chai-as-promised inside a setup function or describe block
let chaiAsPromised: any;

import {
    addMember,
    amountToSmalletDecimal,
    checkAccountFieldsAreInitializedCorrectly,
    createFeePayerWallet,
    createTestMint,
    createWallet, decimals, findATAForPDAForAuthority,
    findATAForPDAForAuthority2, findATAForPDAForJoinCustodialAccount,
    findPDAForAuthority, findPDAForJoinCustodialAccount,
    findPDAForMultisigTransaction,
    getAllAccountsByAuthority,
    initializeAccount,
    initiateJoinRequest, rejectMember,
    transferTokens, WalletWithAta
} from "./helper_function";

import {PublicKey} from "@solana/web3.js";
import {
    Account, ASSOCIATED_TOKEN_PROGRAM_ID,
    getAccount,
    getAssociatedTokenAddress,
    getOrCreateAssociatedTokenAccount, mintTo,
    TOKEN_PROGRAM_ID
} from "@solana/spl-token";
const program = anchor.workspace.SquadMintMultiSig as Program<SquadMintMultiSig>;
const connection = anchor.getProvider().connection;
let walletOwnerAndCreator: WalletWithAta;
let squadMintFeePayer: anchor.web3.Keypair;
let walletOwnerAndCreator2: WalletWithAta;
let memberOpenFundWallet: WalletWithAta;
let memberOpenFundWallet2: WalletWithAta;
let proposedToWallet: WalletWithAta;
let testMint: { mintPubkey: PublicKey; tokenAccountPubkey: PublicKey }

before(async () => {
    chaiAsPromised = await import("chai-as-promised");
    chai.use(chaiAsPromised.default);
    squadMintFeePayer = await createFeePayerWallet(connection, 5);

    testMint = await createTestMint(connection, squadMintFeePayer)

    memberOpenFundWallet = await createWallet(connection, testMint.mintPubkey, squadMintFeePayer, 5);
    memberOpenFundWallet2 = await createWallet(connection, testMint.mintPubkey, squadMintFeePayer, 2);
    proposedToWallet = await createWallet(connection, testMint.mintPubkey, squadMintFeePayer, 5);
    walletOwnerAndCreator = await createWallet(connection, testMint.mintPubkey, squadMintFeePayer, 4);
    walletOwnerAndCreator2 = await createWallet(connection, testMint.mintPubkey, squadMintFeePayer, 5);

    await initializeAccount(program, walletOwnerAndCreator.keyPair, squadMintFeePayer, testMint.mintPubkey, "openFundWallet")
    await initializeAccount(program, walletOwnerAndCreator.keyPair, squadMintFeePayer, testMint.mintPubkey, "openFundWallet2")
    await initializeAccount(program, walletOwnerAndCreator2.keyPair, squadMintFeePayer, testMint.mintPubkey, "someOtherFund")

})

describe("SquadMint Multisig program tests", () => {
    // Configure the client to use the local cluster.


    anchor.setProvider(anchor.AnchorProvider.env());

    const program: Program<SquadMintMultiSig> = anchor.workspace
        .squadMintMultiSig as Program<SquadMintMultiSig>;

    it("Accounts are initialized correctly", async () => {
        const accountWallet1Data = await getAllAccountsByAuthority(
            program.account.squadMintFund,
            walletOwnerAndCreator.keyPair.publicKey
        );

        expect(accountWallet1Data.length).to.equal(2);

        await checkAccountFieldsAreInitializedCorrectly(program, connection, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        await checkAccountFieldsAreInitializedCorrectly(program, connection, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet2");
        await checkAccountFieldsAreInitializedCorrectly(program, connection, walletOwnerAndCreator2.keyPair.publicKey, "someOtherFund");
    });

    // TODO: we need to test the size of the objects created to make sure we are
    // not over counting you can check this on the solscan

    it("Check we can mint to PDA ATA - checking setup", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const ata = await findATAForPDAForAuthority2(program.programId, pda)

        await mintTo(
            connection,
            squadMintFeePayer,
            testMint.mintPubkey,
            ata,
            squadMintFeePayer,
            10 ** decimals * 1
        );

        const userTokenAccount = await getAccount(connection, ata);
        expect(userTokenAccount.amount).to.equal(BigInt(10 ** decimals * 1));
    });


    it("Deposit USDC(decimal 6 token) to my multisig ATA", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const ata = await findATAForPDAForAuthority2(program.programId, pda)
        const userTokenAccount = await getAccount(connection, ata);
        const currentAmount = userTokenAccount.amount;
        expect(currentAmount.toString()).to.equal(new BN(amountToSmalletDecimal(1)).toString());

        await transferTokens(connection, squadMintFeePayer, walletOwnerAndCreator.ataAccount.address, ata, walletOwnerAndCreator.keyPair, 2)
        const userTokenAccountUpdated = await getAccount(connection, ata);
        expect(userTokenAccountUpdated.amount).to.equal(currentAmount + BigInt(10 ** decimals * 2));
    });

    it("Check that ATA authority is the PDA", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const ata = await findATAForPDAForAuthority2(program.programId, pda);
        const accountInfo = await connection.getAccountInfo(ata);

        const ataAccount = await getAccount(connection, ata);
        expect(ataAccount.owner.toBase58()).to.equal(pda.toBase58());
        expect(ataAccount.mint.toBase58()).to.equal(testMint.mintPubkey.toBase58());
        expect(ataAccount.amount).to.not.be.undefined;
        expect(ataAccount.delegate).to.be.null;
        const [expectedPda, bump] = PublicKey.findProgramAddressSync(
            [Buffer.from("openFundWallet"), walletOwnerAndCreator.keyPair.publicKey.toBuffer()],
            program.programId
        );
        expect(pda.toBase58()).to.equal(expectedPda.toBase58());
        expect(accountInfo.owner.toBase58()).to.equal(TOKEN_PROGRAM_ID.toBase58());
        console.log("ATA owner:", ataAccount.owner.toBase58());
        console.log("Expected PDA:", pda.toBase58());
    });

    it("Can Initiate Join Request Request to join to new group - memberOpenFundWallet", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey,
            "openFundWallet"
        );
        const joinCustodialAccountPDA = await findPDAForJoinCustodialAccount(program.programId, pda, memberOpenFundWallet.keyPair.publicKey);
        const joinCustodialAccountATA = findATAForPDAForJoinCustodialAccount(program.programId, joinCustodialAccountPDA);
        const joinAmount = new BN(amountToSmalletDecimal(1.11));
        await initiateJoinRequest(
            program,
            pda,
            memberOpenFundWallet,
            joinAmount,
            squadMintFeePayer,
            testMint.mintPubkey)

        const custodial = await program.account.joinRequestCustodialWallet.fetch(joinCustodialAccountPDA);
        expect(custodial.joinAmount.eq(joinAmount)).to.be.true;
        expect(custodial.requestToJoinUser.toBase58()).to.equal(memberOpenFundWallet.keyPair.publicKey.toBase58());
        expect(custodial.requestToJoinSquadMintFund.toBase58()).to.equal(pda.toBase58());

        const tokenAccount = await getAccount(connection, joinCustodialAccountATA);
        expect(tokenAccount.amount.toString()).to.equal(joinAmount.toString());
        expect(tokenAccount.mint.toBase58()).to.equal(testMint.mintPubkey.toBase58());
    });

    it("Can init different concurrent Join Request Requests - memberOpenFundWallet2", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
        );
        const joinCustodialAccountPDA = await findPDAForJoinCustodialAccount(program.programId, pda, memberOpenFundWallet2.keyPair.publicKey);
        const joinCustodialAccountATA = findATAForPDAForJoinCustodialAccount(program.programId, joinCustodialAccountPDA);
        const joinAmount = new BN(amountToSmalletDecimal(1.11)); // DRAIN memberOpenFundWallet2 ATA
        await initiateJoinRequest(
            program,
            pda,
            memberOpenFundWallet2,
            joinAmount,
            squadMintFeePayer,
            testMint.mintPubkey)

        const custodial = await program.account.joinRequestCustodialWallet.fetch(joinCustodialAccountPDA);
        expect(custodial.joinAmount.eq(joinAmount)).to.be.true;
        expect(custodial.requestToJoinUser.toBase58()).to.equal(memberOpenFundWallet2.keyPair.publicKey.toBase58());
        expect(custodial.requestToJoinSquadMintFund.toBase58()).to.equal(pda.toBase58());

        const tokenAccount = await getAccount(connection, joinCustodialAccountATA);
        expect(tokenAccount.amount.toString()).to.equal(joinAmount.toString());
        expect(tokenAccount.mint.toBase58()).to.equal(testMint.mintPubkey.toBase58());
    });

    it("Cannot Initiate Join Request Request again while one is pending - memberOpenFundWallet", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
        );
        const joinAmount = new BN(amountToSmalletDecimal(2));
        const rejection = initiateJoinRequest(
            program,
            pda,
            memberOpenFundWallet,
            joinAmount,
            squadMintFeePayer,
            testMint.mintPubkey)

        await expect(
            rejection
        ).to.be.rejected;
    });

    it("Cannot Initiate Join Request Request when is member - memberOpenFundWallet", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
        );
        const joinAmount = new BN(amountToSmalletDecimal(2));

        const rejection2 = initiateJoinRequest(
            program,
            pda,
            walletOwnerAndCreator,
            joinAmount,
            squadMintFeePayer,
            testMint.mintPubkey)

        await expect(
            rejection2
        ).to.be.rejected;
    });

    it("Reject When adding a new member but signer is not part of the group", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
        );
        const multisigAta = await findATAForPDAForAuthority2(program.programId, pda);
        const joinCustodialAccountPDA = await findPDAForJoinCustodialAccount(program.programId, pda, memberOpenFundWallet2.keyPair.publicKey);
        const joinCustodialAccountATA = findATAForPDAForJoinCustodialAccount(program.programId, joinCustodialAccountPDA);

        const memberOpenFundWallet2Ata = await getAccount(connection, memberOpenFundWallet2.ataAccount.address)
        const walletAmountBeforeRefund = memberOpenFundWallet2Ata.amount;

        const joinCustodialAccountATATokenAccount = await getAccount(connection, joinCustodialAccountATA);
        expect(joinCustodialAccountATATokenAccount.amount.toString()).to.equal(new BN(amountToSmalletDecimal(1.11)).toString());
        const feePayerSol = await connection.getBalance(squadMintFeePayer.publicKey);

        const rejection = rejectMember(
            program,
            pda,
            joinCustodialAccountPDA,
            memberOpenFundWallet2,
            walletOwnerAndCreator,
            memberOpenFundWallet2,
            squadMintFeePayer,
            testMint.mintPubkey
        )

        const rejection2 = addMember(
            program,
            pda,
            joinCustodialAccountPDA,
            memberOpenFundWallet2,
            walletOwnerAndCreator,
            memberOpenFundWallet2,
            squadMintFeePayer,
            testMint.mintPubkey
        )

        await expect(
            rejection
        ).to.be.rejected;

        await expect(
            rejection2
        ).to.be.rejected;

    });

    it("Accept Join Request and add a new member correctly - memberOpenFundWallet", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
        );
        const multisigAta = await findATAForPDAForAuthority2(program.programId, pda);
        const joinCustodialAccountPDA = await findPDAForJoinCustodialAccount(program.programId, pda, memberOpenFundWallet.keyPair.publicKey);
        const joinCustodialAccountATA = findATAForPDAForJoinCustodialAccount(program.programId, joinCustodialAccountPDA);

        const multisigTokenAccount = await getAccount(connection, multisigAta);
        expect(multisigTokenAccount.amount.toString()).to.equal(new BN(amountToSmalletDecimal(3)).toString());

        const joinCustodialAccountATATokenAccount = await getAccount(connection, joinCustodialAccountATA);
        expect(joinCustodialAccountATATokenAccount.amount.toString()).to.equal(new BN(amountToSmalletDecimal(1.11)).toString());
        const feePayerSol = await connection.getBalance(squadMintFeePayer.publicKey);

        await addMember(
            program,
            pda,
            joinCustodialAccountPDA,
            memberOpenFundWallet,
            walletOwnerAndCreator,
            walletOwnerAndCreator,
            squadMintFeePayer,
            testMint.mintPubkey
        )

        const fund = await program.account.squadMintFund.fetch(pda);
        expect(fund.members).to.have.lengthOf(2);
        expect(fund.members[1].toBase58()).to.equal(memberOpenFundWallet.keyPair.publicKey.toBase58());

        const multisigTokenAccountMut = await getAccount(connection, multisigAta);
        expect(multisigTokenAccountMut.amount.toString()).to.equal(new BN(amountToSmalletDecimal(3 + 1.11)).toString());

        // Expect the account to be closed
        await expect(
            program.account.joinRequestCustodialWallet.fetch(joinCustodialAccountPDA)
        ).to.be.rejected;

        await expect(
            getAccount(connection, joinCustodialAccountATA)
        ).to.be.rejected;

        const feePayerSolMut = await connection.getBalance(squadMintFeePayer.publicKey);
        expect(feePayerSolMut).to.gt(feePayerSol); // LAZY but its enough for now
    });

    it("Only owner can accept join request - memberOpenFundWallet", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
        );
        const joinCustodialAccountPDA = await findPDAForJoinCustodialAccount(program.programId, pda, memberOpenFundWallet.keyPair.publicKey);

        const rejection = addMember(
            program,
            pda,
            joinCustodialAccountPDA,
            memberOpenFundWallet,
            walletOwnerAndCreator,
            memberOpenFundWallet,
            squadMintFeePayer,
            testMint.mintPubkey
        )

        await expect(
            rejection
        ).to.be.rejected;
    });

    it("Cannot Initiate Join Request Request again after acceptance - memberOpenFundWallet", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
        );
        const joinAmount = new BN(amountToSmalletDecimal(1.11));
        const rejection = initiateJoinRequest(
            program,
            pda,
            memberOpenFundWallet,
            joinAmount,
            squadMintFeePayer,
            testMint.mintPubkey)

        await expect(
            rejection
        ).to.be.rejected;
    });

    it("Reject Join Request - memberOpenFundWallet2", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
        );
        const multisigAta = await findATAForPDAForAuthority2(program.programId, pda);
        const joinCustodialAccountPDA = await findPDAForJoinCustodialAccount(program.programId, pda, memberOpenFundWallet2.keyPair.publicKey);
        const joinCustodialAccountATA = findATAForPDAForJoinCustodialAccount(program.programId, joinCustodialAccountPDA);

        const memberOpenFundWallet2Ata = await getAccount(connection, memberOpenFundWallet2.ataAccount.address)
        const walletAmountBeforeRefund = memberOpenFundWallet2Ata.amount;

        const joinCustodialAccountATATokenAccount = await getAccount(connection, joinCustodialAccountATA);
        expect(joinCustodialAccountATATokenAccount.amount.toString()).to.equal(new BN(amountToSmalletDecimal(1.11)).toString());
        const feePayerSol = await connection.getBalance(squadMintFeePayer.publicKey);

        await rejectMember(
            program,
            pda,
            joinCustodialAccountPDA,
            memberOpenFundWallet2,
            walletOwnerAndCreator,
            walletOwnerAndCreator,
            squadMintFeePayer,
            testMint.mintPubkey
        )

        const fund = await program.account.squadMintFund.fetch(pda);
        expect(fund.members).to.have.lengthOf(2);
        expect(fund.members[1].toBase58()).to.equal(memberOpenFundWallet.keyPair.publicKey.toBase58()); // Last memeber should be the last accepted member

        const multisigTokenAccountMut = await getAccount(connection, multisigAta);
        expect(multisigTokenAccountMut.amount.toString()).to.equal(new BN(amountToSmalletDecimal(3 + 1.11)).toString());

        const memberOpenFundWallet2AtaMut = await getAccount(connection, memberOpenFundWallet2.ataAccount.address)
        expect(memberOpenFundWallet2AtaMut.amount.toString()).to.equal(new BN(amountToSmalletDecimal( 1.11)).add(new BN(walletAmountBeforeRefund)).toString());

        // Expect the ATA and PDA accounts to be closed
        await expect(
            program.account.joinRequestCustodialWallet.fetch(joinCustodialAccountPDA)
        ).to.be.rejected;

        await expect(
            getAccount(connection, joinCustodialAccountATA)
        ).to.be.rejected;

        const feePayerSolMut = await connection.getBalance(squadMintFeePayer.publicKey);
        expect(feePayerSolMut).to.gt(feePayerSol); // LAZY but its enough for now
    });

    /// Needs use to test initializing 15 accounts and funding and adding these accounts
    it.skip("try to add more than 15 uninitialized member wallets to openFundWallet2 should be rejected", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet2");
        let unInitializedMember = anchor.web3.Keypair.generate();
        const addMember = program.methods.addMember(unInitializedMember.publicKey)
            .accounts({
                multisig: pda,
                multisigOwner: walletOwnerAndCreator.keyPair.publicKey
            })
            .signers([walletOwnerAndCreator.keyPair])
            .rpc()

        expect(addMember).to.be.rejectedWith(/MaxMembersReached/);
    });

    it("When adding an existing member then should be rejected", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
        );
        const joinAmount = new BN(amountToSmalletDecimal(1.11));
        const rejection = initiateJoinRequest(
            program,
            pda,
            memberOpenFundWallet,
            joinAmount,
            squadMintFeePayer,
            testMint.mintPubkey)

        const rejection2 = initiateJoinRequest(
            program,
            pda,
            walletOwnerAndCreator,
            joinAmount,
            squadMintFeePayer,
            testMint.mintPubkey)

        await expect(
            rejection
        ).to.be.rejected;
        await expect(
            rejection2
        ).to.be.rejected;
    });

    it("We can successfully create a proposal", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const multisigAta = await findATAForPDAForAuthority2(program.programId, pda);

        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(
            program.programId,
            pda,
            "openFundWallet",
            openFundWallet.masterNonce
        )
        console.log("🔥 This is the PDA of the new transaction " + transactionDataPDA.toBase58())
        let amount = new anchor.BN(1);
        await program
            .methods
            .createProposal(amount, proposedToWallet.keyPair.publicKey).accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                proposer: memberOpenFundWallet.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: proposedToWallet.keyPair.publicKey,
                multisigAta: multisigAta,
                proposedToAta: proposedToWallet.ataAccount.address,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId // can remove this
            })
            .signers([squadMintFeePayer, memberOpenFundWallet.keyPair])
            .rpc();

        const oFundTxProposal = await program.account.transaction.fetch(transactionDataPDA);

        expect(oFundTxProposal.belongsToSquadMintFund.toBase58()).to.be.equal(pda.toBase58())
        expect(oFundTxProposal.didMeetThreshold).to.be.equal(false)
        expect(oFundTxProposal.executors).to.have.lengthOf(1);
        expect(oFundTxProposal.votes).to.have.lengthOf(1);
        expect(oFundTxProposal.executors[0].toBase58())
            .to.equal(memberOpenFundWallet.keyPair.publicKey.toBase58());

        expect(oFundTxProposal.messageData.proposedToAccount.toBase58()).to.be.equal(proposedToWallet.keyPair.publicKey.toBase58())
        expect(oFundTxProposal.messageData.amount.eq(new BN(amount))).to.be.true;
        expect(oFundTxProposal.messageData.nonce.eq(new BN(openFundWallet.masterNonce))).to.be.true;
        expect(oFundTxProposal.messageData.proposerAccount.toBase58())
            .to.equal(memberOpenFundWallet.keyPair.publicKey.toBase58());
    });

    it("Should reject when already have active proposal", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const ata = await findATAForPDAForAuthority2(program.programId, pda);

        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(
            program.programId,
            pda,
            "openFundWallet",
            openFundWallet.masterNonce
        )

        const ataAccount = await getAccount(connection, ata);
        const currentAmount = ataAccount.amount

        let amount = new anchor.BN(1);
        let createRejectionProposal = program
            .methods
            .createProposal(amount, proposedToWallet.keyPair.publicKey).accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                proposer: memberOpenFundWallet.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: proposedToWallet.keyPair.publicKey,
                multisigAta: ata,
                proposedToAta: proposedToWallet.ataAccount.address,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, memberOpenFundWallet.keyPair])
            .rpc();

        await expect(createRejectionProposal).to.be.rejected;

        const ataAccountUpdated = await getAccount(connection, ata);
        expect(ataAccountUpdated.amount).to.be.equal(currentAmount)

        const openFundWallet2 = await program.account.squadMintFund.fetch(pda);
        expect(openFundWallet2.hasActiveVote).to.be.true
    });

    it("Should reject when proposer signer is not part of the group", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const ata = await findATAForPDAForAuthority2(program.programId, pda);

        let unInitializedMember = anchor.web3.Keypair.generate();
        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(
            program.programId,
            pda,
            "openFundWallet",
            openFundWallet.masterNonce
        )

        console.log("🔥 This is the PDA of the new transaction " + transactionDataPDA.toBase58())
        let amount = new anchor.BN(1);
        let createRejectionProposal = program
            .methods
            .createProposal(amount, proposedToWallet.keyPair.publicKey).accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                proposer: memberOpenFundWallet.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: proposedToWallet.keyPair.publicKey,
                multisigAta: ata,
                proposedToAta: proposedToWallet.ataAccount.address,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, unInitializedMember])
            .rpc();

        await expect(createRejectionProposal).to.be.rejected;
        expect(openFundWallet.hasActiveVote).to.be.true
    });


    it("Accept transfer/withdrawal on success submit and execute current proposal at 51% yes vote", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const ata = await findATAForPDAForAuthority2(program.programId, pda);

        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(program.programId, pda, "openFundWallet", openFundWallet.masterNonce)
        const oFundTxProposal = await program.account.transaction.fetch(transactionDataPDA);
        const ataAccount = await getAccount(connection, ata);
        const currentAmount = ataAccount.amount

        console.log("🦾Account current amount " + currentAmount.toString())

        const proposedToAta = await findATAForPDAForAuthority(oFundTxProposal.messageData.proposedToAccount, testMint.mintPubkey)

        // First check if everything is expected
        expect(oFundTxProposal.messageData.amount.eq(new BN(1))).to.be.true;
        expect(oFundTxProposal.messageData.nonce.eq(new BN(openFundWallet.masterNonce))).to.be.true;
        expect(oFundTxProposal.messageData.proposerAccount.toBase58())
            .to.equal(memberOpenFundWallet.keyPair.publicKey.toBase58());

        // wallet owner approves which should be second from the member who proposed
        await program.methods.submitAndExecute(true)
            .accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                submitter: walletOwnerAndCreator.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: oFundTxProposal.messageData.proposedToAccount,
                multisigAta: ata,
                proposedToAta: proposedToAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, walletOwnerAndCreator.keyPair])
            .rpc()

        const multisig = await program.account.squadMintFund.fetch(pda);
        const fundTx = await program.account.transaction.fetch(transactionDataPDA);

        const ataAccountUpdated = await getAccount(connection, ata);
        console.log("🔥 New amount " + ataAccountUpdated.amount.toString())


        const transferAmount = BigInt(oFundTxProposal.messageData.amount.toString());
        const expectedBalance = currentAmount - transferAmount;

        expect(ataAccountUpdated.amount).to.equal(expectedBalance);
        expect(multisig.hasActiveVote).to.be.false
        expect(multisig.masterNonce.eq(new anchor.BN(1))).to.be.true
        expect(fundTx.didMeetThreshold).to.be.eq(true)
        expect(fundTx.votes).to.not.be.empty;
        expect(fundTx.executors[0].toBase58())
            .to.equal(memberOpenFundWallet.keyPair.publicKey.toBase58());
        expect(fundTx.executors[1].toBase58())
            .to.equal(walletOwnerAndCreator.keyPair.publicKey.toBase58());
        expect(fundTx.votes[0])
            .to.equal(true);
        expect(fundTx.votes[1])
            .to.equal(true);
    });

    it("Reject proposal when ATA doesn't have enough funds ", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator2.keyPair.publicKey, "someOtherFund");
        const ata = await findATAForPDAForAuthority2(program.programId, pda);

        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(program.programId, pda, "someOtherFund", openFundWallet.masterNonce)
        // const openFundWalletTx = await program.account.transaction.fetch(transactionDataPDA);

        expect(openFundWallet.masterNonce.eq(new anchor.BN(0))).to.be.true
        expect(openFundWallet.hasActiveVote).to.be.eq(false)
        expect(openFundWallet.members).to.have.lengthOf(1);
        const multisigAccount = await getAccount(connection, ata)

        let amount = new anchor.BN(1);
        const proposal = program
            .methods
            .createProposal(amount, proposedToWallet.keyPair.publicKey).accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                proposer: walletOwnerAndCreator2.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: proposedToWallet.keyPair.publicKey,
                multisigAta: ata,
                proposedToAta: proposedToWallet.ataAccount.address,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, walletOwnerAndCreator2.keyPair])
            .rpc();
        await expect(proposal).to.be.rejectedWith(/InsufficientFunds/);
    });


    it("Reject transfer when NO vote is 51% or more", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator2.keyPair.publicKey, "someOtherFund");
        const ata = await findATAForPDAForAuthority2(program.programId, pda);
        const joinCustodialAccountPDA = await findPDAForJoinCustodialAccount(program.programId, pda, memberOpenFundWallet2.keyPair.publicKey);

        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(program.programId, pda, "someOtherFund", openFundWallet.masterNonce)
        // const openFundWalletTx = await program.account.transaction.fetch(transactionDataPDA);

        expect(openFundWallet.masterNonce.eq(new anchor.BN(0))).to.be.true
        expect(openFundWallet.hasActiveVote).to.be.eq(false)
        expect(openFundWallet.members).to.have.lengthOf(1);
        const multisigAccount = await getAccount(connection, ata)
        expect(multisigAccount.amount).to.equal(BigInt(0));

        await transferTokens(connection, squadMintFeePayer, walletOwnerAndCreator.ataAccount.address, ata, walletOwnerAndCreator.keyPair, 2)
        let amount = new anchor.BN(1);

        await program
            .methods
            .createProposal(amount, proposedToWallet.keyPair.publicKey).accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                proposer: walletOwnerAndCreator2.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: proposedToWallet.keyPair.publicKey,
                multisigAta: ata,
                proposedToAta: proposedToWallet.ataAccount.address,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, walletOwnerAndCreator2.keyPair])
            .rpc();

        const f = await program.account.transaction.fetch(transactionDataPDA);

        const multisigAccount2 = await getAccount(connection, ata)

        expect(f.votes[0])
            .to.equal(true);

        expect(multisigAccount2.amount).to.equal(BigInt(10 ** 6 * 2));

        const joinAmount = new BN(amountToSmalletDecimal(1.11));
        await initiateJoinRequest(
            program,
            pda,
            memberOpenFundWallet2,
            joinAmount,
            squadMintFeePayer,
            testMint.mintPubkey)

        await addMember(
            program,
            pda,
            joinCustodialAccountPDA,
            memberOpenFundWallet2,
            walletOwnerAndCreator2,
            walletOwnerAndCreator2,
            squadMintFeePayer,
            testMint.mintPubkey
        )

        const m = await program.account.squadMintFund.fetch(pda);
        expect(m.members).to.have.lengthOf(2);

        // NACKED
        await program.methods.submitAndExecute(false)
            .accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                submitter: memberOpenFundWallet2.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: proposedToWallet.keyPair.publicKey,
                multisigAta: ata,
                proposedToAta: proposedToWallet.ataAccount.address,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, memberOpenFundWallet2.keyPair])
            .rpc()


        const multisig = await program.account.squadMintFund.fetch(pda);
        const fundTx = await program.account.transaction.fetch(transactionDataPDA);

        expect(f.votes[0])
            .to.equal(true);
        expect(multisigAccount2.amount).to.equal(BigInt(10 ** 6 * 2));

        expect(multisig.hasActiveVote).to.be.false
        expect(multisig.masterNonce.eq(new anchor.BN(1))).to.be.true

        expect(fundTx.didMeetThreshold).to.be.eq(false)
        expect(fundTx.votes).to.not.be.empty;
        expect(fundTx.executors[0].toBase58())
            .to.equal(walletOwnerAndCreator2.keyPair.publicKey.toBase58());
        expect(fundTx.executors[1].toBase58())
            .to.equal(memberOpenFundWallet2.keyPair.publicKey.toBase58());
        expect(fundTx.votes[0])
            .to.equal(true);
        expect(fundTx.votes[1])
            .to.equal(false);
    });


    it("Reject duplicate vote on proposal that has already been decided", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const ata = await findATAForPDAForAuthority2(program.programId, pda);

        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(program.programId, pda, "openFundWallet", new BN(0)); // 0 is closed and decided
        const multisigAta = await findATAForPDAForAuthority(pda, testMint.mintPubkey);
        const oFundTxProposal = await program.account.transaction.fetch(transactionDataPDA);
        const proposedToAta = await findATAForPDAForAuthority(oFundTxProposal.messageData.proposedToAccount, testMint.mintPubkey)
        let vote = program.methods.submitAndExecute(true)
            .accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                submitter: walletOwnerAndCreator.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: oFundTxProposal.messageData.proposedToAccount,
                multisigAta: ata,
                proposedToAta: proposedToAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId

            })
            .signers([squadMintFeePayer, walletOwnerAndCreator.keyPair])
            .rpc()

        await expect(vote).to.be.rejected;
    });

    it("Reject duplicate vote on proposal that has already been decided but flipped", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const ata = await findATAForPDAForAuthority2(program.programId, pda);

        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(program.programId, pda, "openFundWallet", new BN(0)); // 0 is closed and decided
        const multisigAta = await findATAForPDAForAuthority(pda, testMint.mintPubkey);
        const oFundTxProposal = await program.account.transaction.fetch(transactionDataPDA);
        const proposedToAta = await findATAForPDAForAuthority(oFundTxProposal.messageData.proposedToAccount, testMint.mintPubkey)
        let vote = program.methods.submitAndExecute(false)
            .accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                submitter: walletOwnerAndCreator.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: oFundTxProposal.messageData.proposedToAccount,
                multisigAta: ata,
                proposedToAta: proposedToAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId

            })
            .signers([squadMintFeePayer, walletOwnerAndCreator.keyPair])
            .rpc()

        await expect(vote).to.be.rejected;
    });

    // ==================== Initialization Validation ====================

    it("Reject initialize with empty handle", async () => {
        const result = initializeAccount(program, walletOwnerAndCreator.keyPair, squadMintFeePayer, testMint.mintPubkey, "");
        await expect(result).to.be.rejected;
    });

    it("Reject initialize with handle exceeding 15 characters", async () => {
        const result = initializeAccount(program, walletOwnerAndCreator.keyPair, squadMintFeePayer, testMint.mintPubkey, "thisHandleIsTooLong");
        await expect(result).to.be.rejected;
    });

    it("Reject initialize with join amount below minimum", async () => {
        const owner = anchor.web3.Keypair.generate();
        const pda = await findPDAForAuthority(program.programId, owner.publicKey, "lowJoinFund");
        const pdaAta = await findATAForPDAForAuthority2(program.programId, pda);

        const result = program.methods.initialize("lowJoinFund", new BN(50000))
            .accounts({
                multisigOwner: owner.publicKey,
                feePayer: squadMintFeePayer.publicKey,
                multisig: pda,
                mint: testMint.mintPubkey,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .signers([owner, squadMintFeePayer])
            .rpc();

        await expect(result).to.be.rejected;
    });

    it("Same wallet handle by different owners succeeds", async () => {
        await initializeAccount(program, walletOwnerAndCreator2.keyPair, squadMintFeePayer, testMint.mintPubkey, "openFundWallet");

        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator2.keyPair.publicKey, "openFundWallet");
        const fund = await program.account.squadMintFund.fetch(pda);
        expect(fund.owner.toBase58()).to.equal(walletOwnerAndCreator2.keyPair.publicKey.toBase58());
        expect(fund.accountHandle).to.equal("openFundWallet");
        expect(fund.members).to.have.lengthOf(1);
    });

    it("Same wallet handle by same owner fails (PDA already exists)", async () => {
        const result = initializeAccount(program, walletOwnerAndCreator.keyPair, squadMintFeePayer, testMint.mintPubkey, "openFundWallet");
        await expect(result).to.be.rejected;
    });

    // ==================== Join Request Validation ====================

    it("Reject join request with wrong join amount", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
        );
        const wrongAmount = new BN(amountToSmalletDecimal(2.0));
        const result = initiateJoinRequest(
            program, pda, memberOpenFundWallet2, wrongAmount, squadMintFeePayer, testMint.mintPubkey
        );
        await expect(result).to.be.rejected;
    });

    // ==================== Sequential Proposals & Owner Proposing ====================

    it("Owner can create second proposal after first is decided (sequential nonce)", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const ata = await findATAForPDAForAuthority2(program.programId, pda);

        const fundBefore = await program.account.squadMintFund.fetch(pda);
        expect(fundBefore.masterNonce.eq(new BN(1))).to.be.true;
        expect(fundBefore.hasActiveVote).to.be.false;

        const transactionDataPDA = await findPDAForMultisigTransaction(
            program.programId, pda, "openFundWallet", fundBefore.masterNonce
        );

        const proposalAmount = new anchor.BN(amountToSmalletDecimal(0.5));
        await program.methods
            .createProposal(proposalAmount, proposedToWallet.keyPair.publicKey)
            .accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                proposer: walletOwnerAndCreator.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: proposedToWallet.keyPair.publicKey,
                multisigAta: ata,
                proposedToAta: proposedToWallet.ataAccount.address,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, walletOwnerAndCreator.keyPair])
            .rpc();

        const fund = await program.account.squadMintFund.fetch(pda);
        expect(fund.hasActiveVote).to.be.true;
        expect(fund.masterNonce.eq(new BN(1))).to.be.true;

        const tx = await program.account.transaction.fetch(transactionDataPDA);
        expect(tx.messageData.nonce.eq(new BN(1))).to.be.true;
        expect(tx.messageData.amount.eq(proposalAmount)).to.be.true;
        expect(tx.executors[0].toBase58()).to.equal(walletOwnerAndCreator.keyPair.publicKey.toBase58());
    });

    it("Recipient actually receives funds after approved transfer", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const ata = await findATAForPDAForAuthority2(program.programId, pda);

        const fundBefore = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(
            program.programId, pda, "openFundWallet", fundBefore.masterNonce
        );

        const multisigAtaBefore = await getAccount(connection, ata);
        const recipientAtaBefore = await getAccount(connection, proposedToWallet.ataAccount.address);

        const tx = await program.account.transaction.fetch(transactionDataPDA);
        const transferAmount = BigInt(tx.messageData.amount.toString());
        const proposedToAta = await findATAForPDAForAuthority(tx.messageData.proposedToAccount, testMint.mintPubkey);

        await program.methods.submitAndExecute(true)
            .accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                submitter: memberOpenFundWallet.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: tx.messageData.proposedToAccount,
                multisigAta: ata,
                proposedToAta: proposedToAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, memberOpenFundWallet.keyPair])
            .rpc();

        const multisigAtaAfter = await getAccount(connection, ata);
        const recipientAtaAfter = await getAccount(connection, proposedToWallet.ataAccount.address);

        expect(multisigAtaAfter.amount).to.equal(multisigAtaBefore.amount - transferAmount);
        expect(recipientAtaAfter.amount).to.equal(recipientAtaBefore.amount + transferAmount);

        const fund = await program.account.squadMintFund.fetch(pda);
        expect(fund.masterNonce.eq(new BN(2))).to.be.true;
        expect(fund.hasActiveVote).to.be.false;
    });

    // ==================== 3-Member Threshold ====================

    it("With 3 members, partial votes (1 yes, 1 no = 33% each) do not meet threshold, then 2 yes (66%) does", async () => {
        const pda = await findPDAForAuthority(
            program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
        );
        const ata = await findATAForPDAForAuthority2(program.programId, pda);

        const thirdMember = await createWallet(connection, testMint.mintPubkey, squadMintFeePayer, 2);
        const joinAmount = new BN(amountToSmalletDecimal(1.11));
        await initiateJoinRequest(program, pda, thirdMember, joinAmount, squadMintFeePayer, testMint.mintPubkey);

        const joinCustodialPDA = await findPDAForJoinCustodialAccount(program.programId, pda, thirdMember.keyPair.publicKey);
        await addMember(program, pda, joinCustodialPDA, thirdMember, walletOwnerAndCreator, walletOwnerAndCreator, squadMintFeePayer, testMint.mintPubkey);

        const fundWith3 = await program.account.squadMintFund.fetch(pda);
        expect(fundWith3.members).to.have.lengthOf(3);

        const transactionDataPDA = await findPDAForMultisigTransaction(
            program.programId, pda, "openFundWallet", fundWith3.masterNonce
        );

        const proposalAmount = new anchor.BN(1);
        await program.methods
            .createProposal(proposalAmount, proposedToWallet.keyPair.publicKey)
            .accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                proposer: walletOwnerAndCreator.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: proposedToWallet.keyPair.publicKey,
                multisigAta: ata,
                proposedToAta: proposedToWallet.ataAccount.address,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, walletOwnerAndCreator.keyPair])
            .rpc();

        const proposedToAta = await findATAForPDAForAuthority(proposedToWallet.keyPair.publicKey, testMint.mintPubkey);

        // Second member votes NO -> 1 yes (33%), 1 no (33%): neither meets threshold
        await program.methods.submitAndExecute(false)
            .accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                submitter: memberOpenFundWallet.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: proposedToWallet.keyPair.publicKey,
                multisigAta: ata,
                proposedToAta: proposedToAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, memberOpenFundWallet.keyPair])
            .rpc();

        const fundAfterPartial = await program.account.squadMintFund.fetch(pda);
        expect(fundAfterPartial.hasActiveVote).to.be.true;
        expect(fundAfterPartial.masterNonce.eq(new BN(2))).to.be.true;

        const txAfterPartial = await program.account.transaction.fetch(transactionDataPDA);
        expect(txAfterPartial.votes).to.have.lengthOf(2);
        expect(txAfterPartial.votes[0]).to.equal(true);
        expect(txAfterPartial.votes[1]).to.equal(false);
        expect(txAfterPartial.didMeetThreshold).to.be.false;

        // Third member votes YES -> 2 yes (66%), 1 no (33%): threshold met
        const multisigAtaBefore = await getAccount(connection, ata);

        await program.methods.submitAndExecute(true)
            .accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                submitter: thirdMember.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: proposedToWallet.keyPair.publicKey,
                multisigAta: ata,
                proposedToAta: proposedToAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, thirdMember.keyPair])
            .rpc();

        const fundAfterThreshold = await program.account.squadMintFund.fetch(pda);
        expect(fundAfterThreshold.hasActiveVote).to.be.false;
        expect(fundAfterThreshold.masterNonce.eq(new BN(3))).to.be.true;

        const txFinal = await program.account.transaction.fetch(transactionDataPDA);
        expect(txFinal.didMeetThreshold).to.be.true;
        expect(txFinal.votes).to.have.lengthOf(3);
        expect(txFinal.votes[0]).to.equal(true);
        expect(txFinal.votes[1]).to.equal(false);
        expect(txFinal.votes[2]).to.equal(true);

        const multisigAtaAfter = await getAccount(connection, ata);
        expect(multisigAtaAfter.amount).to.equal(multisigAtaBefore.amount - BigInt(proposalAmount.toString()));
    });

    // ==================== Transaction/Multisig Mismatch (P0 Security Fix) ====================

    it("Reject submit_and_execute when transaction PDA belongs to different multisig", async () => {
        const openFundPda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const openFundAta = await findATAForPDAForAuthority2(program.programId, openFundPda);

        const someOtherPda = await findPDAForAuthority(program.programId, walletOwnerAndCreator2.keyPair.publicKey, "someOtherFund");
        const someOtherAta = await findATAForPDAForAuthority2(program.programId, someOtherPda);

        const someOtherFund = await program.account.squadMintFund.fetch(someOtherPda);
        const someOtherTxPDA = await findPDAForMultisigTransaction(
            program.programId, someOtherPda, "someOtherFund", someOtherFund.masterNonce
        );

        // Create an active proposal on someOtherFund
        await program.methods
            .createProposal(new anchor.BN(1), proposedToWallet.keyPair.publicKey)
            .accounts({
                transaction: someOtherTxPDA,
                multisig: someOtherPda,
                feePayer: squadMintFeePayer.publicKey,
                proposer: walletOwnerAndCreator2.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: proposedToWallet.keyPair.publicKey,
                multisigAta: someOtherAta,
                proposedToAta: proposedToWallet.ataAccount.address,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, walletOwnerAndCreator2.keyPair])
            .rpc();

        const proposedToAta = await findATAForPDAForAuthority(proposedToWallet.keyPair.publicKey, testMint.mintPubkey);

        // Try to use someOtherFund's transaction with openFundWallet's multisig
        // Seed constraint: [b"proposal_tx_data", openFundWallet.key(), openFundWallet.nonce] won't match someOtherTxPDA
        const result = program.methods.submitAndExecute(true)
            .accounts({
                transaction: someOtherTxPDA,
                multisig: openFundPda,
                feePayer: squadMintFeePayer.publicKey,
                submitter: walletOwnerAndCreator.keyPair.publicKey,
                mint: testMint.mintPubkey,
                proposedToOwner: proposedToWallet.keyPair.publicKey,
                multisigAta: openFundAta,
                proposedToAta: proposedToAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, walletOwnerAndCreator.keyPair])
            .rpc();

        await expect(result).to.be.rejected;
    });
});
