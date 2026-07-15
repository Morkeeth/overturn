//! # phantom_escrow
//!
//! A parametric prop-bet escrow that **cannot pay out on a goal that didn't happen.**
//!
//! ## Why this exists
//!
//! On 2026-07-14, in the World Cup semi-final France v Spain, TxLINE's SSE stream published
//! Spain's 3rd goal at 20:22:29 (`Confirmed:false`). VAR reviewed it and it was retracted at
//! 20:22:55. The final record at 21:04:14 says Spain scored 2. For 26 seconds the stream said
//! 0-3, and it was never 0-3.
//!
//! The hackathon brief suggests using "the SSE Stream to dynamically trigger prediction
//! resolutions". An escrow with a keeper doing that pays out on the phantom goal, permanently.
//!
//! This program has **no keeper and no admin key**. The only path to moving money is a Merkle
//! proof that verifies on-chain via CPI into TxLINE's `validate_stat_v2`. The chain is the
//! oracle. The stream is only ever allowed to light up a UI.
//!
//! ## The three guards
//!
//! Verifying the proof is necessary but *not sufficient*. A valid proof still answers whatever
//! question you ask it, about whatever batch you hand it. So `settle` additionally enforces:
//!
//! 1. **Fixture binding** — the proof must be for *this* match.
//! 2. **Finality** — the proof's batch must cover the end of the match. Otherwise a *half-time*
//!    proof settles a full-match prop before the winning goal exists. The proof is honest; the
//!    settlement is theft.
//! 3. **Predicate binding** — the submitted strategy must match the predicate frozen at
//!    creation. Otherwise the settler chooses the question, and asks the one they win.
//!
//! Guards 2 and 3 are the difference between "we verified a proof" and "we settled correctly".

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
    system_instruction,
};

declare_id!("HhqbLLnNujBFmzRM97xEHM2zKfrqefcbAsXbgoLnxzdv");

/// Anchor discriminator for txoracle's `validate_stat_v2`, read from the published IDL v1.5.6.
const VALIDATE_STAT_V2_DISC: [u8; 8] = [208, 215, 194, 214, 241, 71, 246, 178];

pub const PROP_SEED: &[u8] = b"prop";

// ---------------------------------------------------------------------------
// Mirrors of txoracle's IDL types. These must serialise byte-identically to the oracle's
// expectations, so field order is load-bearing. Source:
// https://raw.githubusercontent.com/txodds/tx-on-chain/main/idl/txoracle.json (v1.5.6)
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatLeaf {
    pub stat: ScoreStat,
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatValidationInput {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub event_stat_root: [u8; 32],
    pub stats: Vec<StatLeaf>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum StatPredicate {
    Single {
        index: u8,
        predicate: TraderPredicate,
    },
    Binary {
        index_a: u8,
        index_b: u8,
        op: BinaryExpression,
        predicate: TraderPredicate,
    },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct GeometricTarget {
    pub stat_index: u8,
    pub prediction: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct NDimensionalStrategy {
    pub geometric_targets: Vec<GeometricTarget>,
    pub distance_predicate: Option<TraderPredicate>,
    pub discrete_predicates: Vec<StatPredicate>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PropState {
    Open,
    Matched,
    Settled,
    Cancelled,
}

#[account]
pub struct Prop {
    pub maker: Pubkey,
    pub taker: Pubkey,
    /// The oracle this prop is bound to, pinned at creation so a settler cannot substitute one.
    pub oracle: Pubkey,
    pub fixture_id: i64,
    /// TxLINE stat key (1 = Participant1 goals, 2 = Participant2 goals, 7/8 = corners, ...).
    pub stat_key: u32,
    pub stat_period: i32,
    pub threshold: i32,
    pub comparison: Comparison,
    pub stake: u64,
    /// Unix seconds. Earliest legal settlement, and the finality bar the proof must clear.
    pub settle_after: i64,
    pub state: PropState,
    pub yes_won: bool,
    pub nonce: u64,
    pub bump: u8,
}

impl Prop {
    pub const SIZE: usize = 8 + 96 + 8 + 4 + 4 + 4 + 1 + 8 + 8 + 1 + 1 + 8 + 1 + 16;
}

#[error_code]
pub enum PhantomError {
    #[msg("prop is not open for taking")]
    NotOpen,
    #[msg("prop is not matched")]
    NotMatched,
    #[msg("maker cannot take their own prop")]
    SelfTake,
    #[msg("too early: the match is not over yet")]
    TooEarly,
    #[msg("GUARD 1: proof is for a different fixture")]
    FixtureMismatch,
    #[msg("GUARD 2: proof batch does not cover the end of the match")]
    ProofNotFinal,
    #[msg("GUARD 3: submitted strategy does not match the predicate this prop was created with")]
    PredicateMismatch,
    #[msg("proof is for a different stat than this prop")]
    StatMismatch,
    #[msg("oracle account does not match the one this prop was bound to")]
    OracleMismatch,
    #[msg("oracle returned no data")]
    NoReturnData,
    #[msg("prop is not settled")]
    NotSettled,
    #[msg("caller is not the winner")]
    NotWinner,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod phantom_escrow {
    use super::*;

    /// Maker opens a prop and funds one side. The predicate is frozen here, on-chain, before
    /// anyone knows the answer. Guard 3 later holds the settler to exactly this.
    #[allow(clippy::too_many_arguments)]
    pub fn create_prop(
        ctx: Context<CreateProp>,
        nonce: u64,
        fixture_id: i64,
        stat_key: u32,
        stat_period: i32,
        threshold: i32,
        comparison: Comparison,
        stake: u64,
        settle_after: i64,
    ) -> Result<()> {
        {
            let p = &mut ctx.accounts.prop;
            p.maker = ctx.accounts.maker.key();
            p.taker = Pubkey::default();
            p.oracle = ctx.accounts.oracle.key();
            p.fixture_id = fixture_id;
            p.stat_key = stat_key;
            p.stat_period = stat_period;
            p.threshold = threshold;
            p.comparison = comparison;
            p.stake = stake;
            p.settle_after = settle_after;
            p.state = PropState::Open;
            p.yes_won = false;
            p.nonce = nonce;
            p.bump = ctx.bumps.prop;
        }

        invoke(
            &system_instruction::transfer(
                &ctx.accounts.maker.key(),
                &ctx.accounts.prop.key(),
                stake,
            ),
            &[
                ctx.accounts.maker.to_account_info(),
                ctx.accounts.prop.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        msg!(
            "prop opened: fixture {} stat {} {:?} {}",
            fixture_id,
            stat_key,
            comparison,
            threshold
        );
        Ok(())
    }

    /// Counterparty takes the other side with a matching stake.
    pub fn take_prop(ctx: Context<TakeProp>) -> Result<()> {
        require!(ctx.accounts.prop.state == PropState::Open, PhantomError::NotOpen);
        require_keys_neq!(
            ctx.accounts.taker.key(),
            ctx.accounts.prop.maker,
            PhantomError::SelfTake
        );
        let stake = ctx.accounts.prop.stake;

        invoke(
            &system_instruction::transfer(
                &ctx.accounts.taker.key(),
                &ctx.accounts.prop.key(),
                stake,
            ),
            &[
                ctx.accounts.taker.to_account_info(),
                ctx.accounts.prop.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let p = &mut ctx.accounts.prop;
        p.taker = ctx.accounts.taker.key();
        p.state = PropState::Matched;
        Ok(())
    }

    /// Settle by proof. Permissionless: anyone may call it, because the caller has no
    /// discretion. Every input is checked against state frozen before kickoff, and the verdict
    /// comes from the oracle, not the caller.
    pub fn settle(
        ctx: Context<Settle>,
        payload: StatValidationInput,
        strategy: NDimensionalStrategy,
    ) -> Result<()> {
        let p = &ctx.accounts.prop;
        require!(p.state == PropState::Matched, PhantomError::NotMatched);
        require_keys_eq!(ctx.accounts.oracle.key(), p.oracle, PhantomError::OracleMismatch);

        // The match must actually be over. Necessary, not sufficient: see guard 2.
        let now = Clock::get()?.unix_timestamp;
        require!(now >= p.settle_after, PhantomError::TooEarly);

        // GUARD 1 — fixture binding. A proof from another match is still a valid proof.
        require!(
            payload.fixture_summary.fixture_id == p.fixture_id,
            PhantomError::FixtureMismatch
        );

        // GUARD 2 — finality. TxLINE proofs are batch-scoped: each proves a stat over a window
        // (e.g. 20:21:18 -> 20:24:59). A half-time batch proves the half-time score honestly,
        // and would settle a full-match prop early and wrongly. Require the batch to extend
        // past the match's end. Feed timestamps are milliseconds.
        require!(
            payload.fixture_summary.update_stats.max_timestamp >= p.settle_after * 1000,
            PhantomError::ProofNotFinal
        );

        // GUARD 3 — predicate binding. Without this the settler picks the question and asks the
        // one they win. Must be exactly the prop frozen at creation.
        require!(payload.stats.len() == 1, PhantomError::PredicateMismatch);
        require!(
            strategy.discrete_predicates.len() == 1
                && strategy.geometric_targets.is_empty()
                && strategy.distance_predicate.is_none(),
            PhantomError::PredicateMismatch
        );
        match &strategy.discrete_predicates[0] {
            StatPredicate::Single { index, predicate } => {
                require!(*index == 0, PhantomError::PredicateMismatch);
                require!(predicate.threshold == p.threshold, PhantomError::PredicateMismatch);
                require!(predicate.comparison == p.comparison, PhantomError::PredicateMismatch);
            }
            _ => return err!(PhantomError::PredicateMismatch),
        }
        require!(
            payload.stats[0].stat.key == p.stat_key
                && payload.stats[0].stat.period == p.stat_period,
            PhantomError::StatMismatch
        );

        // CPI into txoracle::validate_stat_v2. Read-only; returns bool.
        let mut data = VALIDATE_STAT_V2_DISC.to_vec();
        payload.serialize(&mut data)?;
        strategy.serialize(&mut data)?;

        let ix = Instruction {
            program_id: ctx.accounts.oracle.key(),
            accounts: vec![AccountMeta::new_readonly(
                ctx.accounts.daily_scores_merkle_roots.key(),
                false,
            )],
            data,
        };
        invoke(
            &ix,
            &[
                ctx.accounts.daily_scores_merkle_roots.to_account_info(),
                ctx.accounts.oracle.to_account_info(),
            ],
        )?;

        let (returning_program, ret) = get_return_data().ok_or(PhantomError::NoReturnData)?;
        require_keys_eq!(
            returning_program,
            ctx.accounts.oracle.key(),
            PhantomError::OracleMismatch
        );
        require!(!ret.is_empty(), PhantomError::NoReturnData);

        let yes_won = ret[0] == 1;
        let p = &mut ctx.accounts.prop;
        p.yes_won = yes_won;
        p.state = PropState::Settled;
        msg!("settled by proof: predicate held = {}", yes_won);
        Ok(())
    }

    /// Winner withdraws the pot. Maker is the YES side; taker is the NO side.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let p = &ctx.accounts.prop;
        require!(p.state == PropState::Settled, PhantomError::NotSettled);
        let winner = if p.yes_won { p.maker } else { p.taker };
        require_keys_eq!(ctx.accounts.winner.key(), winner, PhantomError::NotWinner);

        // The prop PDA is program-owned, so lamports move by direct debit/credit.
        let pot = p.stake.checked_mul(2).unwrap();
        **ctx.accounts.prop.to_account_info().try_borrow_mut_lamports()? -= pot;
        **ctx.accounts.winner.to_account_info().try_borrow_mut_lamports()? += pot;
        Ok(())
    }

    /// Maker reclaims their stake if nobody ever took the other side.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        require!(ctx.accounts.prop.state == PropState::Open, PhantomError::NotOpen);
        require_keys_eq!(
            ctx.accounts.maker.key(),
            ctx.accounts.prop.maker,
            PhantomError::NotWinner
        );
        let stake = ctx.accounts.prop.stake;
        **ctx.accounts.prop.to_account_info().try_borrow_mut_lamports()? -= stake;
        **ctx.accounts.maker.to_account_info().try_borrow_mut_lamports()? += stake;
        ctx.accounts.prop.state = PropState::Cancelled;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateProp<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(
        init,
        payer = maker,
        space = Prop::SIZE,
        seeds = [PROP_SEED, maker.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub prop: Account<'info, Prop>,
    /// CHECK: pinned into the prop; only ever used as a CPI target, never read or written here.
    pub oracle: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TakeProp<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    #[account(mut)]
    pub prop: Account<'info, Prop>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    /// Permissionless. The caller has no discretion; the guards and the oracle decide.
    pub settler: Signer<'info>,
    #[account(mut)]
    pub prop: Account<'info, Prop>,
    /// CHECK: verified against prop.oracle before any CPI.
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: TxLINE's daily_scores_roots PDA; validated by the oracle itself.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,
    #[account(mut)]
    pub prop: Account<'info, Prop>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(mut)]
    pub prop: Account<'info, Prop>,
}
