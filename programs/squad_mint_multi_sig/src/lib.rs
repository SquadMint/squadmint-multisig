use anchor_lang::prelude::*;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::invoke,
    pubkey::Pubkey,
    system_instruction,
};

declare_id!("BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz");
// https://github.com/pvnotpv/spl-transfer-pda-poc/blob/main/programs/spl-transfer-poc/src/lib.rs
// https://github.com/solana-developers/program-examples/tree/main/basics/transfer-sol/native/program
// https://github.com/solana-foundation/developer-content/blob/main/content/courses/onchain-development/anchor-pdas.md
#[program]
pub mod squad_mint_multi_sig {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, account_handle: String) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        if account_handle.len() > SquadMintFund::SQUAD_MINT_MAX_HANDLE_SIZE {
            return Err(error!(ErrorCode::HandleLenNotValid));
        }
        let fund = &mut ctx.accounts.multisig;
        msg!("Account address: {} ", fund.key());
        fund.owner = *ctx.accounts.multisig_owner.key;
        fund.members.push(*ctx.accounts.multisig_owner.key); // This is possibly waste of space, needs a better design (maybe), user exist in two places
        fund.has_active_vote = false;

        fund.is_private_group = true;                               // We will use this later (Maybe)
        fund.account_handle = account_handle.to_string();           // There might be no need to save this value

        Ok(())
    }

    pub fn add_member(ctx: Context<UpdateFund>, new_member: Pubkey) -> Result<()> {
        msg!("Add member called from: {:?}", ctx.program_id);
        let fund = &mut ctx.accounts.multisig;
        require!(fund.is_private_group, ErrorCode::OperationOnlyApplicableToPrivateGroupFund);
        require!(fund.members.len() < 15, ErrorCode::MaxMembersReached);
        require!(fund.owner.key() == *ctx.accounts.multisig_owner.key, ErrorCode::CannotAddMember);
        require!(!fund.members.contains(&new_member), ErrorCode::DuplicateMember);
        fund.members.push(new_member);

        msg!("Added new member: {:?}. Total members: {}", new_member.key(), fund.members.len());

        Ok(())
    }

    // TODO: we will implement remove here
    // Adding

    pub fn create_proposal(ctx: Context<CreateProposal>,
                           amount: u64,
                           proposed_to_account: Pubkey) -> Result<()> {
        msg!("Initiate vote to transfer, called from: {:?}", ctx.program_id);
        let transaction = &mut ctx.accounts.transaction;
        let multisig = &mut ctx.accounts.multisig;
        let proposer = ctx.accounts.proposer.key();

        require!(!multisig.has_active_vote, ErrorCode::CanOnlyInitOneVoteAtATime);
        require!(multisig.members.contains(&proposer), ErrorCode::MemberNotPartOfFund);

        // Would you like to check the amount balance vs what we have here as well

        transaction.belongs_to_squad_mint_fund = multisig.key();
        transaction.message_data = TransactionMessage {
            amount,
            proposer_account: proposer,
            proposed_to_account,
            nonce: multisig.master_nonce,
        };
        transaction.approved_signers = vec![proposer];
        transaction.did_execute = false;
        multisig.has_active_vote = true;

        Ok(())
    }

    // We need nonce accounts here with signatures to prove that yes 51%+ members of this group did vote YES or NO
    // So we will record their votes on client side with nonce accounts and the client will know that a 51%+
    // has been reached for either a yes or a no
    // we set has_active_vote = false and we make a transfer to destination_address
    pub fn submit_and_execute(ctx: Context<SubmitAndExecute>, signatures: Vec<[u8; 64]>) -> Result<()> {
        msg!("Initiate vote to transfer, called from: {:?}", ctx.program_id);
        let transaction = &mut ctx.accounts.transaction;
        let multisig = &mut ctx.accounts.multisig;

        require!(!transaction.did_execute, ErrorCode::AlreadyExecuted);
        require!(transaction.message_data.nonce == multisig.master_nonce, ErrorCode::AlreadyExecutedInvalidNonce);
        require!(multisig.has_active_vote, ErrorCode::HasNoActiveVote);

        for (_, pubkey) in transaction.approved_signers.iter().enumerate() {
            // TODO: verify signatures here
            require!(multisig.members.contains(&pubkey), ErrorCode::MemberNotPartOfFund);
        }

        let required = (multisig.members.len() * SquadMintFund::SQUAD_MINT_THRESHOLD_PERCENTAGE) / 100;
        require!(transaction.approved_signers.len() >= required, ErrorCode::InsufficientSignatures);
        require!(signatures.len() == transaction.approved_signers.len(), ErrorCode::InvalidSignature);

        transaction.signatures = signatures;
        multisig.master_nonce = multisig
            .master_nonce
            .checked_add(1)
            .ok_or(ErrorCode::NonceOverflow)?;

        transaction.did_execute = true;


        // Execute logic (e.g., CPI)
        // ...

        // let transfer_ix = system_instruction::transfer(
        //     &multisig.key(),
        //     &transaction.message_data.proposed_to_account.key(),
        //     transaction.message_data.amount,
        // );

        // invoke(
        //     &transfer_ix,
        //     &[
        //         ctx.accounts.multisig..to_account_info(),
        //         ctx.accounts.recipient.to_account_info(),
        //         ctx.accounts.system_program.to_account_info(),
        //     ],
        //     &[&[
        //         b"vault",
        //         multisig.key().as_ref(),
        //         &[ctx.accounts.multisig.vault_bump],
        //     ]],
        // )?;

        multisig.has_active_vote = false;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(account_handle: String)]
pub struct Initialize<'info> { // ADD a close argument here must be multisig_owner, the fee_payer maybe
    #[account(
        init,
        seeds = [account_handle.as_bytes(), multisig_owner.key().as_ref()],
        bump,
        payer = fee_payer,
        space = 8 + SquadMintFund::MAX_SIZE
    )]
    pub multisig: Account<'info, SquadMintFund>,
    #[account(signer)]
    pub multisig_owner: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,                   // TODO: think: we could verify this actually and keep it fixed in program?
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(Default, Debug)]
pub struct SquadMintFund {
    owner: Pubkey,     // This is the person that init creating this fund he will soon add contributors
    account_handle: String,
    has_active_vote: bool,
    is_private_group: bool,
    members: Vec<Pubkey>,
    master_nonce: u64
}
//
#[derive(Accounts)]
pub struct CreateProposal<'info> {
    #[account(init,
              payer = fee_payer,
              seeds = [multisig.account_handle.as_bytes(), multisig.key().as_ref(), multisig.master_nonce.to_le_bytes().as_ref()],
              bump,
              space = Transaction::MAX_SIZE)]
    pub transaction: Account<'info, Transaction>,
    #[account(mut)]
    pub multisig: Account<'info, SquadMintFund>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(
        signer,
        constraint = multisig.members.contains(&proposer.key()) @ ErrorCode::MemberNotPartOfFund
    )]
    pub proposer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateFund<'info> {
    #[account(mut,
        seeds = [multisig.account_handle.as_bytes(), multisig.owner.key().as_ref()],
        bump
    )]
    pub multisig: Account<'info, SquadMintFund>,
    #[account(
        constraint = multisig_owner.key() == multisig.owner @ ErrorCode::MemberNotPartOfFund
    )]
    pub multisig_owner: Signer<'info>,
}

#[account]
#[derive(Default, Debug)]
pub struct Transaction {
    pub belongs_to_squad_mint_fund: Pubkey, // Multisig account , this could be part of transaction message
    pub approved_signers: Vec<Pubkey>,      // Verified signer Pubkeys
    pub signatures: Vec<[u8; 64]>,          // Verified signatures (for audit), the first signers will correspond in sigs approvals and the last sigs will be the nos
    pub message_data: TransactionMessage,   // Signable message
    pub did_execute: bool                   // Replay protection
}

// This is what the members of this fund will sign
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, Debug)]
pub struct TransactionMessage {
    pub amount: u64,
    pub proposer_account: Pubkey,
    pub proposed_to_account: Pubkey,
    pub nonce: u64,
}

#[derive(Accounts)]
pub struct SubmitAndExecute<'info> {
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(mut)]
    pub transaction: Account<'info, Transaction>,
    #[account(mut)]
    pub multisig: Account<'info, SquadMintFund>,
    #[account(signer)]
    pub submitter: Signer<'info>,
}


impl SquadMintFund {
    pub const SQUAD_MINT_MAX_HANDLE_SIZE: usize = 15;
    pub const SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE: usize = 15;
    pub const SQUAD_MINT_THRESHOLD_PERCENTAGE: usize = 51;

    // account handle
    // + owner
    // + 15 member max vector pubkey
    pub const MAX_SIZE: usize = (4 + SquadMintFund::SQUAD_MINT_MAX_HANDLE_SIZE) + size_of::<SquadMintFund>() + (4 + (SquadMintFund::SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE * size_of::<Pubkey>()));
}

//
impl TransactionMessage {
    pub const SIZE: usize = size_of::<TransactionMessage>();
}

impl Transaction {
    pub const MAX_SIZE: usize =
            size_of::<Transaction>() +
            (4 + (SquadMintFund::SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE * size_of::<Pubkey>())) +    // approved_signers
            (4 + (SquadMintFund::SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE * size_of::<[u8; 64]>())) +  // signatures
            TransactionMessage::SIZE
    ;
}


#[error_code]
pub enum ErrorCode {
    #[msg("Handle length is not valid")]
    HandleLenNotValid,
    #[msg("Member could should not be more than 15")]
    MaxMembersReached,
    #[msg("This member already exists in this group")]
    DuplicateMember,
    #[msg("This member does not exists in this group")]
    MemberNotPartOfFund,
    #[msg("You are not the owner therefore cannot add new member")]
    CannotAddMember,
    #[msg("This operation is only applicable to group funds")]
    OperationOnlyApplicableToPrivateGroupFund,
    #[msg("Group fund has no active vote. Please create one first")]
    HasNoActiveVote,
    #[msg("A group fund can only have one active vote at a time")]
    CanOnlyInitOneVoteAtATime,
    #[msg("This transaction has already been executed")]
    AlreadyExecuted,
    #[msg("This transaction has already been executed. Invalid Nonce")]
    AlreadyExecutedInvalidNonce,
    InvalidSignature,
    InsufficientSignatures,
    NonceOverflow
}