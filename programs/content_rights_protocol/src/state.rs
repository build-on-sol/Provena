use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub version: u8,
    pub admin: Pubkey,
    pub originality_authority: Pubkey,
    pub rights_authority: Pubkey,
    pub treasury: Pubkey,
    pub paused: bool,
}

#[account]
#[derive(InitSpace)]
pub struct AssetPolicy {
    pub version: u8,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub enabled: bool,
    pub safeguard_enabled: bool,
    pub future_strategy_enabled: bool,
    pub user_liability: u64,
    pub earned_fees: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct FingerprintRegistry {
    pub version: u8,
    pub canonical_hash: [u8; 32],
    pub content: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Content {
    pub version: u8,
    pub author: Pubkey,
    pub raw_hash: [u8; 32],
    pub canonical_hash: [u8; 32],
    pub canonicalization_version: u16,
    pub metadata_commitment: [u8; 32],
    pub storage_commitment: [u8; 32],
    pub citation_manifest_commitment: [u8; 32],
    pub mode: u8,
    pub status: u8,
    pub quote_policy: u8,
    pub price: u64,
    pub price_mint: Pubkey,
    pub original_node: Pubkey,
    pub licensed_source: Pubkey,
    pub licensed_source_bps: u16,
    pub derivative_source: Pubkey,
    pub derivative_source_bps: u16,
    pub created_at: i64,
    pub normal_deadline: i64,
    pub active_case: Pubkey,
    pub case_resolved: bool,
}

#[account]
#[derive(InitSpace)]
pub struct DistributionNode {
    pub version: u8,
    pub content: Pubkey,
    pub creator: Pubkey,
    pub tip_payout_root: [u8; 32],
    pub sale_payout_root: [u8; 32],
    pub tip_child_bps: u16,
    pub sale_child_bps: u16,
    pub tip_residual_bps: u16,
    pub sale_residual_bps: u16,
    pub provenance_commitment: [u8; 32],
    pub next_epoch: u64,
}

#[account]
#[derive(InitSpace)]
pub struct RevenueEpoch {
    pub version: u8,
    pub content: Pubkey,
    pub node: Pubkey,
    pub mint: Pubkey,
    pub kind: u8,
    pub payout_root: [u8; 32],
    pub gross: u64,
    pub paid: u64,
    pub fees: u64,
    pub opened_at: i64,
    pub deadline: i64,
    pub post_review: bool,
}

#[account]
#[derive(InitSpace)]
pub struct LeafPosition {
    pub version: u8,
    pub epoch: Pubkey,
    pub wallet: Pubkey,
    pub role: u8,
    pub share_bps: u16,
    pub paid: u64,
    pub finalized: bool,
    pub owner_allocation: u64,
    pub source_allocation: u64,
    pub source: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct ClaimPosition {
    pub version: u8,
    pub leaf: Pubkey,
    pub recipient: Pubkey,
    pub paid: u64,
    pub exit_amount: u64,
    pub exit_requested_at: i64,
    pub automatic_exit_applied: bool,
}

#[account]
#[derive(InitSpace)]
pub struct AccessReceipt {
    pub version: u8,
    pub content: Pubkey,
    pub buyer: Pubkey,
    pub purchase_node: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
    pub created_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct SimilarityCase {
    pub version: u8,
    pub candidate: Pubkey,
    pub reference: Pubkey,
    pub candidate_author: Pubkey,
    pub reference_author: Pubkey,
    pub evidence_commitment: [u8; 32],
    pub started_at: i64,
    pub cutoff: i64,
    pub status: u8,
    pub resolution: u8,
    pub resolved_at: i64,
    pub source_bps: u16,
    pub next_proposal: u64,
    pub settlement_commitment: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Settlement {
    pub version: u8,
    pub case: Pubkey,
    pub source_bps: u16,
    pub candidate_accepted: bool,
    pub reference_accepted: bool,
    pub finalized: bool,
    pub commitment: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SubmitArgs {
    pub raw_hash: [u8; 32],
    pub canonical_hash: [u8; 32],
    pub canonicalization_version: u16,
    pub metadata_commitment: [u8; 32],
    pub storage_commitment: [u8; 32],
    pub citation_manifest_commitment: [u8; 32],
    pub mode: u8,
    pub quote_policy: u8,
    pub price: u64,
    pub price_mint: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RepostArgs {
    pub nonce: [u8; 32],
    pub tip_root: [u8; 32],
    pub sale_root: [u8; 32],
    pub tip_child_bps: u16,
    pub sale_child_bps: u16,
    pub tip_residual_bps: u16,
    pub sale_residual_bps: u16,
    pub provenance_commitment: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimProof {
    pub beneficiary: Pubkey,
    pub role: u8,
    pub share_bps: u16,
    pub siblings: Vec<[u8; 32]>,
}

#[error_code]
pub enum ProtocolError {
    #[msg("Unauthorized authority or recipient")]
    Unauthorized,
    #[msg("Protocol deposits are paused")]
    Paused,
    #[msg("Unsupported asset or token extension")]
    UnsupportedAsset,
    #[msg("Global canonical fingerprint already reserved")]
    DuplicateContent,
    #[msg("Invalid canonicalization version or zero hash")]
    InvalidCanonicalHash,
    #[msg("Content is not approved")]
    ContentNotApproved,
    #[msg("Invalid payout root or role")]
    InvalidPayoutRoot,
    #[msg("Invalid Merkle proof")]
    InvalidMerkleProof,
    #[msg("Invalid basis-point share")]
    InvalidShareBps,
    #[msg("Amount exceeds remaining recipient balance")]
    InsufficientBalance,
    #[msg("Fixed claim window expired")]
    ClaimWindowExpired,
    #[msg("Expired normal epoch requires a new epoch")]
    EpochClosed,
    #[msg("Safeguarded funds require an exit request")]
    SafeguardExitRequired,
    #[msg("Minimum 48-hour cooldown is active")]
    ExitCooldownActive,
    #[msg("Exit amount has not been requested or expired")]
    ExitNotReady,
    #[msg("An irrevocable exit request is already pending")]
    ExitAlreadyPending,
    #[msg("Case is already resolved")]
    CaseAlreadyResolved,
    #[msg("Case or accepted settlement mismatches content")]
    SettlementMismatch,
    #[msg("Unresolved dispute locks all principal")]
    DisputeStillActive,
    #[msg("Safeguard cutoff not reached")]
    CutoffNotReached,
    #[msg("Integer arithmetic overflow")]
    MathOverflow,
    #[msg("Wrong token program")]
    InvalidTokenProgram,
    #[msg("Wrong mint")]
    InvalidMint,
    #[msg("Wrong revenue kind")]
    InvalidRevenueKind,
    #[msg("Invalid account or nonce")]
    InvalidAccount,
    #[msg("Treasury may withdraw only finalized earned fees")]
    PrincipalProtected,
}

#[event]
pub struct ContentSubmitted {
    pub content: Pubkey,
    pub author: Pubkey,
    pub raw_hash: [u8; 32],
}
#[event]
pub struct ContentApproved {
    pub content: Pubkey,
}
#[event]
pub struct DistributionNodeCreated {
    pub content: Pubkey,
    pub node: Pubkey,
    pub creator: Pubkey,
}
#[event]
pub struct RepostPolicyUpdated {
    pub node: Pubkey,
    pub tip: u16,
    pub sale: u16,
}
#[event]
pub struct TipReceived {
    pub content: Pubkey,
    pub node: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}
#[event]
pub struct AccessPurchased {
    pub content: Pubkey,
    pub node: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}
#[event]
pub struct RevenueClaimed {
    pub epoch: Pubkey,
    pub beneficiary: Pubkey,
    pub amount: u64,
}
#[event]
pub struct RevenueEnteredSafeguard {
    pub epoch: Pubkey,
}
#[event]
pub struct SafeguardExitRequested {
    pub position: Pubkey,
    pub amount: u64,
    pub requested_at: i64,
}
#[event]
pub struct SafeguardExitClaimable {
    pub position: Pubkey,
    pub ready_at: i64,
}
#[event]
pub struct SimilarityCaseOpened {
    pub case: Pubkey,
    pub candidate: Pubkey,
    pub reference: Pubkey,
    pub cutoff: i64,
}
#[event]
pub struct SettlementProposed {
    pub case: Pubkey,
    pub settlement: Pubkey,
}
#[event]
pub struct SettlementAccepted {
    pub settlement: Pubkey,
    pub author: Pubkey,
}
#[event]
pub struct IndependentConfirmed {
    pub case: Pubkey,
}
#[event]
pub struct DerivativeConfirmed {
    pub case: Pubkey,
    pub source_bps: u16,
}
