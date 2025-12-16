use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    account_info::{ next_account_info, AccountInfo },
    entrypoint::ProgramResult,
    // ed25519_program,
    // log::sol_log_compute_units,
    program::invoke,
    instruction::Instruction,
    pubkey::Pubkey,
};

use anchor_spl::{
    token::{Transfer, transfer, TransferChecked, transfer_checked , CloseAccount, close_account },
    associated_token::{AssociatedToken, get_associated_token_address},
    token_interface::{Mint, TokenAccount, TokenInterface}
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
// TODO: check is we need emit certain events as well to capture off app actions (FUTURE)
// Add checkes for the mints are as expected
#[program]
pub mod squad_mint_multi_sig {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, account_handle: String, join_amount: u64) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        if account_handle.len() == 0 || account_handle.len() > SquadMintFund::SQUAD_MINT_MAX_HANDLE_SIZE {
            return Err(error!(ErrorCode::HandleLenNotValid));
        }
        require!(join_amount > 100000, ErrorCode::InsufficientJoiningAmount);
        let fund = &mut ctx.accounts.multisig;
        msg!("Account address: {} ", fund.key());
        fund.owner = *ctx.accounts.multisig_owner.key;
        fund.members.push(*ctx.accounts.multisig_owner.key); // This is possibly waste of space, needs a better design (maybe), user exist in two places
        fund.has_active_vote = false;
        fund.master_nonce = 0;
        fund.join_amount = join_amount;
        fund.is_private_group = true;                               // We will use this later (Maybe)
        fund.account_handle = account_handle.to_string();           // There might be no need to save this value

        Ok(())
    }

    pub fn add_member(ctx: Context<UpdateFund>, new_member: Pubkey) -> Result<()> {
        msg!("Add member called from: {:?}", ctx.program_id);
        let multisig_key = ctx.accounts.multisig.key();
        let new_member_key = ctx.accounts.proposing_joiner.key(); // TODO: do better like in submit_and_execute

        let multisig = &mut ctx.accounts.multisig;
        let join_custodial_account = &mut ctx.accounts.join_custodial_account;

        require!(multisig.is_private_group, ErrorCode::OperationOnlyApplicableToPrivateGroupFund);
        require!(multisig.members.len() <= SquadMintFund::SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE, ErrorCode::MaxMembersReached);
        require_keys_eq!(multisig.owner.key(), *ctx.accounts.multisig_owner.key, ErrorCode::CannotAddMember);
        require!(!multisig.members.contains(&new_member), ErrorCode::DuplicateMember);
        require_keys_eq!(ctx.accounts.proposing_joiner.key(), new_member, ErrorCode::InvalidDestinationOwner);
        require_keys_eq!(join_custodial_account.request_to_join_user.key(), new_member, ErrorCode::DuplicateMember);
        require_keys_eq!(join_custodial_account.request_to_join_squad_mint_fund.key(), multisig_key, ErrorCode::DuplicateMember);
        require!(join_custodial_account.join_amount == multisig.join_amount, ErrorCode::InvalidDestinationOwner);

        let transfer_cpi = TransferChecked {
            from: ctx.accounts.join_custodial_account_ata.to_account_info(),
            to: ctx.accounts.multisig_ata.to_account_info(),
            authority: join_custodial_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
        };

        let join_custodial_account_seeds = &[
            b"join_custodial_account",
            multisig_key.as_ref(),
            new_member_key.as_ref(),
            &[ctx.bumps.join_custodial_account],
        ];

        let signer_seeds = &[&join_custodial_account_seeds[..]];

        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, transfer_cpi, signer_seeds);
        transfer_checked(
            cpi_ctx,
            join_custodial_account.join_amount,
            ctx.accounts.mint.decimals
        )?;

        multisig.members.push(new_member);

        let close_ata_cpi = CloseAccount {
            account: ctx.accounts.join_custodial_account_ata.to_account_info(),
            destination: ctx.accounts.fee_payer.to_account_info(),
            authority: join_custodial_account.to_account_info(),
        };
        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_ata_cpi,
            signer_seeds
        ))?;

        msg!("Added new member: {} | fund {}. Total members: {} | Deposited {} to ATA {} | Closing {} and Closing ATA: {}",
            new_member.key(),
            multisig.key() ,
            multisig.members.len(),
            join_custodial_account.join_amount,
            ctx.accounts.multisig_ata.key(),
            join_custodial_account.key(),
            ctx.accounts.join_custodial_account_ata.key());

        Ok(())
    }

    pub fn reject_member(ctx: Context<UpdateFund>, new_member: Pubkey) -> Result<()> {
        msg!("Calling reject member: {:?}", ctx.program_id);

        let multisig_key = ctx.accounts.multisig.key();
        let new_member_key = ctx.accounts.proposing_joiner.key();

        let multisig = &mut ctx.accounts.multisig;
        let join_custodial_account = &mut ctx.accounts.join_custodial_account;

        require!(multisig.is_private_group, ErrorCode::OperationOnlyApplicableToPrivateGroupFund);
        require_keys_eq!(multisig.owner.key(), *ctx.accounts.multisig_owner.key, ErrorCode::CannotAddMember);
        require_keys_eq!(join_custodial_account.request_to_join_user.key(), ctx.accounts.proposing_joiner.key(), ErrorCode::InvalidDestinationOwner);
        require!(!multisig.members.contains(&new_member), ErrorCode::DuplicateMember);
        require_keys_eq!(ctx.accounts.proposing_joiner.key(), new_member, ErrorCode::InvalidDestinationOwner);
        require_keys_eq!(join_custodial_account.request_to_join_squad_mint_fund.key(), multisig_key, ErrorCode::InvalidDestinationOwner);
        require!(join_custodial_account.join_amount == multisig.join_amount, ErrorCode::DuplicateMember);


        let transfer_cpi = TransferChecked {
            from: ctx.accounts.join_custodial_account_ata.to_account_info(),
            to: ctx.accounts.proposing_joiner_ata.to_account_info(),
            authority: join_custodial_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
        }; // TODO: To avoid abuse we need to take a small fee.

        let join_custodial_account_seeds = &[
            b"join_custodial_account",
            multisig_key.as_ref(),
            new_member_key.as_ref(),
            &[ctx.bumps.join_custodial_account],
        ];

        let signer_seeds = &[&join_custodial_account_seeds[..]];

        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(
            cpi_program,
            transfer_cpi,
            signer_seeds
        );
        transfer_checked(
            cpi_ctx,
            join_custodial_account.join_amount,
            ctx.accounts.mint.decimals
        )?;

        let close_ata_cpi = CloseAccount {
            account: ctx.accounts.join_custodial_account_ata.to_account_info(),
            destination: ctx.accounts.fee_payer.to_account_info(),
            authority: join_custodial_account.to_account_info(),
        };
        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_ata_cpi,
            signer_seeds
        ))?;

        msg!("Rejected new member: {} | fund {}. Total members: {} | Refunded {} to ATA {} | Closing {} and Closing ATA: {}",
            new_member.key(),
            multisig.key() ,
            multisig.members.len(),
            join_custodial_account.join_amount,
            ctx.accounts.proposing_joiner.key(),
            join_custodial_account.key(),
            ctx.accounts.join_custodial_account_ata.key());

        Ok(())
    }

    pub fn initiate_join_request(ctx: Context<CreateJoinRequestProposal>, join_amount: u64) -> Result<()> {
        msg!("Create join request proposal, called from: {:?} amount {:?}", ctx.program_id, join_amount);
        let multisig = &mut ctx.accounts.multisig;
        let join_custodial_account = &mut ctx.accounts.join_custodial_account;
        let proposing_joiner = &mut ctx.accounts.proposing_joiner;
        let proposing_joiner_ata: Pubkey = get_associated_token_address(&proposing_joiner.key(), &ctx.accounts.mint.key());
        require_keys_eq!(
            ctx.accounts.proposing_joiner_ata.key(),
            proposing_joiner_ata,
            ErrorCode::InvalidDestinationOwner
        );

        require!(join_amount == multisig.join_amount, ErrorCode::JoiningAmountShouldMatchTargetWallet);
        require!(!multisig.members.contains(proposing_joiner.key), ErrorCode::DuplicateMember);
        // SHOULD WE LIMIT THE JOIN AMOUNT TO HAVE A MINIMUM?

        let transfer_cpi = TransferChecked {
            from: ctx.accounts.proposing_joiner_ata.to_account_info(),
            to: ctx.accounts.join_custodial_account_ata.to_account_info(),
            authority: proposing_joiner.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
        };

        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, transfer_cpi);
        transfer_checked(cpi_ctx, join_amount, ctx.accounts.mint.decimals)?;
        join_custodial_account.request_to_join_user = proposing_joiner.key();
        join_custodial_account.join_amount = join_amount;
        join_custodial_account.request_to_join_squad_mint_fund = multisig.key();
        
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
        require!(ctx.accounts.multisig_ata.amount >= amount, ErrorCode::InsufficientFunds); // v2 will have this check as joining fee will add money here

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
        let proposed_to_ata: Pubkey = get_associated_token_address(&transaction.message_data.proposed_to_account, &ctx.accounts.mint.key());
        require_keys_eq!(
            proposed_to_ata,
            ctx.accounts.proposed_to_ata.key(),
            ErrorCode::InvalidDestinationOwner
        );
        let (expected_multisig_ata, expected_bump) = Pubkey::find_program_address(
            &[b"token_vault", multisig.key().as_ref()],
            ctx.program_id,
        );
        require_keys_eq!(
            expected_multisig_ata,
            ctx.accounts.multisig_ata.key(),
            ErrorCode::InvalidDestinationOwner
        );
        require!(
            expected_bump == ctx.bumps.multisig_ata,
            ErrorCode::InvalidDestinationOwner
        );
        let (gen_multisig_key, bump) = Pubkey::find_program_address(
            &[
                multisig.account_handle.as_bytes(),
                multisig.owner.key().as_ref(),
            ],
            ctx.program_id,
        );
        require_keys_eq!(
            gen_multisig_key.key(),
            multisig.key(),
            ErrorCode::InvalidDestinationOwner
        );

        let submitter_has_voted = transaction.executors.contains(&ctx.accounts.submitter.key());
        if !submitter_has_voted {
            require!(multisig.members.contains(&ctx.accounts.submitter.key()), ErrorCode::MemberNotPartOfFund);
            require!(!transaction.executors.contains(&ctx.accounts.submitter.key()), ErrorCode::CannotVoteTwice);
            transaction.executors.push(ctx.accounts.submitter.key());
            transaction.votes.push(vote);
            msg!("Has Voted {} on Fund {} to Fund {}. The vote: {}", &ctx.accounts.submitter.key(), multisig.key(), transaction.message_data.proposed_to_account.key() , if vote { "YES" } else { "NO" })
        }

        let yes_votes = transaction.votes.iter().filter(|&&v| v).count();
        let no_votes = transaction.votes.iter().filter(|&&v| !v).count();
        let total_members = multisig.members.len();
        let yes_percentage = (yes_votes as f64 / total_members as f64) * 100.0f64;
        let no_percentage = (no_votes as f64 / total_members as f64) * 100.0f64;
        let threshold = SquadMintFund::SQUAD_MINT_THRESHOLD_PERCENTAGE;
        if yes_percentage >= threshold || no_percentage >= 50.0f64 {
            msg!("threshold met closing proposal on exit");
            transaction.did_meet_threshold = yes_percentage >= threshold;
            multisig.has_active_vote = false;
            multisig.master_nonce = multisig
                .master_nonce
                .checked_add(1)
                .ok_or(ErrorCode::NonceOverflow)?;
            if yes_percentage >= threshold {
                msg!("Attempting to send funds to {:?} and multisig Key: {:?}", ctx.accounts.proposed_to_ata.key(), multisig.key() );
                let amount = transaction.message_data.amount;
                require!(ctx.accounts.multisig_ata.amount >= amount, ErrorCode::InsufficientFunds);
                let multisig_owner_key = multisig.owner.key();
                let multisig_seeds = &[
                    multisig.account_handle.as_bytes(),
                    multisig_owner_key.as_ref(),
                    &[bump]
                ];

                let signer_seeds = &[&multisig_seeds[..]];

                let cpi_accounts = Transfer {
                    from: ctx.accounts.multisig_ata.to_account_info(),
                    to: ctx.accounts.proposed_to_ata.to_account_info(),
                    authority: multisig.to_account_info(),
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
            return Ok(());
        }
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(account_handle: String)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(signer)]
    pub multisig_owner: Signer<'info>,
    #[account(
        init,
        seeds = [account_handle.as_bytes(), multisig_owner.key().as_ref()],
        bump,
        payer = fee_payer,
        space = 8 + SquadMintFund::MAX_SIZE
    )]
    pub multisig: Account<'info, SquadMintFund>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = fee_payer,
        seeds = [b"token_vault", multisig.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = multisig,
        token::token_program = token_program,
    )]
    pub multisig_ata: InterfaceAccount<'info, TokenAccount>,

    // PROGRAMS
    pub token_program: Interface<'info, TokenInterface>,
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
    join_amount: u64, // u32
    master_nonce: u64, // u32
    // This will always be a USDC account
}
//
#[derive(Accounts)]
pub struct CreateProposal<'info> { // This is a payment proposal
    #[account(init,
              payer = fee_payer,
              seeds = [b"proposal_tx_data", multisig.key().as_ref(), multisig.master_nonce.to_le_bytes().as_ref()],
              bump,
              space = 8 + Transaction::MAX_SIZE)]
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
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Validated via `proposed_to_account` in handler
    pub proposed_to_owner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"token_vault", multisig.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = multisig,
        token::token_program = token_program
    )]
    pub multisig_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = fee_payer,
        associated_token::mint = mint,
        associated_token::authority = proposed_to_owner,
        associated_token::token_program = token_program
    )]
    pub proposed_to_ata: InterfaceAccount<'info, TokenAccount>,

    // Programs
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateJoinRequestProposal<'info> {
    pub proposing_joiner: Signer<'info>,
    #[account(mut)]
    pub multisig: Account<'info, SquadMintFund>, // the multi sig we are requesting to join
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init,
              payer = fee_payer,
              seeds = [b"join_custodial_account", multisig.key().as_ref(), proposing_joiner.key().as_ref()],
              bump,
              space = 8 + JoinRequestCustodialWallet::MAX_SIZE)]
    pub join_custodial_account: Account<'info, JoinRequestCustodialWallet>,
    #[account(
        init,
        payer = fee_payer,
        seeds = [b"join_custodial_account_ata", join_custodial_account.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = join_custodial_account,
        token::token_program = token_program
    )]
    pub join_custodial_account_ata: InterfaceAccount<'info, TokenAccount>, // we can close this account and get our money back
    #[account(
        mut,
        seeds = [b"token_vault", multisig.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = multisig,
        token::token_program = token_program
    )]
    pub multisig_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = proposing_joiner,
        associated_token::token_program = token_program
    )]
    pub proposing_joiner_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
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
        mut,
        signer
    )]
    pub fee_payer: Signer<'info>,
    #[account(
        signer,
        constraint = multisig_owner.key() == multisig.owner @ ErrorCode::MemberNotPartOfFund
    )]
    pub multisig_owner: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: this is checked is done in program
    pub proposing_joiner: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = proposing_joiner,
        associated_token::token_program = token_program
    )]
    pub proposing_joiner_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mut,
              close = fee_payer,
              seeds = [b"join_custodial_account", multisig.key().as_ref(), proposing_joiner.key().as_ref()],
              bump,
    )]
    pub join_custodial_account: Account<'info, JoinRequestCustodialWallet>,
    #[account(
        mut,
        seeds = [b"join_custodial_account_ata", join_custodial_account.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = join_custodial_account,
        token::token_program = token_program,
    )]
    pub join_custodial_account_ata: InterfaceAccount<'info, TokenAccount>, // we can close this account and get our money back
    #[account(
        mut,
        seeds = [b"token_vault", multisig.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = multisig,
        token::token_program = token_program
    )]
    pub multisig_ata: InterfaceAccount<'info, TokenAccount>,

    // Programs
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
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
#[account]
#[derive(Default, Debug)]
pub struct JoinRequestCustodialWallet {
    pub request_to_join_squad_mint_fund: Pubkey,
    pub request_to_join_user: Pubkey,
    join_amount: u64 // it will be added to the pool of the squad
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
    /// CHECK: Validated via transaction.message_data.proposed_to_account
    pub proposed_to_owner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"token_vault", multisig.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = multisig,
        token::token_program = token_program
    )]
    pub multisig_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = fee_payer,
        associated_token::mint = mint,
        associated_token::authority = proposed_to_owner,
        associated_token::token_program = token_program
    )]
    pub proposed_to_ata: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,

    // Programs
    pub token_program: Interface<'info, TokenInterface>,
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

impl JoinRequestCustodialWallet {
    pub const MAX_SIZE: usize = size_of::<JoinRequestCustodialWallet>();
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
    #[msg("Member count should not exceed 15")]
    MaxMembersReached,
    #[msg("This member already exists in this group")]
    DuplicateMember,
    #[msg("This member does not exist in this group")]
    MemberNotPartOfFund,
    #[msg("You are not the owner and therefore cannot add a new member")]
    CannotAddMember,
    #[msg("This operation is only applicable to group funds")]
    OperationOnlyApplicableToPrivateGroupFund,
    #[msg("Group fund has no active vote. Please create one first")]
    HasNoActiveVote,
    #[msg("A group fund can only have one active vote at a time")]
    CanOnlyInitOneVoteAtATime,
    #[msg("This transaction has already been executed")]
    AlreadyExecuted,
    #[msg("This transaction has already been executed. Invalid nonce")]
    AlreadyExecutedInvalidNonce,
    #[msg("Invalid signature")]
    InvalidSignature,
    #[msg("Not enough signatures to complete this operation")]
    InsufficientSignatures,
    #[msg("Nonce overflow")]
    NonceOverflow,
    #[msg("You cannot vote twice on the same proposal")]
    CannotVoteTwice,
    #[msg("Invalid destination owner for this operation")]
    InvalidDestinationOwner,
    #[msg("Insufficient funds for this operation")]
    InsufficientFunds,
    #[msg("Insufficient joining amount")]
    InsufficientJoiningAmount,
    #[msg("Joining amount must be equal to that specified my by the wallet")]
    JoiningAmountShouldMatchTargetWallet,
}