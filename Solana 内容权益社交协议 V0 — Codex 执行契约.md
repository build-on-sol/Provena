# Solana Content Rights Social Protocol — V0 Execution Contract

## 0. Role / Execution Mode

你现在负责把以下产品协议实现为一个可测试、可审计、可继续迭代的 Solana V0。

这不是一个普通社交 Feed 项目。核心是：

**Content Identity + Rights + Distribution + Claim + Dispute + Safeguard**

请优先保证：

1. 经济状态正确；
2. 权限边界明确；
3. 用户本金不可被管理员任意转走；
4. 收益分配数学可验证；
5. 状态机无歧义；
6. 链上/链下职责边界清晰；
7. 不为了“Web3 化”把无必要的数据全部上链；
8. 不提前实现 DAO、Tokenomics、NFT、ZK、跨链和 DeFi 收益策略。

开始编码前：

- 检查现有 repository 结构；
- 检查 Rust / Solana / Anchor / TypeScript 实际版本；
- 不要因为本文件提到某版本就无条件升级；
- 保留现有合理结构；
- 如不存在项目结构，再建立合理 monorepo；
- 先写协议数据模型和状态机测试，再写 instruction handler；
- 不允许为了方便实现而偷偷改变本文定义的产品语义。

如果某项产品规则与 Solana 账户模型发生明显扩展性冲突：

**不要默默简化产品规则。**

先在 `docs/architecture-decisions.md` 记录：

- 冲突是什么；
- 为什么；
- 采用什么实现；
- 有什么 trust assumption；
- 后续怎样替换。

然后选择满足产品语义的最小充分实现继续工作。

---

# 1. Objective

实现一个以 Solana 为可信结算层的内容权益协议。

用户可以：

- 创建原创文字内容；
- 转发既有内容；
- 对内容进行打赏；
- 创建付费内容；
- 购买付费内容；
- 通过转发获得传播收益；
- 使用短 Citation 合法引用来源；
- 通过 Licensed Derivative 使用较大比例的来源内容；
- 对高度相似内容建立原创性审计；
- 对争议收入进行锁定、协商和最终重新分配；
- 主动 Claim 自己的收益；
- 超期未 Claim 或长期处于争议状态的资金进入「权益保障库」。

协议核心思想：

> 内容归属不能通过复制重新声明；  
> 传播价值可以获得经济回报；  
> 引用应当低摩擦但必须明确来源；  
> 实质性利用别人的内容应当保留原作者经济权；  
> AI 只负责发现潜在冲突，不拥有最终产权裁决权；  
> 资金状态必须由协议而非平台数据库决定。

---

# 2. Technology Baseline

优先使用：

- Rust
- Anchor
- Solana Program
- TypeScript SDK
- Anchor SPL `token_interface` 兼容：
  - SPL Token Program
  - Token-2022

如果 repo 当前版本不同，先验证兼容性，再决定是否升级。

所有金额使用 token base units。

所有百分比使用：

```text
BPS_DENOMINATOR = 10_000
```

禁止浮点数参与链上经济计算。

V0 只处理：

- native SOL（如果实现成本合理）
- Solana 上的 approved SPL / Token-2022 assets

其他 L1 / L2 原生资产、真正跨链资产和法币结算：

**Out of Scope。**

未来可以通过桥、支付网关或链下入口接入。

---

# 3. Non-Goals / Stop Line

V0 不实现：

- 平台 Token
- DAO
- 文章 NFT
- NFT Marketplace
- 完全链上正文
- 完全链上 Like / Unlike
- AI 推荐
- ZK provenance
- 完全去中心化版权法院
- 跨链结算
- Oracle
- Chainlink
- 外部 DeFi Yield Strategy
- 自动资产管理
- 复杂保险协议
- 实际法币支付
- 语义 AI 模型本身
- 永久 DRM
- 阻止用户截屏 / OCR / 手工复制

需要为部分未来功能预留接口，但禁止现在实现一整套额外系统。

---

# 4. Core Protocol Invariants

以下是协议级不可破坏原则。

## 4.1 Content

```text
Content ownership is immutable.
```

内容创建完成后，原始 author 不允许被改写。

---

## 4.2 Distribution

```text
Distribution rights are composable.
```

传播者只能重新分割自己当前拥有的 residual distribution share。

不能重新稀释已经锁定给上游的权益。

---

## 4.3 Access

```text
Access rights belong to Content.
```

购买权限属于：

```text
(content_id, buyer)
```

而不是：

```text
(distribution_node, buyer)
```

用户买过一次以后，通过其他传播节点访问同一 Content 不得再次收费。

---

## 4.4 Revenue Attribution

```text
Revenue attribution belongs to the distribution node
where the economic event happened.
```

购买权限属于 Content。

但第一次购买发生在哪个传播节点：

该次收入使用该节点的 sale payout policy。

---

## 4.5 User Liabilities

```text
User liabilities are never protocol revenue.
```

用户 principal：

- 不能被管理员 sweep；
- 不能变成平台运营收入；
- 不能因为 Strategy 亏损减少；
- 不能通过治理更新直接没收。

---

## 4.6 Dispute

AI similarity：

```text
Similarity != Copyright Theft
```

相似度只能创建 Review / Dispute 状态。

不能单独证明抄袭。

---

## 4.7 Strategy Risk

未来如果接入资金策略：

```text
Strategy loss cannot socialize into claimant loss.
```

用户本金损失不能转嫁给创作者、传播者或其他权益持有人。

---

# 5. Authority Boundary

必须明确区分权限。

建议至少存在：

```text
AdminAuthority
OriginalityAuthority
RightsAttestationAuthority
```

未来可增加：

```text
ArbitrationAuthority
StrategyAuthority
```

但 V0 不需要全部启用。

---

## 5.1 AdminAuthority

可以：

- 更新部分 configurable protocol parameters；
- pause 特定功能；
- 管理 supported asset policy。

不能：

- 提走用户 principal；
- 提走 dispute principal；
- 任意修改 Content author；
- 任意修改既有 payout root；
- 任意代替 creator Claim。

---

## 5.2 OriginalityAuthority

负责链下 originality pipeline 的链上 attestation。

可以：

- 批准 Original；
- 将候选内容置为 Pending Similarity；
- 创建 SimilarityCase。

不能：

- 移动用户资金；
- 自己领取争议资金；
- 修改 payout beneficiary。

---

## 5.3 RightsAttestationAuthority

V0 用于验证：

- 隐藏 provenance 的 repost 创建；
- 新 payout root 是否符合上级 distribution math；
- licensed source rights。

它不能：

- Claim 用户资金；
- 将资金转给 Treasury；
- 绕过用户签名创建属于用户的钱包身份。

这是 V0 的一个明确 trust assumption。

未来可以被更强的 cryptographic proof / ZK system 替代。

---

# 6. Suggested Repository Structure

如果现有 repo 没有明显更好的结构：

```text
/
├─ programs/
│  └─ content_rights_protocol/
│
├─ packages/
│  ├─ protocol-sdk/
│  ├─ canonicalization/
│  └─ rights-math/
│
├─ services/
│  ├─ content-service/
│  ├─ provenance-service/
│  └─ indexer/
│
├─ tests/
│
└─ docs/
   ├─ protocol-spec.md
   ├─ state-machines.md
   ├─ architecture-decisions.md
   ├─ threat-model.md
   └─ public-covenant.zh-CN.md
```

不要因为本文件要求这个目录就破坏一个已经合理存在的 repo。

---

# 7. Content Identity

一份 Content 至少拥有：

```text
Content {
    version

    author

    raw_hash
    canonical_hash
    canonicalization_version

    content_mode
    status

    metadata_commitment
    storage_commitment

    original_distribution_node

    access_price_amount
    access_price_asset

    quote_policy

    citation_manifest_commitment

    created_at

    active_similarity_case
}
```

具体字段可因 Anchor account layout 调整。

---

# 8. Content Hashing / Uniqueness

必须区分：

```text
raw_hash
```

与：

```text
canonical_hash
```

`raw_hash`：

证明用户最初提交的确切内容没有被替换。

`canonical_hash`：

用于平台内确定性重复检测。

---

## 8.1 Canonicalization V1

链下建立共享 canonicalization library。

至少执行：

- Unicode NFKC；
- normalized newline；
- 去除 zero-width characters；
- 统一可安全归一化的 whitespace；
- trim；
- UTF-8 encoding；
- deterministic hash。

必须存在：

```text
canonicalization_version
```

不得未来偷偷修改 V1 算法。

需要新算法时：

创建 V2。

---

## 8.2 Global Duplicate Registry

Canonical uniqueness 不得包含 author address。

错误：

```text
H(author + body)
```

正确：

```text
H(canonical_body)
```

建立确定性的全局 fingerprint registry。

同一 canonical content 第二次提交 Original：

```text
reject DuplicateContent
```

客户端提示用户：

- Repost 原内容；
- Citation；
- 或走争议 / 独立创作审计。

---

# 9. Content Relations

正式支持以下概念：

```text
ORIGINAL
REPOST
CITATION
LICENSED_DERIVATIVE
INDEPENDENT_SIMILAR
```

以下不是永久 Content 类型，而是审核状态：

```text
PENDING_SIMILARITY
```

---

# 10. Content Storage

正文不要默认完整存储在 Solana account。

Public Content：

```text
plaintext
→ external storage
→ hash / commitment on-chain
```

Paid Content：

```text
plaintext
→ encryption
→ encrypted blob
→ external storage
→ commitment on-chain
```

V0 不需要实现去中心化存储 purity。

Object storage 是允许的。

链上真正需要保证的是：

- 内容 identity；
- hash；
- author；
- rights；
- payment；
- access；
- settlement。

---

# 11. Paid Content

Paid Content 购买后：

创建：

```text
AccessReceipt(content_id, buyer)
```

不是：

```text
AccessReceipt(node_id, buyer)
```

Instruction：

```text
purchase_access(...)
```

执行：

1. 检查 buyer 尚未拥有 AccessReceipt；
2. 收取指定资产；
3. 将收入记录到当前 DistributionNode 的 SALE revenue；
4. 创建 AccessReceipt；
5. emit PurchaseEvent。

链下 Key Service 根据有效 AccessReceipt 解密内容。

V0 可以只定义接口和事件，不需要完成生产级 DRM。

---

# 12. Tip vs Sale Economics

必须存在两套完全独立比例：

```text
TIP
SALE
```

例如：

```text
tip_child_retention_bps

sale_child_retention_bps
```

禁止把两个比例共用。

---

# 13. Distribution Math

这是协议核心。

例：

A 创建文章。

A 设置 future repost policy：

```text
A retain = 7000
child = 3000
```

B 从 A Repost。

有人在 B 节点 Tip 100：

```text
A = 70
B = 30
```

B 设置：

```text
B retain from own residual = 6000
child = 4000
```

C 从 B Repost。

有人在 C 节点 Tip 100：

```text
A = 70
B = 18
C = 12
```

计算：

```text
B locked share:
3000 × 6000 / 10000 = 1800

C new residual:
3000 × 4000 / 10000 = 1200
```

A 的 7000 不得重新稀释。

---

## 13.1 Critical Rule

每个 DistributionNode 的 payout vector 一经创建：

**immutable。**

更新节点自己的 repost policy：

只影响未来 child nodes。

不能 retroactively 修改当前节点或者已存在 child 的 payout vector。

---

## 13.2 Direct Original Revenue

如果用户直接在 A 的 Original Node Tip：

默认 A 获得该节点当前完整 rights vector 所定义收益。

A 设置的 70/30：

是创建 child repost 时才生效。

不是把自己直接收到的打赏提前送 30% 给不存在的下游。

---

# 14. Hidden Provenance

产品要求：

用户看到一个 Repost Node 时：

不能直接通过平台或公开 parent pointer 沿链找到：

```text
C → B → A
```

因此：

**DistributionNode 不允许公开保存 plain parent_node。**

创建 Repost 时也尽量不要把 parent account 作为公开链上输入，否则 transaction history 会暴露关系。

V0 采用：

```text
RightsAttestationAuthority
+
payout_root
+
provenance_commitment
```

模式。

平台链下保存真实 parent mapping。

---

## 14.1 Provenance Commitment

每个节点存储：

```text
provenance_commitment
```

具体 commitment scheme 必须：

- deterministic verify；
- parent relationship 在未 reveal 前不可直接读取；
- reveal 后 SDK 可以验证 parent chain；
- commitment 编码有 domain separation。

可以使用 hash-chain + per-link salt。

建立 SDK：

```text
verifyProvenanceReveal(...)
```

---

## 14.2 Explicit Trust Assumption

V0 不是 ZK。

平台的 RightsAttestationAuthority：

知道真实传播关系。

链上公众不知道。

未来可替换成 ZK / stronger privacy proof。

必须在：

```text
docs/threat-model.md
```

写清楚。

不要假装 V0 提供 cryptographic anonymity。

---

# 15. Merkle Payout Root

每个 DistributionNode 至少拥有：

```text
tip_payout_root
sale_payout_root
```

Beneficiary leaves 必须使用 deterministic canonical encoding。

概念：

```text
leaf =
H(
  domain
  + node_id
  + revenue_kind
  + beneficiary_pubkey
  + share_bps
)
```

实际编码请选择不会产生 ambiguity 的 binary encoding。

RightsAttestationAuthority 必须保证：

```text
Σ share_bps = 10000
```

并且 beneficiary leaves 已经去重/聚合。

---

# 16. Claim Model

禁止每次 Tip：

```text
for beneficiary in all_beneficiaries:
    transfer(...)
```

Revenue event 的执行复杂度不能随传播深度无限增长。

采用：

```text
deposit → revenue accounting
beneficiary → claim later
```

模式。

Claim 时 beneficiary 提供：

- Pubkey；
- share_bps；
- Merkle proof。

Program 验证：

```text
leaf ∈ payout_root
```

然后根据累计 revenue 和已 Claim 记录计算余额。

---

# 17. Rounding

所有金额使用 integer math。

禁止浮点数。

采用：

```text
floor(total * bps / 10000)
```

必须使用 checked arithmetic。

不能 overflow。

由于 cumulative-share rounding 导致的 dust：

- 必须记录；
- 不得偷偷自动发送给 Protocol；
- dust 总量应通过 cumulative accounting 保持有界；
- 在 `docs/protocol-spec.md` 明确处理政策。

---

# 18. Revenue States

用户侧术语：

```text
可领取余额
争议锁定
权益保障库
退出中
可领取
```

禁止用户侧称：

```text
收益资金池
Yield Pool
Investment Pool
```

内部代码可以使用：

```text
SafeguardVault
ProductiveEligible
StrategyAdapter
```

用户看到的产品名统一：

# 权益保障库
# Rights Safeguard Vault

注意：

```text
Rights Safeguard Vault
!=
Insurance Reserve
```

前者是用户 principal / liability。

后者未来如果存在，是 protocol-owned risk capital。

不得混账。

---

# 19. Normal Claim Window

普通、无争议收益：

进入：

```text
CLAIMABLE_LIQUID
```

开始一个：

```text
CLAIM_GRACE = 7 days
```

窗口。

7 天内：

用户可以正常 Claim。

如果 7 天结束仍有未 Claim balance：

剩余 balance 进入：

```text
SAFEGUARD
```

---

## 19.1 No Timer Gaming

必须防止：

- 新收入无限 reset 老余额 7 天；
- 用户 Claim 0.01 后 reset 全余额；
- partial claim 重置整个 deadline。

原则：

```text
A claim window deadline never moves later
because of new revenue or a partial claim.
```

新的独立余额周期在旧窗口完成以后才能开始新的窗口。

具体账本结构由实现决定，但不得破坏该语义。

---

# 20. Safeguard Exit

一旦余额进入：

```text
SAFEGUARD
```

它不允许：

```text
claim_immediately()
```

用户只能：

```text
request_exit(amount)
```

参数：

```text
MIN_EXIT_COOLDOWN = 48 hours
MAX_EXIT_TO_CLAIMABLE = 72 hours
```

语义：

```text
T0
request_exit()

T0 → T+48h
绝对不能 Claim

T+48h → T+72h
协议完成退出 / liquidity settlement

最迟 T+72h
必须重新 CLAIMABLE
```

V0 没有真实外部 Strategy，因此应始终能够满足。

---

## 20.1 Exit Request

Exit Request：

- 可以指定 amount；
- 一经提交不可取消；
- amount 立即从 Productive Eligible accounting 中扣除；
- 不允许再次部署到期限超过 exit deadline 的 strategy；
- 到期后进入 CLAIMABLE。

如果重新 Claimable 后用户仍 7 天不领取：

可以再次进入 Safeguard。

---

# 21. Productive Safeguard Capital

V0：

**不要实际接外部 DeFi strategy。**

但必须设计清楚 future Strategy Adapter boundary。

未来可以让 Safeguard principal 产生 yield。

原则：

```text
principal = user liability

yield = protocol policy controlled economic output
```

本金永远不能成为平台收入。

未来 realized yield 可以按公开政策分配给：

- Protocol Treasury；
- Insurance Reserve；
- Security / dispute infrastructure。

但 V0 只做：

- accounting；
- interface；
- mock/test adapter（如有必要）。

不要接真实 lending / staking。

---

# 22. Similarity / Originality Pipeline

链下流程：

```text
Submit Content
    ↓
Exact Duplicate
    ↓
Structural Similarity
    ↓
Semantic Retrieval
    ↓
Potential Sources
```

AI / similarity service 只输出 risk。

不要输出：

```text
PROVEN_THIEF = true
```

用户界面使用：

```text
相近内容待审计
Potential Similar Content
```

不要在未裁定前使用：

```text
搬运者
小偷
抄袭者
```

---

# 23. SimilarityCase

需要协议对象：

```text
SimilarityCase {
    candidate_content
    reference_content

    candidate_author
    reference_author

    evidence_commitment

    started_at

    safeguard_cutoff_at

    status

    settlement_commitment
}
```

建议状态：

```text
PENDING_REVIEW
NEGOTIATING
INDEPENDENT
DERIVATIVE
DISPUTED
SAFEGUARD_MODE
RESOLVED
```

具体枚举可以整理，但语义必须保留。

---

# 24. Dispute Messaging

Case 创建以后：

双方得到链下：

```text
ReviewThread
```

scope 只属于该 SimilarityCase。

可以：

- 聊天；
- 提供解释；
- 上传证据；
- 提出分成；
- 接受；
- 拒绝。

普通 message 不上链。

以下行为需要 wallet signature / chain state：

```text
propose_settlement
accept_settlement
confirm_independent
finalize_derivative
```

---

# 25. Dispute 7-Day Rule — Critical

这一条必须准确实现。

不要按每笔争议收入重新计算 7 天。

---

## 25.1 New Dispute With No Prior Claim Window

如果 Content 进入争议时没有已经消耗的正常 Claimable Window：

```text
dispute_started_at = Day 0

safeguard_cutoff =
Day 0 + 7 days
```

这 7 天即使：

```text
revenue = 0
```

计时也继续。

如果第 7 天结束争议仍未解除：

Content / Case 进入：

```text
SAFEGUARD_MODE
```

从第 8 天开始产生的任何相关收益：

```text
direct → Rights Safeguard Vault
```

不得再为新收入单独提供新的 7 天 Claimable Period。

---

## 25.2 Dispute Begins During Existing Claimable Window

如果在进入争议以前已经消耗：

```text
elapsed_claimable_time
```

则：

```text
remaining_dispute_grace
=
7 days - elapsed_claimable_time
```

例如：

```text
普通 Claimable 已经过 3 天
↓
进入 dispute
↓
只剩 4 天
↓
之后仍未解决
→ SAFEGUARD_MODE
```

争议：

**不能 reset 7-day timer。**

---

## 25.3 During Dispute Grace

争议期间产生的收入：

```text
DISPUTE_HOLDING
```

不是：

```text
CLAIMABLE
```

A 不能拿。

B 不能拿。

Protocol 不能拿 principal。

如果争议在 cutoff 前解除：

再根据最终 rights relation 处理。

---

## 25.4 After Safeguard Cutoff

只要 Case 未解决：

```text
all accumulated unresolved revenue
→ SAFEGUARD
```

并且：

```text
all future revenue
→ SAFEGUARD directly
```

新的收入：

没有新的 7 天。

---

# 26. Resolve Before Safeguard Cutoff

如果双方在 Safeguard Cutoff 前：

```text
Confirm Independent
```

则：

- SimilarityCase → INDEPENDENT；
- candidate 从 source creator 的「相近内容待审计」列表移除；
- Candidate 恢复正常 Original；
- 不收 derivative dispute fee；
- Holding revenue 按正常 creator rights 处理；
- 不能因为解决争议重新获得新的完整 7 天 Claim 窗口。

---

# 27. Resolve After Funds Enter Safeguard

如果：

```text
SAFEGUARD_MODE
```

以后才达成：

```text
INDEPENDENT
```

或者：

```text
DERIVATIVE SETTLEMENT
```

那么 Settlement Finalization 本身：

视为自动：

```text
request_exit()
```

然后：

```text
48h minimum
72h hard maximum
↓
CLAIMABLE
```

不能因为争议解决而从 Safeguard 瞬间提款。

---

# 28. Derivative Settlement

如果双方确认属于搬运 / 未授权衍生 / 应共享来源权益：

默认经济框架：

```text
Gross Revenue = 100%

Protocol Settlement Fee = 5%
Rights Pool = 95%
```

即：

```text
PROTOCOL_DERIVATIVE_FEE_BPS = 500
RIGHTS_POOL_BPS = 9500
```

双方在 95% 内协商自己的经济比例。

例如：

```text
Original Creator = 70% of Rights Pool
Derivative Creator = 30% of Rights Pool
```

Gross 100：

```text
Protocol = 5

Original Creator
= 95 × 70%
= 66.5

Derivative Creator
= 95 × 30%
= 28.5
```

---

## 28.1 Important Fee Rule

在争议未解决以前：

Protocol 不得提前拿 5%。

必须：

```text
100% principal held
```

只有 DERIVATIVE settlement final 后：

```text
5% → Protocol
95% → Rights settlement
```

如果最终：

```text
INDEPENDENT
```

则：

```text
0% dispute fee
```

防止平台形成“争议越多赚得越多”的直接利益冲突。

---

# 29. No Agreement

如果双方谈不拢：

资金继续保持：

```text
SAFEGUARD / DISPUTED
```

A：

不能 claim。

B：

不能 claim。

Protocol：

不能 claim principal。

V0 不实现复杂 arbitration court。

可以为未来预留状态。

不得给 Admin 一个：

```text
force_take_dispute_funds()
```

之类的万能后门。

---

# 30. Preserve Downstream Distribution Rights

非常重要。

例：

```text
A = 真正原创

B = 被确认 derivative

B
├─ C repost
└─ D repost
   └─ E repost
```

裁决 B 的 origin rights 时：

不能删除：

```text
C
D
E
```

已经形成的合法 distribution rights。

原则：

```text
Copyright / source-rights decision
modifies Origin Rights

NOT Distribution Rights
```

换句话说：

重新定义 B 的 root economic ownership。

不要破坏 downstream tree。

---

# 31. Rights Graph Separation

禁止把以下三个 Graph 合成一个数据结构：

```text
Provenance Graph
Rights Graph
Distribution Graph
```

含义：

### Provenance Graph

内容来源于谁。

### Rights Graph

谁拥有多少经济权。

### Distribution Graph

谁把当前内容传播给谁。

例如：

```text
A --licensed source--> B --repost--> C
```

Provenance：

```text
B ← A
```

Rights：

```text
A 20%
B 80%
```

Distribution：

```text
B → C
```

必须逻辑隔离。

---

# 32. Citation Policy

Citation 是一等对象。

不要把 Citation 当成用户手写：

```text
“xxx”
——A
```

的普通字符串。

链下 Citation manifest 至少记录：

```text
CitationReference {
    source_content_id
    source_author

    source_segments

    excerpt_hash

    citing_content_id
}
```

Content 链上保存：

```text
citation_manifest_commitment
```

---

# 33. Citation Integrity

用户引用的文字必须真实来自 Source Content。

用户不能：

- 修改原文以后仍显示为引用；
- 改几个词；
- 假造 source；
- 手动冒充 protocol citation。

允许省略：

```text
...
```

但必须结构化记录多个 source segments。

---

# 34. Citation Limits

MVP 推荐默认参数：

```text
absolute quote limit:
320 Unicode grapheme clusters

relative source limit:
<= 10% of source content

total citations in new content:
<= 25% of rendered content
```

这些参数：

必须 configurable / versioned。

不要作为不可升级魔法常数散落在代码里。

由于链上没有全文：

Citation length validation 由 Content Service / Originality Attestation 层完成。

---

# 35. Citation Economics

普通 Short Citation：

```text
NO mandatory source revenue share
```

这是明确产品决定。

原因：

Citation 用于：

- 论证；
- 评论；
- 批评；
- 研究；
- 引用。

如果每个短引用都强制收费，会激励用户偷偷改写而不是正确 Citation。

---

## 35.1 Mandatory Citation Benefits

Short Citation 必须：

- 强制显示 Source Author；
- 强制显示 Source Content；
- 提供 View Original；
- 提供 Tip Source。

`Tip Source`：

直接进入 Source Content 自己的经济关系。

Citing author 不参与该笔 Source Tip。

---

# 36. Licensed Excerpt

超出普通 Citation 范围：

不能继续伪装 Citation。

进入：

```text
LICENSED_DERIVATIVE
```

需要 Source Creator 同意。

双方协商固定：

```text
Source Rights
```

例如：

```text
A = 20%
B = 80%
```

然后 B 的传播只能在自己的 residual 中继续分。

例：

```text
A Source Rights = 20%

B residual = 80%

B child policy:
retain 70%
child 30%
```

C Repost 后收入 100：

```text
A = 20

B = 80 × 70%
  = 56

C = 80 × 30%
  = 24
```

总和：

```text
100
```

---

# 37. Multiple Licensed Sources

允许未来：

```text
B
├─ source A
├─ source C
└─ source D
```

但设置 configurable upper bound。

MVP 推荐：

```text
TOTAL_SOURCE_RIGHTS <= 5000 bps
```

超过后应提示内容更接近 compilation / derivative。

V0 如果实现复杂度明显上升：

可以只支持一个 Licensed Source。

但数据模型不得锁死未来多来源。

---

# 38. Paid Content Citation

Paid Content 默认：

```text
public_quote_policy = NONE
```

可选：

```text
NONE
PREVIEW_ONLY
LIMITED
```

用户付费后不能利用 Citation 机制逐段泄漏全文。

如果 `NONE`：

只能引用：

- title；
- public metadata；
- 作者允许的 preview；
- Content reference。

不能公开付费正文。

---

# 39. Reactions / Likes

Like、Unlike、View：

V0 不上链。

使用 wallet signed messages。

例如：

```text
Reaction {
    content_id
    user
    value
    nonce
    timestamp
}
```

链下服务验证签名。

未来如有需要：

周期性 Merkle root anchor 到 Solana。

现在不要实现。

---

# 40. Article Card Metrics

至少区分：

链下 social state：

```text
Likes
Unlikes
Views
```

链上 derived state：

```text
Revenue
Paid Beneficiary Count
```

“收益人数”定义为：

```text
paid_beneficiary_count
```

不是：

```text
claim_count
```

有没有点击 Claim 不应该改变“多少人获得了经济价值”。

---

# 41. Asset Policy

每一种支持资产建立明确 AssetPolicy。

概念：

```text
AssetPolicy {
    asset
    token_program

    enabled

    safeguard_enabled

    future_strategy_enabled

    ...
}
```

V0：

`future_strategy_enabled` 默认 false。

不满足安全要求的资产：

可以正常支付 / Claim，

但 Safeguard 资金不部署外部收益策略。

---

# 42. Vault Isolation

至少逻辑区分：

```text
User Claim Liabilities

Rights Safeguard Liabilities

Protocol Treasury

Future Insurance Reserve
```

不能通过一个 balance 猜 ownership。

必须有明确 accounting。

---

# 43. Solvency Invariant

对任意资产 T：

```text
protocol-backed assets in T
>=
all user liabilities in T
```

V0 不允许使用跨资产偿付。

例如：

欠用户：

```text
100 SOL
```

不能用：

```text
USDC value equivalent
```

声称已经 collateralized。

不引入：

- Oracle；
- liquidation；
- cross-collateral；
- price risk。

---

# 44. No Arbitrary Treasury Withdrawal

Safeguard Vault PDA：

不能拥有：

```text
admin_withdraw_anything(recipient)
```

未来 StrategyAuthority 也不能向任意地址转账。

只能：

```text
approved strategy adapter
```

并受策略 policy 限制。

V0 不实现真实 Strategy。

---

# 45. Suggested On-Chain Accounts

根据实际 Anchor 结构调整，但至少考虑：

```text
ProtocolConfig

AssetPolicy

FingerprintRegistry

Content

DistributionNode

AccessReceipt

RevenuePool / RevenueLedger

ClaimPosition

SimilarityCase

Settlement

SafeguardPosition

ExitRequest
```

如果为了正确实现 7-day accounting 需要：

```text
RevenueEpoch
ClaimWindow
RevenueCheckpoint
```

可以加入。

不要为了少一个 PDA 破坏时间语义。

---

# 46. Revenue Ledger Requirement

这是实现前必须认真设计的一部分。

系统必须正确处理：

- 连续 Revenue；
- partial Claim；
- 7-day claim window；
- 新收入不得 reset 旧 deadline；
- disputed holding；
- dispute cutoff；
- safeguard accounting；
- partial exit；
- 重新 claimable；
- 再次超期；
- 多资产；
- Tip 与 Sale；
- Merkle beneficiary shares。

不要只使用：

```text
total_received
total_claimed
```

然后假装可以推导所有时间状态。

如果无法证明：

```text
old liability
new liability
liquid liability
safeguard liability
```

不会混淆，

说明 ledger 设计不正确。

---

# 47. Required Ledger Design Step

在正式写 Revenue Handler 前：

创建：

```text
docs/revenue-ledger.md
```

必须写：

1. balance model；
2. timestamp model；
3. claim-window model；
4. partial claim behavior；
5. dispute transition；
6. safeguard transition；
7. exit request；
8. rounding；
9. concurrency assumptions；
10. test vectors。

然后再实现。

不要等待人工批准，选择满足所有 invariant 的最简单正确模型继续。

---

# 48. Suggested Instructions

最终名称可以调整，但协议至少需要等价能力：

```text
initialize_protocol

add_asset_policy
update_asset_policy

submit_content
approve_original
open_similarity_case

create_original_node
create_repost_node
update_repost_policy

tip
purchase_access

claim_liquid
request_safeguard_exit
finalize_exit

propose_settlement
accept_settlement

confirm_independent
finalize_derivative_settlement

transition_dispute_to_safeguard

sweep_expired_claim_window
```

不要因为 instruction 多而机械拆分。

以安全与 account validation 为准。

---

# 49. Events

建立 indexer-friendly events。

至少：

```text
ContentSubmitted

ContentApproved

SimilarityCaseOpened

DistributionNodeCreated

RepostPolicyUpdated

TipReceived

AccessPurchased

RevenueClaimed

RevenueEnteredSafeguard

SafeguardExitRequested

SafeguardExitClaimable

SettlementProposed

SettlementAccepted

IndependentConfirmed

DerivativeConfirmed
```

Event 不应泄漏本来要求隐藏的 parent provenance。

---

# 50. Off-Chain Services

## Content Service

负责：

- 正文存储；
- canonicalization；
- fingerprint；
- Citation validation；
- public/paid metadata；
- encrypted blob handling。

---

## Originality Service

V0 Interface 即可。

未来负责：

- exact duplicate；
- paragraph/sentence fingerprints；
- MinHash / SimHash；
- vector retrieval；
- semantic classifier。

V0 可以使用 deterministic mock。

不要现在搭完整 AI pipeline。

---

## Provenance Service

负责：

- private parent mapping；
- payout vector construction；
- Rights Attestation；
- provenance reveal；
- reveal proof generation。

---

## Indexer

负责：

- Feed 查询；
- Content metadata；
- card metrics；
- claim dashboard；
- dispute dashboard；
- creator 「相近内容待审计」列表。

Indexer：

不是金融 source of truth。

Indexer 挂掉以后：

- Content ownership 仍存在；
- Claim 仍存在；
- funds 仍安全；
- AccessReceipt 仍存在。

---

# 51. Public Platform Covenant

生成：

```text
docs/public-covenant.zh-CN.md
```

至少包含以下用户可读规则。

## 权益保障库

普通可领取收益：

- 成为可领取后有 7 天直接领取窗口；
- 超过 7 天仍未领取的余额进入权益保障库。

权益保障库中的本金：

- 仍属于对应权益持有人；
- 不属于平台收入；
- 平台不得任意没收。

从权益保障库退出：

- 必须先申请退出；
- 最低 48 小时冷却；
- 最迟 72 小时重新成为可领取状态。

---

## 争议内容

内容进入权利争议后：

开始最长 7 天的争议缓冲期。

如果争议发生前已经消耗了正常 Claimable Window：

只保留：

```text
7 days - 已消耗时间
```

如果此前没有 Claimable 时间：

从 dispute Day 0 开始完整计算 7 天。

这 7 天：

即使没有产生任何收入：

计时仍然继续。

一旦 cutoff 到达且争议仍未解除：

该内容进入权益保障状态。

此后产生的所有相关收入：

直接进入权益保障库。

新的收入：

不会重新获得自己的 7 天窗口。

---

# 52. Security Tests — Mandatory

不要只写 happy path。

必须测试：

### Content

- duplicate canonical hash rejected；
- author cannot mutate；
- raw hash preserved；
- wrong originality authority rejected。

### Distribution

验证：

```text
A = 70%
B = 30%
```

以及：

```text
A = 70%
B = 18%
C = 12%
```

验证 ancestor share 不会被 child 修改。

验证 policy update 不影响已有 child。

---

### Merkle Claim

- valid proof；
- invalid proof；
- wrong beneficiary；
- wrong share；
- repeated claim；
- modified root；
- amount overflow；
- rounding。

---

### Paid Access

- purchase creates AccessReceipt；
- duplicate purchase rejected；
- same Content through another Node does not charge twice；
- SALE root used rather than TIP root。

---

### Dispute

测试：

```text
Day 0 dispute
0 revenue for 7 days
Day 8 first revenue
→ direct safeguard
```

这是关键测试。

测试：

```text
normal claimable elapsed = 3d
then dispute
→ only 4d remain
```

测试：

```text
dispute resolved before cutoff
→ no derivative protocol fee if independent
```

测试：

```text
dispute unresolved at cutoff
→ all future revenue safeguard
```

测试：

```text
resolved after safeguard
→ automatic exit
→ cannot claim before 48h
→ must be claimable by 72h
```

---

### Safeguard

- admin cannot withdraw principal；
- request_exit irreversible；
- partial exit；
- amount cannot exceed safeguard balance；
- exit pending amount cannot be redeployed；
- no immediate claim；
- 48h minimum；
- 72h maximum；
- unclaimed reactivated balance can re-enter safeguard after new 7-day window。

---

### Settlement

Gross 100：

```text
5 protocol
66.5 original
28.5 derivative
```

测试 integer/base-unit rounding。

---

### Downstream Preservation

创建：

```text
A
↓
B
↓
C
```

随后 B 被判定 derivative of X。

验证：

- Source / Origin rights 改变；
- C 的合法 distribution share 没有消失。

---

### Authorization

逐项测试：

- admin impersonation；
- originality authority impersonation；
- rights authority impersonation；
- arbitrary treasury withdrawal；
- wrong PDA；
- wrong mint；
- wrong token program；
- account substitution；
- replay；
- double settlement。

---

# 53. Property / Invariant Tests

如果工具允许，加入 property-based tests。

至少验证：

```text
Σ payout shares = 10000
```

以及：

```text
total_claimed
<=
total_received
```

以及：

```text
protocol principal extraction
= impossible
```

以及：

```text
ancestor locked share
never decreases because of deeper repost
```

以及：

```text
user liabilities
<= protocol-backed assets
```

以及：

```text
new revenue cannot extend an existing
claim-window deadline
```

---

# 54. Failure Conditions

所有经济 instruction 必须明确失败条件。

例如：

```text
UnsupportedAsset
DuplicateContent
InvalidCanonicalHash
InvalidAttestation
InvalidPayoutRoot
InvalidMerkleProof
InvalidShareBps
Unauthorized
AlreadyPurchased
InsufficientBalance
ClaimWindowExpired
SafeguardExitRequired
ExitCooldownActive
ExitNotReady
CaseAlreadyResolved
SettlementMismatch
DisputeStillActive
MathOverflow
InvalidTokenProgram
InvalidMint
```

错误名称可以调整，但不要依赖模糊 generic error。

---

# 55. Upgrade / Versioning

所有重要长期 account：

需要：

```text
version
```

不要假设 V0 account schema 永远不变。

如果 Anchor 当前版本提供合适 migration capability，可以利用。

但不要为了 migration framework 增加大量不必要复杂度。

---

# 56. No Double Source of Truth

链上 source of truth：

- Content identity；
- ownership；
- rights commitments；
- financial state；
- AccessReceipt；
- dispute status；
- settlement；
- claim / safeguard state。

链下 source of truth：

- plaintext；
- encrypted content blob；
- Feed；
- Search；
- Like；
- Unlike；
- similarity evidence；
- messages；
- private provenance mapping。

Indexer：

只能派生链上金融状态。

不能反过来决定链上余额。

---

# 57. Implementation Phases

## Phase 1 — Protocol Skeleton

完成：

- repo/toolchain validation；
- protocol spec；
- accounts；
- PDA seeds；
- enums；
- errors；
- core math library；
- unit tests。

不要先写 UI。

---

## Phase 2 — Content + Distribution

完成：

- fingerprint registry；
- Content；
- Original node；
- Repost node；
- independent TIP / SALE policy；
- hidden provenance commitment；
- rights attestation；
- tests。

---

## Phase 3 — Revenue + Claim

完成：

- supported assets；
- token transfers；
- revenue accounting；
- Merkle claim；
- claim windows；
- safeguard；
- exit；
- tests。

这是安全优先级最高的一部分。

---

## Phase 4 — Paid Access

完成：

- purchase；
- AccessReceipt；
- sale revenue；
- events；
- SDK。

---

## Phase 5 — Similarity / Dispute

完成：

- SimilarityCase；
- dispute grace；
- safeguard cutoff；
- settlement；
- independent resolution；
- derivative resolution；
- 5% protocol fee；
- downstream rights preservation。

---

## Phase 6 — Offchain Minimum

完成：

- canonicalization package；
- mocked originality attestation；
- provenance service minimum；
- indexer events；
- SDK helpers。

不要构建完整 AI plagiarism engine。

---

# 58. Required Deliverables

最终必须提交：

```text
1. Compiling Anchor program

2. TypeScript SDK

3. Test suite

4. protocol-spec.md

5. state-machines.md

6. revenue-ledger.md

7. threat-model.md

8. architecture-decisions.md

9. public-covenant.zh-CN.md

10. README with:
    build
    local test
    deploy-local
    key authority setup
```

---

# 59. Required State-Machine Diagrams

`state-machines.md` 至少画清楚：

### Content

```text
SUBMITTED
→ ORIGINAL
→ PENDING_SIMILARITY
→ INDEPENDENT / DERIVATIVE
```

根据最终实现调整。

### Revenue

```text
CLAIMABLE
→ SAFEGUARD
→ EXIT_PENDING
→ CLAIMABLE
→ PAID
```

### Dispute

```text
PENDING
→ NEGOTIATING
→ INDEPENDENT

or

→ DERIVATIVE

or

→ SAFEGUARD_MODE
→ RESOLVED
```

---

# 60. Threat Model

必须明确分析：

- malicious creator；
- malicious repost distributor；
- malicious claimant；
- duplicate content attacker；
- fake Merkle proof；
- authority key compromise；
- platform admin compromise；
- indexer compromise；
- content-service compromise；
- provenance DB leak；
- token account substitution；
- malicious Token-2022 asset；
- unsupported token extensions；
- integer overflow；
- replay；
- account spoofing；
- front-running；
- spam account creation；
- rights-attestation abuse。

不要只做智能合约 happy-path threat model。

---

# 61. Privacy Disclaimer

V0 隐藏的是：

```text
public parent relationship
```

不是：

```text
platform itself cannot know provenance
```

平台 Provenance Service 会知道传播关系。

链上只保存：

```text
commitment / roots
```

价值事件发生以后：

平台可以 reveal 完整传播链。

SDK 必须能够验证 reveal commitment。

---

# 62. Acceptance Criteria

只有以下条件全部成立，V0 core 才算完成。

### AC-1

A→B→C 分成测试严格得到：

```text
A 70%
B 18%
C 12%
```

### AC-2

收入事件复杂度不随传播深度线性 transfer N 次。

### AC-3

购买 Access 属于 Content，不属于 Node。

### AC-4

Tip 与 Sale 使用独立 payout policy。

### AC-5

重复 canonical content 无法作为新 Original 创建。

### AC-6

公开链上 DistributionNode 不包含 plain parent pointer。

### AC-7

用户 principal 无 admin 任意提款路径。

### AC-8

普通未 Claim 余额正确执行 7-day → Safeguard。

### AC-9

争议 Day 0 即使零收入：

Day 7 后仍然切换 SAFEGUARD_MODE。

### AC-10

进入 SAFEGUARD_MODE 后：

新的收入直接进入 Safeguard。

### AC-11

Dispute 不能 reset 已经消耗的普通 7-day Claim Window。

### AC-12

Safeguard balance 不可即时 Claim。

必须：

```text
request_exit
→ >=48h
→ <=72h claimable
```

### AC-13

INDEPENDENT resolution 不收 5%。

### AC-14

DERIVATIVE resolution：

```text
5% Protocol
95% Rights Pool
```

### AC-15

版权重新分类不能删除 downstream distributor 已经获得的合法传播权益。

### AC-16

Short Citation 不自动产生 source royalty。

### AC-17

Citation 必须带不可移除 source attribution。

### AC-18

Paid Content 默认不允许公开引用付费正文。

### AC-19

Indexer/Backend 挂掉不会导致用户资金 ownership 丢失。

### AC-20

全部核心路径具备 deterministic tests。

---

# 63. Stop Line

完成上述 V0 后停止。

不要自行继续增加：

- Governance Token；
- DAO voting；
- NFTs；
- creator coin；
- liquidity mining；
- DeFi strategy；
- cross-chain bridge；
- oracle pricing；
- reputation token；
- AI recommendation；
- zk privacy；
- mobile app；
- complex moderation system。

这些不是当前任务。

当前任务的完成定义：

> **让 Content → Rights → Distribution → Revenue → Claim → Dispute → Safeguard 这一条主链在 Solana 上正确、可测试、权限可控。**

如果这条链正确：

停止扩展，提交结果。

---

# 64. Final Engineering Principle

遇到设计冲突时，按以下优先级决策：

```text
1. User principal safety
2. Rights correctness
3. Deterministic settlement
4. Authority isolation
5. Privacy commitments
6. Maintainability
7. Compute/account efficiency
8. Developer convenience
```

不得为了减少代码量牺牲前四项。

整个协议的最终核心原则：

> Content ownership is immutable.  
> Distribution rights are composable.  
> Access rights belong to the content.  
> Revenue attribution belongs to the distribution node.  
> Similarity creates review, not guilt.  
> User liabilities are never protocol revenue.  
> Safeguarded principal remains user property.  
> Source rights and distribution rights must remain separate.