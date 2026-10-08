# Revenue ledger V0

Written before revenue handlers. Amounts are unsigned token base units. Each mint has its own AssetPolicy, controlled token vault, user-liability counter and earned protocol-fee counter. There is no cross-asset collateral and no arbitrary principal withdrawal.

## Balance and time model

RevenueEpoch identifies (distribution node, mint, TIP or SALE, nonce). The payout root is copied from the immutable node; deposits are constant work independent of beneficiary count. Its first deposit fixes the normal deadline. Content remembers the current normal-window deadline so another node or asset cannot reset the consumed grace when a case opens. Old epochs retain their own deadline when a subsequent independent epoch starts. Expired normal epochs reject additional deposits; a new epoch begins a separate cycle.

A Merkle LeafPosition records pre-settlement amounts paid and, when necessary, a once-only final allocation. ClaimPosition identifies the actual recipient for that leaf. Original owner and newly agreed source can therefore claim separately without rewriting the distribution vector or clawing back completed payments.

Normal entitlement is floor(epoch gross * leaf bps / 10000). A partial claim increments that leaf's paid counter; it never changes any deadline. Unallocated floor-rounding dust stays in the vault as user liability, and cannot be swept into Treasury. Deposits and withdrawals checked-add/subtract counters. Full beneficiary enumeration is an optional offchain audit, never part of tip/purchase.

## Dispute transition

Case cutoff is min(dispute start + 7 days, existing normal deadline), including an already elapsed deadline. No revenue is needed for this clock. Every epoch of unresolved content is locked logically by Case state. At or after cutoff its unclaimed principal is safeguarded, whether or not a keeper has materialized the transition. Later deposits enter that same holding/safeguard state; they cannot create a new liquid window.

Opening a case also records its effective cutoff in the existing Content normal deadline, even with zero income. Resolution closes pre-resolution epochs to further deposits. Before cutoff, Independent and Derivative retain that content-cycle deadline; the first post-resolution income and other nodes/assets/TIP/SALE inherit its remaining time. Only after the old cutoff has elapsed can a new post-resolution epoch begin a fresh normal cycle. After cutoff, either resolution automatically starts an exit for each beneficiary's remaining allocation, anchored to the case's resolution timestamp. A later proof submission cannot delay or restart this clock.

## Settlement and partial claims

Never repartition `gross - aggregate_paid` across the original vector: a beneficiary that already claimed would take funds from an unpaid beneficiary. Instead each immutable leaf is settled independently from `floor(gross * leaf_bps / 10000) - this_leaf_paid`. Only a finalized Derivative case assesses floor(unclaimed leaf amount * 500 / 10000). The remaining Origin-role amount splits between candidate and source; Distributor and LicensedSource weights remain immutable. Source rounding remainder stays with the candidate; the total allocation conserves the leaf amount. Independent assesses zero fee.

The sum of integer leaf fees can be below floor(aggregate unclaimed * 500 / 10000), by less than the number of unpaid leaves. That difference remains with the rights holders, and is never protocol revenue. This explicitly defines the contract's integer 5% settlement fee without confiscating rounding dust. Fees become withdrawable only as valid proofs materialize final leaf allocations. No pre-resolution fee accrues.

## Safeguard and exits

Unclaimed expired entitlement is safeguarded. A recipient requests a positive amount no larger than their own balance. One outstanding request per ClaimPosition is irrevocable; requesting a partial amount removes it from the available safeguard balance. There is no strategy adapter deployment in V0.

Readiness is derived at requested_at + 48 hours. It therefore becomes claimable by 72 hours without a keeper or indexer. `finalize_exit` emits the materialized event but does not set the clock. The returned amount has a fixed new deadline at requested_at + 48 hours + 7 days. Partial withdrawal never resets it; unclaimed returned funds revert to safeguard after that deadline. Existing remaining safeguarded funds stay separate.

## Concurrency and replay

Solana serializes mutable epoch, asset and leaf accounts. PDA uniqueness prevents duplicate access receipts and replayed initialization. A settlement has proposal nonce, candidate/reference identities, both signatures and rights-authority approval. Case finalization is one-shot. Token CPIs and accounting updates are atomic in a transaction. Account substitution, beneficiary and mint constraints are checked before transfers.

## Test vectors

- A/B/C: (7000, 1800, 1200); TIP and SALE vectors differ.
- Gross 10000: 500 fee, 6650 source, 2850 candidate at 70/30 source split.
- A leaf already paid 7000: settlement cannot reallocate another leaf's unpaid 3000.
- First dispute revenue on day 8: safeguarded, with cutoff day 7.
- Normal deadline day 7; dispute day 3: only four days remain.
- Exit at T: blocked T+47h59m, claimable T+48h, still claimable T+72h.

The full onchain financial path must be validated in addition to host math tests before a release.
