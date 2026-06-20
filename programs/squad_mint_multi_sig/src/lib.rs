// anchor-lang 0.31's generated code (inside #[program]) still calls the
// deprecated AccountInfo::realloc. Not reachable from our code; remove this
// allow when upgrading Anchor.
#![allow(deprecated)]

use anchor_lang::prelude::*;
use anchor_lang::AccountsClose;

use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken},
    token::{close_account, transfer_checked, CloseAccount, TransferChecked},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

declare_id!("BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz");

#[cfg(feature = "mainnet")]
pub const USDC_MINT: Pubkey = Pubkey::from_str_const(env!(
    "SQUADMINT_USDC_MINT",
    "mainnet builds must set SQUADMINT_USDC_MINT (e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)"
));

#[cfg(not(feature = "mainnet"))]
pub const USDC_MINT: Pubkey = Pubkey::from_str_const(match option_env!("SQUADMINT_USDC_MINT") {
    Some(value) => value,
    None => "37KQMrbBtkNFYJvDKW3tGxEs1WuvqcEeu44JGrjPkYsz",
});

// TODO: check is we need emit certain events as well to capture off app actions (FUTURE)
// Add checkes for the mints are as expected
#[program]
pub mod squad_mint_multi_sig {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        account_handle: [u8; SquadMintFund::SQUAD_MINT_MAX_HANDLE_SIZE],
        join_amount: u64,
    ) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        // The handle is a fixed [u8; 15] (the UTF-8 string left-aligned, NUL-padded
        // by the client). The only thing to reject is an empty handle (all NUL).
        require!(
            account_handle.iter().any(|&b| b != 0),
            ErrorCode::HandleLenNotValid
        );
        require!(
            join_amount >= SquadMintFund::SQUAD_MINT_MIN_AMOUNT,
            ErrorCode::InsufficientJoiningAmount
        );
        let fund = &mut ctx.accounts.multisig;
        msg!("Account address: {} ", fund.key());
        fund.owner = *ctx.accounts.multisig_owner.key;
        fund.members.push(*ctx.accounts.multisig_owner.key); // This is possibly waste of space, needs a better design (maybe), user exist in two places
        fund.has_active_vote = false;
        fund.master_nonce = 0;
        fund.join_amount = join_amount;
        fund.account_handle = account_handle;

        Ok(())
    }

    pub fn add_member(ctx: Context<AddMember>, new_member: Pubkey) -> Result<()> {
        msg!("Add member called from: {:?}", ctx.program_id);
        let multisig_key = ctx.accounts.multisig.key();
        let new_member_key = ctx.accounts.proposing_joiner.key(); // TODO: do better like in submit_and_execute

        let multisig = &mut ctx.accounts.multisig;
        let join_custodial_account = &mut ctx.accounts.join_custodial_account;

        require!(
            multisig.members.len() < SquadMintFund::SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE,
            ErrorCode::MaxMembersReached
        );
        require_keys_eq!(
            multisig.owner.key(),
            *ctx.accounts.multisig_owner.key,
            ErrorCode::CannotAddMember
        );
        require!(
            !multisig.members.contains(&new_member),
            ErrorCode::DuplicateMember
        );
        require_keys_eq!(
            ctx.accounts.proposing_joiner.key(),
            new_member,
            ErrorCode::ProposingJoinerMismatch
        );
        require_keys_eq!(
            join_custodial_account.request_to_join_user.key(),
            new_member,
            ErrorCode::JoinRequestUserMismatch
        );
        require_keys_eq!(
            join_custodial_account.request_to_join_squad_mint_fund.key(),
            multisig_key,
            ErrorCode::JoinRequestFundMismatch
        );
        require!(
            join_custodial_account.join_amount == multisig.join_amount,
            ErrorCode::JoinAmountMismatch
        );

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
            ctx.accounts.mint.decimals,
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
            signer_seeds,
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

    pub fn reject_member(ctx: Context<RejectMember>, new_member: Pubkey) -> Result<()> {
        msg!("Calling reject member: {:?}", ctx.program_id);

        let multisig_key = ctx.accounts.multisig.key();
        let new_member_key = ctx.accounts.proposing_joiner.key();

        let multisig = &mut ctx.accounts.multisig;
        let join_custodial_account = &mut ctx.accounts.join_custodial_account;

        require_keys_eq!(
            multisig.owner.key(),
            *ctx.accounts.multisig_owner.key,
            ErrorCode::CannotAddMember
        );
        require_keys_eq!(
            join_custodial_account.request_to_join_user.key(),
            ctx.accounts.proposing_joiner.key(),
            ErrorCode::JoinRequestUserMismatch
        );
        require!(
            !multisig.members.contains(&new_member),
            ErrorCode::DuplicateMember
        );
        require_keys_eq!(
            ctx.accounts.proposing_joiner.key(),
            new_member,
            ErrorCode::ProposingJoinerMismatch
        );
        require_keys_eq!(
            join_custodial_account.request_to_join_squad_mint_fund.key(),
            multisig_key,
            ErrorCode::JoinRequestFundMismatch
        );
        require!(
            join_custodial_account.join_amount == multisig.join_amount,
            ErrorCode::JoinAmountMismatch
        );

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
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, transfer_cpi, signer_seeds);
        transfer_checked(
            cpi_ctx,
            join_custodial_account.join_amount,
            ctx.accounts.mint.decimals,
        )?;

        let close_ata_cpi = CloseAccount {
            account: ctx.accounts.join_custodial_account_ata.to_account_info(),
            destination: ctx.accounts.fee_payer.to_account_info(),
            authority: join_custodial_account.to_account_info(),
        };
        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_ata_cpi,
            signer_seeds,
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

    pub fn initiate_join_request(
        ctx: Context<CreateJoinRequestProposal>,
        join_amount: u64,
    ) -> Result<()> {
        msg!(
            "Create join request proposal, called from: {:?} amount {:?}",
            ctx.program_id,
            join_amount
        );
        let multisig = &mut ctx.accounts.multisig;
        let join_custodial_account = &mut ctx.accounts.join_custodial_account;
        let proposing_joiner = &mut ctx.accounts.proposing_joiner;
        let proposing_joiner_ata: Pubkey =
            get_associated_token_address(&proposing_joiner.key(), &ctx.accounts.mint.key());
        require_keys_eq!(
            ctx.accounts.proposing_joiner_ata.key(),
            proposing_joiner_ata,
            ErrorCode::InvalidDestinationOwner
        );

        require!(
            join_amount == multisig.join_amount,
            ErrorCode::JoiningAmountShouldMatchTargetWallet
        );
        require!(
            !multisig.members.contains(proposing_joiner.key),
            ErrorCode::DuplicateMember
        );
        require!(
            multisig.members.len() < SquadMintFund::SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE,
            ErrorCode::MaxMembersReached
        );

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

    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        amount: u64,
        proposed_to_account: Pubkey,
    ) -> Result<()> {
        msg!(
            "Initiate vote Create Proposal, called from: {:?}",
            ctx.program_id
        );
        let transaction = &mut ctx.accounts.transaction;
        let multisig = &mut ctx.accounts.multisig;
        let proposer = ctx.accounts.proposer.key();
        require_keys_eq!(
            ctx.accounts.proposed_to_owner.key(),
            proposed_to_account,
            ErrorCode::InvalidDestinationOwner
        );
        require!(
            !multisig.has_active_vote,
            ErrorCode::CanOnlyInitOneVoteAtATime
        );
        require!(
            multisig.members.contains(&proposer),
            ErrorCode::MemberNotPartOfFund
        );
        require!(
            amount >= SquadMintFund::SQUAD_MINT_MIN_AMOUNT,
            ErrorCode::InvalidProposalAmount
        );
        require!(
            ctx.accounts.multisig_ata.amount >= amount,
            ErrorCode::InsufficientFunds
        ); // v2 will have this check as joining fee will add money here

        transaction.belongs_to_squad_mint_fund = multisig.key();
        transaction.message_data = TransactionMessage {
            amount,
            proposer_account: proposer,
            proposed_to_account,
            nonce: multisig.master_nonce,
        };
        // The proposer auto-casts a YES vote. .position() doubles as the
        // membership check (already guaranteed by the account constraint) and
        // yields the proposer's bit index in `multisig.members`.
        let proposer_index = multisig
            .members
            .iter()
            .position(|m| m == &proposer)
            .ok_or(ErrorCode::MemberNotPartOfFund)?;
        let proposer_bit = 1u16 << proposer_index;
        transaction.voted_mask = proposer_bit; // proposer has voted
        transaction.votes = proposer_bit; // ...and the vote is YES
        transaction.did_meet_threshold = false;
        multisig.has_active_vote = true;
        // This Transaction's rent is auto-reclaimed in submit_and_execute when
        // the proposal is decided (no separate client-side close needed).

        msg!(
            "Created TX | proposer: {} | multisig: {} | proposed_to_account: {}",
            proposer,
            multisig.key(),
            proposed_to_account
        );
        Ok(())
    }

    pub fn submit_and_execute(ctx: Context<SubmitAndExecute>, vote: bool) -> Result<()> {
        msg!(
            "Initiate vote to transfer, called from: {:?}",
            ctx.program_id
        );

        let transaction = &mut ctx.accounts.transaction;
        let multisig = &mut ctx.accounts.multisig;

        require!(multisig.has_active_vote, ErrorCode::HasNoActiveVote);
        require!(!transaction.did_meet_threshold, ErrorCode::AlreadyExecuted);

        require!(!multisig.members.is_empty(), ErrorCode::HasNoActiveVote);
        require_keys_eq!(
            transaction.belongs_to_squad_mint_fund,
            multisig.key(),
            ErrorCode::ProposalFundMismatch
        );
        require_keys_eq!(
            ctx.accounts.proposed_to_owner.key(),
            transaction.message_data.proposed_to_account,
            ErrorCode::InvalidDestinationOwner
        );
        let proposed_to_ata: Pubkey = get_associated_token_address(
            &transaction.message_data.proposed_to_account,
            &ctx.accounts.mint.key(),
        );
        require_keys_eq!(
            proposed_to_ata,
            ctx.accounts.proposed_to_ata.key(),
            ErrorCode::InvalidDestinationOwner
        );

        // Find the submitter's index in the member list — that's their bit.
        // .position() does double duty: confirms membership AND yields the bit
        // index, replacing the separate .contains() membership check.
        let member_index = multisig
            .members
            .iter()
            .position(|m| m == &ctx.accounts.submitter.key())
            .ok_or(ErrorCode::MemberNotPartOfFund)?;
        let bit = 1u16 << member_index;

        let submitter_has_voted = transaction.voted_mask & bit != 0;
        if !submitter_has_voted {
            transaction.voted_mask |= bit; // mark as voted (double-vote protection)
            if vote {
                transaction.votes |= bit; // record YES; NO leaves the bit clear
            }
            msg!(
                "Has Voted {} on Fund {} to Fund {}. The vote: {}",
                &ctx.accounts.submitter.key(),
                multisig.key(),
                transaction.message_data.proposed_to_account.key(),
                if vote { "YES" } else { "NO" }
            )
        }

        // YES = set bits in `votes`. NO = voted but not YES (voted_mask & !votes).
        // Plain count_ones() is correct because members can't be deactivated while
        // a proposal is open, so every set bit belongs to a currently-active member.
        let yes_votes = transaction.votes.count_ones() as u64;
        let no_votes = (transaction.voted_mask & !transaction.votes).count_ones() as u64;
        let total_members = multisig.members.len() as u64;
        let yes_threshold = SquadMintFund::SQUAD_MINT_YES_THRESHOLD_PERCENTAGE;
        let no_threshold = SquadMintFund::SQUAD_MINT_NO_THRESHOLD_PERCENTAGE;
        let yes_meets = yes_votes * 100 >= yes_threshold * total_members;
        let no_meets = no_votes * 100 >= no_threshold * total_members;
        if yes_meets || no_meets {
            msg!("threshold met closing proposal on exit");
            transaction.did_meet_threshold = yes_meets;
            multisig.has_active_vote = false;
            multisig.master_nonce = multisig
                .master_nonce
                .checked_add(1)
                .ok_or(ErrorCode::NonceOverflow)?;
            if yes_meets {
                msg!(
                    "Attempting to send funds to {:?} and multisig Key: {:?}",
                    ctx.accounts.proposed_to_ata.key(),
                    multisig.key()
                );
                let amount = transaction.message_data.amount;
                require!(
                    ctx.accounts.multisig_ata.amount >= amount,
                    ErrorCode::InsufficientFunds
                );
                let multisig_owner_key = multisig.owner.key();
                let multisig_seeds = &[
                    multisig.account_handle.as_ref(),
                    multisig_owner_key.as_ref(),
                    &[ctx.bumps.multisig],
                ];

                let signer_seeds = &[&multisig_seeds[..]];

                let cpi_accounts = TransferChecked {
                    from: ctx.accounts.multisig_ata.to_account_info(),
                    to: ctx.accounts.proposed_to_ata.to_account_info(),
                    authority: multisig.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                };
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                );
                transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

                msg!(
                    "TRANSFERRED {} to {}",
                    amount,
                    transaction.message_data.proposed_to_account
                );
            }
            msg!(
                "Threshold met , Exiting transaction {}. Submitter: {}",
                transaction.key(),
                ctx.accounts.submitter.key()
            );
            ctx.accounts
                .transaction
                .close(ctx.accounts.fee_payer.to_account_info())?;
            return Ok(());
        }
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(account_handle: [u8; SquadMintFund::SQUAD_MINT_MAX_HANDLE_SIZE])]
pub struct Initialize<'info> {
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(signer)]
    pub multisig_owner: Signer<'info>,
    #[account(
        init,
        seeds = [account_handle.as_ref(), multisig_owner.key().as_ref()],
        bump,
        payer = fee_payer,
        space = 8 + SquadMintFund::MAX_SIZE
    )]
    pub multisig: Account<'info, SquadMintFund>,
    #[account(
        constraint = mint.key() == USDC_MINT @ ErrorCode::InvalidMint
    )]
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
    owner: Pubkey, // This is the person that init creating this fund he will soon add contributors
    // Fixed-width handle: exactly SQUAD_MINT_MAX_HANDLE_SIZE (15) bytes — the UTF-8
    // handle left-aligned and right-padded with trailing NUL (0) bytes. The client
    // pads the string before calling `initialize`. The same 15 bytes are used as a
    // PDA seed here and on every re-derivation, so derivation is always identical.
    account_handle: [u8; SquadMintFund::SQUAD_MINT_MAX_HANDLE_SIZE],
    has_active_vote: bool,
    members: Vec<Pubkey>,
    join_amount: u64,  // u32
    master_nonce: u64, // u32
}
//
#[derive(Accounts)]
pub struct CreateProposal<'info> {
    // This is a payment proposal
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
    #[account(
        constraint = mint.key() == USDC_MINT @ ErrorCode::InvalidMint
    )]
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
pub struct AddMember<'info> {
    #[account(mut,
        seeds = [multisig.account_handle.as_ref(), multisig.owner.key().as_ref()],
        bump
    )]
    pub multisig: Account<'info, SquadMintFund>,
    #[account(mut, signer)]
    pub fee_payer: Signer<'info>,
    #[account(
        signer,
        constraint = multisig_owner.key() == multisig.owner @ ErrorCode::CannotAddMember
    )]
    pub multisig_owner: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: validated against `new_member` and the custodial PDA seeds in the handler
    pub proposing_joiner: UncheckedAccount<'info>,
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
    pub join_custodial_account_ata: InterfaceAccount<'info, TokenAccount>,
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
    pub system_program: Program<'info, System>,
}

// N-1: reject_member refunds to the joiner's ATA; `init_if_needed` guarantees
// a rejection can never be blocked by the joiner having closed that ATA.
#[derive(Accounts)]
pub struct RejectMember<'info> {
    #[account(mut,
        seeds = [multisig.account_handle.as_ref(), multisig.owner.key().as_ref()],
        bump
    )]
    pub multisig: Account<'info, SquadMintFund>,
    #[account(mut, signer)]
    pub fee_payer: Signer<'info>,
    #[account(
        signer,
        constraint = multisig_owner.key() == multisig.owner @ ErrorCode::CannotAddMember
    )]
    pub multisig_owner: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: validated against `new_member` and the custodial PDA seeds in the handler
    pub proposing_joiner: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = fee_payer,
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
    pub join_custodial_account_ata: InterfaceAccount<'info, TokenAccount>,
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
pub struct Transaction { // Payment Proposal TX
    pub belongs_to_squad_mint_fund: Pubkey, // Multisig account , this could be part of transaction message
    pub voted_mask: u16, // bit i set = member i has cast a vote (participation)
    pub votes: u16,      // bit i set = member i voted YES (NO leaves the bit clear)
    pub message_data: TransactionMessage, // Signable message
    pub did_meet_threshold: bool,         // Replay protection
}
#[account]
#[derive(Default, Debug)]
pub struct JoinRequestCustodialWallet {
    pub request_to_join_squad_mint_fund: Pubkey,
    pub request_to_join_user: Pubkey,
    join_amount: u64, // it will be added to the pool of the squad
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
    #[account(
        mut,
        seeds = [b"proposal_tx_data", multisig.key().as_ref(), multisig.master_nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub transaction: Account<'info, Transaction>,
    #[account(
        mut,
        seeds = [multisig.account_handle.as_ref(), multisig.owner.key().as_ref()],
        bump,
    )]
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
    // 8 members max. Smaller cap → smaller SquadMintFund + Transaction
    // accounts → less upfront rent at fund/proposal creation.
    pub const SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE: usize = 8;
    // M-3: intentionally asymmetric quorum. Spending needs a 51% "yes"
    // supermajority (deliberately hard to withdraw); a 50% "no" can reject.
    pub const SQUAD_MINT_YES_THRESHOLD_PERCENTAGE: u64 = 51;
    pub const SQUAD_MINT_NO_THRESHOLD_PERCENTAGE: u64 = 50;
    // Shared minimum for join deposits and proposal payouts (no zero/dust amounts).
    // USDC has 6 decimals, so 100_000 base units = 0.1 USDC.
    pub const SQUAD_MINT_MIN_AMOUNT: u64 = 100_000;

    // Borsh on-chain byte budget. The 8-byte account discriminator is added
    // separately at the `space = 8 + MAX_SIZE` constraint.
    pub const MAX_SIZE: usize = 32                              // owner
        + Self::SQUAD_MINT_MAX_HANDLE_SIZE                      // account_handle: fixed [u8; 15], no length prefix
        + 1                                                     // has_active_vote
        + (4 + Self::SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE * 32)    // members: 4-byte len + pubkeys
        + 8                                                     // join_amount
        + 8; // master_nonce
}

impl TransactionMessage {
    // amount + proposer_account + proposed_to_account + nonce
    pub const SIZE: usize = 8 + 32 + 32 + 8;
}

impl JoinRequestCustodialWallet {
    // request_to_join_squad_mint_fund + request_to_join_user + join_amount
    pub const MAX_SIZE: usize = 32 + 32 + 8;
}

impl Transaction {
    // Two u16 bitmasks (voted_mask, votes) replace the old executors/votes Vecs,
    // collapsing ~503 bytes of variable-length data into a fixed 4 bytes. The u16
    // width holds 16 members, which comfortably covers SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE.
    pub const MAX_SIZE: usize = 32   // belongs_to_squad_mint_fund
        + 2                          // voted_mask
        + 2                          // votes
        + TransactionMessage::SIZE   // message_data
        + 1; // did_meet_threshold
}

#[error_code]
pub enum ErrorCode {
    #[msg("Handle length is not valid")]
    HandleLenNotValid,
    #[msg("Member count should not exceed 8")]
    MaxMembersReached,
    #[msg("This member already exists in this group")]
    DuplicateMember,
    #[msg("This member does not exist in this group")]
    MemberNotPartOfFund,
    #[msg("You are not the owner and therefore cannot add a new member")]
    CannotAddMember,
    #[msg("Group fund has no active vote. Please create one first")]
    HasNoActiveVote,
    #[msg("A group fund can only have one active vote at a time")]
    CanOnlyInitOneVoteAtATime,
    #[msg("This transaction has already been executed")]
    AlreadyExecuted,
    #[msg("Nonce overflow")]
    NonceOverflow,
    #[msg("Invalid destination owner for this operation")]
    InvalidDestinationOwner,
    #[msg("Insufficient funds for this operation")]
    InsufficientFunds,
    #[msg("Insufficient joining amount")]
    InsufficientJoiningAmount,
    #[msg("Joining amount must be equal to that specified my by the wallet")]
    JoiningAmountShouldMatchTargetWallet,
    #[msg("Fund must be created on the USDC mint")]
    InvalidMint,
    #[msg("Proposal does not belong to this fund")]
    ProposalFundMismatch,
    #[msg("Proposal amount is below the minimum")]
    InvalidProposalAmount,
    #[msg("Proposing joiner account does not match the new member key")]
    ProposingJoinerMismatch,
    #[msg("Join request was not created by this user")]
    JoinRequestUserMismatch,
    #[msg("Join request does not belong to this fund")]
    JoinRequestFundMismatch,
    #[msg("Join request amount does not match the fund's join amount")]
    JoinAmountMismatch,
}
