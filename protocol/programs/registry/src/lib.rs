use anchor_lang::prelude::*;

declare_id!("rrQYPhuygZ6VkV37F7KmiHAjagf3k6m7CqjyEmkFV3J");

/// AGENTZON Registry — agent & skill registration, reputation.
/// Devnet build. Companion to the Escrow program (payments) and Governance (staking/voting).
#[program]
pub mod registry {
    use super::*;

    /// One-time protocol config (singleton PDA). Sets authority, treasury, and the $AGENTZON mint.
    pub fn initialize(ctx: Context<Initialize>, treasury: Pubkey, agentzon_mint: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.bump = ctx.bumps.config;
        c.authority = ctx.accounts.authority.key();
        c.treasury = treasury;
        c.agentzon_mint = agentzon_mint;
        c.total_agents = 0;
        c.total_skills = 0;
        Ok(())
    }

    /// Register an agent. PDA is one-per-operator: seeds ["agent", operator].
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_id: [u8; 16],
        name: String,
        metadata_uri: String,
    ) -> Result<()> {
        require!(name.len() <= AgentAccount::MAX_NAME, RegistryError::NameTooLong);
        require!(metadata_uri.len() <= AgentAccount::MAX_URI, RegistryError::UriTooLong);

        let agent = &mut ctx.accounts.agent;
        agent.bump = ctx.bumps.agent;
        agent.operator = ctx.accounts.operator.key();
        agent.agent_id = agent_id;
        agent.name = name;
        agent.reputation_score = 0;
        agent.total_executions = 0;
        agent.total_earnings = 0;
        agent.staked_amount = 0;
        agent.status = AgentStatus::Active;
        agent.registered_at = Clock::get()?.unix_timestamp;
        agent.metadata_uri = metadata_uri;

        let config = &mut ctx.accounts.config;
        config.total_agents = config.total_agents.saturating_add(1);

        emit!(AgentRegistered { agent: agent.key(), operator: agent.operator, agent_id });
        Ok(())
    }

    /// Update an agent's off-chain metadata URI (operator only).
    pub fn update_agent(ctx: Context<UpdateAgent>, metadata_uri: String) -> Result<()> {
        require!(metadata_uri.len() <= AgentAccount::MAX_URI, RegistryError::UriTooLong);
        ctx.accounts.agent.metadata_uri = metadata_uri;
        Ok(())
    }

    /// List a skill under the caller's agent. PDA seeds ["skill", agent, skill_id].
    pub fn list_skill(
        ctx: Context<ListSkill>,
        skill_id: [u8; 16],
        name: String,
        price: u64,
        category: SkillCategory,
        schema_uri: String,
    ) -> Result<()> {
        require!(name.len() <= SkillAccount::MAX_NAME, RegistryError::NameTooLong);
        require!(schema_uri.len() <= SkillAccount::MAX_URI, RegistryError::UriTooLong);
        require!(price > 0, RegistryError::InvalidPrice);
        require!(ctx.accounts.agent.status == AgentStatus::Active, RegistryError::AgentNotActive);

        let now = Clock::get()?.unix_timestamp;
        let skill = &mut ctx.accounts.skill;
        skill.bump = ctx.bumps.skill;
        skill.seller_agent = ctx.accounts.agent.key();
        skill.skill_id = skill_id;
        skill.name = name;
        skill.price = price;
        skill.category = category;
        skill.schema_uri = schema_uri;
        skill.execution_count = 0;
        skill.total_rating = 0;
        skill.rating_count = 0;
        skill.status = SkillStatus::Listed;
        skill.listed_at = now;
        skill.updated_at = now;

        let config = &mut ctx.accounts.config;
        config.total_skills = config.total_skills.saturating_add(1);

        emit!(SkillListed { skill: skill.key(), agent: skill.seller_agent, skill_id, price });
        Ok(())
    }

    /// Update price / status of a listed skill (operator only).
    pub fn update_skill(ctx: Context<UpdateSkill>, price: u64, status: SkillStatus) -> Result<()> {
        require!(price > 0, RegistryError::InvalidPrice);
        let skill = &mut ctx.accounts.skill;
        skill.price = price;
        skill.status = status;
        skill.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Delist a skill (operator only). Existing escrows remain valid.
    pub fn delist_skill(ctx: Context<UpdateSkill>) -> Result<()> {
        let skill = &mut ctx.accounts.skill;
        skill.status = SkillStatus::Delisted;
        skill.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Protocol-authority hook: called after an execution completes to update
    /// reputation, lifetime counters, and (optionally) a 1-5 star rating.
    pub fn update_reputation(
        ctx: Context<UpdateReputation>,
        execution_success: bool,
        rating: Option<u8>,
        earnings: u64,
    ) -> Result<()> {
        if let Some(r) = rating {
            require!((1..=5).contains(&r), RegistryError::InvalidRating);
        }
        let agent = &mut ctx.accounts.agent;
        agent.total_executions = agent.total_executions.saturating_add(1);
        agent.total_earnings = agent.total_earnings.saturating_add(earnings);

        // reputation scaled *100 (9420 == 94.20); success nudges up, failure penalizes harder.
        let delta: i64 = if execution_success { 30 } else { -80 };
        agent.reputation_score = ((agent.reputation_score as i64 + delta).clamp(0, 10_000)) as u64;

        // per-skill counters
        let skill = &mut ctx.accounts.skill;
        skill.execution_count = skill.execution_count.saturating_add(1);
        if let Some(r) = rating {
            skill.total_rating = skill.total_rating.saturating_add(r as u64);
            skill.rating_count = skill.rating_count.saturating_add(1);
        }
        Ok(())
    }
}

/* ----------------------------- Accounts ----------------------------- */

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_id: [u8; 16])]
pub struct RegisterAgent<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = operator,
        space = 8 + AgentAccount::INIT_SPACE,
        seeds = [b"agent", operator.key().as_ref()],
        bump
    )]
    pub agent: Account<'info, AgentAccount>,
    #[account(mut)]
    pub operator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    #[account(mut, seeds = [b"agent", operator.key().as_ref()], bump = agent.bump, has_one = operator)]
    pub agent: Account<'info, AgentAccount>,
    pub operator: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(skill_id: [u8; 16])]
pub struct ListSkill<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"agent", operator.key().as_ref()], bump = agent.bump, has_one = operator)]
    pub agent: Account<'info, AgentAccount>,
    #[account(
        init,
        payer = operator,
        space = 8 + SkillAccount::INIT_SPACE,
        seeds = [b"skill", agent.key().as_ref(), skill_id.as_ref()],
        bump
    )]
    pub skill: Account<'info, SkillAccount>,
    #[account(mut)]
    pub operator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateSkill<'info> {
    #[account(seeds = [b"agent", operator.key().as_ref()], bump = agent.bump, has_one = operator)]
    pub agent: Account<'info, AgentAccount>,
    #[account(
        mut,
        seeds = [b"skill", agent.key().as_ref(), skill.skill_id.as_ref()],
        bump = skill.bump,
        constraint = skill.seller_agent == agent.key() @ RegistryError::Unauthorized
    )]
    pub skill: Account<'info, SkillAccount>,
    pub operator: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateReputation<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub agent: Account<'info, AgentAccount>,
    #[account(mut, constraint = skill.seller_agent == agent.key() @ RegistryError::Unauthorized)]
    pub skill: Account<'info, SkillAccount>,
    #[account(constraint = authority.key() == config.authority @ RegistryError::Unauthorized)]
    pub authority: Signer<'info>,
}

/* ------------------------------ State ------------------------------ */

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub bump: u8,
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub agentzon_mint: Pubkey,
    pub total_agents: u64,
    pub total_skills: u64,
}

#[account]
#[derive(InitSpace)]
pub struct AgentAccount {
    pub bump: u8,
    pub operator: Pubkey,
    pub agent_id: [u8; 16],
    #[max_len(64)]
    pub name: String,
    pub reputation_score: u64,
    pub total_executions: u64,
    pub total_earnings: u64,
    pub staked_amount: u64,
    pub status: AgentStatus,
    pub registered_at: i64,
    #[max_len(200)]
    pub metadata_uri: String,
}
impl AgentAccount {
    pub const MAX_NAME: usize = 64;
    pub const MAX_URI: usize = 200;
}

#[account]
#[derive(InitSpace)]
pub struct SkillAccount {
    pub bump: u8,
    pub seller_agent: Pubkey,
    pub skill_id: [u8; 16],
    #[max_len(128)]
    pub name: String,
    pub price: u64,
    pub category: SkillCategory,
    #[max_len(200)]
    pub schema_uri: String,
    pub execution_count: u64,
    pub total_rating: u64,
    pub rating_count: u64,
    pub status: SkillStatus,
    pub listed_at: i64,
    pub updated_at: i64,
}
impl SkillAccount {
    pub const MAX_NAME: usize = 128;
    pub const MAX_URI: usize = 200;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum AgentStatus { Active, Suspended, Deactivated }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum SkillStatus { Listed, Delisted, Suspended }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum SkillCategory {
    MarketAnalysis, Content, Trading, Development, Data, Other,
}

/* ------------------------------ Events ----------------------------- */

#[event]
pub struct AgentRegistered { pub agent: Pubkey, pub operator: Pubkey, pub agent_id: [u8; 16] }
#[event]
pub struct SkillListed { pub skill: Pubkey, pub agent: Pubkey, pub skill_id: [u8; 16], pub price: u64 }

/* ------------------------------ Errors ----------------------------- */

#[error_code]
pub enum RegistryError {
    #[msg("Name exceeds maximum length")] NameTooLong,
    #[msg("URI exceeds maximum length")] UriTooLong,
    #[msg("Price must be greater than zero")] InvalidPrice,
    #[msg("Rating must be between 1 and 5")] InvalidRating,
    #[msg("Agent is not active")] AgentNotActive,
    #[msg("Unauthorized")] Unauthorized,
}
