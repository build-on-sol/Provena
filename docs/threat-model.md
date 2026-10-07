# Threat model

## Custody and economic attacks

- Malicious claimant: leaf binds node/kind/role/wallet/weight; position binds actual signed recipient; PDA, mint, vault, authority and token program constraints prevent substitution. Cumulative paid counters prevent repeated claims. Epoch conservation cap protects other epochs even if an attestation is bad.
- Admin compromise: pause/asset enable and bounded earned-fee withdrawal only. No principal sweep, forced settlement, author mutation or creator impersonation. Upgrade authority can replace program code; operational custody/disclosure remains essential and is not hidden by PDA safety claims.
- Malicious Token-2022 mint: all extensions are rejected in V0, as are freeze-authority mints. Approval is explicit. Plain SPL/Token-2022 checked transfers maintain requested/received parity. Existing deposits cannot be trapped merely by disabling payment acceptance. Mint issuer dilution is price risk, never counted as cross-asset backing.
- Overflow/dust: u128 fraction intermediates and checked counters. Dust is user liability. No cross-asset solvency claims, oracle pricing or strategy loss socialization.
- Dispute abuse: no principal claim by either party until agreement. AI attestation cannot resolve rights, move funds or receive a fee. Fee accrues only after accepted derivative finalization. Prior partial payments are checkpointed leaf by leaf. Zero revenue does not stop the cutoff clock.
- Exit abuse: irrevocable request, amount cap and48h minimum. Readiness derives from chain Clock; keeper outages cannot postpone it beyond72h. Old windows and partial claims never extend deadlines.

## Content and distribution attacks

- Malicious creator, fake citation and duplicates: wallet signature, attested canonical hash and global fingerprint PDA. Structured grapheme segments must exactly match source; aggregate citation limits are versioned. Quote-none paid bodies cannot be disclosed by citation. The program cannot validate plaintext it does not store; content/originality-service compromise can mis-attest hashes or manifests and is an explicit trust boundary.
- Repost/rights-attestation abuse: private parent math and entire vector are authority-certified. A compromised rights key can certify dishonest new roots or private provenance; no ZK correctness claim. Creator signature is still required, existing roots cannot mutate, and per-epoch caps prevent spending someone else's deposited epoch. SDK verifies math/reveals before signing.
- Front-running/spam: deterministic author+raw-hash identity cannot be taken over by another wallet; global fingerprints require originality co-sign. Users pay account rent. Backend rate limits and reviewed attestation signing are needed operationally, not replaced with a new moderation system.
- Settlement replay: proposal nonce, case identity, author signatures and irreversible finalization. Accepted old proposal cannot reopen a resolved case. One final case per content avoids historical rights mutation; extending this requires versioned snapshots.

## Offchain systems

- Indexer compromise/outage: display data may be wrong or stale; owner, financial state, receipt and exit clocks remain onchain. Clients should verify sensitive facts with RPC. Event ingestion must verify program identity and transaction finality before accepting a projection.
- Content storage/key-service compromise: paid plaintext/keys can leak; AES-GCM prevents accidental/tampered ciphertext acceptance but the operator sees plaintext. Key release checks live receipt and wallet request signatures. No promise against screenshots, OCR or authorized redistribution.
- Provenance DB leak: service knows real parent relationships. Salted commitments hide public parent pointers until reveal; claims and economic activity may still correlate users. V0 is not anonymity or ZK. Keep private store separate from public metadata and expose reveal only under configured authorization.
- Signed reaction/message replay: domain-separated route/payload, timestamp bounds and durable per-wallet nonce. Review messages are scoped to chain-attested case participants; ordinary messages do not write financial state.
- Authority key compromise: keys should be separate, offline/multisig custody considered outside this local build. Test fixtures must never become production keys. Service co-sign/broadcast is deliberately separate from receiving user content.

## Validation limits

Host math tests do not prove token custody or account constraints. Run SBF/LiteSVM transactions for substitutions, authorization, replay, time transitions and solvency before treating V0 core as accepted. No production release, public deployment or security audit is implied by this repository scaffolding.
