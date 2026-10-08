use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use solana_sha256_hasher::hashv;

pub mod math;
pub mod state;
use state::*;

declare_id!("Fg6PaFpoGXkYsidMpWxTWqkZ86H8vFnafnHCW3Yj6nD");

#[program]
pub mod content_rights_protocol {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<Initialize>,
        originality: Pubkey,
        rights: Pubkey,
        treasury: Pubkey,
    ) -> Result<()> {
        let admin = ctx.accounts.admin.key();
        require!(
            originality != admin && rights != admin && rights != originality,
            ProtocolError::Unauthorized
        );
        require!(
            originality != Pubkey::default()
                && rights != Pubkey::default()
                && treasury != Pubkey::default(),
            ProtocolError::InvalidAccount
        );
        ctx.accounts.config.set_inner(ProtocolConfig {
            version: 1,
            admin,
            originality_authority: originality,
            rights_authority: rights,
            treasury,
            paused: false,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<Admin>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    pub fn add_asset_policy(ctx: Context<AddAsset>) -> Result<()> {
        require!(
            ctx.accounts.mint.freeze_authority.is_none(),
            ProtocolError::UnsupportedAsset
        );
        // Plain mints only: reject every extension until its custody semantics are audited.
        require!(
            ctx.accounts.mint.to_account_info().data_len() == 82,
            ProtocolError::UnsupportedAsset
        );
        ctx.accounts.asset.set_inner(AssetPolicy {
            version: 1,
            mint: ctx.accounts.mint.key(),
            token_program: ctx.accounts.token_program.key(),
            enabled: true,
            safeguard_enabled: true,
            future_strategy_enabled: false,
            user_liability: 0,
            earned_fees: 0,
            bump: ctx.bumps.asset,
        });
        Ok(())
    }

    pub fn update_asset_policy(ctx: Context<UpdateAsset>, enabled: bool) -> Result<()> {
        ctx.accounts.asset.enabled = enabled;
        Ok(())
    }

    pub fn submit_content(ctx: Context<Submit>, args: SubmitArgs) -> Result<()> {
        require!(!ctx.accounts.config.paused, ProtocolError::Paused);
        require!(
            ctx.accounts.fingerprint.version == 0,
            ProtocolError::DuplicateContent
        );
        require!(
            args.canonicalization_version == 1
                && args.raw_hash != [0; 32]
                && args.canonical_hash != [0; 32],
            ProtocolError::InvalidCanonicalHash
        );
        require!(
            args.mode <= 1 && args.quote_policy <= 2,
            ProtocolError::InvalidAccount
        );
        require!(
            (args.mode == 0 && args.price == 0)
                || (args.mode == 1 && args.price > 0 && args.price_mint != Pubkey::default()),
            ProtocolError::InvalidMint
        );
        // The originality signer attests canonicalization and paid quote policy, not ownership.
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.content.set_inner(Content {
            version: 1,
            author: ctx.accounts.author.key(),
            raw_hash: args.raw_hash,
            canonical_hash: args.canonical_hash,
            canonicalization_version: args.canonicalization_version,
            metadata_commitment: args.metadata_commitment,
            storage_commitment: args.storage_commitment,
            citation_manifest_commitment: args.citation_manifest_commitment,
            mode: args.mode,
            status: 0,
            quote_policy: args.quote_policy,
            price: args.price,
            price_mint: args.price_mint,
            original_node: Pubkey::default(),
            licensed_source: Pubkey::default(),
            licensed_source_bps: 0,
            derivative_source: Pubkey::default(),
            derivative_source_bps: 0,
            created_at: now,
            normal_deadline: 0,
            active_case: Pubkey::default(),
            case_resolved: false,
        });
        ctx.accounts.fingerprint.set_inner(FingerprintRegistry {
            version: 1,
            canonical_hash: args.canonical_hash,
            content: ctx.accounts.content.key(),
        });
        emit!(ContentSubmitted {
            content: ctx.accounts.content.key(),
            author: ctx.accounts.author.key(),
            raw_hash: args.raw_hash
        });
        Ok(())
    }

    pub fn license_source(ctx: Context<LicenseSource>, source_bps: u16) -> Result<()> {
        require!(
            ctx.accounts.content.status == 0
                && ctx.accounts.content.original_node == Pubkey::default(),
            ProtocolError::InvalidAccount
        );
        require!(
            source_bps > 0 && source_bps <= 5000,
            ProtocolError::InvalidShareBps
        );
        require!(
            ctx.accounts.source_content.status == 1
                || ctx.accounts.source_content.status == 3
                || ctx.accounts.source_content.status == 4,
            ProtocolError::ContentNotApproved
        );
        require!(
            ctx.accounts.source_author.key() != ctx.accounts.content.author,
            ProtocolError::InvalidAccount
        );
        ctx.accounts.content.licensed_source = ctx.accounts.source_author.key();
        ctx.accounts.content.licensed_source_bps = source_bps;
        Ok(())
    }

    pub fn approve_original(ctx: Context<Approve>) -> Result<()> {
        require!(
            ctx.accounts.content.status == 0,
            ProtocolError::InvalidAccount
        );
        ctx.accounts.content.status = 1;
        emit!(ContentApproved {
            content: ctx.accounts.content.key()
        });
        Ok(())
    }

    pub fn create_original_node(
        ctx: Context<OriginalNode>,
        tip_child_bps: u16,
        sale_child_bps: u16,
    ) -> Result<()> {
        check_bps(tip_child_bps)?;
        check_bps(sale_child_bps)?;
        require!(
            ctx.accounts.content.status != 0
                && ctx.accounts.content.original_node == Pubkey::default(),
            ProtocolError::ContentNotApproved
        );
        let node_key = ctx.accounts.node.key();
        let c = &ctx.accounts.content;
        let tip_root = original_root(
            node_key,
            0,
            c.author,
            c.licensed_source,
            c.licensed_source_bps,
        );
        let sale_root = original_root(
            node_key,
            1,
            c.author,
            c.licensed_source,
            c.licensed_source_bps,
        );
        ctx.accounts.node.set_inner(DistributionNode {
            version: 1,
            content: c.key(),
            creator: c.author,
            tip_payout_root: tip_root,
            sale_payout_root: sale_root,
            tip_child_bps,
            sale_child_bps,
            tip_residual_bps: 10000 - c.licensed_source_bps,
            sale_residual_bps: 10000 - c.licensed_source_bps,
            provenance_commitment: [0; 32],
            next_epoch: 0,
        });
        ctx.accounts.content.original_node = node_key;
        emit!(DistributionNodeCreated {
            content: ctx.accounts.content.key(),
            node: node_key,
            creator: ctx.accounts.author.key()
        });
        Ok(())
    }

    pub fn create_repost_node(ctx: Context<RepostNode>, args: RepostArgs) -> Result<()> {
        require!(!ctx.accounts.config.paused, ProtocolError::Paused);
        require!(
            ctx.accounts.content.status != 0
                && ctx.accounts.content.original_node != Pubkey::default(),
            ProtocolError::ContentNotApproved
        );
        check_bps(args.tip_child_bps)?;
        check_bps(args.sale_child_bps)?;
        check_bps(args.tip_residual_bps)?;
        check_bps(args.sale_residual_bps)?;
        require!(
            args.tip_root != [0; 32]
                && args.sale_root != [0; 32]
                && args.provenance_commitment != [0; 32],
            ProtocolError::InvalidPayoutRoot
        );
        // The rights signer attests sum=10000, deduplication, and private-parent residual math.
        ctx.accounts.node.set_inner(DistributionNode {
            version: 1,
            content: ctx.accounts.content.key(),
            creator: ctx.accounts.creator.key(),
            tip_payout_root: args.tip_root,
            sale_payout_root: args.sale_root,
            tip_child_bps: args.tip_child_bps,
            sale_child_bps: args.sale_child_bps,
            tip_residual_bps: args.tip_residual_bps,
            sale_residual_bps: args.sale_residual_bps,
            provenance_commitment: args.provenance_commitment,
            next_epoch: 0,
        });
        emit!(DistributionNodeCreated {
            content: ctx.accounts.content.key(),
            node: ctx.accounts.node.key(),
            creator: ctx.accounts.creator.key()
        });
        Ok(())
    }

    pub fn update_repost_policy(
        ctx: Context<UpdateNode>,
        tip_child_bps: u16,
        sale_child_bps: u16,
    ) -> Result<()> {
        check_bps(tip_child_bps)?;
        check_bps(sale_child_bps)?;
        ctx.accounts.node.tip_child_bps = tip_child_bps;
        ctx.accounts.node.sale_child_bps = sale_child_bps;
        emit!(RepostPolicyUpdated {
            node: ctx.accounts.node.key(),
            tip: tip_child_bps,
            sale: sale_child_bps
        });
        Ok(())
    }

    pub fn open_revenue_epoch(ctx: Context<OpenEpoch>, kind: u8, nonce: u64) -> Result<()> {
        require!(kind <= 1, ProtocolError::InvalidRevenueKind);
        require!(
            ctx.accounts.node.next_epoch == nonce,
            ProtocolError::InvalidAccount
        );
        ctx.accounts.node.next_epoch = add(nonce, 1)?;
        ctx.accounts.epoch.set_inner(RevenueEpoch {
            version: 1,
            content: ctx.accounts.content.key(),
            node: ctx.accounts.node.key(),
            mint: ctx.accounts.mint.key(),
            kind,
            payout_root: if kind == 0 {
                ctx.accounts.node.tip_payout_root
            } else {
                ctx.accounts.node.sale_payout_root
            },
            gross: 0,
            paid: 0,
            fees: 0,
            opened_at: Clock::get()?.unix_timestamp,
            deadline: 0,
            post_review: ctx.accounts.content.case_resolved,
        });
        Ok(())
    }

    pub fn tip(ctx: Context<Economic>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.epoch.kind == 0,
            ProtocolError::InvalidRevenueKind
        );
        process_deposit(ctx.accounts, amount)?;
        emit!(TipReceived {
            content: ctx.accounts.content.key(),
            node: ctx.accounts.node.key(),
            mint: ctx.accounts.mint.key(),
            amount
        });
        Ok(())
    }

    pub fn purchase_access(ctx: Context<Purchase>) -> Result<()> {
        let a = &mut ctx.accounts.economic;
        require_keys_eq!(
            ctx.accounts.buyer.key(),
            a.funder.key(),
            ProtocolError::Unauthorized
        );
        require!(
            a.content.mode == 1 && a.epoch.kind == 1,
            ProtocolError::InvalidRevenueKind
        );
        require_keys_eq!(
            a.content.price_mint,
            a.mint.key(),
            ProtocolError::InvalidMint
        );
        let amount = a.content.price;
        process_deposit(a, amount)?;
        ctx.accounts.receipt.set_inner(AccessReceipt {
            version: 1,
            content: a.content.key(),
            buyer: ctx.accounts.buyer.key(),
            purchase_node: a.node.key(),
            amount,
            mint: a.mint.key(),
            created_at: Clock::get()?.unix_timestamp,
        });
        emit!(AccessPurchased {
            content: a.content.key(),
            node: a.node.key(),
            buyer: ctx.accounts.buyer.key(),
            mint: a.mint.key(),
            amount
        });
        Ok(())
    }

    pub fn claim_liquid(ctx: Context<Claim>, proof: ClaimProof, amount: u64) -> Result<()> {
        let a = ctx.accounts;
        let (entitlement, normal) = prepare_position(a, &proof)?;
        let now = Clock::get()?.unix_timestamp;
        require!(amount > 0, ProtocolError::InsufficientBalance);
        require!(
            add(add(a.epoch.paid, a.epoch.fees)?, amount)? <= a.epoch.gross,
            ProtocolError::PrincipalProtected
        );
        if normal {
            require!(
                amount <= sub(entitlement, a.position.paid)?,
                ProtocolError::InsufficientBalance
            );
        } else {
            require!(
                a.position.exit_amount > 0,
                ProtocolError::SafeguardExitRequired
            );
            require!(
                math::exit_ready(now, a.position.exit_requested_at)?,
                ProtocolError::ExitCooldownActive
            );
            require!(
                amount <= a.position.exit_amount,
                ProtocolError::InsufficientBalance
            );
            a.position.exit_amount = sub(a.position.exit_amount, amount)?;
        }
        let mint_key = a.asset.mint;
        let bump = [a.asset.bump];
        let seeds: &[&[u8]] = &[b"asset", mint_key.as_ref(), &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                TransferChecked {
                    from: a.vault.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.destination.to_account_info(),
                    authority: a.asset.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            a.mint.decimals,
        )?;
        a.position.paid = add(a.position.paid, amount)?;
        a.leaf.paid = add(a.leaf.paid, amount)?;
        a.epoch.paid = add(a.epoch.paid, amount)?;
        a.asset.user_liability = sub(a.asset.user_liability, amount)?;
        emit!(RevenueClaimed {
            epoch: a.epoch.key(),
            beneficiary: a.recipient.key(),
            amount
        });
        Ok(())
    }

    pub fn request_safeguard_exit(
        ctx: Context<Claim>,
        proof: ClaimProof,
        amount: u64,
    ) -> Result<()> {
        let a = ctx.accounts;
        let (entitlement, normal) = prepare_position(a, &proof)?;
        require!(!normal, ProtocolError::ExitNotReady);
        require!(
            a.position.exit_amount == 0,
            ProtocolError::ExitAlreadyPending
        );
        require!(
            amount > 0 && amount <= sub(entitlement, a.position.paid)?,
            ProtocolError::InsufficientBalance
        );
        let now = Clock::get()?.unix_timestamp;
        math::exit_ready(now, now)?; // also validates representable 72-hour hard bound
        a.position.exit_amount = amount;
        a.position.exit_requested_at = now;
        emit!(SafeguardExitRequested {
            position: a.position.key(),
            amount,
            requested_at: now
        });
        Ok(())
    }

    pub fn finalize_exit(ctx: Context<Claim>, proof: ClaimProof) -> Result<()> {
        let a = ctx.accounts;
        prepare_position(a, &proof)?;
        require!(a.position.exit_amount > 0, ProtocolError::ExitNotReady);
        require!(
            math::exit_ready(Clock::get()?.unix_timestamp, a.position.exit_requested_at)?,
            ProtocolError::ExitCooldownActive
        );
        emit!(SafeguardExitClaimable {
            position: a.position.key(),
            ready_at: a
                .position
                .exit_requested_at
                .checked_add(math::MIN_EXIT)
                .ok_or(ProtocolError::MathOverflow)?
        });
        Ok(())
    }

    pub fn sweep_expired_claim_window(ctx: Context<Claim>, proof: ClaimProof) -> Result<()> {
        let a = ctx.accounts;
        let (_, normal) = prepare_position(a, &proof)?;
        require!(!normal, ProtocolError::ClaimWindowExpired);
        emit!(RevenueEnteredSafeguard {
            epoch: a.epoch.key()
        });
        Ok(())
    }

    pub fn open_similarity_case(
        ctx: Context<OpenCase>,
        evidence_commitment: [u8; 32],
    ) -> Result<()> {
        let c = &mut ctx.accounts.content;
        require!(
            c.active_case == Pubkey::default() && c.author != ctx.accounts.reference.author,
            ProtocolError::InvalidAccount
        );
        require!(
            ctx.accounts.reference.status == 1
                || ctx.accounts.reference.status == 3
                || ctx.accounts.reference.status == 4,
            ProtocolError::ContentNotApproved
        );
        let now = Clock::get()?.unix_timestamp;
        let cutoff = math::dispute_cutoff(
            now,
            if c.normal_deadline == 0 {
                None
            } else {
                Some(c.normal_deadline)
            },
        )?;
        // The case starts a fixed content cycle even before the first revenue.
        // Early resolution must inherit its remaining grace; normal deposits
        // may rotate this existing clock only after the cutoff has elapsed.
        c.normal_deadline = cutoff;
        ctx.accounts.case.set_inner(SimilarityCase {
            version: 1,
            candidate: c.key(),
            reference: ctx.accounts.reference.key(),
            candidate_author: c.author,
            reference_author: ctx.accounts.reference.author,
            evidence_commitment,
            started_at: now,
            cutoff,
            status: if now >= cutoff { 3 } else { 0 },
            resolution: 0,
            resolved_at: 0,
            source_bps: 0,
            next_proposal: 0,
            settlement_commitment: [0; 32],
        });
        c.active_case = ctx.accounts.case.key();
        c.status = 2;
        emit!(SimilarityCaseOpened {
            case: ctx.accounts.case.key(),
            candidate: c.key(),
            reference: ctx.accounts.reference.key(),
            cutoff
        });
        Ok(())
    }

    pub fn transition_dispute_to_safeguard(ctx: Context<CaseClock>) -> Result<()> {
        require!(
            ctx.accounts.case.resolution == 0,
            ProtocolError::CaseAlreadyResolved
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.case.cutoff,
            ProtocolError::CutoffNotReached
        );
        ctx.accounts.case.status = 3;
        Ok(())
    }

    pub fn propose_settlement(
        ctx: Context<Propose>,
        nonce: u64,
        source_bps: u16,
        commitment: [u8; 32],
    ) -> Result<()> {
        let c = &mut ctx.accounts.case;
        require!(c.resolution == 0, ProtocolError::CaseAlreadyResolved);
        require!(nonce == c.next_proposal, ProtocolError::SettlementMismatch);
        check_bps(source_bps)?;
        let signer = ctx.accounts.author.key();
        require!(
            signer == c.candidate_author || signer == c.reference_author,
            ProtocolError::Unauthorized
        );
        ctx.accounts.settlement.set_inner(Settlement {
            version: 1,
            case: c.key(),
            source_bps,
            candidate_accepted: signer == c.candidate_author,
            reference_accepted: signer == c.reference_author,
            finalized: false,
            commitment,
        });
        c.next_proposal = add(c.next_proposal, 1)?;
        if Clock::get()?.unix_timestamp < c.cutoff {
            c.status = 1;
        }
        emit!(SettlementProposed {
            case: c.key(),
            settlement: ctx.accounts.settlement.key()
        });
        Ok(())
    }

    pub fn accept_settlement(ctx: Context<Accept>) -> Result<()> {
        let c = &ctx.accounts.case;
        let s = &mut ctx.accounts.settlement;
        require!(
            c.resolution == 0 && !s.finalized,
            ProtocolError::CaseAlreadyResolved
        );
        if ctx.accounts.author.key() == c.candidate_author {
            s.candidate_accepted = true;
        } else {
            require_keys_eq!(
                ctx.accounts.author.key(),
                c.reference_author,
                ProtocolError::Unauthorized
            );
            s.reference_accepted = true;
        }
        emit!(SettlementAccepted {
            settlement: s.key(),
            author: ctx.accounts.author.key()
        });
        Ok(())
    }

    pub fn confirm_independent(ctx: Context<Independent>) -> Result<()> {
        require!(
            ctx.accounts.case.resolution == 0,
            ProtocolError::CaseAlreadyResolved
        );
        let c = &mut ctx.accounts.case;
        c.resolution = 1;
        c.status = 4;
        c.resolved_at = Clock::get()?.unix_timestamp;
        ctx.accounts.content.status = 3;
        ctx.accounts.content.case_resolved = true;
        emit!(IndependentConfirmed { case: c.key() });
        Ok(())
    }

    pub fn finalize_derivative_settlement(ctx: Context<FinalizeSettlement>) -> Result<()> {
        let c = &mut ctx.accounts.case;
        let s = &mut ctx.accounts.settlement;
        require!(
            c.resolution == 0 && !s.finalized,
            ProtocolError::CaseAlreadyResolved
        );
        require!(
            s.candidate_accepted && s.reference_accepted,
            ProtocolError::SettlementMismatch
        );
        c.resolution = 2;
        c.status = 4;
        c.resolved_at = Clock::get()?.unix_timestamp;
        c.source_bps = s.source_bps;
        c.settlement_commitment = s.commitment;
        s.finalized = true;
        ctx.accounts.content.status = 4;
        ctx.accounts.content.case_resolved = true;
        ctx.accounts.content.derivative_source = c.reference_author;
        ctx.accounts.content.derivative_source_bps = s.source_bps;
        emit!(DerivativeConfirmed {
            case: c.key(),
            source_bps: s.source_bps
        });
        Ok(())
    }

    pub fn withdraw_protocol_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        require!(
            amount > 0 && amount <= ctx.accounts.asset.earned_fees,
            ProtocolError::PrincipalProtected
        );
        let mint = ctx.accounts.asset.mint;
        let bump = [ctx.accounts.asset.bump];
        let seeds: &[&[u8]] = &[b"asset", mint.as_ref(), &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.asset.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.asset.earned_fees = sub(ctx.accounts.asset.earned_fees, amount)?;
        Ok(())
    }
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(ProtocolError::MathOverflow))
}
fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or_else(|| error!(ProtocolError::InsufficientBalance))
}
fn check_bps(bps: u16) -> Result<()> {
    require!(bps <= 10000, ProtocolError::InvalidShareBps);
    Ok(())
}

impl From<math::MathError> for anchor_lang::error::Error {
    fn from(e: math::MathError) -> Self {
        match e {
            math::MathError::Overflow | math::MathError::InvalidTime => {
                error!(ProtocolError::MathOverflow)
            }
            math::MathError::InvalidShare => error!(ProtocolError::InvalidShareBps),
            math::MathError::InsufficientBalance => error!(ProtocolError::InsufficientBalance),
            math::MathError::ExitCooldown => error!(ProtocolError::ExitCooldownActive),
            math::MathError::DisputeActive => error!(ProtocolError::DisputeStillActive),
        }
    }
}

pub fn payout_leaf(node: Pubkey, kind: u8, role: u8, wallet: Pubkey, bps: u16) -> [u8; 32] {
    hashv(&[
        b"provena:payout:v1",
        node.as_ref(),
        &[kind],
        &[role],
        wallet.as_ref(),
        &bps.to_le_bytes(),
    ])
    .to_bytes()
}
pub fn merkle_pair(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[b"provena:merkle:v1", &lo, &hi]).to_bytes()
}
fn original_root(
    node: Pubkey,
    kind: u8,
    author: Pubkey,
    source: Pubkey,
    source_bps: u16,
) -> [u8; 32] {
    let origin = payout_leaf(node, kind, 0, author, 10000 - source_bps);
    if source_bps == 0 {
        origin
    } else {
        merkle_pair(origin, payout_leaf(node, kind, 2, source, source_bps))
    }
}
fn case_ref<'a, 'info>(
    content: &Content,
    key: Pubkey,
    review: &'a Option<Account<'info, SimilarityCase>>,
) -> Result<Option<&'a SimilarityCase>> {
    if content.active_case == Pubkey::default() {
        require!(review.is_none(), ProtocolError::SettlementMismatch);
        return Ok(None);
    }
    let c = review.as_ref().ok_or(ProtocolError::SettlementMismatch)?;
    require_keys_eq!(
        c.key(),
        content.active_case,
        ProtocolError::SettlementMismatch
    );
    require_keys_eq!(c.candidate, key, ProtocolError::SettlementMismatch);
    Ok(Some(c))
}

fn process_deposit(a: &mut Economic, amount: u64) -> Result<()> {
    require!(!a.config.paused && a.asset.enabled, ProtocolError::Paused);
    require!(
        a.content.status != 0 && amount > 0,
        ProtocolError::ContentNotApproved
    );
    require!(
        a.mint.to_account_info().data_len() == 82 && a.mint.freeze_authority.is_none(),
        ProtocolError::UnsupportedAsset
    );
    let now = Clock::get()?.unix_timestamp;
    let review = case_ref(&a.content, a.content.key(), &a.review)?;
    let unresolved = review.is_some_and(|c| c.resolution == 0);
    require!(
        !(review.is_some_and(|c| c.resolution > 0) && !a.epoch.post_review),
        ProtocolError::EpochClosed
    );
    if a.epoch.gross == 0 {
        let deadline = if unresolved {
            review.unwrap().cutoff
        } else {
            if a.content.normal_deadline == 0 || a.content.normal_deadline <= now {
                a.content.normal_deadline = math::deadline(now)?;
            }
            a.content.normal_deadline
        };
        a.epoch.deadline = deadline;
    } else if !unresolved {
        require!(now < a.epoch.deadline, ProtocolError::EpochClosed);
    }
    token_interface::transfer_checked(
        CpiContext::new(
            a.token_program.to_account_info(),
            TransferChecked {
                from: a.source.to_account_info(),
                to: a.vault.to_account_info(),
                mint: a.mint.to_account_info(),
                authority: a.funder.to_account_info(),
            },
        ),
        amount,
        a.mint.decimals,
    )?;
    a.epoch.gross = add(a.epoch.gross, amount)?;
    a.asset.user_liability = add(a.asset.user_liability, amount)?;
    if unresolved && now >= review.unwrap().cutoff {
        emit!(RevenueEnteredSafeguard {
            epoch: a.epoch.key()
        });
    }
    Ok(())
}

fn prepare_position(a: &mut Claim, proof: &ClaimProof) -> Result<(u64, bool)> {
    require!(
        proof.role <= 2
            && proof.share_bps > 0
            && proof.share_bps <= 10000
            && proof.siblings.len() <= 32,
        ProtocolError::InvalidShareBps
    );
    if proof.role == 0 {
        require_keys_eq!(
            proof.beneficiary,
            a.content.author,
            ProtocolError::InvalidPayoutRoot
        );
    }
    if proof.role == 2 {
        require_keys_eq!(
            proof.beneficiary,
            a.content.licensed_source,
            ProtocolError::InvalidPayoutRoot
        );
    }
    let mut h = payout_leaf(
        a.epoch.node,
        a.epoch.kind,
        proof.role,
        proof.beneficiary,
        proof.share_bps,
    );
    for sibling in &proof.siblings {
        h = merkle_pair(h, *sibling);
    }
    require!(h == a.epoch.payout_root, ProtocolError::InvalidMerkleProof);
    let now = Clock::get()?.unix_timestamp;
    let review = case_ref(&a.content, a.content.key(), &a.review)?;
    if let Some(c) = review {
        require!(c.resolution != 0, ProtocolError::DisputeStillActive);
    }
    if a.leaf.version == 0 {
        a.leaf.set_inner(LeafPosition {
            version: 1,
            epoch: a.epoch.key(),
            wallet: proof.beneficiary,
            role: proof.role,
            share_bps: proof.share_bps,
            paid: 0,
            finalized: false,
            owner_allocation: 0,
            source_allocation: 0,
            source: Pubkey::default(),
        });
    }
    require!(
        a.leaf.share_bps == proof.share_bps
            && a.leaf.role == proof.role
            && a.leaf.wallet == proof.beneficiary,
        ProtocolError::InvalidPayoutRoot
    );
    let gross_entitlement = math::share(a.epoch.gross, proof.share_bps)?;
    let closed_review = review.filter(|_| !a.epoch.post_review);
    if let Some(c) = closed_review {
        if !a.leaf.finalized {
            let (fee, source, owner) = if c.resolution == 2 {
                math::settle_unclaimed_leaf(
                    gross_entitlement,
                    a.leaf.paid,
                    c.source_bps,
                    proof.role == 0,
                )?
            } else {
                (0, 0, sub(gross_entitlement, a.leaf.paid)?)
            };
            a.leaf.owner_allocation = add(a.leaf.paid, owner)?;
            a.leaf.source_allocation = source;
            a.leaf.source = if proof.role == 0 && c.resolution == 2 {
                c.reference_author
            } else {
                Pubkey::default()
            };
            a.leaf.finalized = true;
            require!(
                add(add(a.epoch.paid, a.epoch.fees)?, fee)? <= a.epoch.gross,
                ProtocolError::PrincipalProtected
            );
            a.epoch.fees = add(a.epoch.fees, fee)?;
            a.asset.user_liability = sub(a.asset.user_liability, fee)?;
            a.asset.earned_fees = add(a.asset.earned_fees, fee)?;
        }
    }
    let (owner_entitlement, source_entitlement, source_wallet) = if a.leaf.finalized {
        (
            a.leaf.owner_allocation,
            a.leaf.source_allocation,
            a.leaf.source,
        )
    } else if a.epoch.post_review
        && proof.role == 0
        && a.content.derivative_source != Pubkey::default()
    {
        let source = math::share(gross_entitlement, a.content.derivative_source_bps)?;
        (
            sub(gross_entitlement, source)?,
            source,
            a.content.derivative_source,
        )
    } else {
        (gross_entitlement, 0, Pubkey::default())
    };
    let recipient = a.recipient.key();
    let entitlement = if recipient == proof.beneficiary {
        owner_entitlement
    } else {
        require!(
            recipient == source_wallet && source_wallet != Pubkey::default(),
            ProtocolError::Unauthorized
        );
        source_entitlement
    };
    if a.position.version == 0 {
        a.position.set_inner(ClaimPosition {
            version: 1,
            leaf: a.leaf.key(),
            recipient,
            paid: 0,
            exit_amount: 0,
            exit_requested_at: 0,
            automatic_exit_applied: false,
        });
    }
    require!(
        a.position.leaf == a.leaf.key() && a.position.recipient == recipient,
        ProtocolError::InvalidAccount
    );
    if let Some(c) = closed_review {
        if (c.resolved_at >= c.cutoff
            || (a.epoch.deadline != 0 && a.epoch.deadline <= c.resolved_at))
            && !a.position.automatic_exit_applied
        {
            a.position.exit_amount = sub(entitlement, a.position.paid)?;
            a.position.exit_requested_at = c.resolved_at;
            a.position.automatic_exit_applied = true;
        }
    }
    if a.position.exit_amount > 0 {
        let returned_deadline = a
            .position
            .exit_requested_at
            .checked_add(math::MIN_EXIT)
            .and_then(|t| t.checked_add(math::GRACE))
            .ok_or(ProtocolError::MathOverflow)?;
        if now >= returned_deadline {
            a.position.exit_amount = 0;
        }
    }
    let normal = a.epoch.deadline != 0
        && now < a.epoch.deadline
        && closed_review.is_none_or(|c| c.resolved_at < c.cutoff)
        && !a.position.automatic_exit_applied;
    Ok((entitlement, normal))
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + ProtocolConfig::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ProtocolError::Unauthorized)]
    pub program: Program<'info, crate::program::ContentRightsProtocol>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ ProtocolError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Admin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump, has_one = admin @ ProtocolError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
}
#[derive(Accounts)]
pub struct AddAsset<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump, has_one = admin @ ProtocolError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(init, payer = admin, space = 8 + AssetPolicy::INIT_SPACE, seeds = [b"asset", mint.key().as_ref()], bump)]
    pub asset: Account<'info, AssetPolicy>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = admin, seeds = [b"vault", asset.key().as_ref()], bump, token::mint = mint, token::authority = asset, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct UpdateAsset<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump, has_one = admin @ ProtocolError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [b"asset", asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Account<'info, AssetPolicy>,
}
#[derive(Accounts)]
#[instruction(args: SubmitArgs)]
pub struct Submit<'info> {
    #[account(mut)]
    pub author: Signer<'info>,
    #[account(address = config.originality_authority @ ProtocolError::Unauthorized)]
    pub originality: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(init, payer = author, space = 8 + Content::INIT_SPACE, seeds = [b"content", author.key().as_ref(), &args.raw_hash], bump)]
    pub content: Account<'info, Content>,
    #[account(init_if_needed, payer = author, space = 8 + FingerprintRegistry::INIT_SPACE, seeds = [b"fingerprint".as_ref(), args.canonical_hash.as_ref()], bump)]
    pub fingerprint: Account<'info, FingerprintRegistry>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct LicenseSource<'info> {
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(address = config.rights_authority @ ProtocolError::Unauthorized)]
    pub rights: Signer<'info>,
    #[account(address = content.author @ ProtocolError::Unauthorized)]
    pub author: Signer<'info>,
    #[account(mut)]
    pub content: Account<'info, Content>,
    pub source_content: Account<'info, Content>,
    #[account(address = source_content.author @ ProtocolError::Unauthorized)]
    pub source_author: Signer<'info>,
}
#[derive(Accounts)]
pub struct Approve<'info> {
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(address = config.originality_authority @ ProtocolError::Unauthorized)]
    pub originality: Signer<'info>,
    #[account(mut)]
    pub content: Account<'info, Content>,
}
#[derive(Accounts)]
pub struct OriginalNode<'info> {
    #[account(mut, address = content.author @ ProtocolError::Unauthorized)]
    pub author: Signer<'info>,
    #[account(mut)]
    pub content: Account<'info, Content>,
    #[account(init, payer = author, space = 8 + DistributionNode::INIT_SPACE, seeds = [b"original", content.key().as_ref()], bump)]
    pub node: Account<'info, DistributionNode>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(args: RepostArgs)]
pub struct RepostNode<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(address = config.rights_authority @ ProtocolError::Unauthorized)]
    pub rights: Signer<'info>,
    pub content: Account<'info, Content>,
    #[account(init, payer = creator, space = 8 + DistributionNode::INIT_SPACE, seeds = [b"node", content.key().as_ref(), creator.key().as_ref(), &args.nonce], bump)]
    pub node: Account<'info, DistributionNode>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct UpdateNode<'info> {
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator @ ProtocolError::Unauthorized)]
    pub node: Account<'info, DistributionNode>,
}
#[derive(Accounts)]
#[instruction(kind: u8, nonce: u64)]
pub struct OpenEpoch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub content: Account<'info, Content>,
    #[account(mut, has_one = content)]
    pub node: Account<'info, DistributionNode>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = payer, space = 8 + RevenueEpoch::INIT_SPACE, seeds = [b"epoch", node.key().as_ref(), mint.key().as_ref(), &[kind], &nonce.to_le_bytes()], bump)]
    pub epoch: Account<'info, RevenueEpoch>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Economic<'info> {
    pub funder: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub content: Box<Account<'info, Content>>,
    #[account(has_one = content)]
    pub node: Box<Account<'info, DistributionNode>>,
    #[account(mut, has_one = content, has_one = node, has_one = mint)]
    pub epoch: Box<Account<'info, RevenueEpoch>>,
    #[account(mut, seeds = [b"asset", mint.key().as_ref()], bump = asset.bump, has_one = mint, has_one = token_program)]
    pub asset: Box<Account<'info, AssetPolicy>>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = funder, token::token_program = token_program)]
    pub source: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", asset.key().as_ref()], bump, token::mint = mint, token::authority = asset, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub review: Option<Account<'info, SimilarityCase>>,
    pub token_program: Interface<'info, TokenInterface>,
}
#[derive(Accounts)]
pub struct Purchase<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub economic: Economic<'info>,
    #[account(init, payer = buyer, space = 8 + AccessReceipt::INIT_SPACE, seeds = [b"access", economic.content.key().as_ref(), buyer.key().as_ref()], bump)]
    pub receipt: Account<'info, AccessReceipt>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(proof: ClaimProof)]
pub struct Claim<'info> {
    #[account(mut)]
    pub recipient: Signer<'info>,
    pub content: Box<Account<'info, Content>>,
    #[account(mut, has_one = content, has_one = mint)]
    pub epoch: Box<Account<'info, RevenueEpoch>>,
    #[account(mut, seeds = [b"asset", mint.key().as_ref()], bump = asset.bump, has_one = mint, has_one = token_program)]
    pub asset: Box<Account<'info, AssetPolicy>>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"vault", asset.key().as_ref()], bump, token::mint = mint, token::authority = asset, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = recipient, token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = recipient, space = 8 + LeafPosition::INIT_SPACE, seeds = [b"leaf", epoch.key().as_ref(), &[proof.role], proof.beneficiary.as_ref()], bump)]
    pub leaf: Box<Account<'info, LeafPosition>>,
    #[account(init_if_needed, payer = recipient, space = 8 + ClaimPosition::INIT_SPACE, seeds = [b"position", leaf.key().as_ref(), recipient.key().as_ref()], bump)]
    pub position: Box<Account<'info, ClaimPosition>>,
    pub review: Option<Account<'info, SimilarityCase>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct OpenCase<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(address = config.originality_authority @ ProtocolError::Unauthorized)]
    pub originality: Signer<'info>,
    #[account(mut)]
    pub content: Account<'info, Content>,
    pub reference: Account<'info, Content>,
    #[account(init, payer = payer, space = 8 + SimilarityCase::INIT_SPACE, seeds = [b"case", content.key().as_ref()], bump)]
    pub case: Account<'info, SimilarityCase>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct CaseClock<'info> {
    #[account(mut, seeds = [b"case", case.candidate.as_ref()], bump)]
    pub case: Account<'info, SimilarityCase>,
}
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Propose<'info> {
    #[account(mut)]
    pub author: Signer<'info>,
    #[account(mut, seeds = [b"case", case.candidate.as_ref()], bump)]
    pub case: Account<'info, SimilarityCase>,
    #[account(init, payer = author, space = 8 + Settlement::INIT_SPACE, seeds = [b"settlement", case.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub settlement: Account<'info, Settlement>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Accept<'info> {
    pub author: Signer<'info>,
    pub case: Account<'info, SimilarityCase>,
    #[account(mut, has_one = case)]
    pub settlement: Account<'info, Settlement>,
}
#[derive(Accounts)]
pub struct Independent<'info> {
    #[account(mut, address = case.candidate)]
    pub content: Account<'info, Content>,
    #[account(mut, seeds = [b"case", content.key().as_ref()], bump)]
    pub case: Account<'info, SimilarityCase>,
    #[account(address = case.candidate_author @ ProtocolError::Unauthorized)]
    pub candidate_author: Signer<'info>,
    #[account(address = case.reference_author @ ProtocolError::Unauthorized)]
    pub reference_author: Signer<'info>,
}
#[derive(Accounts)]
pub struct FinalizeSettlement<'info> {
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(address = config.rights_authority @ ProtocolError::Unauthorized)]
    pub rights: Signer<'info>,
    #[account(mut, address = case.candidate)]
    pub content: Account<'info, Content>,
    #[account(mut, seeds = [b"case", content.key().as_ref()], bump)]
    pub case: Account<'info, SimilarityCase>,
    #[account(mut, has_one = case)]
    pub settlement: Account<'info, Settlement>,
}
#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump, has_one = admin @ ProtocolError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [b"asset", mint.key().as_ref()], bump = asset.bump, has_one = mint, has_one = token_program)]
    pub asset: Account<'info, AssetPolicy>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"vault", asset.key().as_ref()], bump, token::mint = mint, token::authority = asset, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = config.treasury, token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}
