use anchor_lang::prelude::*;

use crate::{error::ErrorCode, Vault};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    pub system_program: Program<'info, System>,
}

pub fn withdraw_handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let vault_info = ctx.accounts.vault.to_account_info();
    let owner_info = ctx.accounts.owner.to_account_info();

    require!(
        vault_info.lamports() >= amount,
        ErrorCode::InsufficientFunds
    );

    **vault_info.try_borrow_mut_lamports()? -= amount;
    **owner_info.try_borrow_mut_lamports()? += amount;

    Ok(())
}