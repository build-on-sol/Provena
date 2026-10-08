# Provena V0 protocol specification

Authoritative product source: [V0 execution contract](../Solana%20内容权益社交协议%20V0%20—%20Codex%20执行契约.md). This implementation has no UI, governance token, NFT, oracle, cross-chain system, external yield strategy, arbitration court or AI recommendation engine.

## Identity and authority

Content author, raw SHA256, canonical SHA256, canonicalization version, storage and citation commitments are immutable. V1 canonicalization is frozen in the shared package. Fingerprint PDA uses canonical hash alone, globally across authors. Submit requires the author and originality authority; the latter attests canonical hashing and citation validation, and cannot sign for the author. Original approval is separate from the author's submission. Content bodies stay offchain.

Admin, originality and rights authorities are distinct wallets at initialization. Initialization must be signed by the program's actual upgrade authority. Admin can pause deposits and disable assets; it cannot change ownership, roots, receipts, finalized cases or recipient positions. Withdrawal is capped to earned fees and the configured treasury wallet. Claims remain available when deposits are paused/disabled. Program upgrade authority remains a trust boundary and must be publicly disclosed and operationally separated before production use.

## PDAs and accounts

All long-lived accounts include version1. Seeds use literal ASCII domains and fixed-width public keys/hashes. Integers are little endian.

| Account | Seeds after domain |
|---|---|
| config | none |
| asset | mint |
| vault | asset policy |
| content | author, raw hash |
| fingerprint | canonical hash |
| original | content |
| node | content, creator, nonce32 |
| epoch | node, mint, kindu8, nonceu64 |
| leaf | epoch, roleu8, leaf wallet |
| position | leaf, actual recipient |
| access | content, buyer |
| case | candidate content |
| settlement | case, proposal nonceu64 |

ClaimPosition combines SafeguardPosition and ExitRequest accounting without creating parallel custody. RevenueEpoch fixes the claim window. LeafPosition preserves a previous partial payment before reclassification. Graphs remain separate: the private provenance store has parent mappings; nodes hold immutable payout commitments; Content/SimilarityCase hold origin-right classification.

## Distribution and proofs

TIP=0 and SALE=1 have separate roots and child policies. Roles: Origin=0, Distributor=1, LicensedSource=2. Original root includes author10000bps or licensed source plus author's residual. One licensed source is supported in V0, up to5000bps; the canonical manifest accepts multiple sources for versioned extension.

Child policy allocates only the parent's residual. Locked upstream shares are preserved. Child=floor(residual*child_bps/10000); parent retains the remainder. A7000/B3000 followed by a4000bps child allocation produces A7000/B1800/C1200. Policy edits affect only future nodes, never current/previous roots.

Leaf SHA256 input: ASCII `provena:payout:v1`, node32, kind1, role1, wallet32, share2LE. Internal hash input: ASCII `provena:merkle:v1`, smaller hash32, larger hash32. Leaves are aggregated by (role,wallet), sorted canonically, and odd nodes duplicate their own hash. A proof is capped at32 siblings. The rights authority certifies deduplication, sum10000 and valid residual composition. Repost creation takes no public parent account. Provenance SHA256 commits `provena:provenance:v1`, node32, parent32, parent commitment32, salt32. SDK verifies disclosed links.

## Revenue, access and solvency

All amounts are u64 token base units. Checked u128 intermediates compute BPS fractions. Deposits transfer once into the mint vault and increment one epoch and asset liability. No transfer loop over beneficiaries. Epoch paid+assessed fees may never exceed that epoch's deposited gross, preventing a bad root from spending another epoch's backing. Vault assets cover user liability plus unpaid earned fees in the same mint.

Purchase uses the content price and SALE root. AccessReceipt seeds exclude node, so a second purchase through another node fails before any CPI. Paid key service checks the live receipt's PDA, program owner, account discriminator, content and buyer; it fails closed on RPC error. Paid bodies default quote policy NONE. It is access control, not permanent DRM.

Normal epochs have a shared content-cycle deadline, retained inside each epoch. New deposits and partial payments cannot extend existing time. All time/settlement behavior is defined in [revenue-ledger.md](revenue-ledger.md).

## Review and settlement

Similarity is risk evidence, not proof of theft. Originality authority opens a case; only both authors can confirm Independent. Either author may propose a versioned settlement; both must accept; rights authority finalizes Derivative. Case transitions are irreversible. One final source-classification review per content is the V0 schema boundary, recorded in ADR-004.

Unresolved revenue is locked. Cutoff runs even at zero income, inherits elapsed normal grace and cannot reset. After cutoff, both old and future unresolved liabilities are safeguarded. Independent pays no dispute fee. Derivative assesses a nominal5% integer fee on each unclaimed leaf;95% remains rights allocation. The fee rounding remainder favors users. Only Origin-role residual is reclassified; downstream roots/weights and existing licensed source rights survive. Late settlement triggers automatic exit anchored to resolution, never immediate withdrawal. Future approved derivative income honors source rights without repeating the historical dispute settlement fee.

## Offchain scope

Canonical bodies, encrypted blobs, structured exact citation segments, private parent mappings, signed reactions, review messages and similarity evidence are offchain. Indexer projections are display/query state and cannot alter chain balances. Claiming directly through RPC/SDK remains possible when services are down. Paid beneficiary count is the count of distinct recipients with positive computed entitlement, not claim invocations; an unavailable complete vector must be marked unknown, never guessed.

Signed staging creates a PENDING artifact and does not reserve another author's canonical fingerprint. Production staging consults the finalized global fingerprint registry. Signed `/content/confirm` is restricted to the artifact author and verifies the finalized Content identity and registry against the stored hashes, mode and commitments; confirmation preserves ciphertext and key bytes. Missing lifecycle in legacy stores means PENDING. The local originality result remains risk evidence, never approval.

Full provenance reveal and full payout-vector responses require the existing node creator or configured Rights authority, a live finalized node matching the private commitment/roots, and `valueEvent: { epoch, nonce }`. The reader checks the program-owned RevenueEpoch PDA, content/node/mint/kind/nonce, payout root, accounting and positive gross from a successful deposit. A plan or cached confirmation alone cannot authorize disclosure. Without value-event evidence, `/provenance/proof` returns only the requesting beneficiary's own leaves and proofs. No new reading role or minimum payment is introduced.

The indexer reads legacy/v0/v1 transactions with the pinned client and attributes events to completed Provena invocation frames. Unknown formats/events, missing logs and RPC failures preserve the unprocessed checkpoint and expose an ERROR synchronization state. Health, metrics and the claim dashboard report synchronization status; a checkpoint loaded after restart is NOT_STARTED until a complete finalized scan succeeds. Chain receipt and custody reads remain independent of this projection.

## Rounding and failures

Per-vector dust is gross minus the sum of floor leaf entitlements; it is user liability and stays in the vault. Settlement fees floor per unpaid leaf and never confiscate dust. Exits and partial claims preserve recipient balance. There is no dust sweep or external strategy method.

Explicit errors cover unauthorized authority, paused/unsupported asset, duplicate canonical identity, invalid roots/proofs/shares, insufficient balance, expired window, closed epoch, unresolved dispute, exit cooldown/pending/not-ready, mismatched or already finalized settlement, arithmetic overflow, mint/program/account mismatch and principal protection. Account initialization also returns Anchor's deterministic existing-PDA error for replayed receipts.
