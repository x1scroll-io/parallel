use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("GQBinKdihy1CB3GoD7HES5N4LQxZQWvwVrZA5VaAJKQL"); // replace after deploy

// ── FEE SPLIT (immutable once deployed) ──────────────────────────────────────
const TREASURY_BPS: u64 = 5000;   // 50% to x1scroll treasury (dead fee)
const BURN_BPS: u64 = 5000;       // 50% burned 🔥
const BASIS_POINTS: u64 = 10000;

// x1scroll treasury — hardcoded, cannot be changed
const TREASURY: &str = "A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK";

// Burn address — XNT sent here is unrecoverable
const BURN_ADDRESS: &str = "1nc1nerator11111111111111111111111111111111";

// Fee schedule (in lamports)
const BASE_FEE: u64 = 500;        // per bundle
const PER_TX_FEE: u64 = 50;       // per transaction in bundle
const MAX_BUNDLE_SIZE: u8 = 64;   // X1 max parallel txs per entry

#[program]
pub mod parallel_optimizer {
    use super::*;

    /// Pay optimization fee for a parallel bundle.
    /// Called once per optimized bundle submission.
    /// Splits 50% to treasury, 50% burned — immutable forever.
    ///
    /// @param tx_count: number of transactions in the bundle being optimized
    pub fn pay_bundle_fee(ctx: Context<PayBundleFee>, tx_count: u8) -> Result<()> {
        require!(tx_count > 0, ParallelError::EmptyBundle);
        require!(tx_count <= MAX_BUNDLE_SIZE, ParallelError::BundleTooLarge);

        // Calculate fee: base + per-tx
        let total_fee = BASE_FEE + (PER_TX_FEE * tx_count as u64);
        let treasury_amount = total_fee * TREASURY_BPS / BASIS_POINTS;
        let burn_amount = total_fee - treasury_amount; // remainder to burn

        // Transfer to treasury
        let cpi_treasury = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        );
        system_program::transfer(cpi_treasury, treasury_amount)?;

        // Burn — send to incinerator (permanently removes from supply)
        let cpi_burn = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.burn_address.to_account_info(),
            },
        );
        system_program::transfer(cpi_burn, burn_amount)?;

        // Update stats
        let stats = &mut ctx.accounts.stats;
        stats.total_bundles += 1;
        stats.total_transactions += tx_count as u64;
        stats.total_fees_collected += total_fee;
        stats.total_burned += burn_amount;

        emit!(BundleOptimized {
            payer: ctx.accounts.payer.key(),
            tx_count,
            total_fee,
            treasury_amount,
            burn_amount,
            slot: Clock::get()?.slot,
        });

        Ok(())
    }

    /// Initialize global stats account (called once by x1scroll)
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let stats = &mut ctx.accounts.stats;
        stats.total_bundles = 0;
        stats.total_transactions = 0;
        stats.total_fees_collected = 0;
        stats.total_burned = 0;
        stats.bump = ctx.bumps.stats;
        Ok(())
    }
}

// ── ACCOUNTS ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + OptimizerStats::LEN,
        seeds = [b"parallel-stats"],
        bump,
    )]
    pub stats: Account<'info, OptimizerStats>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayBundleFee<'info> {
    #[account(
        mut,
        seeds = [b"parallel-stats"],
        bump = stats.bump,
    )]
    pub stats: Account<'info, OptimizerStats>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: treasury — hardcoded in program
    #[account(
        mut,
        constraint = treasury.key().to_string() == TREASURY @ ParallelError::InvalidTreasury
    )]
    pub treasury: AccountInfo<'info>,
    /// CHECK: burn address — incinerator
    #[account(
        mut,
        constraint = burn_address.key().to_string() == BURN_ADDRESS @ ParallelError::InvalidBurnAddress
    )]
    pub burn_address: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

// ── STATE ─────────────────────────────────────────────────────────────────────

#[account]
pub struct OptimizerStats {
    pub total_bundles: u64,
    pub total_transactions: u64,
    pub total_fees_collected: u64,   // lamports
    pub total_burned: u64,           // lamports burned forever
    pub bump: u8,
}

impl OptimizerStats {
    pub const LEN: usize = 8 + 8 + 8 + 8 + 1;
}

// ── EVENTS ────────────────────────────────────────────────────────────────────

#[event]
pub struct BundleOptimized {
    pub payer: Pubkey,
    pub tx_count: u8,
    pub total_fee: u64,
    pub treasury_amount: u64,
    pub burn_amount: u64,
    pub slot: u64,
}

// ── ERRORS ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum ParallelError {
    #[msg("Bundle cannot be empty")]
    EmptyBundle,
    #[msg("Bundle exceeds X1 max parallel limit of 64 transactions")]
    BundleTooLarge,
    #[msg("Invalid treasury address")]
    InvalidTreasury,
    #[msg("Invalid burn address")]
    InvalidBurnAddress,
}
