use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    ed25519_program,
    log::sol_log_compute_units,
    program::invoke,
    instruction::Instruction,
    pubkey::Pubkey,
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
    use anchor_lang::solana_program::vote::instruction::vote;
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
        require!(fund.members.len() < SquadMintFund::SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE, ErrorCode::MaxMembersReached);
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
        transaction.executors = vec![proposer];
        transaction.votes = vec![true];
        transaction.did_meet_threshold = false;
        multisig.has_active_vote = true;

        Ok(())
    }

    // We need nonce accounts here with signatures to prove that yes 51%+ members of this group did vote YES or NO
    // So we will record their votes on client side with nonce accounts and the client will know that a 51%+
    // has been reached for either a yes or a no
    // we set has_active_vote = false and we make a transfer to destination_address
    pub fn submit_and_execute(ctx: Context<SubmitAndExecute>,
                              vote: bool) -> Result<()> {

        msg!("Initiate vote to transfer, called from: {:?}", ctx.program_id);

        let transaction = &mut ctx.accounts.transaction;
        let multisig = &mut ctx.accounts.multisig;

        let yes_votes = transaction.votes.iter().filter(|&&v| v).count();
        let no_votes = transaction.votes.iter().filter(|&&v| !v).count();
        let total_members = multisig.members.len();
        let current_yes_percentage_signers = (yes_votes as f64 / total_members as f64) * 100.0f64;
        let current_no_percentage_signers = (no_votes as f64 / total_members as f64) * 100.0f64;

        if current_yes_percentage_signers >= SquadMintFund::SQUAD_MINT_THRESHOLD_PERCENTAGE {
            transaction.did_meet_threshold = true;
            multisig.has_active_vote = false;
            multisig.master_nonce = multisig
                .master_nonce
                .checked_add(1)
                .ok_or(ErrorCode::NonceOverflow)?;
            msg!("Transfer funds");
            sol_log_compute_units();
            msg!("CU_LOG: Final compute units logged above");
            return Ok(())
        } else if current_no_percentage_signers >= SquadMintFund::SQUAD_MINT_THRESHOLD_PERCENTAGE {
            transaction.did_meet_threshold = false;
            multisig.has_active_vote = false;
            multisig.master_nonce = multisig
                .master_nonce
                .checked_add(1)
                .ok_or(ErrorCode::NonceOverflow)?;
            // do nothing thats all
            sol_log_compute_units();
            msg!("CU_LOG: Final compute units logged above");
            return Ok(())
        }

        require!(!transaction.did_meet_threshold, ErrorCode::AlreadyExecuted);
        require!(transaction.message_data.nonce == multisig.master_nonce, ErrorCode::AlreadyExecutedInvalidNonce);
        require!(multisig.has_active_vote, ErrorCode::HasNoActiveVote);
        require!(multisig.members.len() > 0, ErrorCode::HasNoActiveVote);
        require!(multisig.members.contains(&ctx.accounts.submitter.key()), ErrorCode::MemberNotPartOfFund);
        require!(!transaction.executors.contains(&ctx.accounts.submitter.key()), ErrorCode::CannotVoteTwice);

        transaction.executors.push(ctx.accounts.submitter.key());
        transaction.votes.push(vote);

        sol_log_compute_units();
        msg!("CU_LOG: Final compute units logged above");
        Ok(())
    }

    pub fn close_declined_vote(ctx: Context<SubmitAndExecute>) -> Result<()> {
        let multisig = &mut ctx.accounts.multisig;
        let transaction = &mut ctx.accounts.transaction;

        let submitter = ctx.accounts.submitter.key();

        require!(!multisig.has_active_vote, ErrorCode::CanOnlyInitOneVoteAtATime);
        require!(multisig.members.contains(&submitter), ErrorCode::MemberNotPartOfFund);

        multisig.master_nonce = multisig
            .master_nonce
            .checked_add(1)
            .ok_or(ErrorCode::NonceOverflow)?;
        transaction.did_meet_threshold = false;
        multisig.has_active_vote = false;
        Ok(())
    }
}

// pub fn invoke_ed25519_precompile_multi(
//     ctx: &Context<SubmitAndExecute>,
//     messages: &[&[u8]],
//     signatures: &[[u8; SIGNATURE_SERIALIZED_SIZE]],
//     pubkeys: &[[u8; PUBKEY_SERIALIZED_SIZE]],
// ) -> Result<()> {
//     assert_eq!(messages.len(), signatures.len());
//     assert_eq!(signatures.len(), pubkeys.len());
//
//     let num_signatures = messages.len() as u8;
//     let mut instruction_data = Vec::new();
//     instruction_data.extend_from_slice(&[num_signatures, 0]); // padding
//
//     // Precompute offsets
//     let mut offsets_vec = Vec::with_capacity(messages.len());
//     let mut data_offset = DATA_START + (messages.len() * std::mem::size_of::<Ed25519SignatureOffsets>());
//
//     let mut signature_blocks = Vec::new();
//
//     for i in 0..messages.len() {
//         let public_key_offset = data_offset;
//         let signature_offset = public_key_offset + PUBKEY_SERIALIZED_SIZE;
//         let message_data_offset = signature_offset + SIGNATURE_SERIALIZED_SIZE;
//
//         let offsets = Ed25519SignatureOffsets {
//             signature_offset: signature_offset as u16,
//             signature_instruction_index: u16::MAX,
//             public_key_offset: public_key_offset as u16,
//             public_key_instruction_index: u16::MAX,
//             message_data_offset: message_data_offset as u16,
//             message_data_size: messages[i].len() as u16,
//             message_instruction_index: u16::MAX,
//         };
//
//         offsets_vec.push(offsets);
//
//         data_offset = message_data_offset + messages[i].len();
//
//         // Collect the actual data block
//         signature_blocks.extend_from_slice(&pubkeys[i]);
//         signature_blocks.extend_from_slice(&signatures[i]);
//         signature_blocks.extend_from_slice(messages[i]);
//     }
//
//     // Append offsets
//     for offsets in &offsets_vec {
//         instruction_data.extend_from_slice(bytemuck::bytes_of(offsets));
//     }
//
//     // Append actual signature/pubkey/message data
//     instruction_data.extend_from_slice(&signature_blocks);
//     let accounts = vec![solana_program::instruction::AccountMeta::new_readonly(
//         ed25519_program::id(),
//         false,
//     )];
//     // Build the instruction
//     let instruction = solana_program::instruction::Instruction {
//         program_id: ed25519_program::id(),
//         accounts: vec![], // still fine to keep empty
//         data: instruction_data,
//     };
//
//     let account_infos: &[AccountInfo] = &[
//         ctx.accounts.ed25519_program.to_account_info(),
//     ];
//
//     invoke(&instruction, account_infos)?;
//     Ok(())
// }

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
}
#[derive(Accounts)]
pub struct CloseDeclinedVote<'info> {
    #[account(mut)]
    pub transaction: Account<'info, Transaction>,
    #[account(mut)]
    pub multisig: Account<'info, SquadMintFund>,
    #[account(
        signer,
        constraint = multisig.members.contains(&submitter.key()) @ ErrorCode::MemberNotPartOfFund
    )]
    pub submitter: Signer<'info>,

    // we could also hard code our fee payer account here
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
    CannotVoteTwice
}