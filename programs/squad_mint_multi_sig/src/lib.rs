use anchor_lang::prelude::*;

declare_id!("BW1dtKfuqUPZxyYKfFCgUwo8tzqnGfw9of5L4yfAzuRz");

#[program]
pub mod squad_mint_multi_sig {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, account_handle: String) -> Result<()> {
        if account_handle.len() > SquadMintFund::SQUAD_MINT_MAX_HANDLE_SIZE {
            return Err(error!(ErrorCode::HandleLenNotValid));
        }

        msg!("Greetings from: {:?}", ctx.program_id);
        let fund = &mut ctx.accounts.fund;
        msg!("Account address: {} ", fund.key());
        fund.owner = *ctx.accounts.authority.key;
        fund.account_handle = account_handle; // There might be no need to save this value

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
    owner: Pubkey, // This is the person that init creating this fund he will soon add contributors
    // data: u64,
    account_handle: String,
    members: Vec<Pubkey>
}

#[derive(Accounts)]
#[instruction(account_handle: String)]
pub struct UpdateFund<'info> {
    #[account(mut, seeds = [account_handle.as_bytes(), authority.key().as_ref()], bump)]
    pub fund: Account<'info, SquadMintFund>,
    pub authority: Signer<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Handle length is not valid")]
    HandleLenNotValid,
}

impl SquadMintFund {
    pub const SQUAD_MINT_MAX_HANDLE_SIZE: usize = 15;

    // account handle
    // + owner
    // + 15 member max vector pubkey
    pub const MAX_SIZE: usize = (4 + SquadMintFund::SQUAD_MINT_MAX_HANDLE_SIZE) + 32 + (4 + (15 * 32));
}