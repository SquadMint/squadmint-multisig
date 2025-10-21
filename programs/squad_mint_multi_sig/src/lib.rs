use anchor_lang::prelude::*;

declare_id!("BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz");

#[program]
pub mod squad_mint_multi_sig {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, account_handle: String, is_private_group: bool) -> Result<()> {
        if account_handle.len() > SquadMintFund::SQUAD_MINT_MAX_HANDLE_SIZE {
            return Err(error!(ErrorCode::HandleLenNotValid));
        }
        msg!("Greetings from: {:?}", ctx.program_id);
        let fund = &mut ctx.accounts.fund;
        msg!("Account address: {} ", fund.key());
        fund.authority = *ctx.accounts.authority.key;
        fund.members.push(*ctx.accounts.authority.key); // This is possibly waste of space
        fund.has_active_vote = false;
        fund.is_private_group = is_private_group;
        fund.account_handle = account_handle; // There might be no need to save this value

        Ok(())
    }

    pub fn add_member(ctx: Context<UpdateFund>, new_member: Pubkey) -> Result<()> {
        msg!("Add member called from: {:?}", ctx.program_id);
        let fund = &mut ctx.accounts.fund;
        require!(fund.is_private_group, ErrorCode::OperationOnlyApplicableToPrivateGroupFund);
        require!(fund.members.len() < 15, ErrorCode::MaxMembersReached);
        require!(fund.authority.key() == *ctx.accounts.authority.key, ErrorCode::CannotAddMember);
        require!(!fund.members.contains(&new_member), ErrorCode::DuplicateMember);
        fund.members.push(new_member);

        msg!("Added new member: {:?}. Total members: {}", new_member, fund.members.len());

        Ok(())
    }

    // TODO: we will implement remove here
    // Adding

    pub fn init_transfer_vote(ctx: Context<UpdateFund>) -> Result<()> {
        msg!("Initiate vote to transfer, called from: {:?}", ctx.program_id);
        let fund = &mut ctx.accounts.fund;
        require!(fund.is_private_group, ErrorCode::OperationOnlyApplicableToPrivateGroupFund);
        require!(fund.has_active_vote, ErrorCode::CanOnlyInitOneVoteAtATime);
        require!(fund.members.contains(&ctx.accounts.authority.key), ErrorCode::MemberNotPartOfFund);
        fund.has_active_vote = true;

        Ok(())
    }

    // We need nonce accounts here with signatures to prove that yes 51%+ members of this group did vote YES or NO
    // So we will record their votes on client side with nonce accounts and the client will know that a 51%+
    // has been reached for either a yes or a no
    // we set has_active_vote = false and we make a transfer to destination_address
    pub fn withdraw_if_majority_yes(ctx: Context<UpdateFund>, destination_address: Pubkey) -> Result<()> {
        msg!("Initiate vote to transfer, called from: {:?}", ctx.program_id);
        let fund = &mut ctx.accounts.fund;
        require!(fund.is_private_group, ErrorCode::OperationOnlyApplicableToPrivateGroupFund);
        require!(fund.members.contains(&ctx.accounts.authority.key), ErrorCode::MemberNotPartOfFund);
        fund.has_active_vote = true;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(account_handle: String)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(init,
             payer = fee_payer,
             seeds = [account_handle.as_bytes(), authority.key().as_ref()],
             bump,
             space = 8 + SquadMintFund::MAX_SIZE,
    )]
    pub fund: Account<'info, SquadMintFund>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(Default, Debug)]
pub struct SquadMintFund {
    authority: Pubkey, // This is the person that init creating this fund he will soon add contributors
    // data: u64,
    account_handle: String,
    has_active_vote: bool,
    is_private_group: bool,
    members: Vec<Pubkey>
}

#[derive(Accounts)]
pub struct UpdateFund<'info> {
    #[account(mut, seeds = [fund.account_handle.as_bytes(), fund.authority.key().as_ref()], bump)]
    pub fund: Account<'info, SquadMintFund>,
    pub authority: Signer<'info>,
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
    #[msg("A group fund can only have one active vote at a time")]
    CanOnlyInitOneVoteAtATime


}

fn assert_unique_owners(owners: &[Pubkey]) -> Result<()> {
    for (i, owner) in owners.iter().enumerate() {
        require!(
            !owners.iter().skip(i + 1).any(|item| item == owner),
            ErrorCode::DuplicateMember
        )
    }
    Ok(())
}

impl SquadMintFund {
    pub const SQUAD_MINT_MAX_HANDLE_SIZE: usize = 15;
    pub const SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE: usize = 15;

    // account handle
    // + owner
    // + 15 member max vector pubkey
    pub const MAX_SIZE: usize = (4 + SquadMintFund::SQUAD_MINT_MAX_HANDLE_SIZE) + 32 + (4 + (SquadMintFund::SQUAD_MINT_MAX_PRIVATE_GROUP_SIZE * 32));
}