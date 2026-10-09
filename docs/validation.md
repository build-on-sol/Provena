# V0 validation and engineering handoff

## Baseline and scope

This section and the original acceptance/corrective findings below are historical bootstrap records. Current audit-remediation provenance and actual results are in Final check results; historical statements alone are not current PASS evidence.

Verified worktree: `/home/k5068/.codex/worktrees/c5e8/Provena`, branch `dev`, initial HEAD `a8f7e266cbae41e5954b42b09c33d75b1b22e6d7`. The initial checkout contained README, LICENSE and the V0 execution contract; there was no existing runtime, schema, migration, test suite or separate Engineering Handoff. No applicable filesystem AGENTS.md was present. The user's supplied repository execution instructions and the execution contract govern this implementation.

Implementation follows the six V0 phases: Anchor account/authority skeleton; immutable content and distribution; integer token custody/claims/safeguard; content-scoped paid access; bilateral review settlement; minimal offchain services and SDK. The original execution contract and license are unchanged. This document records verified findings rather than changing the product contract.

## Reproducible checks

Use the toolchain/environment in README, including the OpenSSL paths for this WSL image. Run:

```bash
npm ci --ignore-scripts
npm test
npm audit
cargo fmt --all --check
cargo test --workspace
npm run build:program
npm run build:idl
npm run test:vm
git diff --check
```

The VM suite deliberately requires an SBF artifact. It is ignored by ordinary host `cargo test`, then explicitly enabled by `test:vm`; a missing artifact fails that run instead of silently skipping custody tests. No RPC, deployment, token purchase or externally funded transaction is required for these in-process tests.

## Acceptance evidence

| Criteria | Implementation and deterministic evidence |
|---|---|
| AC-1, AC-4 | Rights-math golden/property vectors plus actual co-signed repost transactions and token payouts: TIP 70/18/12, independent SALE 80/18/2. Updating a parent policy leaves existing child roots unchanged. |
| AC-2 | `process_deposit` makes one checked token transfer to the asset vault. It does not enumerate beneficiaries or load ancestors. Merkle work belongs to individual claims. |
| AC-3 | Receipt PDA seeds are `access, content, buyer`; VM purchase replay and SDK/RPC content/buyer/owner checks. |
| AC-5 | Canonical hash is a global fingerprint seed; cross-author duplicate VM submission rejects. Shared canonicalization retains raw identity and freezes V1 behavior. |
| AC-6 | DistributionNode schema and repost account metas contain no parent address. Private salted commitments and complete reveal verification are tested separately. |
| AC-7 | Fee withdrawal requires configured admin/treasury and earned-fee cap; VM arbitrary admin, destination and amount attacks reject. Upgrade authority remains a disclosed deployment trust boundary. |
| AC-8, AC-12 | Expired normal balances require a signed, amount-bounded exit. VM tests reject immediate/early withdrawal, allow 48-hour readiness, preserve partial requests and expire returned windows. |
| AC-9, AC-10 | Zero-revenue dispute starts a real Clock cutoff. Permissionless transition and late deposits retain the original cutoff; they do not start a new window. |
| AC-11 | Content-wide inherited deadline, unresolved-case checks, old-epoch closure and partial-claim tests prevent grace resets. |
| AC-13, AC-14 | Independent charges zero. Derivative assesses an integer 5% fee only on each leaf's unclaimed disputed allocation. Prior payments, one-time fee assessment, source/candidate split and token solvency are tested. |
| AC-15 | Immutable distributor leaves survive origin reclassification. Math tests verify both downstream shares; VM settlement exercises actual distributor and source withdrawals. |
| AC-16, AC-17 | Citation manifests commit exact ordered source segments and mandatory attribution/view/tip actions. Citation processing never adds a royalty leaf; source licensing is a separate bilateral instruction. |
| AC-18 | Paid body defaults NONE. Shared and service tests reject unauthorized paid-body citation and release keys only after signed requests and verified chain receipts. |
| AC-19 | Ownership, liabilities, receipts, dispute and exit clocks live in Anchor accounts. VM financial tests use no backend/indexer. Service tests fail closed on RPC failure and reject public financial event ingestion. Proof/storage backups remain an operational requirement. |
| AC-20 | Host math/property tests, strict SDK/canonicalization/service tests and separately executed real SBF/LiteSVM transaction tests cover core paths, substitutions, impersonation, replay, integer bounds and time transitions. |

## Verified corrective findings

1. Anchor 0.32.1 requires AccountInfo's `resize`; an old test-dependency lock selected 2.2.1 and failed compilation. The compatible VM line is LiteSVM 0.7.1 with Solana SDK 2.3.1, AccountInfo 2.3.0 and Keypair 2.2.3 frozen in Cargo.lock. These were environment/dependency integration failures, not transaction-test failures.
2. The SBF compiler reports stack errors while returning success. Purchase/Claim contexts exceeded 4096 bytes; boxing their large Anchor accounts removed those errors without changing serialized schema or instruction ABI. Acceptance requires actual VM execution, not the build exit code alone.
3. A shared mint vault needs an epoch-level cap as well as individual paid counters. Claims and fee materialization now enforce `paid + fees <= gross`, protecting other epochs even if a rights authority certifies a bad vector.
4. Anchor's AccountClient does not check the owning program on receipt fetch. SDK access checks now read one RPC account and validate owner, executable flag, discriminator, version, positive amount and exact content/buyer. The key service performs equivalent finalized checks.
5. The official anchor-lang-idl 0.1.4 builder incorrectly passes literal `+{toolchain}` when Rustup exports RUSTUP_TOOLCHAIN. The example preserves the resolved Cargo binary and removes that environment branch before calling the official builder. IDL is generated from source, not hand-maintained.
6. Local program-address synchronization originally left a service constant unchanged. Service readers now reuse the SDK's address. The user-run local helper rebuilds source, IDL and SDK after synchronizing its freshly generated deployment key.
7. Targeted TOML/Jayson dependency overrides remove the reported npm advisories. Both Anchor/web3 imports and the SDK/service test suite are verified after the overrides.

Agave 2.3.0 post-processing with newer platform-tools v1.57 emits an undefined-syscall warning for standard Solana calls. The SBF artifact is verified by executing its real hashing, system-account creation and SPL token CPI paths in LiteSVM. This warning is recorded distinctly from the corrected stack errors; no public/local-validator deployment result is claimed.

## Capability limits and authority preservation

- V0 permits one licensed source with a 5000-bps cap, and one irreversible final classification case per content. Multi-source and repeat-review schema changes require a separately authorized versioned design.
- Native SOL was optional and is omitted; approved wrapped SOL and plain SPL/Token-2022 use the existing asset adapter. Every Token-2022 extension and freeze-authority mint is rejected.
- Article metrics return an explicit unknown paid-beneficiary count when a complete verified entitlement projection is unavailable; they never substitute claim count. The claim dashboard reports finalized historical claims and marks live balances unknown. Clients read chain accounts and use proofs for authoritative balances. These display projections are not complete financial dashboards.
- Detached originality/rights audit signatures require the corresponding authority to co-sign actual transactions. The mock similarity result is risk evidence, never unilateral copyright adjudication.
- Local deployment/initialization scripts are delivered for explicit user execution. No deployment, merge, push, publication, production mutation, paid service, external communication or future strategy was performed.
- Production custody, independent security review, durable storage operation and optional future UI are outside this V0 implementation. The retained upgrade key can replace code; handler restrictions alone do not remove that trust.

## Final check results

Current result as of 2026-10-09: the residual log-truncation correction and required matrix have completed at READY_FOR_DEPLOYMENT_REVIEW; see [the current run](#2026-10-09-indexer-log-truncation). The following 2026-10-08 results are preserved historical evidence and did not cover the subsequently verified truncation defect.

2026-10-08, Asia/Shanghai: the authorized R1–R6 remediation is complete at **READY_FOR_DEPLOYMENT_REVIEW**. This is a local verification result, not public-cluster deployment authorization or security certification. See [the executed Handoff](handoffs/v0.0.1-audit-remediation.md#7-codex-findings) for verified defects, failure-first evidence, boundaries and all 17 changed files.

Historical execution repository/worktree: `build-on-sol/Provena`, `/home/k5068/.codex/worktrees/c5e8/Provena`; branch `chore/v0.0.1-audit-handoff`; starting/execution HEAD `db6dafe4115f5f002c7fc62dad29ca4fe8d7c726` plus that round's corrective changes. No newer branch commits were found then. The October8 delivery commit was `26a03ba078aec39eabdadf4d9f259ae08cc72533`; the October9 residual correction is a separate delivery recorded below.

Tooling actually used: Node 22.22.1/npm 9.2.0, TypeScript 5.9.2, host Rust/Cargo 1.99.0, Anchor Rust/TS 0.32.1, Agave CLI/validator 2.3.0, LiteSVM 0.7.1. SBF builds explicitly use tools v1.57 (actual solana rustc 1.95.0-dev); the cargo-build-sbf 2.3.0 bare version display reports its default v1.48/1.84.1 and does not describe this invocation. Anchor CLI was unavailable (the inventory's `command -v anchor` exited 1); the existing official IDL builder example succeeded without it. The locked minimal client change is web3.js 1.98.4→1.99.0 with required codecs/errors 5.5.1 and commander 14.0.2; Anchor, Rust dependencies and Agave were not upgraded. [Official v1 read support](https://github.com/solana-foundation/solana-web3.js/releases/tag/v1.99.0) and the actual Connection response-decoding regressions justify that change.

Commands ran with repository-local Cargo/Rustup/Agave paths and `OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu`, `OPENSSL_INCLUDE_DIR=/usr/include`. All following logs are local ignored files under `.local-tools/audit-evidence/`; logs, keys, paid content, DBs and build artifacts are not committed. `final-gates.jsonl` records exact command, timestamp, exit and log path. No `npm run lint` exists or was run.

| Actual command | Result / exit | Log file |
|---|---|---|
| `npm ci --ignore-scripts` | PASS / 0 | `final-npm-ci.log` |
| `npm test` (includes tsc) | PASS / 0; 67 passed, 0 failed, 0 skipped | `final-npm-test.log` |
| `npm audit` | PASS / 0; 0 vulnerabilities | `final-npm-audit.log` |
| `cargo fmt --all --check` | PASS / 0 | `final-cargo-fmt.log` |
| `cargo test --workspace` | PASS / 0; 27 host passed, 26 security ignored | `final-cargo-test.log` |
| `npm run build:program` | PASS / 0; no stack errors; postprocess warnings reviewed below | `final-build-program.log` |
| `npm run build:idl` | PASS / 0; 24 instructions, byte-identical baseline IDL | `final-build-idl.log` |
| `npm run test:vm` | PASS / 0; 26 passed, 0 failed, 0 ignored using this round's SBF | `final-test-vm.log` |
| `node --check scripts/setup-local.cjs` | PASS / 0 | `final-check-setup.log` |
| `node --check scripts/sync-local-program.cjs` | PASS / 0 | `final-check-sync.log` |
| `node --check scripts/initialize-local.cjs` | PASS / 0 | `final-check-init.log` |
| `node --check tests/local-validator-smoke.cjs` | PASS / 0 | `final-check-smoke.log` |
| `bash -n scripts/deploy-local.sh` | PASS / 0 | `final-check-deploy.log` |
| `git diff --check` (also after documentation) | PASS / 0 | `final-diff-check.log` |
| Isolated copy: `bash scripts/deploy-local.sh` | PASS / 0; actual loopback deployment/initialization | `local-deploy.log` |
| Isolated copy: `node tests/local-validator-smoke.cjs` | PASS / 0; loader/roles + 4 economic paths, 2 receipt allow/deny pairs | `local-smoke.log` |

The ordinary host command's 26 ignored tests are not custody PASS evidence; the explicit VM command ran every one. Regression evidence before/after the fix:

| Finding | Before | After | Evidence |
|---|---|---|---|
| R1/R5 | 0 passed / 5 failed, exit1 | targeted 7/7, full service 18/18, exit0 | `R1-R5-before.log`, `R1-R5-after.log`, `R1-R5-service-suite.log` |
| R2 | frozen baseline .so: 0/2, exit101, deadline D10 instead of D7 | 2/2, exit0, including both classifications, holding/no-income, node/mint/kind and expiry | `/tmp/provena-r2-before.log`, `/tmp/provena-r2-after.log` |
| R3 | actual Connection against JSON-RPC: 1 passed / 9 failed, exit1 | 11/11, exit0; includes additional v0 ALT case | `R3-baseline-regression.log`, `R3-regression.log`, `R3-client-compatibility.log` |
| R4 | original suite had no successful Token-2022 economic transfer coverage | 3/3 new actual SBF CPI tests, exit0; total VM 26/26 | `/tmp/provena-r4.log`, `final-test-vm.log` |

R4 verifies TransferChecked invocation, source/vault/destination balances and epoch/asset conservation for tip/claim, purchase/receipt/claim, bilateral Derivative (6650 source + 2850 candidate + 500 fees), capped treasury withdrawal and partial safeguard exits at 48h. Wrong program/mint/destination, replay, insufficient-funds CPI and premature/oversized withdrawals assert account snapshots unchanged. Existing SPL, freeze/extension, authority and late-settlement tests remain enabled. Financial time is not shortened for the validator.

Main program/SDK/IDL address is unchanged: `Fg6PaFpoGXkYsidMpWxTWqkZ86H8vFnafnHCW3Yj6nD`.

- Main SBF `target/deploy/content_rights_protocol.so` SHA256: `20b063fc0dc2fc9ebf9bdb473284c405b9f1423b41ba8bd5d2bb1861d52e1e81`.
- Generated main IDL SHA256: `dd0f3590b61ca2d06c47bc225c18b3b6a967b20ef2ac51e128e594b6d473f5a1`, equal to the document-commit IDL; no account/instruction ABI change.
- Frozen baseline SBF hash for R2 reproduction: `145f2e7ed3db3e979050c9493a405d61684b624920571305173f886c9b6b263e`.

The isolated source copy is `.local-tools/audit-evidence/validator-copy`. Its source HEAD is the execution SHA above. Tracked patch hash is `634e1a24a8bb1f0d3a1d3a8c67c0cf99f4510b145dedf578799a4e31c6f9ccd8`; `validator-source.json` records hashes of every copied file including both then-untracked new tests (manifest SHA256 `6f35c97672334db546dde126859e5c93aa83456da1dcd561d3688c1fff2dfdde`). Subsequent changes only completed report documents. No global wallet or cluster configuration was used. The validator invocation was:

```bash
solana-test-validator --ledger .local-tools/audit-evidence/validator-ledger \
  --bind-address 127.0.0.1 --rpc-port 8899 --faucet-port 19900 \
  --gossip-port 18660 --dynamic-port-range 18661-18701 --quiet
```

Four distinct temporary admin/originality/rights/treasury keys were prepared using the existing helpers. The copy alone was synchronized and rebuilt. Its changed source/generated files are exactly lib.rs, Anchor.toml, SDK and IDL. Recursive IDL comparison found only the top-level address and initialize's fixed program-account address changed; account layouts and instructions are identical. The initial comparison that normalized only the top-level address failed, then both expected address fields were identified and checked; no unexplained ABI difference remains.

Temporary program id: `DpgWvT7YrHwmVxTY6hN3D6J2WzgRCJqVB66ahzCVbS91`; ProgramData: `4evNtkeZD2U3DiWijyH9QsEvDhNooBn1sTuqKKfgYxx5`. Isolated SBF SHA256: `91b3004dd15e1da7281ae5e3065268fd3272a558934b3aba8b4a972f861addfe`. Deployment signature: `VsLspoYTYbPQH5vR4HGBDuuiyCZLVXfo5JUawHkwrbG4mVQxbirGz4P52SMjtua5tpQL1ZEjTqjVFH1q4YoUC6T`; initialization signature: `4fxuiJGiEgiY2oZ8eqVmQ9iaqbGs9d5Xf45ujCtsUBnL3rVajGbJyDtCXv7X45btz95B2z7J3bTXNdJouqQjasD`.

Smoke assertions verify actual loader ownership/executable state and ProgramData upgrade authority, role config, approved plain SPL/Token-2022 mints, signed staged→chain-confirmed Content/Fingerprint identities, nodes, positive deposits, content-scoped receipts and claims. Every path ends at gross100/paid100/fees0/user-liability0, with exact funding/recipient/vault balances. Receipt/claim replay cannot transfer again. Signed paid-key release succeeds for the real finalized buyer receipt, rejects outsiders, and rejects a simulated RPC outage. Live zero-gross epochs reject reveal while own proofs remain available; matching positive epochs authorize it. The validator was stopped after completion; ledger/temporary keys remain ignored for local evidence.

Warnings were preserved: Agave 2.3.0 post-processing lists standard Solana syscalls as undefined with tools v1.57; real current-artifact LiteSVM and actual validator executions successfully exercise hashing, Clock/Rent, PDA/account creation and SPL/Token-2022 CPI, with no runtime syscall failure. The CLI also advises loader-v4 migration and Node emits punycode deprecation; these do not fail the tested upgradeable-loader contract. No loader migration or dependency expansion was performed to silence warnings.

No unresolved R1–R6 or local-gate blocker remains. **UNKNOWN / NOT_RUN**: public-cluster transaction-v1 activation, devnet/testnet/mainnet deployment/configuration, production durability/key operations and independent security certification. These are outside this task. Execution contract, account/ABI, Canonicalization V1, PDA/Merkle formats, economic rates, authority, architecture and Mission/Milestone boundaries are preserved. No merge, tag/release, real funds or production mutation occurred. Stop at deployment review; subsequent public deployment is a separate authorized task.

### 2026-10-09 Indexer Log Truncation

Authorized corrective patch on `fix/v0.0.1-indexer-log-truncation`, starting/execution HEAD `4ef80c427fe589a2a3306f63b6426efc6342915e`, clean worktree `/home/k5068/.codex/worktrees/c5e8/Provena`; only a Handoff document was added after the earlier 26a03ba implementation. Current GitHub ref was checked before implementation. [Executed Handoff](handoffs/v0.0.1-indexer-log-truncation.md#codex-findings) contains per-AC findings and the five-file scope.

The actual poller previously treated balanced invocation logs as complete even when the exact runtime marker indicated missing data. New tests use the existing RpcFixture, actual web3.js Connection JSON-RPC decoder and generated-IDL Borsh event coder. The production fix is one whole-log guard before any parsing/persistence, reusing IncompleteChainLogs/503 and failSync. Ordinary `Program log: Log truncated` text is accepted; the exact standalone runtime marker anywhere in a successful transaction rejects the entire transaction. No schema, error code, public response, financial ledger, dependency or chain change.

Failure-first run: `npm run build` exit0, then `node --test --test-name-pattern 'log truncation' dist/services/indexer-rpc.test.js` exit1: **1 pass / 5 fail / 0 skip** (Missing expected rejection). Parser SHA256 before fix was `188b08458c45b5c317169f3e6208fbf4f53167093ccdc106b4af2cf189ded0d2`, matching HEAD; test-only patch hash `6c2cfdcf815c4be903ef53d071e1035c90d79ff75c0edd92f95e5f6df5acc2a6`. After the guard, the same command exits0: **6 pass / 0 fail / 0 skip**. Entire RPC suite: **17/17**, including all previous 11 cases. Cases cover marker inside/outside frames, foreign-only invocation, decodable prefix rollback, S1 retention/S2 block/no S3 request, durable restart/retry/concurrent polling, ordinary text/no-event controls and exactly-once recovery/backfill only when the test provider supplies complete verified logs.

All logs below are new local ignored evidence in `.local-tools/log-truncation-evidence/`, not the previous audit directory. `gates.jsonl` records command, UTC timestamp, exit, execution HEAD, working patch hash and parser hash. Executable code/test patch SHA256 was `e0995e6765cb5d97581f3293bbfa75a3bbc60a3e27af47d7e9e67edf0a27c1ab`; subsequent edits only complete the three authorized report documents. Parser SHA256 after fix: `7e3bd7bec0a70d5792b16ad0a02350dbfbd1f7415187bff289f8eaff394b4c3f`; regression file SHA256: `907820c513b96a9fc8b90b5ee42c043120e4ca37c84fe5353a306528b032e8df`.

| Actual current-run command | Result / exit | Log |
|---|---|---|
| `npm ci --ignore-scripts` | PASS / 0 | `before-ci.log` |
| `npm run build` before/after fix | PASS / 0 each | `before-build.log`, `after-build.log` |
| `node --test --test-name-pattern 'log truncation' dist/services/indexer-rpc.test.js` before fix | Verified original defect / 1; 1 pass, 5 fail, 0 skip | `before-regression.log` |
| Same regression after fix | PASS / 0; 6 pass, 0 fail, 0 skip | `after-regression.log` |
| `node --test dist/services/indexer-rpc.test.js` | PASS / 0; 17 pass, 0 fail, 0 skip | `after-rpc-suite.log` |
| `npm test` (includes tsc) | PASS / 0; 73 pass, 0 fail, 0 skip | `after-npm-test.log` |
| `npm audit` | PASS / 0; 0 vulnerabilities | `after-audit.log` |
| `cargo fmt --all --check` | PASS / 0 | `after-fmt.log` |
| `cargo test --workspace` | PASS / 0; 27 host passed, 26 security ignored | `after-host.log` |
| `npm run build:program` | PASS / 0; warnings retained below | `after-program.log` |
| `npm run build:idl` | PASS / 0; 24 instructions, unchanged IDL | `after-idl.log` |
| `npm run test:vm` | PASS / 0; 26 passed, 0 failed, 0 ignored | `after-vm.log` |
| `git diff --check`, including completed docs | PASS / 0 | `after-diff.log`, `final-diff.log` |

Actual versions (`before-versions.log`, exit0): Node22.22.1/npm9.2.0, TypeScript5.9.2, web3.js1.99.0, Anchor Rust/TS0.32.1, Rust/Cargo1.99.0, Agave2.3.0, LiteSVM0.7.1. Builds explicitly select SBF tools v1.57 and actual solana rustc1.95.0-dev; bare cargo-build-sbf output still lists default v1.48/1.84.1. Repository-local tool paths/OpenSSL environment were used. No dependency/lockfile upgrade and no npm lint command.

Freshly invoked main build artifact SHA256: `20b063fc0dc2fc9ebf9bdb473284c405b9f1423b41ba8bd5d2bb1861d52e1e81`; the explicit VM used this file, with no DeclaredProgramIdMismatch. Source/SDK/Anchor/generated IDL program id is unchanged `Fg6PaFpoGXkYsidMpWxTWqkZ86H8vFnafnHCW3Yj6nD`; IDL SHA256 `dd0f3590b61ca2d06c47bc225c18b3b6a967b20ef2ac51e128e594b6d473f5a1`, byte-identical to HEAD. Host ignored counts were followed by actual explicit VM execution and are not counted as financial tests.

The standard syscall postprocess and dual-crate-type warnings remain in the SBF build output. No stack errors; current identical-artifact VM hashing/account/financial paths actually pass without corresponding runtime syscall errors. Node punycode deprecation is retained. No toolchain or security-check relaxation to remove warnings. The initial sandbox CreateProcess failure was an environment startup issue; approved execution succeeded. Official source web cache-miss was followed by a successful GitHub source read. Final required gates have no implementation-caused or pre-existing repository failure and no unresolved ENV_BLOCKED condition.

**NOT_RUN:** validator/deployment (not required by this Handoff), public-cluster truncation reproduction, historical financial reconstruction or production data inspection. October8 loopback evidence remains historical and is not claimed as a current run. No keys, database, logs or build artifacts are committed.

Verified result: **READY_FOR_DEPLOYMENT_REVIEW** for the correction and its required local matrix. No actual unprocessed production signature was examined. Persistent truncation remains a capability boundary: ERROR with the blocking signature, no checkpoint bypass or synthetic events, and NOT_CLEARED_FOR_DEVNET until complete verifiable evidence exists. Test-provider recovery is not a promise of real-provider recovery or historical completeness. No scope exception, merge/force push/release/deployment/real funds; architecture, Mission/Milestone, economic, ABI and authority boundaries preserved. Final delivery SHA is the Git commit containing this record and the final execution report (`git log -1 --format=%H -- docs/validation.md`).
