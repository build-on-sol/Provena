//! Checked, deterministic economic and time arithmetic shared by instructions.
//!
//! These functions do not authorize transfers or establish settlement finality.
//! The caller must verify the immutable payout proof, claimant, asset, episode,
//! and finalized case before changing any ledger balance.

pub const BPS: u16 = 10_000;
pub const GRACE: i64 = 7 * 24 * 60 * 60;
pub const MIN_EXIT: i64 = 48 * 60 * 60;
pub const MAX_EXIT: i64 = 72 * 60 * 60;
pub const DERIVATIVE_FEE_BPS: u16 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    Overflow,
    InvalidShare,
    InsufficientBalance,
    InvalidTime,
    ExitCooldown,
    DisputeActive,
}

/// `floor(total * bps / 10000)`, with a wide intermediate for all `u64` amounts.
pub fn share(total: u64, bps: u16) -> Result<u64, MathError> {
    if bps > BPS {
        return Err(MathError::InvalidShare);
    }
    let numerator = u128::from(total)
        .checked_mul(u128::from(bps))
        .ok_or(MathError::Overflow)?;
    u64::try_from(numerator / u128::from(BPS)).map_err(|_| MathError::Overflow)
}

/// The remaining cumulative entitlement; partial claims do not round anew.
/// An already-paid amount greater than entitlement indicates invalid accounting.
pub fn claim_due(total: u64, bps: u16, already: u64) -> Result<u64, MathError> {
    share(total, bps)?
        .checked_sub(already)
        .ok_or(MathError::InsufficientBalance)
}

/// Split only the current distributor's residual, preserving every ancestor.
/// `child_retention` is the future child's fraction of that residual. The child
/// receives a floor-rounded share and the current distributor keeps the remainder.
/// Returning `(retained, child)` ensures the payout vector still sums to 10000.
pub fn split_residual(residual: u16, child_retention: u16) -> Result<(u16, u16), MathError> {
    if residual > BPS || child_retention > BPS {
        return Err(MathError::InvalidShare);
    }
    let child = u16::try_from(share(u64::from(residual), child_retention)?)
        .map_err(|_| MathError::Overflow)?;
    let retained = residual.checked_sub(child).ok_or(MathError::Overflow)?;
    Ok((retained, child))
}

/// A new fixed seven-day deadline. Deposits and partial claims must retain the
/// existing deadline instead of invoking this helper again for an active epoch.
pub fn deadline(now: i64) -> Result<i64, MathError> {
    if now < 0 {
        return Err(MathError::InvalidTime);
    }
    now.checked_add(GRACE).ok_or(MathError::Overflow)
}

/// A dispute cannot extend a consumed claim window, even if it already expired.
/// Without an existing window the clock begins now, including at zero revenue.
pub fn dispute_cutoff(now: i64, current_deadline: Option<i64>) -> Result<i64, MathError> {
    let new_deadline = deadline(now)?;
    match current_deadline {
        Some(existing) if existing < 0 => Err(MathError::InvalidTime),
        Some(existing) => Ok(existing.min(new_deadline)),
        None => Ok(new_deadline),
    }
}

/// In V0 the assets remain liquid, so an exit is claimable from 48 hours onward.
/// There is no upper expiry and no keeper dependency: a late caller remains
/// eligible. A caller materializing the next claim window must use the fixed
/// `requested_at + MIN_EXIT`, rather than the caller's later wall-clock time.
pub fn exit_ready(now: i64, requested_at: i64) -> Result<bool, MathError> {
    if requested_at < 0 || now < requested_at {
        return Err(MathError::InvalidTime);
    }
    // Refuse a request whose contractual latest completion is unrepresentable.
    requested_at
        .checked_add(MAX_EXIT)
        .ok_or(MathError::Overflow)?;
    let earliest = requested_at
        .checked_add(MIN_EXIT)
        .ok_or(MathError::Overflow)?;
    Ok(now >= earliest)
}

/// Allocate a *finalized derivative episode's* remaining leaf liability once.
///
/// Returns `(protocol_fee, source, owner)`. Prior payments stay with their actual
/// recipients. Only an Origin leaf is split between source and candidate; a
/// distributor keeps its immutable leaf entitlement after the settlement fee.
/// The rights holder keeps division remainders, so principal cannot silently
/// become treasury dust. Per-leaf fee floors can produce less than the aggregate
/// 5% by fewer than one base unit per nonzero leaf, retained as user liability.
/// This is arithmetic only: calling twice must be prevented by the caller's
/// immutable episode/position checkpoint, and independent resolution must skip it.
pub fn settle_unclaimed_leaf(
    gross_entitlement: u64,
    already_paid: u64,
    source_bps: u16,
    is_origin: bool,
) -> Result<(u64, u64, u64), MathError> {
    if source_bps > BPS {
        return Err(MathError::InvalidShare);
    }
    let unclaimed = gross_entitlement
        .checked_sub(already_paid)
        .ok_or(MathError::InsufficientBalance)?;
    let fee = share(unclaimed, DERIVATIVE_FEE_BPS)?;
    let rights = unclaimed.checked_sub(fee).ok_or(MathError::Overflow)?;
    let source = if is_origin {
        share(rights, source_bps)?
    } else {
        0
    };
    let owner = rights.checked_sub(source).ok_or(MathError::Overflow)?;
    Ok((fee, source, owner))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 24 * 60 * 60;

    // Deterministic dependency-free property loops; wrapping is test RNG only.
    fn random(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *seed
    }

    #[test]
    fn protocol_time_constants_match_contract() {
        assert_eq!(GRACE, 604_800);
        assert_eq!(MIN_EXIT, 172_800);
        assert_eq!(MAX_EXIT, 259_200);
        assert!(MIN_EXIT <= MAX_EXIT);
    }

    #[test]
    fn shares_are_floor_rounded_base_units() {
        assert_eq!(share(100, 7000), Ok(70));
        assert_eq!(share(101, 7000), Ok(70));
        assert_eq!(share(1, 9999), Ok(0));
        assert_eq!(share(0, BPS), Ok(0));
        assert_eq!(share(100, 0), Ok(0));
        assert_eq!(share(100, BPS), Ok(100));
    }

    #[test]
    fn full_u64_amounts_use_wide_intermediate() {
        assert_eq!(share(u64::MAX, BPS), Ok(u64::MAX));
        assert_eq!(share(u64::MAX, 500), Ok(u64::MAX / 20));
        assert_eq!(claim_due(u64::MAX, BPS, 1), Ok(u64::MAX - 1));
    }

    #[test]
    fn shares_outside_bps_are_rejected() {
        for invalid in [BPS + 1, u16::MAX] {
            assert_eq!(share(1, invalid), Err(MathError::InvalidShare));
            assert_eq!(claim_due(1, invalid, 0), Err(MathError::InvalidShare));
            assert_eq!(split_residual(invalid, 0), Err(MathError::InvalidShare));
            assert_eq!(split_residual(0, invalid), Err(MathError::InvalidShare));
            assert_eq!(
                settle_unclaimed_leaf(1, 0, invalid, false),
                Err(MathError::InvalidShare)
            );
        }
    }

    #[test]
    fn repeated_and_partial_claims_use_cumulative_rounding() {
        assert_eq!(claim_due(3, 3333, 0), Ok(0));
        assert_eq!(claim_due(4, 3333, 0), Ok(1));
        assert_eq!(claim_due(4, 3333, 1), Ok(0));
        assert_eq!(claim_due(7, 3333, 1), Ok(1));
        assert_eq!(claim_due(100, 7000, 20), Ok(50));
        assert_eq!(claim_due(100, 7000, 70), Ok(0));
        assert_eq!(
            claim_due(100, 7000, 71),
            Err(MathError::InsufficientBalance)
        );
    }

    #[test]
    fn original_revenue_does_not_allocate_to_nonexistent_children() {
        let direct_original_vector = [BPS];
        let future_child_policy = 3000;
        assert_eq!(share(100, direct_original_vector[0]), Ok(100));
        assert_eq!(split_residual(BPS, future_child_policy), Ok((7000, 3000)));
        assert_eq!(direct_original_vector, [BPS]);
    }

    #[test]
    fn a_b_c_distribution_vector_is_exact() {
        let (a, b_residual) = split_residual(BPS, 3000).unwrap();
        let (b, c) = split_residual(b_residual, 4000).unwrap();
        assert_eq!([a, b, c], [7000, 1800, 1200]);
        assert_eq!(share(100, a), Ok(70));
        assert_eq!(share(100, b), Ok(18));
        assert_eq!(share(100, c), Ok(12));
        assert_eq!(a + b + c, BPS);
    }

    #[test]
    fn residual_rounding_keeps_remainder_with_current_distributor() {
        assert_eq!(split_residual(1, 9999), Ok((1, 0)));
        assert_eq!(split_residual(3, 5000), Ok((2, 1)));
        assert_eq!(split_residual(BPS, 0), Ok((BPS, 0)));
        assert_eq!(split_residual(BPS, BPS), Ok((0, BPS)));
        assert_eq!(split_residual(0, BPS), Ok((0, 0)));
    }

    #[test]
    fn tip_sale_policies_are_independent_and_existing_vectors_immutable() {
        let tip_original = split_residual(BPS, 3000).unwrap();
        let sale_original = split_residual(BPS, 2000).unwrap();
        assert_eq!(tip_original, (7000, 3000));
        assert_eq!(sale_original, (8000, 2000));
        let future_tip_child = split_residual(tip_original.1, 4000).unwrap();
        let future_sale_child = split_residual(sale_original.1, 1000).unwrap();
        assert_eq!(future_tip_child, (1800, 1200));
        assert_eq!(future_sale_child, (1800, 200));
        assert_eq!(tip_original, (7000, 3000));
        assert_eq!(sale_original, (8000, 2000));
    }

    #[test]
    fn licensed_source_is_locked_while_residual_propagates() {
        let source = 2000;
        let (creator, child) = split_residual(BPS - source, 3000).unwrap();
        assert_eq!([source, creator, child], [2000, 5600, 2400]);
        assert_eq!(share(100, source), Ok(20));
        assert_eq!(share(100, creator), Ok(56));
        assert_eq!(share(100, child), Ok(24));
    }

    #[test]
    fn zero_revenue_dispute_starts_a_real_clock() {
        let start = DAY;
        let cutoff = dispute_cutoff(start, None).unwrap();
        assert_eq!(cutoff, start + 7 * DAY);
        assert!(start + 6 * DAY < cutoff);
        assert!(start + 7 * DAY >= cutoff);
        assert!(start + 8 * DAY >= cutoff);
    }

    #[test]
    fn dispute_after_three_days_has_only_four_days_remaining() {
        let original_deadline = deadline(0).unwrap();
        let dispute_started_at = 3 * DAY;
        let cutoff = dispute_cutoff(dispute_started_at, Some(original_deadline)).unwrap();
        assert_eq!(cutoff, original_deadline);
        assert_eq!(cutoff - dispute_started_at, 4 * DAY);
    }

    #[test]
    fn dispute_never_reopens_an_already_expired_window() {
        let original_deadline = deadline(0).unwrap();
        assert_eq!(
            dispute_cutoff(8 * DAY, Some(original_deadline)),
            Ok(original_deadline)
        );
        assert_eq!(dispute_cutoff(8 * DAY, Some(0)), Ok(0));
    }

    #[test]
    fn new_revenue_cannot_move_an_existing_cutoff_later() {
        let original_deadline = deadline(100).unwrap();
        for elapsed in 0..=30 * DAY {
            assert_eq!(
                dispute_cutoff(100 + elapsed, Some(original_deadline)),
                Ok(original_deadline)
            );
        }
    }

    #[test]
    fn negative_or_unrepresentable_times_are_rejected() {
        assert_eq!(deadline(-1), Err(MathError::InvalidTime));
        assert_eq!(deadline(i64::MAX), Err(MathError::Overflow));
        assert_eq!(deadline(i64::MAX - GRACE), Ok(i64::MAX));
        assert_eq!(deadline(i64::MAX - GRACE + 1), Err(MathError::Overflow));
        assert_eq!(dispute_cutoff(-1, None), Err(MathError::InvalidTime));
        assert_eq!(dispute_cutoff(0, Some(-1)), Err(MathError::InvalidTime));
        assert_eq!(dispute_cutoff(i64::MAX, None), Err(MathError::Overflow));
        assert_eq!(exit_ready(-1, -1), Err(MathError::InvalidTime));
        assert_eq!(exit_ready(99, 100), Err(MathError::InvalidTime));
        assert_eq!(exit_ready(i64::MAX, i64::MAX), Err(MathError::Overflow));
        assert_eq!(exit_ready(i64::MAX, i64::MAX - MAX_EXIT), Ok(true));
        assert_eq!(
            exit_ready(i64::MAX, i64::MAX - MAX_EXIT + 1),
            Err(MathError::Overflow)
        );
    }

    #[test]
    fn exit_is_never_claimable_before_48h_and_remains_ready_after_72h() {
        let requested_at = 100;
        assert_eq!(exit_ready(requested_at, requested_at), Ok(false));
        assert_eq!(
            exit_ready(requested_at + MIN_EXIT - 1, requested_at),
            Ok(false)
        );
        assert_eq!(exit_ready(requested_at + MIN_EXIT, requested_at), Ok(true));
        assert_eq!(exit_ready(requested_at + MAX_EXIT, requested_at), Ok(true));
        assert_eq!(exit_ready(requested_at + 30 * DAY, requested_at), Ok(true));
    }

    #[test]
    fn reactivated_window_uses_fixed_readiness_time() {
        let requested_at = 100;
        let ready_at = requested_at + MIN_EXIT;
        let fixed_claim_deadline = deadline(ready_at).unwrap();
        assert_eq!(fixed_claim_deadline, requested_at + 9 * DAY);
        let delayed_caller = requested_at + 30 * DAY;
        assert_eq!(exit_ready(delayed_caller, requested_at), Ok(true));
        assert!(delayed_caller >= fixed_claim_deadline);
    }

    #[test]
    fn derivative_settlement_matches_5_66_5_28_5_vector_in_base_units() {
        assert_eq!(
            settle_unclaimed_leaf(10_000, 0, 7000, true),
            Ok((500, 6650, 2850))
        );
        assert_eq!(settle_unclaimed_leaf(100, 0, 7000, true), Ok((5, 66, 29)));
        assert_eq!(settle_unclaimed_leaf(1, 0, 7000, true), Ok((0, 0, 1)));
        assert_eq!(settle_unclaimed_leaf(0, 0, BPS, true), Ok((0, 0, 0)));
    }

    #[test]
    fn settlement_preserves_historical_payments_and_only_splits_remaining_origin() {
        // Original cumulative entitlement is 7000, of which 6000 was already paid.
        assert_eq!(
            settle_unclaimed_leaf(7000, 6000, 7000, true),
            Ok((50, 665, 285))
        );
        assert_eq!(settle_unclaimed_leaf(7000, 7000, 7000, true), Ok((0, 0, 0)));
        assert_eq!(
            settle_unclaimed_leaf(7000, 7001, 7000, true),
            Err(MathError::InsufficientBalance)
        );
    }

    #[test]
    fn derivative_reclassification_preserves_downstream_vectors() {
        let vector = [7000, 1800, 1200];
        let origin =
            settle_unclaimed_leaf(share(10_000, vector[0]).unwrap(), 0, 7000, true).unwrap();
        let b = settle_unclaimed_leaf(share(10_000, vector[1]).unwrap(), 0, 7000, false).unwrap();
        let c = settle_unclaimed_leaf(share(10_000, vector[2]).unwrap(), 0, 7000, false).unwrap();
        assert_eq!(origin, (350, 4655, 1995));
        assert_eq!(b, (90, 0, 1710));
        assert_eq!(c, (60, 0, 1140));
        assert_eq!(vector, [7000, 1800, 1200]);
        assert_eq!(origin.0 + b.0 + c.0, 500);
        assert_eq!(origin.1 + origin.2 + b.2 + c.2, 9500);
    }

    #[test]
    fn aggregate_repartitioning_cannot_confiscate_late_distributor_entitlement() {
        // In a 100-unit episode, A already claimed 70. B is still entitled to 30.
        // Repartitioning the remaining 30 by the old vector would wrongly leave
        // B just 9. Settlement must instead use B's own unclaimed entitlement.
        let b_entitlement = share(100, 3000).unwrap();
        let (fee, source, b_remaining) =
            settle_unclaimed_leaf(b_entitlement, 0, 7000, false).unwrap();
        assert_eq!((fee, source, b_remaining), (1, 0, 29));
        assert_eq!(fee + b_remaining, b_entitlement);
        assert_eq!(settle_unclaimed_leaf(70, 70, 7000, true), Ok((0, 0, 0)));
    }

    #[test]
    fn full_u64_settlement_does_not_overflow_or_extract_extra_principal() {
        let (fee, source, owner) = settle_unclaimed_leaf(u64::MAX, 0, 7000, true).unwrap();
        assert_eq!(fee, u64::MAX / 20);
        assert_eq!(
            u128::from(fee) + u128::from(source) + u128::from(owner),
            u128::from(u64::MAX)
        );
        assert_eq!(settle_unclaimed_leaf(u64::MAX, 0, BPS, false).unwrap().1, 0);
    }

    #[test]
    fn property_shares_and_settlement_conserve_liability() {
        let mut seed = 0x7368_6172_652d_7630;
        for _ in 0..20_000 {
            let total = random(&mut seed);
            let bps = (random(&mut seed) % (u64::from(BPS) + 1)) as u16;
            let entitlement = share(total, bps).unwrap();
            assert!(entitlement <= total);
            assert_eq!(
                u128::from(entitlement),
                u128::from(total) * u128::from(bps) / u128::from(BPS)
            );
            let already = random(&mut seed).min(entitlement);
            let due = claim_due(total, bps, already).unwrap();
            assert_eq!(
                u128::from(due) + u128::from(already),
                u128::from(entitlement)
            );
            let (fee, source, owner) =
                settle_unclaimed_leaf(entitlement, already, bps, true).unwrap();
            assert_eq!(
                u128::from(already) + u128::from(fee) + u128::from(source) + u128::from(owner),
                u128::from(entitlement)
            );
            assert_eq!(fee, due / 20);
        }
    }

    #[test]
    fn property_deeper_reposts_preserve_ancestors_and_exact_total() {
        let mut seed = 0x7072_6f70_6167_6174;
        for _ in 0..1000 {
            let mut vector = vec![BPS];
            for _ in 0..64 {
                let ancestors = vector[..vector.len() - 1].to_vec();
                let residual = vector.pop().unwrap();
                let policy = (random(&mut seed) % (u64::from(BPS) + 1)) as u16;
                let (retained, child) = split_residual(residual, policy).unwrap();
                vector.push(retained);
                vector.push(child);
                assert_eq!(&vector[..ancestors.len()], ancestors.as_slice());
                assert_eq!(
                    vector.iter().map(|value| u32::from(*value)).sum::<u32>(),
                    u32::from(BPS)
                );
            }
        }
    }

    #[test]
    fn property_cumulative_claims_never_exceed_received_and_dust_is_bounded() {
        let vector = [7000, 1800, 1200];
        let mut claimed = [0u64; 3];
        for total in 0..20_000 {
            for (index, bps) in vector.iter().enumerate() {
                let due = claim_due(total, *bps, claimed[index]).unwrap();
                claimed[index] = claimed[index].checked_add(due).unwrap();
                assert_eq!(claim_due(total, *bps, claimed[index]), Ok(0));
            }
            let paid: u64 = claimed.iter().sum();
            assert!(paid <= total);
            // Sum of three floor divisions loses fewer than three base units.
            assert!(total - paid < vector.len() as u64);
        }
    }

    #[test]
    fn property_fee_rounding_never_exceeds_aggregate_5_percent() {
        let vector = [7000, 1800, 1200];
        let mut seed = 0x6665_652d_6475_7374;
        for _ in 0..10_000 {
            let gross = random(&mut seed);
            let mut total_entitlement = 0u128;
            let mut fees = 0u128;
            let mut rights = 0u128;
            for (index, bps) in vector.iter().enumerate() {
                let entitlement = share(gross, *bps).unwrap();
                let (fee, source, owner) =
                    settle_unclaimed_leaf(entitlement, 0, 7000, index == 0).unwrap();
                total_entitlement += u128::from(entitlement);
                fees += u128::from(fee);
                rights += u128::from(source) + u128::from(owner);
            }
            let aggregate_fee = total_entitlement * 500 / u128::from(BPS);
            assert!(fees <= aggregate_fee);
            assert!(aggregate_fee - fees < vector.len() as u128);
            assert_eq!(fees + rights, total_entitlement);
            assert!(total_entitlement <= u128::from(gross));
        }
    }
}
