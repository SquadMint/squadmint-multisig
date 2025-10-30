import { SquadMintMultiSig } from "../target/types/squad_mint_multi_sig";
import chai from "chai";
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import {AnchorError, BN, Program} from "@coral-xyz/anchor";
import nacl from "tweetnacl";

// Initialize chai-as-promised inside a setup function or describe block
let chaiAsPromised: any;

import {
    checkAccountFieldsAreInitializedCorrectly,
    createFeePayerWallet,
    createTestMint,
    createWallet, decimals,
    findATAForPDAForAuthority,
    findPDAForAuthority,
    findPDAForMultisigTransaction,
    getAllAccountsByAuthority,
    initializeAccount, transferTokens
} from "./helper_function";

import {PublicKey} from "@solana/web3.js";
import {Account, getAccount, getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount} from "@solana/spl-token";

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
  testMint = await createTestMint(connection, squadMintFeePayer)
  squadMintFeePayer = await createFeePayerWallet(connection, 5);

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

    await checkAccountFieldsAreInitializedCorrectly(program, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
    await checkAccountFieldsAreInitializedCorrectly(program, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet2");
    await checkAccountFieldsAreInitializedCorrectly(program, walletOwnerAndCreator2.keyPair.publicKey, "someOtherFund");
  });

    it("Deposit USDC(decimal 6 token) to my multisig ATA", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const ata = await findATAForPDAForAuthority(pda, testMint.mintPubkey)
        const amount = BigInt(Number(1) / 10 ** decimals);
        const userTokenAccount = await getAccount(connection, ata);
        const currentAmount = userTokenAccount.amount;

        await transferTokens(connection, squadMintFeePayer, walletOwnerAndCreator.keyPair.publicKey, ata, walletOwnerAndCreator.keyPair, 2)
        const userTokenAccountUpdated = await getAccount(connection, ata);
        expect(userTokenAccountUpdated.amount).to.equal(currentAmount + BigInt(2));
    });

  it("Add a new member correctly", async () => {
    const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
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

  // WE NEED TO FUND the multisig ATA

  // TODO: test if we can fit 15 pubkeys

    it("We can successfully create a proposal", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");

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

        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(
            program.programId,
            pda,
            "openFundWallet",
            openFundWallet.masterNonce
        )

        const ata = await findATAForPDAForAuthority(pda, testMint.mintPubkey);
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
                systemProgram: anchor.web3.SystemProgram.programId // can remove this
            })
            .signers([squadMintFeePayer, memberOpenFundWallet.keyPair])
            .rpc();
        const ataAccountUpdated = await getAccount(connection, ata);
        expect(ataAccountUpdated.amount).to.be.equal(ataAccountUpdated.amount)
        expect(createRejectionProposal).to.be.rejected
        expect(openFundWallet.hasActiveVote).to.be.true
    });

    it("Should reject when proposer signer is not part of the group", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
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
                systemProgram: anchor.web3.SystemProgram.programId // can remove this
            })
            .signers([squadMintFeePayer, unInitializedMember])
            .rpc();

        expect(createRejectionProposal).to.be.rejected
        expect(openFundWallet.hasActiveVote).to.be.true
    });

    it("Accept transfer then submit and execute current proposal", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(program.programId, pda, "openFundWallet", openFundWallet.masterNonce)
        const oFundTxProposal = await program.account.transaction.fetch(transactionDataPDA);

        // Get ATA
        const ata = await findATAForPDAForAuthority(pda, testMint.mintPubkey);
        const ataAccount = await getAccount(connection, ata);
        const currentAmount = ataAccount.amount

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
            })
            .signers([squadMintFeePayer, walletOwnerAndCreator.keyPair])
            .rpc()


        const multisig = await program.account.squadMintFund.fetch(pda);
        const fundTx = await program.account.transaction.fetch(transactionDataPDA);

        const ataAccountUpdated = await getAccount(connection, ata);

        expect(ataAccountUpdated.amount).to.be.equal(BigInt(oFundTxProposal.messageData.amount.toString()) + currentAmount)
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

    it("Reject transfer when NO vote is 51% or more", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator2.keyPair.publicKey, "someOtherFund");
        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(program.programId, pda, "someOtherFund", openFundWallet.masterNonce)

        expect(openFundWallet.masterNonce.eq(new anchor.BN(0))).to.be.true
        expect(openFundWallet.hasActiveVote).to.be.eq(false)
        expect(openFundWallet.members).to.have.lengthOf(1);

        let amount = new anchor.BN(1);
        await program
            .methods
            .createProposal(amount, proposedToWallet.keyPair.publicKey).accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                proposer: walletOwnerAndCreator2.keyPair.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId // can remove this
            })
            .signers([squadMintFeePayer, walletOwnerAndCreator2.keyPair])
            .rpc();

        const f = await program.account.transaction.fetch(transactionDataPDA);

        expect(f.votes[0])
            .to.equal(true);


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
            })
            .signers([squadMintFeePayer, memberOpenFundWallet2.keyPair])
            .rpc()


        const multisig = await program.account.squadMintFund.fetch(pda);
        const fundTx = await program.account.transaction.fetch(transactionDataPDA);

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

        // TODO: check balance did not change
    });

    it("Reject duplicate vote on proposal", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(program.programId, pda, "openFundWallet", openFundWallet.masterNonce);

        let vote = program.methods.submitAndExecute(true)
            .accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                submitter: walletOwnerAndCreator.keyPair.publicKey,
            })
            .signers([squadMintFeePayer, walletOwnerAndCreator.keyPair])
            .rpc()

        expect(vote).to.be.rejected
    });

    it("Reject duplicate but flipped vote on proposal", async () => {
        const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.keyPair.publicKey, "openFundWallet");
        const openFundWallet = await program.account.squadMintFund.fetch(pda);
        const transactionDataPDA = await findPDAForMultisigTransaction(program.programId, pda, "openFundWallet", openFundWallet.masterNonce);

        let vote = program.methods.submitAndExecute(false)
            .accounts({
                transaction: transactionDataPDA,
                multisig: pda,
                feePayer: squadMintFeePayer.publicKey,
                submitter: walletOwnerAndCreator.keyPair.publicKey,
            })
            .signers([squadMintFeePayer, walletOwnerAndCreator.keyPair])
            .rpc()

        expect(vote).to.be.rejected
    });
});
