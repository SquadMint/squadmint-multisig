use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    account_info::{ next_account_info, AccountInfo },
    entrypoint::ProgramResult,
    ed25519_program,
    log::sol_log_compute_units,
    program::invoke,
    instruction::Instruction,
    pubkey::Pubkey,
};

use  anchor_spl::{
    token::{ Mint, Token, TokenAccount, Transfer, transfer },
    associated_token::AssociatedToken
};

declare_id!("BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz");
// https://github.com/pvnotpv/spl-transfer-pda-poc/blob/main/programs/spl-transfer-poc/src/lib.rs
// https://github.com/solana-developers/program-examples/tree/main/basics/transfer-sol/native/program
// https://github.com/solana-foundation/developer-content/blob/main/content/courses/onchain-development/anchor-pdas.md
// https://www.anchor-lang.com/docs/references/account-constraints#accounthas_one--target
// https://www.anchor-lang.com/docs/references/account-constraints#accounttoken
// https://beta.solpg.io/https://github.com/solana-developers/anchor-examples/tree/main/account-constraints/toke
// https://solana.com/developers/cookbook/wallets/sign-message
// https://solana.stackexchange.com/questions/20848/encountering-an-account-required-by-the-instruction-is-missing-error-with-ed25
#[program]
pub mod squad_mint_multi_sig {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, account_handle: String) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        if account_handle.len() == 0 || account_handle.len() > SquadMintFund::SQUAD_MINT_MAX_HANDLE_SIZE {
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
        require!(fund.members.len() < SquadMintFund::SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE, ErrorCode::MaxMembersReached);
        require!(fund.owner.key() == *ctx.accounts.multisig_owner.key, ErrorCode::CannotAddMember);
        require!(!fund.members.contains(&new_member), ErrorCode::DuplicateMember);
        fund.members.push(new_member);

        msg!("Added new member: {} | fund {}. Total members: {}", new_member.key(), fund.key() , fund.members.len());

        Ok(())
    }

    // TODO: we will implement remove here, also add money to Tx
    // when a user wants to join as an escrow revert to them in rejected
    // must pass a joining ID account_handle-user_handle or UUID not sure

    pub fn create_proposal(ctx: Context<CreateProposal>,
                           amount: u64,
                           proposed_to_account: Pubkey) -> Result<()> {
        msg!("Initiate vote Create Proposal, called from: {:?}", ctx.program_id);
        let transaction = &mut ctx.accounts.transaction;
        let multisig = &mut ctx.accounts.multisig;
        let proposer = ctx.accounts.proposer.key();
        require_keys_eq!(
            ctx.accounts.proposed_to_owner.key(),
            proposed_to_account,
            ErrorCode::InvalidDestinationOwner
         );
        require!(!multisig.has_active_vote, ErrorCode::CanOnlyInitOneVoteAtATime);
        require!(multisig.members.contains(&proposer), ErrorCode::MemberNotPartOfFund);
        require!(ctx.accounts.multisig_ata.amount >= amount, ErrorCode::InsufficientFunds);

        transaction.belongs_to_squad_mint_fund = multisig.key();
        transaction.message_data = TransactionMessage {
            amount,
            proposer_account: proposer,
            proposed_to_account,
            nonce: multisig.master_nonce,
        };
        transaction.executors = vec![proposer];
        transaction.votes = vec![true];
        transaction.did_meet_threshold = false;
        multisig.has_active_vote = true;
        msg!(
            "Created TX | proposer: {} | multisig: {} | proposed_to_account: {}",
            proposer,
            multisig.key(),
            proposed_to_account
        );
        Ok(())
    }

    pub fn submit_and_execute(ctx: Context<SubmitAndExecute>,
                              vote: bool) -> Result<()> {
        msg!("Initiate vote to transfer, called from: {:?}", ctx.program_id);
        let multisig_key = ctx.accounts.multisig.key(); // Cache - something could be done better still learning Rust
        let transaction = &mut ctx.accounts.transaction;
        let multisig = &mut ctx.accounts.multisig;

        require!(multisig.has_active_vote, ErrorCode::HasNoActiveVote);
        require!(!transaction.did_meet_threshold, ErrorCode::AlreadyExecuted);
        require!(transaction.message_data.nonce == multisig.master_nonce, ErrorCode::AlreadyExecutedInvalidNonce);
        require!(!multisig.members.is_empty(), ErrorCode::HasNoActiveVote);
        require_keys_eq!(
            ctx.accounts.proposed_to_owner.key(),
            transaction.message_data.proposed_to_account,
            ErrorCode::InvalidDestinationOwner
        );

        let submitter_has_voted = transaction.executors.contains(&ctx.accounts.submitter.key());
        if !submitter_has_voted {
            require!(multisig.members.contains(&ctx.accounts.submitter.key()), ErrorCode::MemberNotPartOfFund);
            require!(!transaction.executors.contains(&ctx.accounts.submitter.key()), ErrorCode::CannotVoteTwice);
            transaction.executors.push(ctx.accounts.submitter.key());
            transaction.votes.push(vote);
            msg!("Has Voted {} to Fund {}. The vote: {}", &ctx.accounts.submitter.key(), multisig.key(), if vote { "YES" } else { "NO" })
        }

        let yes_votes = transaction.votes.iter().filter(|&&v| v).count();
        let no_votes = transaction.votes.len() - yes_votes;
        let total_members = multisig.members.len();
        let yes_percentage = (yes_votes as f64 / total_members as f64) * 100.0f64;
        let no_percentage = (no_votes as f64 / total_members as f64) * 100.0f64;
        let threshold = SquadMintFund::SQUAD_MINT_THRESHOLD_PERCENTAGE;
        if yes_percentage >= threshold || no_percentage >= 50.0f64 {
            transaction.did_meet_threshold = yes_percentage >= threshold;
            multisig.has_active_vote = false;
            multisig.master_nonce = multisig
                .master_nonce
                .checked_add(1)
                .ok_or(ErrorCode::NonceOverflow)?;
            if yes_percentage >= threshold {
                let amount = transaction.message_data.amount;
                require!(ctx.accounts.multisig_ata.amount >= amount, ErrorCode::InsufficientFunds);

                let seeds: &[&[u8]; 3] = &[
                    b"token_vault".as_ref(),
                    multisig_key.as_ref(),
                    &[ctx.bumps.multisig_ata],
                ];
                let signer_seeds: &[&[&[u8]]; 1] = &[&seeds[..]];

                let cpi_accounts = Transfer {
                    from: ctx.accounts.multisig_ata.to_account_info(),
                    to: ctx.accounts.proposed_to_ata.to_account_info(),
                    authority: ctx.accounts.multisig.to_account_info(),
                };
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                );
                transfer(cpi_ctx, amount)?;

                msg!("TRANSFERRED {} to {}", amount, transaction.message_data.proposed_to_account);
            }
            msg!("Threshold met , Exiting transaction {}. Submitter: {}", transaction.key(), ctx.accounts.submitter.key());
            sol_log_compute_units();
            msg!("CU_LOG: Final compute units logged above");
            return Ok(());
        }

        sol_log_compute_units();
        msg!("CU_LOG: Final compute units logged above");
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(account_handle: String)]
pub struct Initialize<'info> {
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
    pub fee_payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = fee_payer,
        seeds = [b"token_vault", multisig.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = multisig
    )]
    pub multisig_ata: Account<'info, TokenAccount>,

    // PROGRAMS
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(Default, Debug)]
pub struct SquadMintFund {
    owner: Pubkey,     // This is the person that init creating this fund he will soon add contributors
    account_handle: String, // convert to [u8; 15]
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
    pub mint: Account<'info, Mint>,
    /// CHECK: Validated via `proposed_to_account` in handler
    pub proposed_to_owner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"token_vault", multisig.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = multisig
    )]
    pub multisig_ata: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = fee_payer,
        associated_token::mint = mint,
        associated_token::authority = proposed_to_owner
    )]
    pub proposed_to_ata: Account<'info, TokenAccount>,

    // Programs
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateFund<'info> { // Should input amount and add this to the Tx to refund add to group
    #[account(mut,
        seeds = [multisig.account_handle.as_bytes(), multisig.owner.key().as_ref()],
        bump
    )]
    pub multisig: Account<'info, SquadMintFund>,
    #[account(
        signer,
        constraint = multisig_owner.key() == multisig.owner @ ErrorCode::MemberNotPartOfFund
    )]
    pub multisig_owner: Signer<'info>,
}

#[account]
#[derive(Default, Debug)]
pub struct Transaction {
    pub belongs_to_squad_mint_fund: Pubkey, // Multisig account , this could be part of transaction message
    pub executors: Vec<Pubkey>,             // Verified signer Pubkeys
    pub votes: Vec<bool>,                   //
    pub message_data: TransactionMessage,   // Signable message
    pub did_meet_threshold: bool            // Replay protection
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
    pub transaction: Account<'info, Transaction>,
    #[account(mut)]
    pub multisig: Account<'info, SquadMintFund>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(
        signer,
        constraint = multisig.members.contains(&submitter.key()) @ ErrorCode::MemberNotPartOfFund
    )]
    pub submitter: Signer<'info>,
    pub mint: Account<'info, Mint>,
    /// CHECK: Validated via transaction.message_data.proposed_to_account
    pub proposed_to_owner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"token_vault", multisig.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = multisig
    )]
    pub multisig_ata: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = fee_payer,
        associated_token::mint = mint,
        associated_token::authority = proposed_to_owner
    )]
    pub proposed_to_ata: Account<'info, TokenAccount>,

    // Programs
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl SquadMintFund {
    pub const SQUAD_MINT_MAX_HANDLE_SIZE: usize = 15;
    pub const SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE: usize = 15;
    pub const SQUAD_MINT_THRESHOLD_PERCENTAGE: f64 = 51.0;

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
    NonceOverflow,
    CannotVoteTwice,
    InvalidDestinationOwner,
    InsufficientFunds
}