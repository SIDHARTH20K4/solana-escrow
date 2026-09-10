use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::{state::Escrow, ErrorCode, ESCROW_SEED};

#[derive(Accounts)]
pub struct Update<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    pub mint_a: InterfaceAccount<'info, Mint>,
    pub mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        has_one = maker,
        has_one = mint_a,
        has_one = mint_b,
        seeds = [ESCROW_SEED, maker.key().as_ref(), escrow.seed.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,
}

pub fn handler(ctx: Context<Update>, new_receive: u64) -> Result<()> {
    require!(new_receive > 0, ErrorCode::InvalidAmount);

    ctx.accounts.escrow.receive = new_receive;

    Ok(())
}