use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("8UWKUJSsqku5Ag6sbQTdHcGiNFpjU5moWF29QRcHVtJP");

/// 7-day unstake cooldown (seconds).
const UNSTAKE_COOLDOWN: i64 = 7 * 24 * 60 * 60;
/// Participation quorum: >=10% of staked supply must vote for a proposal to pass.
const QUORUM_BPS: u128 = 1000;
const BPS_DENOM: u128 = 10_000;

/// AGENTZON Governance — stake $AGENTZON (boosts reputation / vote weight) and
/// vote on proposals. Vote weight = staked balance. A proposal passes if yes > no
/// AND total votes >= 10% of staked supply. Token-2022 compatible.
#[program]
pub mod governance {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.bump = ctx.bumps.config;
        c.authority = ctx.accounts.authority.key();
        c.mint = ctx.accounts.mint.key();
        c.total_staked = 0;
        c.proposal_count = 0;
        Ok(())
    }

    /// Stake $AGENTZON into the governance vault.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, GovError::InvalidAmount);
        let decimals = ctx.accounts.mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.staker_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.staker.to_account_info(),
                },
            ),
            amount,
            decimals,
        )?;

        let now = Clock::get()?.unix_timestamp;
        let s = &mut ctx.accounts.stake_account;
        if s.staked_at == 0 {
            s.bump = ctx.bumps.stake_account;
            s.staker = ctx.accounts.staker.key();
            s.staked_at = now;
        }
        s.amount = s.amount.checked_add(amount).unwrap();
        s.unstake_requested_at = 0;

        ctx.accounts.config.total_staked = ctx.accounts.config.total_staked.checked_add(amount).unwrap();
        emit!(Staked { staker: s.staker, amount, total: s.amount });
        Ok(())
    }

    /// Begin the 7-day unstake cooldown.
    pub fn request_unstake(ctx: Context<RequestUnstake>) -> Result<()> {
        let s = &mut ctx.accounts.stake_account;
        require!(s.amount > 0, GovError::NothingStaked);
        s.unstake_requested_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Withdraw staked tokens after the cooldown elapses.
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (amount, requested) = {
            let s = &ctx.accounts.stake_account;
            (s.amount, s.unstake_requested_at)
        };
        require!(requested > 0, GovError::UnstakeNotRequested);
        require!(now >= requested + UNSTAKE_COOLDOWN, GovError::CooldownNotElapsed);
        require!(amount > 0, GovError::NothingStaked);

        let bump = ctx.accounts.config.bump;
        let seeds: &[&[u8]] = &[b"config", &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        let decimals = ctx.accounts.mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.staker_token.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            amount,
            decimals,
        )?;

        ctx.accounts.config.total_staked = ctx.accounts.config.total_staked.saturating_sub(amount);
        let s = &mut ctx.accounts.stake_account;
        s.amount = 0;
        s.unstake_requested_at = 0;
        emit!(Unstaked { staker: s.staker, amount });
        Ok(())
    }

    /// Create a governance proposal. Proposer must have an active stake.
    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        id: [u8; 16],
        title: String,
        description_uri: String,
        voting_period_secs: i64,
    ) -> Result<()> {
        require!(title.len() <= Proposal::MAX_TITLE, GovError::TooLong);
        require!(description_uri.len() <= Proposal::MAX_URI, GovError::TooLong);
        require!(voting_period_secs > 0, GovError::InvalidPeriod);
        require!(ctx.accounts.stake_account.amount > 0, GovError::NothingStaked);

        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.proposal;
        p.bump = ctx.bumps.proposal;
        p.id = id;
        p.proposer = ctx.accounts.proposer.key();
        p.title = title;
        p.description_uri = description_uri;
        p.created_at = now;
        p.voting_ends_at = now + voting_period_secs;
        p.yes_votes = 0;
        p.no_votes = 0;
        p.snapshot_total_staked = ctx.accounts.config.total_staked;
        p.status = ProposalStatus::Active;

        ctx.accounts.config.proposal_count = ctx.accounts.config.proposal_count.checked_add(1).unwrap();
        emit!(ProposalCreated { proposal: p.key(), id, proposer: p.proposer });
        Ok(())
    }

    /// Cast a vote weighted by staked balance. One vote per staker per proposal.
    pub fn vote(ctx: Context<CastVote>, in_favor: bool) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(ctx.accounts.proposal.status == ProposalStatus::Active, GovError::NotActive);
        require!(now < ctx.accounts.proposal.voting_ends_at, GovError::VotingClosed);
        let weight = ctx.accounts.stake_account.amount;
        require!(weight > 0, GovError::NothingStaked);

        let p = &mut ctx.accounts.proposal;
        if in_favor {
            p.yes_votes = p.yes_votes.checked_add(weight).unwrap();
        } else {
            p.no_votes = p.no_votes.checked_add(weight).unwrap();
        }
        let vr = &mut ctx.accounts.vote_record;
        vr.bump = ctx.bumps.vote_record;
        vr.proposal = p.key();
        vr.voter = ctx.accounts.voter.key();
        vr.weight = weight;
        vr.in_favor = in_favor;
        emit!(Voted { proposal: p.key(), voter: vr.voter, weight, in_favor });
        Ok(())
    }

    /// Finalize after voting ends: passes if yes > no AND participation >= 10%.
    pub fn finalize_proposal(ctx: Context<FinalizeProposal>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.proposal;
        require!(p.status == ProposalStatus::Active, GovError::NotActive);
        require!(now >= p.voting_ends_at, GovError::VotingNotEnded);

        let total = (p.yes_votes as u128) + (p.no_votes as u128);
        let quorum = (p.snapshot_total_staked as u128) * QUORUM_BPS / BPS_DENOM;
        p.status = if total >= quorum && p.yes_votes > p.no_votes {
            ProposalStatus::Passed
        } else {
            ProposalStatus::Rejected
        };
        emit!(ProposalFinalized { proposal: p.key(), passed: p.status == ProposalStatus::Passed });
        Ok(())
    }
}

/* ----------------------------- Accounts ----------------------------- */

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + GovConfig::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, GovConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = authority, associated_token::mint = mint, associated_token::authority = config, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, GovConfig>,
    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + StakeAccount::INIT_SPACE,
        seeds = [b"stake", staker.key().as_ref()],
        bump
    )]
    pub stake_account: Account<'info, StakeAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = config, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = staker, token::token_program = token_program)]
    pub staker_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub staker: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestUnstake<'info> {
    #[account(mut, seeds = [b"stake", staker.key().as_ref()], bump = stake_account.bump, has_one = staker)]
    pub stake_account: Account<'info, StakeAccount>,
    pub staker: Signer<'info>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, GovConfig>,
    #[account(mut, seeds = [b"stake", staker.key().as_ref()], bump = stake_account.bump, has_one = staker)]
    pub stake_account: Account<'info, StakeAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = config, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = staker, token::token_program = token_program)]
    pub staker_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub staker: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(id: [u8; 16])]
pub struct CreateProposal<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GovConfig>,
    #[account(seeds = [b"stake", proposer.key().as_ref()], bump = stake_account.bump, constraint = stake_account.staker == proposer.key() @ GovError::Unauthorized)]
    pub stake_account: Account<'info, StakeAccount>,
    #[account(
        init,
        payer = proposer,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [b"proposal", id.as_ref()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    #[account(mut)]
    pub proposer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CastVote<'info> {
    #[account(mut, seeds = [b"proposal", proposal.id.as_ref()], bump = proposal.bump)]
    pub proposal: Account<'info, Proposal>,
    #[account(seeds = [b"stake", voter.key().as_ref()], bump = stake_account.bump, constraint = stake_account.staker == voter.key() @ GovError::Unauthorized)]
    pub stake_account: Account<'info, StakeAccount>,
    #[account(
        init,
        payer = voter,
        space = 8 + VoteRecord::INIT_SPACE,
        seeds = [b"vote", proposal.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote_record: Account<'info, VoteRecord>,
    #[account(mut)]
    pub voter: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeProposal<'info> {
    #[account(mut, seeds = [b"proposal", proposal.id.as_ref()], bump = proposal.bump)]
    pub proposal: Account<'info, Proposal>,
    pub caller: Signer<'info>,
}

/* ------------------------------ State ------------------------------ */

#[account]
#[derive(InitSpace)]
pub struct GovConfig {
    pub bump: u8,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub total_staked: u64,
    pub proposal_count: u64,
}

#[account]
#[derive(InitSpace)]
pub struct StakeAccount {
    pub bump: u8,
    pub staker: Pubkey,
    pub amount: u64,
    pub staked_at: i64,
    pub unstake_requested_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub bump: u8,
    pub id: [u8; 16],
    pub proposer: Pubkey,
    #[max_len(128)]
    pub title: String,
    #[max_len(200)]
    pub description_uri: String,
    pub created_at: i64,
    pub voting_ends_at: i64,
    pub yes_votes: u64,
    pub no_votes: u64,
    pub snapshot_total_staked: u64,
    pub status: ProposalStatus,
}
impl Proposal {
    pub const MAX_TITLE: usize = 128;
    pub const MAX_URI: usize = 200;
}

#[account]
#[derive(InitSpace)]
pub struct VoteRecord {
    pub bump: u8,
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub weight: u64,
    pub in_favor: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum ProposalStatus { Active, Passed, Rejected }

/* ------------------------------ Events ----------------------------- */

#[event]
pub struct Staked { pub staker: Pubkey, pub amount: u64, pub total: u64 }
#[event]
pub struct Unstaked { pub staker: Pubkey, pub amount: u64 }
#[event]
pub struct ProposalCreated { pub proposal: Pubkey, pub id: [u8; 16], pub proposer: Pubkey }
#[event]
pub struct Voted { pub proposal: Pubkey, pub voter: Pubkey, pub weight: u64, pub in_favor: bool }
#[event]
pub struct ProposalFinalized { pub proposal: Pubkey, pub passed: bool }

/* ------------------------------ Errors ----------------------------- */

#[error_code]
pub enum GovError {
    #[msg("Amount must be greater than zero")] InvalidAmount,
    #[msg("Nothing staked")] NothingStaked,
    #[msg("Unstake was not requested")] UnstakeNotRequested,
    #[msg("Unstake cooldown has not elapsed")] CooldownNotElapsed,
    #[msg("String exceeds maximum length")] TooLong,
    #[msg("Invalid voting period")] InvalidPeriod,
    #[msg("Proposal is not active")] NotActive,
    #[msg("Voting has closed")] VotingClosed,
    #[msg("Voting has not ended")] VotingNotEnded,
    #[msg("Unauthorized")] Unauthorized,
}
