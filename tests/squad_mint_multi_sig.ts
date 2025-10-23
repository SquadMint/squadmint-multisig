import { SquadMintMultiSig } from "../target/types/squad_mint_multi_sig";
import chai from "chai";
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import {AnchorError, Program} from "@coral-xyz/anchor";

// Initialize chai-as-promised inside a setup function or describe block
let chaiAsPromised: any;

import {
  createWallet,
  findPDAForAuthority,
  getAllAccountsByAuthority,
  initializeAccount
} from "./helper_function";

const program = anchor.workspace.SquadMintMultiSig as Program<SquadMintMultiSig>;
const connection = anchor.getProvider().connection;
let walletOwnerAndCreator: anchor.web3.Keypair;
let squadMintFeePayer: anchor.web3.Keypair;
let walletOwnerAndCreator2: anchor.web3.Keypair;
let memberWallet1: anchor.web3.Keypair;
let memberWallet2: anchor.web3.Keypair;
let memberWallet3: anchor.web3.Keypair;

before(async () => {
  chaiAsPromised = await import("chai-as-promised");
  chai.use(chaiAsPromised.default);
  walletOwnerAndCreator = await createWallet(connection, 1);
  walletOwnerAndCreator2 = await createWallet(connection, 1);
  squadMintFeePayer = await createWallet(connection, 1);

  await initializeAccount(program, walletOwnerAndCreator, squadMintFeePayer, "openFundWallet")
  await initializeAccount(program, walletOwnerAndCreator, squadMintFeePayer, "openFundWallet2")
  await initializeAccount(program, walletOwnerAndCreator2, squadMintFeePayer, "someOtherFund")
})

describe("SquadMint Multisig program tests", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace
    .squadMintMultiSig as Program<SquadMintMultiSig>;

  it("Accounts are initialized correctly", async () => {
    // --- Wallet 1 Accounts ---
    const accountWallet1Data = await getAllAccountsByAuthority(
        program.account.squadMintFund,
        walletOwnerAndCreator.publicKey
    );

    // Expect exactly two funds owned by walletOwnerAndCreator
    expect(accountWallet1Data.length).to.equal(2);

    // Check first fund
    const firstFund = accountWallet1Data[0].account;
    expect(firstFund.owner.toBase58()).to.equal(walletOwnerAndCreator.publicKey.toBase58());
    expect(firstFund.accountHandle).to.equal("openFundWallet");
    expect(firstFund.hasActiveVote).to.be.false;
    expect(firstFund.isPrivateGroup).to.be.false;
    expect(firstFund.members).to.be.an("array").that.is.empty; // assuming no members yet
    expect(firstFund.masterNonce).to.equal(0); // adjust if you increment this elsewhere

    // Check second fund
    const secondFund = accountWallet1Data[1].account;
    expect(secondFund.owner.toBase58()).to.equal(walletOwnerAndCreator.publicKey.toBase58());
    expect(secondFund.accountHandle).to.equal("openFundWallet2");
    expect(secondFund.hasActiveVote).to.be.false;
    expect(secondFund.isPrivateGroup).to.be.false;
    expect(secondFund.members).to.be.an("array").that.is.empty;
    expect(secondFund.masterNonce).to.equal(0);

    const accountWallet2Data = await getAllAccountsByAuthority(
        program.account.squadMintFund,
        walletOwnerAndCreator2.publicKey
    );

    expect(accountWallet2Data.length).to.equal(1);

    const wallet2Fund = accountWallet2Data[0].account;
    expect(wallet2Fund.owner.toBase58()).to.equal(walletOwnerAndCreator2.publicKey.toBase58());
    expect(wallet2Fund.accountHandle).to.equal("someOtherFund");
    expect(wallet2Fund.hasActiveVote).to.be.false;
    expect(wallet2Fund.isPrivateGroup).to.be.false;
    expect(wallet2Fund.members).to.be.an("array").that.is.empty;
    expect(wallet2Fund.masterNonce).to.equal(0);
  });
});
