pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

pub use constants::*;
pub use instructions::*;
pub use state::*;
pub use error::ErrorCode;

declare_id!("6cGBMGuFqwm1BQs3vdkCrFbcmJWnV6bUMPPRGAXp2ksU");

#[program]
pub mod solana_escrow {
    use super::*;

    pub fn make(
        ctx: Context<Make>,
        seed: u64,
        deposit: u64,
        receive: u64,
        expiration: i64,
    ) -> Result<()> {
        ctx.accounts
            .init_escrow(seed, receive, &ctx.bumps, expiration)?;
        ctx.accounts.deposit(deposit)
    }

    pub fn take(ctx: Context<Take>) -> Result<()> {
        ctx.accounts.deposit_to_maker()?;
        ctx.accounts.withdraw_and_close_vault()
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        ctx.accounts.refund_and_close_vault()
    }

    pub fn update(ctx: Context<Update>, new_receive: u64) -> Result<()> {
        require!(new_receive > 0, ErrorCode::InvalidAmount);
        ctx.accounts.escrow.receive = new_receive;
        Ok(())
    }
}