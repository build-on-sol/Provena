# AGENTS.md — Provena

## 角色与任务边界

作为 repo-native engineering executor 工作。实现当前用户授权的任务；架构、产品、协议权限和发布范围由项目既定文档与用户决定。

- 当前用户明确指令决定授权范围；当前仓库和当前分支是首要工程事实来源，记忆和历史聊天只作线索。
- 区分 Verified Facts、Inferences/Hypotheses、Recommendations 和 Unknowns。Handoff 假设或历史结论须由当前仓库/运行证据复核，不能把疑似根因写成已验证事实。
- 开始前核实仓库、worktree、分支、HEAD、工作区改动、适用的 AGENTS.md，以及本次 Handoff。不得把历史路径、版本或测试结论当作当前事实。
- 代码、schema、lockfiles 和测试说明当前实现；[V0 执行契约](Solana%20内容权益社交协议%20V0%20—%20Codex%20执行契约.md)定义预期协议。本文件约束执行流程，Handoff 定义具体整改与验收。
- 如果代码、派生说明与执行契约冲突，记录差异并核对；不能把现有 bug 解释为新的产品规则。需要改变 Mission、Milestone、架构、账户模型、authority 或 release 边界时，先报告 gap。
- investigation 只调查和记录；只有用户明确要求实施时才执行对应 Handoff。corrective_patch 恢复既定行为，不附带重构。
- 改行为前追踪实际执行路径及上下游状态、权限、adapter、服务、schema 和外部执行接口，不能只机械修改任务点名的函数。
- 使用最小充分改动，复用现有 runtime、服务、RPC adapters、状态和测试。不要为解决一个问题创建平行账本、权限系统或索引平台。
- 对 schema、迁移、公开 API、序列化状态、标识符、事件和部署契约先核对兼容与迁移影响，不能作为普通重构随意更改。
- feature 仅实现验收所需能力；缺少上层决策时报告 gap，不自行定义产品规则。重构、框架替换和依赖升级必须有与任务相关的已证明缺陷、安全、兼容、能力或实质维护需要。
- 保留其他人的未提交改动。优先使用 rg 定位源码；不要为了让测试通过而删除、跳过或降低安全断言。
- 独立追踪、测试审查和安全审查可使用子代理；避免对同一区域并行写入。

## 阅读入口

先读请求指定的 Handoff，再按改动范围阅读：

- [README.md](README.md)：目录、工具链和运行命令。
- [docs/protocol-spec.md](docs/protocol-spec.md)、[docs/revenue-ledger.md](docs/revenue-ledger.md)、[docs/state-machines.md](docs/state-machines.md)：身份、经济账本和时间语义。
- [docs/architecture-decisions.md](docs/architecture-decisions.md)、[docs/threat-model.md](docs/threat-model.md)：当前实现选择与已披露信任边界。
- [docs/validation.md](docs/validation.md)：历史实现交接和必需验证；其中的历史声明不是本轮通过证据。
- [v0.0.1 审计整改 Handoff](docs/handoffs/v0.0.1-audit-remediation.md)：本分支准备的整改任务。仅阅读它不自动授权实施。

## 仓库地图

| 路径 | 职责 |
|---|---|
| programs/content_rights_protocol/src/ | Anchor instructions、账户、整数数学 |
| programs/content_rights_protocol/tests/security.rs | 编译后 SBF 的 LiteSVM 交易与托管测试 |
| packages/canonicalization/ | 冻结的 canonicalization V1 与 Citation 校验 |
| packages/rights-math/ | residual 分成、Merkle 叶及证明 |
| packages/protocol-sdk/ | PDA、IDL instruction builders 与 provenance 校验 |
| services/ | signed 请求、内容存储、私有 provenance、finalized 事件投影 |
| idl/ | 从实际 Anchor 源码生成的接口 |
| scripts/ | 仅本地的密钥、program id 和部署初始化辅助 |
| docs/ | 协议、决策、威胁模型、Handoff 和验证证据 |

## 必须保持的协议不变量

- 内容 author、raw/canonical identity 不可被重写；全局 fingerprint 不按作者分区。Canonicalization V1 不静默改变。
- TIP 与 SALE 分离。传播只能分割当前 residual，锁定上游权益不被稀释；A→B→C 的既定向量为 7000/1800/1200 bps。未来 policy 更新不改既有 payout roots。
- 金额为 token base units，比例为 10000 BPS；禁止浮点经济计算，使用 checked arithmetic 和宽中间值。Merkle 编码、域分离、PDA seeds 和 IDL 必须跨 Rust/SDK 一致。
- AccessReceipt 属于 (content, buyer)，而非 node。链下密钥放行要验证真实账户，RPC 不可用时拒绝。
- 新收入、部分 claim、争议及提前解决不能重置已消耗的七天窗口。零收入争议也有 cutoff；cutoff 后未解决的新收入直接 safeguard。
- Safeguard 退出不能立即提款；最低 48h，最迟 72h 可领取，固定返回窗口不能由晚调用或部分领取延长。
- Independent 不收争议费；Derivative 只在最终协定后对未支付争议权益计提一次整数 5%。历史支付、Distributor 和 LicensedSource 的既有权益必须保留。
- 每资产隔离负债；epoch paid + fees 不超过 gross。用户本金和舍入 dust 不是协议收入，admin 不能任意提款或代替用户 claim。
- 已允许 plain SPL Token / Token-2022；核对 mint、token_program、owner、authority、vault 与 checked CPI。不得为了通过测试放开 freeze authority 或未审计扩展。
- public node、instruction metas、事件不得暴露 plain parent。完整 provenance reveal 必须遵守执行契约的价值事件条件；拥有自行创建的计划不能授予读取既有祖先的资格。
- 付费正文默认 quote NONE。AI similarity 是风险证据；最终权益分类遵守双方签名与既有 authority 边界。
- Backend/indexer 是查询投影；不能成为资金、账户所有权或购买资格的第二真相源。保留已披露的升级权限、链下 attestation 和内容运营方信任假设。

## 工具链与验证

先检查 Anchor.toml、Cargo.toml、Cargo.lock、package.json、package-lock.json 和实际工具版本。审计基线是 Anchor 0.32.1、Agave 2.3.0、SBF tools v1.57、LiteSVM 0.7.1、Node ≥22；这是可核对的基线，不是永久版本要求。README 的 Rust 验证版本不是当前环境检测结果。

只为已复现的兼容问题调整最小依赖集合，并记录原因、官方依据与 lockfile 变化。不要自动升级到 latest、批量修复 advisories 或迁移整套框架。

涉及运行代码、依赖或账户/ABI 的改动，遵循 Handoff 和 docs/validation.md，至少完成对应完整验证：

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

- npm test 包含 TypeScript 编译；仓库当前没有 npm run lint，不要假称执行了它。
- 普通 cargo test 默认跳过 security.rs 的 SBF 测试。先构建实际 .so，再显式执行 test:vm；不得把 host/math 通过写成资金路径通过。
- 检查 SBF 输出中的 stack、syscall 和部署兼容问题；不能只看构建退出码。实际 VM 执行与 Handoff 要求的 loopback validator smoke test 各自记录。
- IDL 从源码生成，不手写来掩盖 ABI 不一致。核对 program id、IDL 和 SDK/service 配置。
- 仅文档任务检查内容、链接、文件范围和差异；不需要安装整套工具链，也不得声称应用测试已运行。
- 修复已验证缺陷时，在可行范围内增加或更新回归测试，使原失败有仓库表达；按问题记录通过/失败/跳过数量、命令退出码、日志位置和证据对应的 commit。
- 区分实施引入失败、预先存在的仓库失败和本地环境/工具失败；分别记录 REPO_FAILURE、ENV_BLOCKED、NOT_RUN 或 PASS。工具没启动、依赖没下载或 artifact 缺失不等于仓库测试失败；任何未实际成功执行的验证均不得写成通过。

## 本地操作与外部权限

- 当前任务的本地测试使用临时密钥、临时数据和明确的 loopback RPC；不能继承全局 cluster、钱包或真实资产。
- scripts/deploy-local.sh 会调用 program id 同步并修改 lib.rs、Anchor.toml、SDK 和生成 IDL。仅在 Handoff 已授权本地 smoke test 的隔离副本中运行；保留部署密钥与生成结果为忽略的本地产物，不能覆盖待提交整改或用户改动。
- 不提交秘密、钱包 keypair、付费正文、私有 parent mapping、数据库、日志或构建产物。
- Git 分支写入、push、PR 或外部服务操作以当前用户授权为准。未获明确授权，不得 merge、tag/release、部署到 devnet/testnet/mainnet、发布、花钱、向外部人员发消息或修改生产数据。
- 不扩展 DAO/tokenomics/NFT/ZK/跨链/Oracle/DeFi strategy/UI 等 V0 非目标。

## Code Review Rules

- 优先审查可复现的本金、权限、状态机、隐私披露与跨层 ABI 问题；引用真实路径/行号和触发条件。
- 特别检查未授权提款、重复领取、跨 epoch/mint 侵占、timer reset、错误 receipt owner 和通过新计划获取受保护 ancestry。
- Token-2022 资产初始化测试不能替代真实 transfer_checked 成功路径；必须看账户约束、CPI 及转移后的账本。
- 已披露 trust assumption 与新漏洞分别报告；静态检查不是完整安全认证。

## 交付与停止线

按任务要求在当前 Handoff 的 Codex Findings 中记录已验证实现、测试证据、剩余失败与 capability gaps；保留历史记录，不把待运行状态写成完成。临时排查结论或一次性 workaround 不自动成为永久架构规则。

验收和 Stop Line 满足且无缺陷阻断请求能力后停止。最终报告分支、完整 commit SHA、文件清单、Verified Result、根因/改动、实际验证结果、未解决阻断/风险/capability gaps、任何 scope exception，以及 architecture、Mission/Milestone 和 authority 边界保持情况。测试仍 ENV_BLOCKED 或存在协议阻断时，不宣称可安全部署。
