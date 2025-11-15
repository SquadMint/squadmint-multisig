import { SquadMintMultiSig } from "../target/types/squad_mint_multi_sig";
import chai from "chai";
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import {AnchorError, BN, Program} from "@coral-xyz/anchor";

// Initialize chai-as-promised inside a setup function or describe block
let chaiAsPromised: any;

import {
    amountToSmalletDecimal,
    checkAccountFieldsAreInitializedCorrectly,
    createFeePayerWallet,
    createTestMint,
    createWallet, decimals, findATAForPDAForAuthority,
    findATAForPDAForAuthority2, findATAForPDAForJoinCustodialAccount,
    findPDAForAuthority, findPDAForJoinCustodialAccount,
    findPDAForMultisigTransaction,
    getAllAccountsByAuthority,
    initializeAccount, transferTokens
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
let walletOwnerAndCreator: { keyPair: anchor.web3.Keypair, ataAddress: Account  };
let squadMintFeePayer: anchor.web3.Keypair;
let walletOwnerAndCreator2: { keyPair: anchor.web3.Keypair, ataAddress: Account  };
let memberOpenFundWallet: { keyPair: anchor.web3.Keypair, ataAddress: Account  };
let memberOpenFundWallet2: { keyPair: anchor.web3.Keypair, ataAddress: Account  };
let proposedToWallet: { keyPair: anchor.web3.Keypair, ataAddress: Account  };
let testMint: { mintPubkey: PublicKey; tokenAccountPubkey: PublicKey }

before(async () => {
  chaiAsPromised = await import("chai-as-promised");
  chai.use(chaiAsPromised.default);
    squadMintFeePayer = await createFeePayerWallet(connection, 5);

    testMint = await createTestMint(connection, squadMintFeePayer)

  memberOpenFundWallet = await createWallet(connection, testMint.mintPubkey, squadMintFeePayer,  5);
  proposedToWallet = await createWallet(connection, testMint.mintPubkey, squadMintFeePayer, 5);
  memberOpenFundWallet2 = await createWallet(connection, testMint.mintPubkey, squadMintFeePayer,  2);
  walletOwnerAndCreator = await createWallet(connection, testMint.mintPubkey, squadMintFeePayer,  4);
  walletOwnerAndCreator2 = await createWallet(connection, testMint.mintPubkey, squadMintFeePayer,  5);

  await initializeAccount(program, walletOwnerAndCreator.keyPair, squadMintFeePayer, testMint.mintPubkey, "openFundWallet")
  await initializeAccount(program, walletOwnerAndCreator.keyPair, squadMintFeePayer, testMint.mintPubkey,"openFundWallet2")
  await initializeAccount(program, walletOwnerAndCreator2.keyPair, squadMintFeePayer, testMint.mintPubkey, "someOtherFund")

})

describe("SquadMint Multisig program tests", () => {
  // Configure the client to use the local cluster.


  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace
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

        await transferTokens(connection, squadMintFeePayer, walletOwnerAndCreator.ataAddress.address, ata, walletOwnerAndCreator.keyPair, 2)
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

    it("Can Initiate Join Request Request to join to new group", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
        );
        const multisigAta = await findATAForPDAForAuthority2(program.programId, pda);
        const joinCustodialAccountPDA = await findPDAForJoinCustodialAccount(program.programId, pda, memberOpenFundWallet.keyPair.publicKey);
        const joinCustodialAccountATA = findATAForPDAForJoinCustodialAccount(program.programId, joinCustodialAccountPDA);
        const joinAmount = new BN(amountToSmalletDecimal(1.11));
        await program.methods.initiateJoinRequest(joinAmount)
            .accounts({
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                mint: testMint.mintPubkey,
                proposingJoiner: memberOpenFundWallet.keyPair.publicKey,
                proposingJoinerAta: memberOpenFundWallet.ataAddress.address,
                joinCustodialAccount: joinCustodialAccountPDA,
                joinCustodialAccountAta: joinCustodialAccountATA,
                multisigAta: multisigAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId // can remove this
            })
            .signers([squadMintFeePayer, memberOpenFundWallet.keyPair])
            .rpc()

        const custodial = await program.account.joinRequestCustodialWallet.fetch(joinCustodialAccountPDA);
        expect(custodial.joinAmount.eq(joinAmount)).to.be.true;
        expect(custodial.requestToJoinUser.toBase58()).to.equal(memberOpenFundWallet.keyPair.publicKey.toBase58());
        expect(custodial.requestToJoinSquadMintFund.toBase58()).to.equal(pda.toBase58());

        const tokenAccount = await getAccount(connection, joinCustodialAccountATA);
        expect(tokenAccount.amount.toString()).to.equal(joinAmount.toString());
        expect(tokenAccount.mint.toBase58()).to.equal(testMint.mintPubkey.toBase58());
    });

    return;

    it("Accept Join Request and add a new member correctly", async () => {
    const pda = await findPDAForAuthority(
        program.programId,
        walletOwnerAndCreator.keyPair.publicKey, "openFundWallet"
    );
      await program.methods.addMember(memberOpenFundWallet.keyPair.publicKey)
        .accounts({
          multisig: pda,
          multisigOwner: walletOwnerAndCreator.keyPair.publicKey
        })
        .signers([walletOwnerAndCreator.keyPair])
        .rpc()

    const fund = await program.account.squadMintFund.fetch(pda);
    expect(fund.members).to.have.lengthOf(2);
    expect(fund.members[1].toBase58()).to.equal(memberOpenFundWallet.keyPair.publicKey.toBase58());
  });

  it("try to add unInitialized member wallet to openFundWallet2", async () => {
    const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet2");
    let unInitializedMember = anchor.web3.Keypair.generate();
    await program.methods.addMember(unInitializedMember.publicKey)
        .accounts({
          multisig: pda,
          multisigOwner: walletOwnerAndCreator.keyPair.publicKey
        })
        .signers([walletOwnerAndCreator.keyPair])
        .rpc()

    const fund = await program.account.squadMintFund.fetch(pda);
    expect(fund.members).to.have.lengthOf(2);
    expect(fund.members[1].toBase58()).to.equal(unInitializedMember.publicKey.toBase58());
  });

    /// SKIP 1
  // Taking too long will skip for now
    it("try to add 15 uninitialized member wallets to openFundWallet2", async () => {
        const pda = await findPDAForAuthority(
            program.programId,
            walletOwnerAndCreator.keyPair.publicKey,
            "openFundWallet2"
        );

        const members: anchor.web3.Keypair[] = [];

        for (let i = 0; i < 13; i++) {
            members.push(anchor.web3.Keypair.generate());
        }

        for (const member of members) {
            await program.methods.addMember(member.publicKey)
                .accounts({
                    multisig: pda,
                    multisigOwner: walletOwnerAndCreator.keyPair.publicKey
                })
                .signers([walletOwnerAndCreator.keyPair])
                .rpc();
        }

        const fund = await program.account.squadMintFund.fetch(pda);
        expect(fund.members).to.have.lengthOf(15);
        for (let i = 0; i < members.length; i++) {
            expect(fund.members[i + 2].toBase58()).to.equal(members[i].publicKey.toBase58());
        }
    });

    /// SKIP 2
    it("try to add more than 15 uninitialized member wallets to openFundWallet2 should be rejected", async () => {
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

  it("When adding unInitialized wallet and sign with a wallet that's not owner", async () => {
    const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet2");
    let unInitializedMember = anchor.web3.Keypair.generate();

    let addMember = program.methods.addMember(unInitializedMember.publicKey)
        .accounts({
          multisig: pda,
          multisigOwner: walletOwnerAndCreator.keyPair.publicKey
        })
        .signers([walletOwnerAndCreator2.keyPair])
        .rpc()

    expect(addMember).to.be.rejected
  });

  it("When adding an existing member then should be rejected", async () => {
    const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet2");
    let addMember = program.methods.addMember(memberOpenFundWallet.keyPair.publicKey)
        .accounts({
          multisig: pda,
          multisigOwner: walletOwnerAndCreator.keyPair.publicKey
        })
        .signers([walletOwnerAndCreator.keyPair])
        .rpc()

    expect(addMember).to.be.rejected // BE MORE explict with the error here please
  });

    it("When adding a new member but signer is not part of the group", async () => {
        let unInitializedMember = anchor.web3.Keypair.generate();

        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet2");
        let addMember = program.methods.addMember(memberOpenFundWallet.keyPair.publicKey)
            .accounts({
                multisig: pda,
                multisigOwner: walletOwnerAndCreator.keyPair.publicKey
            })
            .signers([unInitializedMember])
            .rpc()

        expect(addMember).to.be.rejected
    });

  it("When adding an wallet Owner again as member then should be rejected", async () => {
    const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator2.keyPair.publicKey, "someOtherFund");
      let addMember = program.methods.addMember(walletOwnerAndCreator2.keyPair.publicKey)
        .accounts({
          multisig: pda,
          multisigOwner: walletOwnerAndCreator2.keyPair.publicKey
        })
        .signers([walletOwnerAndCreator2.keyPair])
        .rpc()

    expect(addMember).to.be.rejectedWith("This member already exists in this group");
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
                            proposedToAta: proposedToWallet.ataAddress.address,
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
                proposedToAta: proposedToWallet.ataAddress.address,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, memberOpenFundWallet.keyPair])
            .rpc();
        const ataAccountUpdated = await getAccount(connection, ata);
        expect(ataAccountUpdated.amount).to.be.equal(currentAmount)
        expect(createRejectionProposal).to.be.rejected
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
                proposedToAta: proposedToWallet.ataAddress.address,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, unInitializedMember])
            .rpc();

        expect(createRejectionProposal).to.be.rejected
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
        expect(fundTx.didMeetThreshold).to.be.eq( true)
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

    it.skip("Reject proposal when ATA doesn't have enough funds ", async () => {
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
                proposedToAta: proposedToWallet.ataAddress.address,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId
            })
            .signers([squadMintFeePayer, walletOwnerAndCreator2.keyPair])
            .rpc();
        expect(proposal).to.be.rejectedWith(/InsufficientFunds/);
    });


    it("Reject transfer when NO vote is 51% or more", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator2.keyPair.publicKey, "someOtherFund");
        const ata = await findATAForPDAForAuthority2(program.programId, pda);

        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(program.programId, pda, "someOtherFund", openFundWallet.masterNonce)
        // const openFundWalletTx = await program.account.transaction.fetch(transactionDataPDA);

        expect(openFundWallet.masterNonce.eq(new anchor.BN(0))).to.be.true
        expect(openFundWallet.hasActiveVote).to.be.eq(false)
        expect(openFundWallet.members).to.have.lengthOf(1);
        const multisigAccount = await getAccount(connection, ata)
        expect(multisigAccount.amount).to.equal(BigInt(0));

        await transferTokens(connection, squadMintFeePayer, walletOwnerAndCreator.ataAddress.address, ata, walletOwnerAndCreator.keyPair, 2)
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
                proposedToAta: proposedToWallet.ataAddress.address,
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

        expect(multisigAccount2.amount).to.equal(BigInt(10**6*2));

        await program.methods.addMember(memberOpenFundWallet2.keyPair.publicKey)
            .accounts({
                multisig: pda,
                multisigOwner: walletOwnerAndCreator2.keyPair.publicKey
            })
            .signers([walletOwnerAndCreator2.keyPair])
            .rpc()

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
                proposedToAta: proposedToWallet.ataAddress.address,
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
        expect(multisigAccount2.amount).to.equal(BigInt(10**6*2));

        expect(multisig.hasActiveVote).to.be.false
        expect(multisig.masterNonce.eq(new anchor.BN(1))).to.be.true

        expect(fundTx.didMeetThreshold).to.be.eq( false)
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

        expect(vote).to.be.rejected
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

        expect(vote).to.be.rejected
    });
});
