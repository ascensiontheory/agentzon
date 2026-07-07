use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, BurnChecked, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("6aYkBvJUGYNycSGmUgMVCPvVUtZmxbNwguNNkBcQpVdw");

/// Revenue split (basis points). Seller 90%, burn 5%, treasury 5%.
const SELLER_BPS: u64 = 9000;
const BURN_BPS: u64 = 500;
const BPS_DENOM: u64 = 10_000;

/// AGENTZON Escrow — holds $AGENTZON for a skill execution, then splits
/// 90% seller / 5% burned / 5% treasury on release, or refunds the buyer on
/// timeout / dispute. Token-2022 compatible (transfer_checked / burn_checked).
#[program]
pub mod escrow {
    use super::*;

    /// One-time config: authority (release/refund signer), treasury token account, $AGENTZON mint.
    pub fn initialize(ctx: Context<Initialize>, treasury: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.bump = ctx.bumps.config;
        c.authority = ctx.accounts.authority.key();
        c.treasury = treasury;
        c.mint = ctx.accounts.mint.key();
        Ok(())
    }

    /// Buyer funds escrow for an execution.
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        execution_id: [u8; 16],
        amount: u64,
        deadline_seconds: i64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(deadline_seconds > 0, EscrowError::InvalidDeadline);

        let decimals = ctx.accounts.mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
            decimals,
        )?;

        let now = Clock::get()?.unix_timestamp;
        let seller_share = amount.checked_mul(SELLER_BPS).unwrap() / BPS_DENOM;
        let burn_amount = amount.checked_mul(BURN_BPS).unwrap() / BPS_DENOM;
        let treasury_share = amount.checked_sub(seller_share).unwrap().checked_sub(burn_amount).unwrap();

        let e = &mut ctx.accounts.escrow;
        e.bump = ctx.bumps.escrow;
        e.execution_id = execution_id;
        e.buyer = ctx.accounts.buyer.key();
        e.seller_token = ctx.accounts.seller_token.key();
        e.mint = ctx.accounts.config.mint;
        e.amount = amount;
        e.seller_share = seller_share;
        e.burn_amount = burn_amount;
        e.treasury_share = treasury_share;
        e.status = EscrowStatus::Funded;
        e.created_at = now;
        e.deadline_at = now + deadline_seconds;
        e.completed_at = None;

        emit!(EscrowFunded { escrow: e.key(), execution_id, buyer: e.buyer, amount });
        Ok(())
    }

    /// Release on successful delivery (authority only): 90% seller, 5% treasury, burn 5%.
    pub fn release_escrow(ctx: Context<ReleaseEscrow>) -> Result<()> {
        require!(ctx.accounts.escrow.status == EscrowStatus::Funded, EscrowError::NotFunded);
        require!(ctx.accounts.authority.key() == ctx.accounts.config.authority, EscrowError::Unauthorized);

        let eid = ctx.accounts.escrow.execution_id;
        let bump = ctx.accounts.escrow.bump;
        let seeds: &[&[u8]] = &[b"escrow", eid.as_ref(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        let decimals = ctx.accounts.mint.decimals;
        let (seller_share, treasury_share, burn_amount) = {
            let e = &ctx.accounts.escrow;
            (e.seller_share, e.treasury_share, e.burn_amount)
        };

        if seller_share > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.seller_token.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    signer,
                ),
                seller_share,
                decimals,
            )?;
        }
        if treasury_share > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.treasury_token.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    signer,
                ),
                treasury_share,
                decimals,
            )?;
        }
        if burn_amount > 0 {
            token_interface::burn_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    BurnChecked {
                        mint: ctx.accounts.mint.to_account_info(),
                        from: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    signer,
                ),
                burn_amount,
                decimals,
            )?;
        }

        let e = &mut ctx.accounts.escrow;
        e.status = EscrowStatus::Released;
        e.completed_at = Some(Clock::get()?.unix_timestamp);
        emit!(EscrowReleased { escrow: e.key(), execution_id: eid, seller_share, burn_amount, treasury_share });
        Ok(())
    }

    /// Refund the buyer. Allowed after deadline (anyone) or by authority (dispute).
    pub fn refund_escrow(ctx: Context<RefundEscrow>) -> Result<()> {
        require!(ctx.accounts.escrow.status == EscrowStatus::Funded, EscrowError::NotFunded);
        let now = Clock::get()?.unix_timestamp;
        let is_authority = ctx.accounts.caller.key() == ctx.accounts.config.authority;
        require!(is_authority || now >= ctx.accounts.escrow.deadline_at, EscrowError::DeadlineNotReached);

        let eid = ctx.accounts.escrow.execution_id;
        let bump = ctx.accounts.escrow.bump;
        let amount = ctx.accounts.escrow.amount;
        let decimals = ctx.accounts.mint.decimals;
        let seeds: &[&[u8]] = &[b"escrow", eid.as_ref(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.buyer_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer,
            ),
            amount,
            decimals,
        )?;

        let e = &mut ctx.accounts.escrow;
        e.status = EscrowStatus::Refunded;
        e.completed_at = Some(now);
        emit!(EscrowRefunded { escrow: e.key(), execution_id: eid, amount });
        Ok(())
    }
}

/* ----------------------------- Accounts ----------------------------- */

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + EscrowConfig::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, EscrowConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(execution_id: [u8; 16])]
pub struct CreateEscrow<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, EscrowConfig>,
    #[account(
        init,
        payer = buyer,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [b"escrow", execution_id.as_ref()],
        bump
    )]
    pub escrow: Account<'info, EscrowAccount>,
    #[account(
        init,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(token::mint = mint, token::token_program = token_program)]
    pub seller_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseEscrow<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, EscrowConfig>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.execution_id.as_ref()],
        bump = escrow.bump,
        has_one = seller_token,
        has_one = mint
    )]
    pub escrow: Account<'info, EscrowAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = escrow, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub seller_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = config.treasury)]
    pub treasury_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RefundEscrow<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, EscrowConfig>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.execution_id.as_ref()],
        bump = escrow.bump,
        has_one = mint,
        constraint = escrow.buyer == buyer_token.owner @ EscrowError::Unauthorized
    )]
    pub escrow: Account<'info, EscrowAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = escrow, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub caller: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

/* ------------------------------ State ------------------------------ */

#[account]
#[derive(InitSpace)]
pub struct EscrowConfig {
    pub bump: u8,
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub mint: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct EscrowAccount {
    pub bump: u8,
    pub execution_id: [u8; 16],
    pub buyer: Pubkey,
    pub seller_token: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub seller_share: u64,
    pub burn_amount: u64,
    pub treasury_share: u64,
    pub status: EscrowStatus,
    pub created_at: i64,
    pub deadline_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus { Funded, Released, Refunded, Disputed }

/* ------------------------------ Events ----------------------------- */

#[event]
pub struct EscrowFunded { pub escrow: Pubkey, pub execution_id: [u8; 16], pub buyer: Pubkey, pub amount: u64 }
#[event]
pub struct EscrowReleased { pub escrow: Pubkey, pub execution_id: [u8; 16], pub seller_share: u64, pub burn_amount: u64, pub treasury_share: u64 }
#[event]
pub struct EscrowRefunded { pub escrow: Pubkey, pub execution_id: [u8; 16], pub amount: u64 }

/* ------------------------------ Errors ----------------------------- */

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")] InvalidAmount,
    #[msg("Deadline must be greater than zero")] InvalidDeadline,
    #[msg("Escrow is not in a funded state")] NotFunded,
    #[msg("Deadline has not been reached")] DeadlineNotReached,
    #[msg("Unauthorized")] Unauthorized,
}
