import { SquadMintMultiSig } from "../target/types/squad_mint_multi_sig";
import chai from "chai";
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import {AnchorError, Program} from "@coral-xyz/anchor";

// Initialize chai-as-promised inside a setup function or describe block
let chaiAsPromised: any;

import {
  checkAccountFieldsAreInitializedCorrectly,
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
  squadMintFeePayer = await createWallet(connection, 3);

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
    const accountWallet1Data = await getAllAccountsByAuthority(
        program.account.squadMintFund,
        walletOwnerAndCreator.publicKey
    );

    expect(accountWallet1Data.length).to.equal(2);

    await checkAccountFieldsAreInitializedCorrectly(program, walletOwnerAndCreator.publicKey, "openFundWallet");
    await checkAccountFieldsAreInitializedCorrectly(program, walletOwnerAndCreator.publicKey, "openFundWallet2");
    await checkAccountFieldsAreInitializedCorrectly(program, walletOwnerAndCreator2.publicKey, "someOtherFund");
  });

  it("Add a new member correctly", async () => {
    const pda = await findPDAForAuthority(program.programId, walletOwnerAndCreator.publicKey, "openFundWallet");
    const fund = await program.account.squadMintFund.fetch(pda);
    memberWallet1 = await createWallet(connection, 1);
    // await program.methods.addMember()
    //     .accounts({myAccount: pda, authority: wallet1.publicKey})
    //     .signers([wallet1])
    //     .rpc()

  });


});
