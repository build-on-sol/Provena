//! Transaction-level security tests against the compiled program, real Anchor
//! account validation, and SPL Token CPIs in LiteSVM. Initial config/content
//! fixtures avoid deployment-only upgrade-authority initialization requirements.
//! Run after the SBF build: cargo test --test security -- --ignored.

use anchor_lang::system_program;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token::{
    self,
    state::{Account as TokenState, AccountState, Mint as MintState},
};
use content_rights_protocol::{
    self as protocol, accounts, instruction, merkle_pair, payout_leaf, state::*,
};
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    clock::Clock,
    instruction::Instruction,
    program_option::COption,
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};

const DAY: i64 = 86_400;
const START: i64 = 1_000_000;

#[derive(Clone, Copy)]
enum Who {
    Admin,
    Originality,
    Rights,
    Author,
    Source,
    Buyer,
    Attacker,
}

struct Fixture {
    vm: LiteSVM,
    payer: Keypair,
    admin: Keypair,
    originality: Keypair,
    rights: Keypair,
    author: Keypair,
    source: Keypair,
    buyer: Keypair,
    attacker: Keypair,
    config: Pubkey,
    content: Pubkey,
    reference: Pubkey,
    node: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
    asset: Pubkey,
    vault: Pubkey,
    epoch: Pubkey,
    funding: Pubkey,
    author_destination: Pubkey,
    source_destination: Pubkey,
    attacker_destination: Pubkey,
    treasury_destination: Pubkey,
    review: Option<Pubkey>,
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &protocol::ID).0
}

fn put<T: AccountSerialize>(vm: &mut LiteSVM, key: Pubkey, value: &T) {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    vm.set_account(
        key,
        Account {
            lamports: 100_000_000,
            data,
            owner: protocol::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn put_mint(vm: &mut LiteSVM, mint: Pubkey) {
    let state = MintState {
        mint_authority: COption::None,
        supply: 1_000_000,
        decimals: 0,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut data = vec![0; MintState::LEN];
    MintState::pack(state, &mut data).unwrap();
    vm.set_account(
        mint,
        Account {
            lamports: 100_000_000,
            data,
            owner: spl_token::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn put_token(vm: &mut LiteSVM, key: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
    let state = TokenState {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0; TokenState::LEN];
    TokenState::pack(state, &mut data).unwrap();
    vm.set_account(
        key,
        Account {
            lamports: 100_000_000,
            data,
            owner: spl_token::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn content(author: Pubkey, raw_hash: [u8; 32], canonical_hash: [u8; 32]) -> Content {
    Content {
        version: 1,
        author,
        raw_hash,
        canonical_hash,
        canonicalization_version: 1,
        metadata_commitment: [5; 32],
        storage_commitment: [6; 32],
        citation_manifest_commitment: [0; 32],
        mode: 0,
        status: 1,
        quote_policy: 0,
        price: 0,
        price_mint: Pubkey::default(),
        original_node: Pubkey::default(),
        licensed_source: Pubkey::default(),
        licensed_source_bps: 0,
        derivative_source: Pubkey::default(),
        derivative_source_bps: 0,
        created_at: START,
        normal_deadline: 0,
        active_case: Pubkey::default(),
        case_resolved: false,
    }
}

impl Fixture {
    fn new() -> Self {
        let default = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/deploy/content_rights_protocol.so");
        let path = std::env::var_os("PROVENA_PROGRAM_SO")
            .map(std::path::PathBuf::from)
            .unwrap_or(default);
        let bytes = std::fs::read(&path).unwrap_or_else(|error| {
            panic!(
                "SBF artifact {} is required; build-sbf first: {error}",
                path.display()
            )
        });
        let mut vm = LiteSVM::new();
        vm.add_program(protocol::ID, &bytes).unwrap();
        let payer = Keypair::new();
        let admin = Keypair::new();
        let originality = Keypair::new();
        let rights = Keypair::new();
        let author = Keypair::new();
        let source = Keypair::new();
        let buyer = Keypair::new();
        let attacker = Keypair::new();
        for signer in [
            &payer,
            &admin,
            &originality,
            &rights,
            &author,
            &source,
            &buyer,
            &attacker,
        ] {
            vm.airdrop(&signer.pubkey(), 10_000_000_000).unwrap();
        }
        let mut clock: Clock = vm.get_sysvar();
        clock.unix_timestamp = START;
        vm.set_sysvar(&clock);
        let config = pda(&[b"config"]);
        put(
            &mut vm,
            config,
            &ProtocolConfig {
                version: 1,
                admin: admin.pubkey(),
                originality_authority: originality.pubkey(),
                rights_authority: rights.pubkey(),
                treasury: admin.pubkey(),
                paused: false,
            },
        );
        let content_key = pda(&[b"content", author.pubkey().as_ref(), &[1; 32]]);
        let reference = pda(&[b"content", source.pubkey().as_ref(), &[3; 32]]);
        let node = pda(&[b"original", content_key.as_ref()]);
        let mut c = content(author.pubkey(), [1; 32], [2; 32]);
        c.original_node = node;
        put(&mut vm, content_key, &c);
        put(
            &mut vm,
            reference,
            &content(source.pubkey(), [3; 32], [4; 32]),
        );
        put(
            &mut vm,
            pda(&[b"fingerprint", &[2; 32]]),
            &FingerprintRegistry {
                version: 1,
                canonical_hash: [2; 32],
                content: content_key,
            },
        );
        put(
            &mut vm,
            node,
            &DistributionNode {
                version: 1,
                content: content_key,
                creator: author.pubkey(),
                tip_payout_root: payout_leaf(node, 0, 0, author.pubkey(), 10000),
                sale_payout_root: payout_leaf(node, 1, 0, author.pubkey(), 10000),
                tip_child_bps: 3000,
                sale_child_bps: 2000,
                tip_residual_bps: 10000,
                sale_residual_bps: 10000,
                provenance_commitment: [0; 32],
                next_epoch: 1,
            },
        );
        let mint = Pubkey::new_unique();
        put_mint(&mut vm, mint);
        let (asset, bump) = Pubkey::find_program_address(&[b"asset", mint.as_ref()], &protocol::ID);
        put(
            &mut vm,
            asset,
            &AssetPolicy {
                version: 1,
                mint,
                token_program: spl_token::ID,
                enabled: true,
                safeguard_enabled: true,
                future_strategy_enabled: false,
                user_liability: 0,
                earned_fees: 0,
                bump,
            },
        );
        let vault = pda(&[b"vault", asset.as_ref()]);
        put_token(&mut vm, vault, mint, asset, 0);
        let funding = Pubkey::new_unique();
        put_token(&mut vm, funding, mint, buyer.pubkey(), 1_000_000);
        let author_destination = Pubkey::new_unique();
        put_token(&mut vm, author_destination, mint, author.pubkey(), 0);
        let source_destination = Pubkey::new_unique();
        put_token(&mut vm, source_destination, mint, source.pubkey(), 0);
        let attacker_destination = Pubkey::new_unique();
        put_token(&mut vm, attacker_destination, mint, attacker.pubkey(), 0);
        let treasury_destination = Pubkey::new_unique();
        put_token(&mut vm, treasury_destination, mint, admin.pubkey(), 0);
        let epoch = pda(&[
            b"epoch",
            node.as_ref(),
            mint.as_ref(),
            &[0],
            &0u64.to_le_bytes(),
        ]);
        put(
            &mut vm,
            epoch,
            &RevenueEpoch {
                version: 1,
                content: content_key,
                node,
                mint,
                kind: 0,
                payout_root: payout_leaf(node, 0, 0, author.pubkey(), 10000),
                gross: 0,
                paid: 0,
                fees: 0,
                opened_at: START,
                deadline: 0,
                post_review: false,
            },
        );
        Self {
            vm,
            payer,
            admin,
            originality,
            rights,
            author,
            source,
            buyer,
            attacker,
            config,
            content: content_key,
            reference,
            node,
            mint,
            token_program: spl_token::ID,
            asset,
            vault,
            epoch,
            funding,
            author_destination,
            source_destination,
            attacker_destination,
            treasury_destination,
            review: None,
        }
    }

    fn key(&self, who: Who) -> Pubkey {
        self.signer(who).pubkey()
    }
    fn signer(&self, who: Who) -> &Keypair {
        match who {
            Who::Admin => &self.admin,
            Who::Originality => &self.originality,
            Who::Rights => &self.rights,
            Who::Author => &self.author,
            Who::Source => &self.source,
            Who::Buyer => &self.buyer,
            Who::Attacker => &self.attacker,
        }
    }
    fn read<T: AccountDeserialize>(&self, key: Pubkey) -> T {
        T::try_deserialize(&mut self.vm.get_account(&key).unwrap().data.as_slice()).unwrap()
    }
    fn balance(&self, key: Pubkey) -> u64 {
        TokenState::unpack(&self.vm.get_account(&key).unwrap().data)
            .unwrap()
            .amount
    }
    fn at(&mut self, elapsed: i64) {
        let mut clock: Clock = self.vm.get_sysvar();
        clock.unix_timestamp = START + elapsed;
        self.vm.set_sysvar(&clock);
    }
    fn send(&mut self, ix: Instruction, who: &[Who]) -> Result<Vec<String>, String> {
        self.vm.expire_blockhash();
        let mut signers = vec![&self.payer];
        signers.extend(who.iter().map(|who| self.signer(*who)));
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&self.payer.pubkey()),
            &signers,
            self.vm.latest_blockhash(),
        );
        self.vm
            .send_transaction(tx)
            .map(|meta| meta.logs)
            .map_err(|error| format!("{error:?}"))
    }
    fn succeeds(&mut self, ix: Instruction, who: &[Who]) {
        self.send(ix, who).unwrap();
    }
    fn rejects(&mut self, ix: Instruction, who: &[Who], error: ProtocolError) {
        let actual = self.send(ix, who).expect_err("transaction must reject");
        let code: u32 = error.into();
        assert!(
            actual.contains(&format!("Custom({code})")),
            "unexpected failure: {actual}"
        );
    }
    fn economic(&self) -> accounts::Economic {
        accounts::Economic {
            funder: self.buyer.pubkey(),
            config: self.config,
            content: self.content,
            node: self.node,
            epoch: self.epoch,
            asset: self.asset,
            mint: self.mint,
            source: self.funding,
            vault: self.vault,
            review: self.review,
            token_program: self.token_program,
        }
    }
    fn tip_ix(&self, amount: u64) -> Instruction {
        Instruction {
            program_id: protocol::ID,
            accounts: self.economic().to_account_metas(None),
            data: instruction::Tip { amount }.data(),
        }
    }
    fn tip(&mut self, amount: u64) {
        self.succeeds(self.tip_ix(amount), &[Who::Buyer]);
    }
    fn proof(&self) -> ClaimProof {
        ClaimProof {
            beneficiary: self.author.pubkey(),
            role: 0,
            share_bps: 10000,
            siblings: vec![],
        }
    }
    fn destination(&self, who: Who) -> Pubkey {
        match who {
            Who::Author => self.author_destination,
            Who::Source => self.source_destination,
            Who::Attacker => self.attacker_destination,
            Who::Admin => self.treasury_destination,
            _ => panic!("not a recipient"),
        }
    }
    fn leaf_key(&self, proof: &ClaimProof) -> Pubkey {
        pda(&[
            b"leaf",
            self.epoch.as_ref(),
            &[proof.role],
            proof.beneficiary.as_ref(),
        ])
    }
    fn position_key(&self, proof: &ClaimProof, who: Who) -> Pubkey {
        pda(&[
            b"position",
            self.leaf_key(proof).as_ref(),
            self.key(who).as_ref(),
        ])
    }
    fn claim_accounts(&self, proof: &ClaimProof, who: Who) -> accounts::Claim {
        accounts::Claim {
            recipient: self.key(who),
            content: self.content,
            epoch: self.epoch,
            asset: self.asset,
            mint: self.mint,
            vault: self.vault,
            destination: self.destination(who),
            leaf: self.leaf_key(proof),
            position: self.position_key(proof, who),
            review: self.review,
            token_program: self.token_program,
            system_program: system_program::ID,
        }
    }
    fn claim_ix(&self, proof: ClaimProof, who: Who, amount: u64) -> Instruction {
        Instruction {
            program_id: protocol::ID,
            accounts: self.claim_accounts(&proof, who).to_account_metas(None),
            data: instruction::ClaimLiquid { proof, amount }.data(),
        }
    }
    fn claim(&mut self, proof: ClaimProof, who: Who, amount: u64) {
        self.succeeds(self.claim_ix(proof, who, amount), &[who]);
    }
    fn exit_ix(&self, proof: ClaimProof, who: Who, amount: u64) -> Instruction {
        Instruction {
            program_id: protocol::ID,
            accounts: self.claim_accounts(&proof, who).to_account_metas(None),
            data: instruction::RequestSafeguardExit { proof, amount }.data(),
        }
    }
    fn open_case(&mut self) {
        let case = pda(&[b"case", self.content.as_ref()]);
        let ix = Instruction {
            program_id: protocol::ID,
            accounts: accounts::OpenCase {
                payer: self.payer.pubkey(),
                config: self.config,
                originality: self.originality.pubkey(),
                content: self.content,
                reference: self.reference,
                case,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::OpenSimilarityCase {
                evidence_commitment: [8; 32],
            }
            .data(),
        };
        self.succeeds(ix, &[Who::Originality]);
        self.review = Some(case);
    }
    fn independent_ix(&self) -> Instruction {
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::Independent {
                content: self.content,
                case: self.review.unwrap(),
                candidate_author: self.author.pubkey(),
                reference_author: self.source.pubkey(),
            }
            .to_account_metas(None),
            data: instruction::ConfirmIndependent {}.data(),
        }
    }
    fn independent(&mut self) {
        self.succeeds(self.independent_ix(), &[Who::Author, Who::Source]);
    }
    fn derivative(&mut self, source_bps: u16) -> Pubkey {
        let case = self.review.unwrap();
        let nonce = 0u64;
        let settlement = pda(&[b"settlement", case.as_ref(), &nonce.to_le_bytes()]);
        self.succeeds(
            Instruction {
                program_id: protocol::ID,
                accounts: accounts::Propose {
                    author: self.author.pubkey(),
                    case,
                    settlement,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
                data: instruction::ProposeSettlement {
                    nonce,
                    source_bps,
                    commitment: [11; 32],
                }
                .data(),
            },
            &[Who::Author],
        );
        self.succeeds(
            Instruction {
                program_id: protocol::ID,
                accounts: accounts::Accept {
                    author: self.source.pubkey(),
                    case,
                    settlement,
                }
                .to_account_metas(None),
                data: instruction::AcceptSettlement {}.data(),
            },
            &[Who::Source],
        );
        self.succeeds(self.finalize_ix(settlement, Who::Rights), &[Who::Rights]);
        settlement
    }
    fn finalize_ix(&self, settlement: Pubkey, signer: Who) -> Instruction {
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::FinalizeSettlement {
                config: self.config,
                rights: self.key(signer),
                content: self.content,
                case: self.review.unwrap(),
                settlement,
            }
            .to_account_metas(None),
            data: instruction::FinalizeDerivativeSettlement {}.data(),
        }
    }
    fn new_epoch(&mut self, kind: u8) {
        let nonce = self.read::<DistributionNode>(self.node).next_epoch;
        let epoch = pda(&[
            b"epoch",
            self.node.as_ref(),
            self.mint.as_ref(),
            &[kind],
            &nonce.to_le_bytes(),
        ]);
        self.succeeds(
            Instruction {
                program_id: protocol::ID,
                accounts: accounts::OpenEpoch {
                    payer: self.payer.pubkey(),
                    content: self.content,
                    node: self.node,
                    mint: self.mint,
                    epoch,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
                data: instruction::OpenRevenueEpoch { kind, nonce }.data(),
            },
            &[],
        );
        self.epoch = epoch;
    }
    fn solvency(&self) {
        let policy: AssetPolicy = self.read(self.asset);
        assert!(self.balance(self.vault) >= policy.user_liability + policy.earned_fees);
    }
}

#[test]
#[ignore = "requires compiled SBF program; run cargo test --test security -- --ignored"]
fn canonical_registry_authorities_and_immutable_content() {
    let mut f = Fixture::new();
    let raw = [100; 32];
    let canonical = [101; 32];
    let key = pda(&[b"content", f.author.pubkey().as_ref(), &raw]);
    let fingerprint = pda(&[b"fingerprint", &canonical]);
    let args = SubmitArgs {
        raw_hash: raw,
        canonical_hash: canonical,
        canonicalization_version: 1,
        metadata_commitment: [5; 32],
        storage_commitment: [6; 32],
        citation_manifest_commitment: [0; 32],
        mode: 0,
        quote_policy: 0,
        price: 0,
        price_mint: Pubkey::default(),
    };
    let submit = |f: &Fixture, author: Who, originality: Who, raw_hash: [u8; 32]| {
        let mut input = args.clone();
        input.raw_hash = raw_hash;
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::Submit {
                author: f.key(author),
                originality: f.key(originality),
                config: f.config,
                content: pda(&[b"content", f.key(author).as_ref(), &raw_hash]),
                fingerprint,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::SubmitContent { args: input }.data(),
        }
    };
    f.rejects(
        submit(&f, Who::Author, Who::Attacker, raw),
        &[Who::Author, Who::Attacker],
        ProtocolError::Unauthorized,
    );
    f.succeeds(
        submit(&f, Who::Author, Who::Originality, raw),
        &[Who::Author, Who::Originality],
    );
    f.rejects(
        submit(&f, Who::Attacker, Who::Originality, [102; 32]),
        &[Who::Attacker, Who::Originality],
        ProtocolError::DuplicateContent,
    );
    let approve = |f: &Fixture, originality: Who| Instruction {
        program_id: protocol::ID,
        accounts: accounts::Approve {
            config: f.config,
            originality: f.key(originality),
            content: key,
        }
        .to_account_metas(None),
        data: instruction::ApproveOriginal {}.data(),
    };
    f.rejects(
        approve(&f, Who::Attacker),
        &[Who::Attacker],
        ProtocolError::Unauthorized,
    );
    f.succeeds(approve(&f, Who::Originality), &[Who::Originality]);
    let state: Content = f.read(key);
    assert_eq!(state.author, f.author.pubkey());
    assert_eq!(state.raw_hash, raw);
    assert_eq!(state.canonical_hash, canonical);
    f.rejects(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::OriginalNode {
                author: f.attacker.pubkey(),
                content: key,
                node: pda(&[b"original", key.as_ref()]),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateOriginalNode {
                tip_child_bps: 3000,
                sale_child_bps: 2000,
            }
            .data(),
        },
        &[Who::Attacker],
        ProtocolError::Unauthorized,
    );
    assert_eq!(f.read::<Content>(key).author, f.author.pubkey());
}

#[test]
#[ignore = "requires compiled SBF program"]
fn merkle_proofs_recipient_pda_and_asset_substitution_reject() {
    let mut f = Fixture::new();
    f.tip(1000);
    let proof = f.proof();
    let mut wrong_share = proof.clone();
    wrong_share.share_bps = 9999;
    f.rejects(
        f.claim_ix(wrong_share, Who::Author, 1),
        &[Who::Author],
        ProtocolError::InvalidMerkleProof,
    );
    let mut wrong_role = proof.clone();
    wrong_role.role = 1;
    f.rejects(
        f.claim_ix(wrong_role, Who::Author, 1),
        &[Who::Author],
        ProtocolError::InvalidMerkleProof,
    );
    let mut modified = proof.clone();
    modified.siblings.push([9; 32]);
    f.rejects(
        f.claim_ix(modified, Who::Author, 1),
        &[Who::Author],
        ProtocolError::InvalidMerkleProof,
    );
    let mut wrong_beneficiary = proof.clone();
    wrong_beneficiary.beneficiary = f.source.pubkey();
    f.rejects(
        f.claim_ix(wrong_beneficiary, Who::Source, 1),
        &[Who::Source],
        ProtocolError::InvalidPayoutRoot,
    );
    f.rejects(
        f.claim_ix(proof.clone(), Who::Attacker, 1),
        &[Who::Attacker],
        ProtocolError::Unauthorized,
    );
    for replacement in [f.source_destination, f.attacker_destination, f.funding] {
        let mut a = f.claim_accounts(&proof, Who::Author);
        a.destination = replacement;
        let ix = Instruction {
            program_id: protocol::ID,
            accounts: a.to_account_metas(None),
            data: instruction::ClaimLiquid {
                proof: proof.clone(),
                amount: 1,
            }
            .data(),
        };
        assert!(f.send(ix, &[Who::Author]).is_err());
    }
    let mut a = f.claim_accounts(&proof, Who::Author);
    a.vault = f.funding;
    assert!(f
        .send(
            Instruction {
                program_id: protocol::ID,
                accounts: a.to_account_metas(None),
                data: instruction::ClaimLiquid {
                    proof: proof.clone(),
                    amount: 1
                }
                .data()
            },
            &[Who::Author]
        )
        .is_err());
    let second_mint = Pubkey::new_unique();
    put_mint(&mut f.vm, second_mint);
    let mut a = f.claim_accounts(&proof, Who::Author);
    a.mint = second_mint;
    assert!(f
        .send(
            Instruction {
                program_id: protocol::ID,
                accounts: a.to_account_metas(None),
                data: instruction::ClaimLiquid {
                    proof: proof.clone(),
                    amount: 1
                }
                .data()
            },
            &[Who::Author]
        )
        .is_err());
    let mut a = f.claim_accounts(&proof, Who::Author);
    a.token_program = anchor_spl::token_2022::ID;
    assert!(f
        .send(
            Instruction {
                program_id: protocol::ID,
                accounts: a.to_account_metas(None),
                data: instruction::ClaimLiquid {
                    proof: proof.clone(),
                    amount: 1
                }
                .data()
            },
            &[Who::Author]
        )
        .is_err());
    assert_eq!(f.balance(f.vault), 1000);
    assert_eq!(f.balance(f.author_destination), 0);
    f.claim(proof.clone(), Who::Author, 1000);
    f.rejects(
        f.claim_ix(proof, Who::Author, 1),
        &[Who::Author],
        ProtocolError::PrincipalProtected,
    );
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn pause_blocks_deposits_but_preserves_claims_and_policy_roots() {
    let mut f = Fixture::new();
    f.tip(1000);
    let original: DistributionNode = f.read(f.node);
    let epoch: RevenueEpoch = f.read(f.epoch);
    f.rejects(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::UpdateNode {
                creator: f.attacker.pubkey(),
                node: f.node,
            }
            .to_account_metas(None),
            data: instruction::UpdateRepostPolicy {
                tip_child_bps: 5000,
                sale_child_bps: 8000,
            }
            .data(),
        },
        &[Who::Attacker],
        ProtocolError::Unauthorized,
    );
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::UpdateNode {
                creator: f.author.pubkey(),
                node: f.node,
            }
            .to_account_metas(None),
            data: instruction::UpdateRepostPolicy {
                tip_child_bps: 5000,
                sale_child_bps: 8000,
            }
            .data(),
        },
        &[Who::Author],
    );
    let after: DistributionNode = f.read(f.node);
    assert_eq!(after.tip_payout_root, original.tip_payout_root);
    assert_eq!(after.sale_payout_root, original.sale_payout_root);
    assert_eq!(
        f.read::<RevenueEpoch>(f.epoch).payout_root,
        epoch.payout_root
    );
    assert_eq!((after.tip_child_bps, after.sale_child_bps), (5000, 8000));
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::Admin {
                admin: f.admin.pubkey(),
                config: f.config,
            }
            .to_account_metas(None),
            data: instruction::SetPaused { paused: true }.data(),
        },
        &[Who::Admin],
    );
    f.rejects(f.tip_ix(1), &[Who::Buyer], ProtocolError::Paused);
    f.claim(f.proof(), Who::Author, 1000);
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn partial_claim_independent_resolution_never_charges_fee() {
    let mut f = Fixture::new();
    f.tip(10_000);
    f.claim(f.proof(), Who::Author, 2000);
    f.at(3 * DAY);
    f.open_case();
    let c: SimilarityCase = f.read(f.review.unwrap());
    assert_eq!(c.cutoff, START + 7 * DAY);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::DisputeStillActive,
    );
    let mut omitted = f.claim_accounts(&f.proof(), Who::Author);
    omitted.review = None;
    f.rejects(
        Instruction {
            program_id: protocol::ID,
            accounts: omitted.to_account_metas(None),
            data: instruction::ClaimLiquid {
                proof: f.proof(),
                amount: 1,
            }
            .data(),
        },
        &[Who::Author],
        ProtocolError::SettlementMismatch,
    );
    f.at(4 * DAY);
    f.independent();
    f.claim(f.proof(), Who::Author, 8000);
    let asset: AssetPolicy = f.read(f.asset);
    assert_eq!(asset.earned_fees, 0);
    assert_eq!(asset.user_liability, 0);
    assert_eq!(f.balance(f.author_destination), 10_000);
    f.rejects(
        f.independent_ix(),
        &[Who::Author, Who::Source],
        ProtocolError::CaseAlreadyResolved,
    );
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn partial_claim_derivative_allocations_once_and_treasury_only_earned_fees() {
    let mut f = Fixture::new();
    f.tip(10_000);
    f.claim(f.proof(), Who::Author, 2000);
    f.at(3 * DAY);
    f.open_case();
    f.at(4 * DAY);
    let settlement = f.derivative(7000);
    f.rejects(
        f.finalize_ix(settlement, Who::Attacker),
        &[Who::Attacker],
        ProtocolError::Unauthorized,
    );
    f.rejects(
        f.finalize_ix(settlement, Who::Rights),
        &[Who::Rights],
        ProtocolError::CaseAlreadyResolved,
    );
    // The reference author can present the Origin proof without impersonating its owner.
    f.claim(f.proof(), Who::Source, 5320);
    let policy: AssetPolicy = f.read(f.asset);
    assert_eq!(policy.earned_fees, 400);
    f.claim(f.proof(), Who::Author, 2280);
    assert_eq!(f.balance(f.author_destination), 4280);
    assert_eq!(f.balance(f.source_destination), 5320);
    assert_eq!(f.read::<AssetPolicy>(f.asset).earned_fees, 400);
    f.rejects(
        f.claim_ix(f.proof(), Who::Source, 1),
        &[Who::Source],
        ProtocolError::PrincipalProtected,
    );
    let fees = |f: &Fixture, who: Who, destination: Pubkey, amount| Instruction {
        program_id: protocol::ID,
        accounts: accounts::WithdrawFees {
            admin: f.key(who),
            config: f.config,
            asset: f.asset,
            mint: f.mint,
            vault: f.vault,
            destination,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: instruction::WithdrawProtocolFees { amount }.data(),
    };
    f.rejects(
        fees(&f, Who::Attacker, f.treasury_destination, 1),
        &[Who::Attacker],
        ProtocolError::Unauthorized,
    );
    f.rejects(
        fees(&f, Who::Admin, f.treasury_destination, 401),
        &[Who::Admin],
        ProtocolError::PrincipalProtected,
    );
    assert!(f
        .send(
            fees(&f, Who::Admin, f.attacker_destination, 400),
            &[Who::Admin]
        )
        .is_err());
    f.succeeds(
        fees(&f, Who::Admin, f.treasury_destination, 400),
        &[Who::Admin],
    );
    assert_eq!(f.balance(f.vault), 0);
    assert_eq!(f.balance(f.treasury_destination), 400);
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn zero_revenue_dispute_late_deposit_and_automatic_exit_are_clock_derived() {
    let mut f = Fixture::new();
    f.open_case();
    f.at(8 * DAY);
    f.new_epoch(0);
    f.tip(10_000);
    assert_eq!(f.read::<RevenueEpoch>(f.epoch).deadline, START + 7 * DAY);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::DisputeStillActive,
    );
    f.at(9 * DAY);
    f.independent();
    f.at(11 * DAY - 1);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::ExitCooldownActive,
    );
    // No keeper or proof submission ran at readiness; the first successful proof is day13.
    f.at(13 * DAY);
    f.claim(f.proof(), Who::Author, 100);
    let position: ClaimPosition = f.read(f.position_key(&f.proof(), Who::Author));
    assert_eq!(position.exit_requested_at, START + 9 * DAY);
    assert_eq!(position.exit_amount, 9900);
    f.at(19 * DAY);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::SafeguardExitRequired,
    );
    f.succeeds(f.exit_ix(f.proof(), Who::Author, 9900), &[Who::Author]);
    f.at(21 * DAY);
    f.claim(f.proof(), Who::Author, 9900);
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn partial_safeguard_exit_cannot_overdraw_or_reset_pending_request() {
    let mut f = Fixture::new();
    f.tip(10_000);
    f.at(8 * DAY);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::SafeguardExitRequired,
    );
    f.rejects(
        f.exit_ix(f.proof(), Who::Author, 10_001),
        &[Who::Author],
        ProtocolError::InsufficientBalance,
    );
    f.succeeds(f.exit_ix(f.proof(), Who::Author, 4000), &[Who::Author]);
    f.rejects(
        f.exit_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::ExitAlreadyPending,
    );
    f.at(10 * DAY - 1);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::ExitCooldownActive,
    );
    f.at(10 * DAY);
    f.claim(f.proof(), Who::Author, 1000);
    let position: ClaimPosition = f.read(f.position_key(&f.proof(), Who::Author));
    assert_eq!(position.exit_requested_at, START + 8 * DAY);
    assert_eq!(position.exit_amount, 3000);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 3001),
        &[Who::Author],
        ProtocolError::InsufficientBalance,
    );
    f.claim(f.proof(), Who::Author, 3000);
    f.rejects(
        f.exit_ix(f.proof(), Who::Author, 6001),
        &[Who::Author],
        ProtocolError::InsufficientBalance,
    );
    f.succeeds(f.exit_ix(f.proof(), Who::Author, 6000), &[Who::Author]);
    f.at(12 * DAY);
    f.claim(f.proof(), Who::Author, 6000);
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn access_receipt_is_content_scoped_and_purchase_uses_sale_root() {
    let mut f = Fixture::new();
    let mut c: Content = f.read(f.content);
    c.mode = 1;
    c.price = 100;
    c.price_mint = f.mint;
    put(&mut f.vm, f.content, &c);
    f.new_epoch(1);
    let receipt = pda(&[b"access", f.content.as_ref(), f.buyer.pubkey().as_ref()]);
    let purchase = |f: &Fixture| Instruction {
        program_id: protocol::ID,
        accounts: accounts::Purchase {
            buyer: f.buyer.pubkey(),
            economic: f.economic(),
            receipt,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::PurchaseAccess {}.data(),
    };
    f.succeeds(purchase(&f), &[Who::Buyer]);
    let stored: AccessReceipt = f.read(receipt);
    assert_eq!(stored.content, f.content);
    assert_eq!(stored.purchase_node, f.node);
    let sale: RevenueEpoch = f.read(f.epoch);
    assert_eq!(sale.kind, 1);
    assert_eq!(
        sale.payout_root,
        payout_leaf(f.node, 1, 0, f.author.pubkey(), 10000)
    );
    let before = f.balance(f.funding);
    let nonce = [43; 32];
    let second_node = pda(&[
        b"node",
        f.content.as_ref(),
        f.attacker.pubkey().as_ref(),
        &nonce,
    ]);
    let args = RepostArgs {
        nonce,
        tip_root: payout_leaf(second_node, 0, 0, f.author.pubkey(), 10000),
        sale_root: payout_leaf(second_node, 1, 0, f.author.pubkey(), 10000),
        tip_child_bps: 0,
        sale_child_bps: 0,
        tip_residual_bps: 0,
        sale_residual_bps: 0,
        provenance_commitment: [13; 32],
    };
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::RepostNode {
                creator: f.attacker.pubkey(),
                config: f.config,
                rights: f.rights.pubkey(),
                content: f.content,
                node: second_node,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateRepostNode { args }.data(),
        },
        &[Who::Attacker, Who::Rights],
    );
    f.node = second_node;
    f.new_epoch(1);
    assert!(f.send(purchase(&f), &[Who::Buyer]).is_err());
    assert_eq!(f.balance(f.funding), before);
    assert_eq!(f.balance(f.vault), 100);
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn largest_u64_deposit_and_claim_are_valid_and_conserve_tokens() {
    let mut f = Fixture::new();
    put_token(&mut f.vm, f.funding, f.mint, f.buyer.pubkey(), u64::MAX);
    f.tip(u64::MAX);
    assert_eq!(f.read::<AssetPolicy>(f.asset).user_liability, u64::MAX);
    assert_eq!(f.balance(f.vault), u64::MAX);
    f.claim(f.proof(), Who::Author, u64::MAX);
    assert_eq!(f.balance(f.author_destination), u64::MAX);
    assert_eq!(f.balance(f.vault), 0);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::MathOverflow,
    );
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn compromised_attestation_cannot_spend_other_epochs_principal() {
    let mut f = Fixture::new();
    f.tip(10_000);
    let first_epoch = f.epoch;
    let nonce = [42; 32];
    let node = pda(&[
        b"node",
        f.content.as_ref(),
        f.attacker.pubkey().as_ref(),
        &nonce,
    ]);
    let origin = payout_leaf(node, 0, 0, f.author.pubkey(), 7000);
    let distributor = payout_leaf(node, 0, 1, f.attacker.pubkey(), 7000);
    let bad_root = merkle_pair(origin, distributor); // rights signer mis-attests 14000bps.
    let args = RepostArgs {
        nonce,
        tip_root: bad_root,
        sale_root: bad_root,
        tip_child_bps: 0,
        sale_child_bps: 0,
        tip_residual_bps: 7000,
        sale_residual_bps: 7000,
        provenance_commitment: [12; 32],
    };
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::RepostNode {
                creator: f.attacker.pubkey(),
                config: f.config,
                rights: f.rights.pubkey(),
                content: f.content,
                node,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateRepostNode { args }.data(),
        },
        &[Who::Attacker, Who::Rights],
    );
    f.node = node;
    f.new_epoch(0);
    f.tip(10_000);
    let author_proof = ClaimProof {
        beneficiary: f.author.pubkey(),
        role: 0,
        share_bps: 7000,
        siblings: vec![distributor],
    };
    let attacker_proof = ClaimProof {
        beneficiary: f.attacker.pubkey(),
        role: 1,
        share_bps: 7000,
        siblings: vec![origin],
    };
    f.claim(author_proof, Who::Author, 7000);
    f.rejects(
        f.claim_ix(attacker_proof, Who::Attacker, 7000),
        &[Who::Attacker],
        ProtocolError::PrincipalProtected,
    );
    assert_eq!(f.balance(f.vault), 13_000);
    assert_eq!(f.read::<RevenueEpoch>(first_epoch).paid, 0);
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn licensed_source_and_derivative_source_can_share_wallet_without_double_claim() {
    let mut f = Fixture::new();
    let mut c: Content = f.read(f.content);
    c.licensed_source = f.source.pubkey();
    c.licensed_source_bps = 2000;
    put(&mut f.vm, f.content, &c);
    let origin = payout_leaf(f.node, 0, 0, f.author.pubkey(), 8000);
    let licensed = payout_leaf(f.node, 0, 2, f.source.pubkey(), 2000);
    let mut node: DistributionNode = f.read(f.node);
    node.tip_payout_root = merkle_pair(origin, licensed);
    node.tip_residual_bps = 8000;
    put(&mut f.vm, f.node, &node);
    let mut epoch: RevenueEpoch = f.read(f.epoch);
    epoch.payout_root = node.tip_payout_root;
    put(&mut f.vm, f.epoch, &epoch);
    let origin_proof = ClaimProof {
        beneficiary: f.author.pubkey(),
        role: 0,
        share_bps: 8000,
        siblings: vec![licensed],
    };
    let licensed_proof = ClaimProof {
        beneficiary: f.source.pubkey(),
        role: 2,
        share_bps: 2000,
        siblings: vec![origin],
    };
    f.tip(10_000);
    f.claim(licensed_proof.clone(), Who::Source, 1000);
    f.at(3 * DAY);
    f.open_case();
    f.at(4 * DAY);
    f.derivative(7000);
    f.claim(origin_proof.clone(), Who::Source, 5320);
    f.claim(origin_proof.clone(), Who::Author, 2280);
    f.claim(licensed_proof.clone(), Who::Source, 950);
    assert_eq!(f.balance(f.source_destination), 7270);
    assert_eq!(f.balance(f.author_destination), 2280);
    assert_eq!(f.read::<AssetPolicy>(f.asset).earned_fees, 450);
    f.rejects(
        f.claim_ix(licensed_proof.clone(), Who::Source, 1),
        &[Who::Source],
        ProtocolError::PrincipalProtected,
    );
    f.rejects(
        f.claim_ix(origin_proof.clone(), Who::Source, 1),
        &[Who::Source],
        ProtocolError::PrincipalProtected,
    );
    // Later revenue owes ongoing source rights, but is outside the settled episode.
    f.new_epoch(0);
    f.tip(10_000);
    f.claim(origin_proof, Who::Source, 5600);
    f.claim(licensed_proof, Who::Source, 2000);
    f.claim(
        ClaimProof {
            beneficiary: f.author.pubkey(),
            role: 0,
            share_bps: 8000,
            siblings: vec![licensed],
        },
        Who::Author,
        2400,
    );
    assert_eq!(f.read::<AssetPolicy>(f.asset).earned_fees, 450);
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn epochs_share_fixed_content_clock_and_resolution_closes_holding_epochs() {
    let mut f = Fixture::new();
    f.tip(1000);
    let initial = f.epoch;
    let deadline = f.read::<RevenueEpoch>(initial).deadline;
    f.at(3 * DAY);
    f.new_epoch(0);
    f.tip(2000);
    f.claim(f.proof(), Who::Author, 100);
    f.tip(300);
    assert_eq!(f.read::<RevenueEpoch>(f.epoch).deadline, deadline);
    assert_eq!(f.read::<Content>(f.content).normal_deadline, deadline);
    f.at(4 * DAY);
    f.open_case();
    assert_eq!(f.read::<SimilarityCase>(f.review.unwrap()).cutoff, deadline);
    f.new_epoch(0);
    f.tip(100);
    let holding = f.epoch;
    f.at(5 * DAY);
    f.independent();
    f.rejects(f.tip_ix(1), &[Who::Buyer], ProtocolError::EpochClosed);
    f.new_epoch(0);
    f.tip(100);
    assert_eq!(f.read::<RevenueEpoch>(f.epoch).deadline, deadline);
    assert!(f.read::<RevenueEpoch>(f.epoch).post_review);
    assert!(!f.read::<RevenueEpoch>(holding).post_review);
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn substituted_case_and_unsupported_token_extensions_cannot_move_principal() {
    let mut f = Fixture::new();
    f.tip(1000);
    f.open_case();
    let correct = f.review;
    let unrelated = pda(&[b"case", f.reference.as_ref()]);
    put(
        &mut f.vm,
        unrelated,
        &SimilarityCase {
            version: 1,
            candidate: f.reference,
            reference: f.content,
            candidate_author: f.source.pubkey(),
            reference_author: f.author.pubkey(),
            evidence_commitment: [7; 32],
            started_at: START,
            cutoff: START + 7 * DAY,
            status: 4,
            resolution: 1,
            resolved_at: START,
            source_bps: 0,
            next_proposal: 0,
            settlement_commitment: [0; 32],
        },
    );
    f.review = Some(unrelated);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::SettlementMismatch,
    );
    f.rejects(
        f.tip_ix(1),
        &[Who::Buyer],
        ProtocolError::SettlementMismatch,
    );
    f.review = correct;
    assert_eq!(f.balance(f.vault), 1000);
    assert_eq!(f.balance(f.author_destination), 0);
    // An extension-bearing Token-2022 mint is not admitted, even if the admin signs.
    let extended_mint = Pubkey::new_unique();
    let state = MintState {
        mint_authority: COption::None,
        supply: 0,
        decimals: 0,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut data = vec![0u8; 170];
    MintState::pack(state, &mut data[..MintState::LEN]).unwrap();
    data[165] = 1;
    f.vm.set_account(
        extended_mint,
        Account {
            lamports: 100_000_000,
            data,
            owner: anchor_spl::token_2022::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let asset = pda(&[b"asset", extended_mint.as_ref()]);
    let vault = pda(&[b"vault", asset.as_ref()]);
    f.rejects(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::AddAsset {
                admin: f.admin.pubkey(),
                config: f.config,
                asset,
                mint: extended_mint,
                vault,
                token_program: anchor_spl::token_2022::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::AddAssetPolicy {}.data(),
        },
        &[Who::Admin],
        ProtocolError::UnsupportedAsset,
    );
    assert!(f.vm.get_account(&asset).is_none());
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn a_b_c_actual_token_payouts_and_existing_child_policy_are_immutable() {
    let mut f = Fixture::new();
    let b_nonce = [44; 32];
    let b = pda(&[
        b"node",
        f.content.as_ref(),
        f.source.pubkey().as_ref(),
        &b_nonce,
    ]);
    let b_tip_a = payout_leaf(b, 0, 0, f.author.pubkey(), 7000);
    let b_tip_b = payout_leaf(b, 0, 1, f.source.pubkey(), 3000);
    let b_sale_a = payout_leaf(b, 1, 0, f.author.pubkey(), 8000);
    let b_sale_b = payout_leaf(b, 1, 1, f.source.pubkey(), 2000);
    let b_args = RepostArgs {
        nonce: b_nonce,
        tip_root: merkle_pair(b_tip_a, b_tip_b),
        sale_root: merkle_pair(b_sale_a, b_sale_b),
        tip_child_bps: 4000,
        sale_child_bps: 1000,
        tip_residual_bps: 3000,
        sale_residual_bps: 2000,
        provenance_commitment: [14; 32],
    };
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::RepostNode {
                creator: f.source.pubkey(),
                config: f.config,
                rights: f.rights.pubkey(),
                content: f.content,
                node: b,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateRepostNode { args: b_args }.data(),
        },
        &[Who::Source, Who::Rights],
    );
    let c_nonce = [45; 32];
    let c = pda(&[
        b"node",
        f.content.as_ref(),
        f.attacker.pubkey().as_ref(),
        &c_nonce,
    ]);
    let tip_a = payout_leaf(c, 0, 0, f.author.pubkey(), 7000);
    let tip_b = payout_leaf(c, 0, 1, f.source.pubkey(), 1800);
    let tip_c = payout_leaf(c, 0, 1, f.attacker.pubkey(), 1200);
    let sale_a = payout_leaf(c, 1, 0, f.author.pubkey(), 8000);
    let sale_b = payout_leaf(c, 1, 1, f.source.pubkey(), 1800);
    let sale_c = payout_leaf(c, 1, 1, f.attacker.pubkey(), 200);
    let tip_root = merkle_pair(merkle_pair(tip_a, tip_b), merkle_pair(tip_c, tip_c));
    let sale_root = merkle_pair(merkle_pair(sale_a, sale_b), merkle_pair(sale_c, sale_c));
    let c_args = RepostArgs {
        nonce: c_nonce,
        tip_root,
        sale_root,
        tip_child_bps: 0,
        sale_child_bps: 0,
        tip_residual_bps: 1200,
        sale_residual_bps: 200,
        provenance_commitment: [15; 32],
    };
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::RepostNode {
                creator: f.attacker.pubkey(),
                config: f.config,
                rights: f.rights.pubkey(),
                content: f.content,
                node: c,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateRepostNode { args: c_args }.data(),
        },
        &[Who::Attacker, Who::Rights],
    );
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::UpdateNode {
                creator: f.source.pubkey(),
                node: b,
            }
            .to_account_metas(None),
            data: instruction::UpdateRepostPolicy {
                tip_child_bps: 9000,
                sale_child_bps: 9000,
            }
            .data(),
        },
        &[Who::Source],
    );
    let existing: DistributionNode = f.read(c);
    assert_eq!(existing.tip_payout_root, tip_root);
    assert_eq!(existing.sale_payout_root, sale_root);
    f.node = c;
    f.new_epoch(0);
    f.tip(100);
    f.claim(
        ClaimProof {
            beneficiary: f.author.pubkey(),
            role: 0,
            share_bps: 7000,
            siblings: vec![tip_b, merkle_pair(tip_c, tip_c)],
        },
        Who::Author,
        70,
    );
    f.claim(
        ClaimProof {
            beneficiary: f.source.pubkey(),
            role: 1,
            share_bps: 1800,
            siblings: vec![tip_a, merkle_pair(tip_c, tip_c)],
        },
        Who::Source,
        18,
    );
    f.claim(
        ClaimProof {
            beneficiary: f.attacker.pubkey(),
            role: 1,
            share_bps: 1200,
            siblings: vec![tip_c, merkle_pair(tip_a, tip_b)],
        },
        Who::Attacker,
        12,
    );
    assert_eq!(
        [
            f.balance(f.author_destination),
            f.balance(f.source_destination),
            f.balance(f.attacker_destination)
        ],
        [70, 18, 12]
    );
    // SALE independently uses 80/18/2 rather than the TIP vector70/18/12.
    let mut content: Content = f.read(f.content);
    content.mode = 1;
    content.price = 100;
    content.price_mint = f.mint;
    put(&mut f.vm, f.content, &content);
    f.new_epoch(1);
    let receipt = pda(&[b"access", f.content.as_ref(), f.buyer.pubkey().as_ref()]);
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::Purchase {
                buyer: f.buyer.pubkey(),
                economic: f.economic(),
                receipt,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::PurchaseAccess {}.data(),
        },
        &[Who::Buyer],
    );
    let wrong_tip = ClaimProof {
        beneficiary: f.author.pubkey(),
        role: 0,
        share_bps: 7000,
        siblings: vec![tip_b, merkle_pair(tip_c, tip_c)],
    };
    f.rejects(
        f.claim_ix(wrong_tip, Who::Author, 1),
        &[Who::Author],
        ProtocolError::InvalidMerkleProof,
    );
    f.claim(
        ClaimProof {
            beneficiary: f.author.pubkey(),
            role: 0,
            share_bps: 8000,
            siblings: vec![sale_b, merkle_pair(sale_c, sale_c)],
        },
        Who::Author,
        80,
    );
    f.claim(
        ClaimProof {
            beneficiary: f.source.pubkey(),
            role: 1,
            share_bps: 1800,
            siblings: vec![sale_a, merkle_pair(sale_c, sale_c)],
        },
        Who::Source,
        18,
    );
    f.claim(
        ClaimProof {
            beneficiary: f.attacker.pubkey(),
            role: 1,
            share_bps: 200,
            siblings: vec![sale_c, merkle_pair(sale_a, sale_b)],
        },
        Who::Attacker,
        2,
    );
    assert_eq!(
        [
            f.balance(f.author_destination),
            f.balance(f.source_destination),
            f.balance(f.attacker_destination)
        ],
        [150, 36, 14]
    );
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn derivative_after_safeguard_starts_both_recipient_exits_at_finalization() {
    let mut f = Fixture::new();
    f.open_case();
    f.at(8 * DAY);
    f.tip(10_000);
    f.derivative(7000);
    assert_eq!(f.read::<AssetPolicy>(f.asset).earned_fees, 0);
    f.at(10 * DAY - 1);
    f.rejects(
        f.claim_ix(f.proof(), Who::Source, 1),
        &[Who::Source],
        ProtocolError::ExitCooldownActive,
    );
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::ExitCooldownActive,
    );
    assert_eq!(f.read::<AssetPolicy>(f.asset).earned_fees, 0);
    assert_eq!(f.balance(f.vault), 10_000);
    f.at(10 * DAY);
    f.claim(f.proof(), Who::Source, 6650);
    // The candidate submits their first proof at72h; their48h deadline stays fixed.
    f.at(11 * DAY);
    f.claim(f.proof(), Who::Author, 2850);
    let source: ClaimPosition = f.read(f.position_key(&f.proof(), Who::Source));
    let author: ClaimPosition = f.read(f.position_key(&f.proof(), Who::Author));
    assert_eq!(source.exit_requested_at, START + 8 * DAY);
    assert_eq!(author.exit_requested_at, START + 8 * DAY);
    assert_eq!(f.read::<AssetPolicy>(f.asset).earned_fees, 500);
    assert_eq!(f.balance(f.source_destination), 6650);
    assert_eq!(f.balance(f.author_destination), 2850);
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn compromised_attestation_cannot_materialize_fees_from_other_epoch_principal() {
    let mut f = Fixture::new();
    f.tip(10_000);
    let untouched = f.epoch;
    let nonce = [46; 32];
    let node = pda(&[
        b"node",
        f.content.as_ref(),
        f.attacker.pubkey().as_ref(),
        &nonce,
    ]);
    let origin = payout_leaf(node, 0, 0, f.author.pubkey(), 10000);
    let attacker = payout_leaf(node, 0, 1, f.attacker.pubkey(), 10000);
    let args = RepostArgs {
        nonce,
        tip_root: merkle_pair(origin, attacker),
        sale_root: merkle_pair(origin, attacker),
        tip_child_bps: 0,
        sale_child_bps: 0,
        tip_residual_bps: 10000,
        sale_residual_bps: 10000,
        provenance_commitment: [16; 32],
    };
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::RepostNode {
                creator: f.attacker.pubkey(),
                config: f.config,
                rights: f.rights.pubkey(),
                content: f.content,
                node,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateRepostNode { args }.data(),
        },
        &[Who::Attacker, Who::Rights],
    );
    f.node = node;
    f.new_epoch(0);
    f.tip(10_000);
    f.claim(
        ClaimProof {
            beneficiary: f.author.pubkey(),
            role: 0,
            share_bps: 10000,
            siblings: vec![attacker],
        },
        Who::Author,
        10_000,
    );
    f.open_case();
    f.derivative(7000);
    let bad = ClaimProof {
        beneficiary: f.attacker.pubkey(),
        role: 1,
        share_bps: 10000,
        siblings: vec![origin],
    };
    // Even an exit/sweep path, which would materialize the fee before a CPI, must
    // fail on the fee cap and roll back. No unbacked fee becomes withdrawable.
    f.rejects(
        f.exit_ix(bad, Who::Attacker, 1),
        &[Who::Attacker],
        ProtocolError::PrincipalProtected,
    );
    assert_eq!(f.read::<AssetPolicy>(f.asset).earned_fees, 0);
    assert_eq!(f.read::<RevenueEpoch>(f.epoch).fees, 0);
    assert_eq!(f.read::<RevenueEpoch>(untouched).paid, 0);
    assert_eq!(f.balance(f.vault), 10_000);
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn initialization_requires_real_programdata_and_upgrade_authority() {
    let mut f = Fixture::new();
    let loader: Pubkey = "BPFLoaderUpgradeab1e11111111111111111111111"
        .parse()
        .unwrap();
    let programdata = Pubkey::find_program_address(&[protocol::ID.as_ref()], &loader).0;
    // Canonical upgradeable-loader bincode metadata: ProgramData variant3,
    // slot u64, Some(authority) option tag, authority32; code follows at byte45.
    let mut data = 3u32.to_le_bytes().to_vec();
    data.extend_from_slice(&0u64.to_le_bytes());
    data.push(1);
    data.extend_from_slice(f.admin.pubkey().as_ref());
    assert_eq!(data.len(), 45);
    let executable = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/deploy/content_rights_protocol.so");
    let executable = std::env::var_os("PROVENA_PROGRAM_SO")
        .map(std::path::PathBuf::from)
        .unwrap_or(executable);
    data.extend_from_slice(&std::fs::read(executable).unwrap());
    let pd = Account {
        lamports: 1_000_000_000,
        data,
        owner: loader,
        executable: false,
        rent_epoch: 0,
    };
    f.vm.set_account(programdata, pd.clone()).unwrap();
    let mut program_data = 2u32.to_le_bytes().to_vec();
    program_data.extend_from_slice(programdata.as_ref());
    f.vm.set_account(
        protocol::ID,
        Account {
            lamports: 100_000_000,
            data: program_data,
            owner: loader,
            executable: true,
            rent_epoch: 0,
        },
    )
    .unwrap();
    f.vm.set_account(
        f.config,
        Account {
            lamports: 0,
            data: vec![],
            owner: system_program::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let initialize = |f: &Fixture, admin: Who, provided: Pubkey| Instruction {
        program_id: protocol::ID,
        accounts: accounts::Initialize {
            admin: f.key(admin),
            config: f.config,
            program: protocol::ID,
            program_data: provided,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitializeProtocol {
            originality: f.originality.pubkey(),
            rights: f.rights.pubkey(),
            treasury: f.admin.pubkey(),
        }
        .data(),
    };
    f.rejects(
        initialize(&f, Who::Attacker, programdata),
        &[Who::Attacker],
        ProtocolError::Unauthorized,
    );
    let substituted = Pubkey::new_unique();
    f.vm.set_account(substituted, pd).unwrap();
    f.rejects(
        initialize(&f, Who::Admin, substituted),
        &[Who::Admin],
        ProtocolError::Unauthorized,
    );
    f.succeeds(initialize(&f, Who::Admin, programdata), &[Who::Admin]);
    let config: ProtocolConfig = f.read(f.config);
    assert_eq!(config.admin, f.admin.pubkey());
    assert_eq!(config.originality_authority, f.originality.pubkey());
    assert_eq!(config.rights_authority, f.rights.pubkey());
}

#[test]
#[ignore = "requires compiled SBF program"]
fn plain_spl_and_token2022_assets_require_admin_and_reject_freeze_authority() {
    let mut f = Fixture::new();
    for token_program in [spl_token::ID, anchor_spl::token_2022::ID] {
        let mint = Pubkey::new_unique();
        put_mint(&mut f.vm, mint);
        let mut mint_account = f.vm.get_account(&mint).unwrap();
        mint_account.owner = token_program;
        f.vm.set_account(mint, mint_account).unwrap();
        let asset = pda(&[b"asset", mint.as_ref()]);
        let vault = pda(&[b"vault", asset.as_ref()]);
        let add = |f: &Fixture, admin: Who| Instruction {
            program_id: protocol::ID,
            accounts: accounts::AddAsset {
                admin: f.key(admin),
                config: f.config,
                asset,
                mint,
                vault,
                token_program,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::AddAssetPolicy {}.data(),
        };
        f.rejects(
            add(&f, Who::Attacker),
            &[Who::Attacker],
            ProtocolError::Unauthorized,
        );
        f.succeeds(add(&f, Who::Admin), &[Who::Admin]);
        let policy: AssetPolicy = f.read(asset);
        assert_eq!(policy.mint, mint);
        assert_eq!(policy.token_program, token_program);
        assert!(policy.enabled && policy.safeguard_enabled && !policy.future_strategy_enabled);
        let vault_account = f.vm.get_account(&vault).unwrap();
        assert_eq!(vault_account.owner, token_program);
        let vault_state = TokenState::unpack(&vault_account.data).unwrap();
        assert_eq!(vault_state.owner, asset);
        assert_eq!(vault_state.amount, 0);
        let frozen_mint = Pubkey::new_unique();
        put_mint(&mut f.vm, frozen_mint);
        let mut mint_account = f.vm.get_account(&frozen_mint).unwrap();
        mint_account.owner = token_program;
        let mut state = MintState::unpack(&mint_account.data).unwrap();
        state.freeze_authority = COption::Some(f.attacker.pubkey());
        MintState::pack(state, &mut mint_account.data).unwrap();
        f.vm.set_account(frozen_mint, mint_account).unwrap();
        let frozen_asset = pda(&[b"asset", frozen_mint.as_ref()]);
        f.rejects(
            Instruction {
                program_id: protocol::ID,
                accounts: accounts::AddAsset {
                    admin: f.admin.pubkey(),
                    config: f.config,
                    asset: frozen_asset,
                    mint: frozen_mint,
                    vault: pda(&[b"vault", frozen_asset.as_ref()]),
                    token_program,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
                data: instruction::AddAssetPolicy {}.data(),
            },
            &[Who::Admin],
            ProtocolError::UnsupportedAsset,
        );
        assert!(f.vm.get_account(&frozen_asset).is_none());
    }
}

#[test]
#[ignore = "requires compiled SBF program"]
fn derivative_changes_origin_but_actual_downstream_payouts_remain() {
    let mut f = Fixture::new();
    let b_nonce = [48; 32];
    let b = pda(&[
        b"node",
        f.content.as_ref(),
        f.source.pubkey().as_ref(),
        &b_nonce,
    ]);
    let b_args = RepostArgs {
        nonce: b_nonce,
        tip_root: merkle_pair(
            payout_leaf(b, 0, 0, f.author.pubkey(), 7000),
            payout_leaf(b, 0, 1, f.source.pubkey(), 3000),
        ),
        sale_root: merkle_pair(
            payout_leaf(b, 1, 0, f.author.pubkey(), 8000),
            payout_leaf(b, 1, 1, f.source.pubkey(), 2000),
        ),
        tip_child_bps: 4000,
        sale_child_bps: 1000,
        tip_residual_bps: 3000,
        sale_residual_bps: 2000,
        provenance_commitment: [17; 32],
    };
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::RepostNode {
                creator: f.source.pubkey(),
                config: f.config,
                rights: f.rights.pubkey(),
                content: f.content,
                node: b,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateRepostNode { args: b_args }.data(),
        },
        &[Who::Source, Who::Rights],
    );
    let nonce = [47; 32];
    let c = pda(&[
        b"node",
        f.content.as_ref(),
        f.attacker.pubkey().as_ref(),
        &nonce,
    ]);
    let a_leaf = payout_leaf(c, 0, 0, f.author.pubkey(), 7000);
    let b_leaf = payout_leaf(c, 0, 1, f.source.pubkey(), 1800);
    let c_leaf = payout_leaf(c, 0, 1, f.attacker.pubkey(), 1200);
    let root = merkle_pair(merkle_pair(a_leaf, b_leaf), merkle_pair(c_leaf, c_leaf));
    let args = RepostArgs {
        nonce,
        tip_root: root,
        sale_root: root,
        tip_child_bps: 0,
        sale_child_bps: 0,
        tip_residual_bps: 1200,
        sale_residual_bps: 1200,
        provenance_commitment: [18; 32],
    };
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::RepostNode {
                creator: f.attacker.pubkey(),
                config: f.config,
                rights: f.rights.pubkey(),
                content: f.content,
                node: c,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateRepostNode { args }.data(),
        },
        &[Who::Attacker, Who::Rights],
    );
    f.node = c;
    f.new_epoch(0);
    f.tip(10_000);
    f.open_case();
    f.derivative(7000);
    let origin = ClaimProof {
        beneficiary: f.author.pubkey(),
        role: 0,
        share_bps: 7000,
        siblings: vec![b_leaf, merkle_pair(c_leaf, c_leaf)],
    };
    let b_proof = ClaimProof {
        beneficiary: f.source.pubkey(),
        role: 1,
        share_bps: 1800,
        siblings: vec![a_leaf, merkle_pair(c_leaf, c_leaf)],
    };
    let c_proof = ClaimProof {
        beneficiary: f.attacker.pubkey(),
        role: 1,
        share_bps: 1200,
        siblings: vec![c_leaf, merkle_pair(a_leaf, b_leaf)],
    };
    f.claim(origin.clone(), Who::Author, 1995);
    f.claim(origin, Who::Source, 4655);
    f.claim(b_proof, Who::Source, 1710);
    f.claim(c_proof, Who::Attacker, 1140);
    assert_eq!(f.read::<DistributionNode>(c).tip_payout_root, root);
    assert_eq!(f.balance(f.author_destination), 1995);
    assert_eq!(f.balance(f.source_destination), 6365);
    assert_eq!(f.balance(f.attacker_destination), 1140);
    assert_eq!(f.read::<AssetPolicy>(f.asset).earned_fees, 500);
    assert_eq!(f.read::<AssetPolicy>(f.asset).user_liability, 0);
    f.solvency();
}

fn emitted<T: anchor_lang::Event>(logs: &[String]) -> T {
    use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine};
    for log in logs {
        if let Some(encoded) = log.strip_prefix("Program data: ") {
            let bytes = STANDARD.decode(encoded).expect("valid Anchor base64 event");
            if bytes.starts_with(T::DISCRIMINATOR) {
                return T::deserialize(&mut &bytes[T::DISCRIMINATOR.len()..])
                    .expect("valid Anchor event body");
            }
        }
    }
    panic!("missing event {} in {logs:?}", std::any::type_name::<T>());
}

#[test]
#[ignore = "requires compiled SBF program"]
fn license_source_requires_both_creators_and_rights_then_locks_20_80_roots() {
    let mut f = Fixture::new();
    let raw = [105; 32];
    let canonical = [106; 32];
    let target = pda(&[b"content", f.author.pubkey().as_ref(), &raw]);
    let args = SubmitArgs {
        raw_hash: raw,
        canonical_hash: canonical,
        canonicalization_version: 1,
        metadata_commitment: [5; 32],
        storage_commitment: [6; 32],
        citation_manifest_commitment: [0; 32],
        mode: 0,
        quote_policy: 0,
        price: 0,
        price_mint: Pubkey::default(),
    };
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::Submit {
                author: f.author.pubkey(),
                originality: f.originality.pubkey(),
                config: f.config,
                content: target,
                fingerprint: pda(&[b"fingerprint", &canonical]),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::SubmitContent { args }.data(),
        },
        &[Who::Author, Who::Originality],
    );
    let license = |f: &Fixture, source_author: Who, rights: Who| Instruction {
        program_id: protocol::ID,
        accounts: accounts::LicenseSource {
            config: f.config,
            rights: f.key(rights),
            author: f.author.pubkey(),
            content: target,
            source_content: f.reference,
            source_author: f.key(source_author),
        }
        .to_account_metas(None),
        data: instruction::LicenseSource { source_bps: 2000 }.data(),
    };
    f.rejects(
        license(&f, Who::Attacker, Who::Rights),
        &[Who::Author, Who::Attacker, Who::Rights],
        ProtocolError::Unauthorized,
    );
    f.rejects(
        license(&f, Who::Source, Who::Attacker),
        &[Who::Author, Who::Source, Who::Attacker],
        ProtocolError::Unauthorized,
    );
    // A matching source address without its signature cannot authorize a license.
    let mut unsigned = license(&f, Who::Source, Who::Rights);
    unsigned
        .accounts
        .iter_mut()
        .find(|meta| meta.pubkey == f.source.pubkey())
        .unwrap()
        .is_signer = false;
    let failure = f
        .send(unsigned, &[Who::Author, Who::Rights])
        .expect_err("source consent required");
    assert!(
        failure.contains("Custom(3010)"),
        "expected Anchor AccountNotSigner: {failure}"
    );
    assert_eq!(f.read::<Content>(target).licensed_source_bps, 0);
    f.succeeds(
        license(&f, Who::Source, Who::Rights),
        &[Who::Author, Who::Source, Who::Rights],
    );
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::Approve {
                config: f.config,
                originality: f.originality.pubkey(),
                content: target,
            }
            .to_account_metas(None),
            data: instruction::ApproveOriginal {}.data(),
        },
        &[Who::Originality],
    );
    let node = pda(&[b"original", target.as_ref()]);
    f.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::OriginalNode {
                author: f.author.pubkey(),
                content: target,
                node,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateOriginalNode {
                tip_child_bps: 3000,
                sale_child_bps: 1000,
            }
            .data(),
        },
        &[Who::Author],
    );
    let tip_origin = payout_leaf(node, 0, 0, f.author.pubkey(), 8000);
    let tip_source = payout_leaf(node, 0, 2, f.source.pubkey(), 2000);
    let locked: DistributionNode = f.read(node);
    assert_eq!(locked.tip_payout_root, merkle_pair(tip_origin, tip_source));
    assert_eq!(
        locked.sale_payout_root,
        merkle_pair(
            payout_leaf(node, 1, 0, f.author.pubkey(), 8000),
            payout_leaf(node, 1, 2, f.source.pubkey(), 2000)
        )
    );
    assert_eq!(locked.tip_residual_bps, 8000);
    assert_eq!(locked.sale_residual_bps, 8000);
    f.rejects(
        license(&f, Who::Source, Who::Rights),
        &[Who::Author, Who::Source, Who::Rights],
        ProtocolError::InvalidAccount,
    );
    assert_eq!(
        f.read::<DistributionNode>(node).tip_payout_root,
        locked.tip_payout_root
    );
    f.content = target;
    f.node = node;
    f.new_epoch(0);
    f.tip(100);
    f.claim(
        ClaimProof {
            beneficiary: f.author.pubkey(),
            role: 0,
            share_bps: 8000,
            siblings: vec![tip_source],
        },
        Who::Author,
        80,
    );
    f.claim(
        ClaimProof {
            beneficiary: f.source.pubkey(),
            role: 2,
            share_bps: 2000,
            siblings: vec![tip_origin],
        },
        Who::Source,
        20,
    );
    assert_eq!(f.balance(f.author_destination), 80);
    assert_eq!(f.balance(f.source_destination), 20);
    f.solvency();
}

#[test]
#[ignore = "requires compiled SBF program"]
fn materialized_safeguard_exit_and_case_clock_guard_boundaries_and_emit_events() {
    let mut f = Fixture::new();
    f.tip(1000);
    let sweep = |f: &Fixture| Instruction {
        program_id: protocol::ID,
        accounts: f
            .claim_accounts(&f.proof(), Who::Author)
            .to_account_metas(None),
        data: instruction::SweepExpiredClaimWindow { proof: f.proof() }.data(),
    };
    f.at(7 * DAY - 1);
    f.rejects(sweep(&f), &[Who::Author], ProtocolError::ClaimWindowExpired);
    f.at(7 * DAY);
    let logs = f.send(sweep(&f), &[Who::Author]).unwrap();
    let event: RevenueEnteredSafeguard = emitted(&logs);
    assert_eq!(event.epoch, f.epoch);
    let logs = f
        .send(f.exit_ix(f.proof(), Who::Author, 1000), &[Who::Author])
        .unwrap();
    let request: SafeguardExitRequested = emitted(&logs);
    assert_eq!(request.position, f.position_key(&f.proof(), Who::Author));
    assert_eq!(request.amount, 1000);
    assert_eq!(request.requested_at, START + 7 * DAY);
    let finalize = |f: &Fixture| Instruction {
        program_id: protocol::ID,
        accounts: f
            .claim_accounts(&f.proof(), Who::Author)
            .to_account_metas(None),
        data: instruction::FinalizeExit { proof: f.proof() }.data(),
    };
    f.at(9 * DAY - 1);
    f.rejects(
        finalize(&f),
        &[Who::Author],
        ProtocolError::ExitCooldownActive,
    );
    f.at(9 * DAY);
    let logs = f.send(finalize(&f), &[Who::Author]).unwrap();
    let ready: SafeguardExitClaimable = emitted(&logs);
    assert_eq!(ready.position, request.position);
    assert_eq!(ready.ready_at, START + 9 * DAY);
    assert_eq!(f.balance(f.vault), 1000);
    assert_eq!(f.balance(f.author_destination), 0);
    assert_eq!(
        f.read::<ClaimPosition>(request.position).exit_requested_at,
        START + 7 * DAY
    );
    f.claim(f.proof(), Who::Author, 1000);
    f.rejects(finalize(&f), &[Who::Author], ProtocolError::ExitNotReady);
    f.solvency();
    let mut g = Fixture::new();
    g.open_case();
    let transition = |g: &Fixture| Instruction {
        program_id: protocol::ID,
        accounts: accounts::CaseClock {
            case: g.review.unwrap(),
        }
        .to_account_metas(None),
        data: instruction::TransitionDisputeToSafeguard {}.data(),
    };
    g.at(7 * DAY - 1);
    g.rejects(transition(&g), &[], ProtocolError::CutoffNotReached);
    g.at(7 * DAY);
    let logs = g.send(transition(&g), &[]).unwrap();
    // This case-only transition has no financial epoch to emit; validate the
    // persisted case state and successful instruction log rather than inventing an event.
    assert!(logs
        .iter()
        .any(|log| log.contains("Instruction: TransitionDisputeToSafeguard")));
    let case: SimilarityCase = g.read(g.review.unwrap());
    assert_eq!(case.status, 3);
    assert_eq!(case.cutoff, START + 7 * DAY);
    g.independent();
    g.rejects(transition(&g), &[], ProtocolError::CaseAlreadyResolved);
}

impl Fixture {
    /// Admit a plain Token-2022 mint through the actual program instruction, then
    /// reuse the same economic fixture with that mint's real Token-2022 vault.
    fn approve_token2022(&mut self) {
        let mint = Pubkey::new_unique();
        put_mint(&mut self.vm, mint);
        let mut mint_account = self.vm.get_account(&mint).unwrap();
        mint_account.owner = anchor_spl::token_2022::ID;
        self.vm.set_account(mint, mint_account).unwrap();
        let asset = pda(&[b"asset", mint.as_ref()]);
        let vault = pda(&[b"vault", asset.as_ref()]);
        self.succeeds(
            Instruction {
                program_id: protocol::ID,
                accounts: accounts::AddAsset {
                    admin: self.admin.pubkey(),
                    config: self.config,
                    asset,
                    mint,
                    vault,
                    token_program: anchor_spl::token_2022::ID,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
                data: instruction::AddAssetPolicy {}.data(),
            },
            &[Who::Admin],
        );
        self.mint = mint;
        self.asset = asset;
        self.vault = vault;
        self.token_program = anchor_spl::token_2022::ID;
        self.funding = Pubkey::new_unique();
        self.author_destination = Pubkey::new_unique();
        self.source_destination = Pubkey::new_unique();
        self.attacker_destination = Pubkey::new_unique();
        self.treasury_destination = Pubkey::new_unique();
        for (key, owner, amount) in [
            (self.funding, self.buyer.pubkey(), 1_000_000),
            (self.author_destination, self.author.pubkey(), 0),
            (self.source_destination, self.source.pubkey(), 0),
            (self.attacker_destination, self.attacker.pubkey(), 0),
            (self.treasury_destination, self.admin.pubkey(), 0),
        ] {
            put_token(&mut self.vm, key, mint, owner, amount);
            let mut account = self.vm.get_account(&key).unwrap();
            account.owner = self.token_program;
            self.vm.set_account(key, account).unwrap();
        }
        self.new_epoch(0);
    }
}

#[test]
#[ignore = "requires compiled SBF program"]
fn r2_zero_income_early_resolution_inherits_cutoff_and_completed_cycle_rotates() {
    for (label, holding, derivative) in [
        ("holding-independent", true, false),
        ("holding-derivative", true, true),
        ("no-income-independent", false, false),
        ("no-income-derivative", false, true),
    ] {
        let mut f = Fixture::new();
        f.open_case();
        let cutoff = f.read::<SimilarityCase>(f.review.unwrap()).cutoff;
        assert_eq!(cutoff, START + 7 * DAY);
        if holding {
            f.at(DAY);
            f.tip(1000);
            assert_eq!(f.read::<RevenueEpoch>(f.epoch).deadline, cutoff);
        }
        let holding_epoch = f.epoch;
        f.at(3 * DAY);
        if derivative {
            f.derivative(7000);
        } else {
            f.independent();
        }
        f.new_epoch(0);
        f.tip(100);
        let new_deadline = f.read::<RevenueEpoch>(f.epoch).deadline;
        println!(
            "R2 {label}: cutoff={cutoff}, new_deadline={new_deadline}, content_deadline={}",
            f.read::<Content>(f.content).normal_deadline
        );
        assert_eq!(
            new_deadline, cutoff,
            "R2 {label}: early resolution cannot reset the unfinished content cycle"
        );
        if holding {
            assert_eq!(f.read::<RevenueEpoch>(holding_epoch).deadline, cutoff);
        }
        f.claim(f.proof(), Who::Author, 1);
        f.at(4 * DAY);
        f.tip(100);
        assert_eq!(f.read::<RevenueEpoch>(f.epoch).deadline, cutoff);
        assert_eq!(f.read::<Content>(f.content).normal_deadline, cutoff);
        f.at(8 * DAY);
        f.rejects(f.tip_ix(1), &[Who::Buyer], ProtocolError::EpochClosed);
        f.new_epoch(0);
        f.tip(10);
        assert_eq!(
            f.read::<RevenueEpoch>(f.epoch).deadline,
            START + 15 * DAY,
            "completed cycle must permit a genuinely new seven-day cycle"
        );
        f.solvency();
    }
}

#[test]
#[ignore = "requires compiled SBF program"]
fn r2_early_resolution_cross_node_mint_tip_sale_preserves_content_cutoff() {
    for derivative in [false, true] {
        let mut f = Fixture::new();
        let legacy = (f.mint, f.asset, f.vault, f.epoch, f.funding);
        f.approve_token2022();
        let mut paid: Content = f.read(f.content);
        paid.mode = 1;
        paid.price = 100;
        paid.price_mint = f.mint;
        put(&mut f.vm, f.content, &paid);
        f.open_case();
        f.at(DAY);
        let mut holding = f.economic();
        holding.mint = legacy.0;
        holding.asset = legacy.1;
        holding.vault = legacy.2;
        holding.epoch = legacy.3;
        holding.source = legacy.4;
        holding.token_program = spl_token::ID;
        f.succeeds(
            Instruction {
                program_id: protocol::ID,
                accounts: holding.to_account_metas(None),
                data: instruction::Tip { amount: 100 }.data(),
            },
            &[Who::Buyer],
        );
        let cutoff = START + 7 * DAY;
        assert_eq!(f.read::<RevenueEpoch>(legacy.3).deadline, cutoff);
        f.at(3 * DAY);
        if derivative {
            f.derivative(7000);
        } else {
            f.independent();
        }
        let nonce = [49; 32];
        let node = pda(&[
            b"node",
            f.content.as_ref(),
            f.attacker.pubkey().as_ref(),
            &nonce,
        ]);
        let args = RepostArgs {
            nonce,
            tip_root: merkle_pair(
                payout_leaf(node, 0, 0, f.author.pubkey(), 7000),
                payout_leaf(node, 0, 1, f.attacker.pubkey(), 3000),
            ),
            sale_root: merkle_pair(
                payout_leaf(node, 1, 0, f.author.pubkey(), 8000),
                payout_leaf(node, 1, 1, f.attacker.pubkey(), 2000),
            ),
            tip_child_bps: 0,
            sale_child_bps: 0,
            tip_residual_bps: 3000,
            sale_residual_bps: 2000,
            provenance_commitment: [19; 32],
        };
        f.succeeds(
            Instruction {
                program_id: protocol::ID,
                accounts: accounts::RepostNode {
                    creator: f.attacker.pubkey(),
                    config: f.config,
                    rights: f.rights.pubkey(),
                    content: f.content,
                    node,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
                data: instruction::CreateRepostNode { args }.data(),
            },
            &[Who::Attacker, Who::Rights],
        );
        f.node = node;
        f.new_epoch(1);
        let receipt = pda(&[b"access", f.content.as_ref(), f.buyer.pubkey().as_ref()]);
        f.succeeds(
            Instruction {
                program_id: protocol::ID,
                accounts: accounts::Purchase {
                    buyer: f.buyer.pubkey(),
                    economic: f.economic(),
                    receipt,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
                data: instruction::PurchaseAccess {}.data(),
            },
            &[Who::Buyer],
        );
        let sale: RevenueEpoch = f.read(f.epoch);
        println!("R2 cross-node/mint/kind derivative={derivative}: SPL TIP cutoff={cutoff}, Token-2022 SALE deadline={}", sale.deadline);
        assert_eq!(
            sale.deadline, cutoff,
            "changing node, mint and revenue kind cannot reset an unfinished content cycle"
        );
        assert_eq!(f.balance(legacy.2), 100);
        assert_eq!(f.read::<AssetPolicy>(legacy.1).user_liability, 100);
        assert_eq!(f.balance(f.vault), 100);
        assert_eq!(sale.kind, 1);
        assert_eq!(f.read::<AccessReceipt>(receipt).content, f.content);
        f.solvency();
    }
}

impl Fixture {
    fn custody_snapshot(&self, extra: &[Pubkey]) -> Vec<(Pubkey, Option<Account>)> {
        let mut keys = vec![
            self.content,
            self.node,
            self.epoch,
            self.asset,
            self.mint,
            self.funding,
            self.vault,
            self.author_destination,
            self.source_destination,
            self.attacker_destination,
            self.treasury_destination,
        ];
        keys.extend_from_slice(extra);
        keys.into_iter()
            .map(|key| (key, self.vm.get_account(&key)))
            .collect()
    }
    fn assert_unchanged(&self, snapshot: &[(Pubkey, Option<Account>)]) {
        for (key, before) in snapshot {
            assert_eq!(
                &self.vm.get_account(key),
                before,
                "failed transaction changed financial account {key}"
            );
        }
    }
    fn assert_token2022_ledger(
        &self,
        gross: u64,
        paid: u64,
        fees: u64,
        liability: u64,
        earned: u64,
    ) {
        assert_eq!(self.token_program, anchor_spl::token_2022::ID);
        let epoch: RevenueEpoch = self.read(self.epoch);
        let asset: AssetPolicy = self.read(self.asset);
        assert_eq!((epoch.gross, epoch.paid, epoch.fees), (gross, paid, fees));
        assert_eq!(
            (asset.user_liability, asset.earned_fees),
            (liability, earned)
        );
        assert_eq!(asset.token_program, self.token_program);
        assert_eq!(
            self.vm.get_account(&self.vault).unwrap().owner,
            self.token_program
        );
        assert_eq!(self.balance(self.vault), liability + earned);
        assert!(epoch.paid + epoch.fees <= epoch.gross);
        let held: u128 = [
            self.funding,
            self.vault,
            self.author_destination,
            self.source_destination,
            self.attacker_destination,
            self.treasury_destination,
        ]
        .iter()
        .map(|key| u128::from(self.balance(*key)))
        .sum();
        assert_eq!(
            held, 1_000_000,
            "Token-2022 source/vault/all recipients must conserve minted base units"
        );
        self.solvency();
    }
    fn purchase_ix(&self) -> Instruction {
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::Purchase {
                buyer: self.buyer.pubkey(),
                economic: self.economic(),
                receipt: pda(&[
                    b"access",
                    self.content.as_ref(),
                    self.buyer.pubkey().as_ref(),
                ]),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::PurchaseAccess {}.data(),
        }
    }
    fn fee_withdraw_ix(&self, destination: Pubkey, amount: u64) -> Instruction {
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::WithdrawFees {
                admin: self.admin.pubkey(),
                config: self.config,
                asset: self.asset,
                mint: self.mint,
                vault: self.vault,
                destination,
                token_program: self.token_program,
            }
            .to_account_metas(None),
            data: instruction::WithdrawProtocolFees { amount }.data(),
        }
    }
}

fn checked_token2022_transfer(logs: &[String]) {
    let invocation = format!("Program {} invoke [2]", anchor_spl::token_2022::ID);
    assert!(
        logs.iter().any(|log| log.contains(&invocation)),
        "real Token-2022 CPI missing: {logs:?}"
    );
    assert!(
        logs.iter()
            .any(|log| log.contains("Instruction: TransferChecked")),
        "checked transfer CPI missing: {logs:?}"
    );
}

#[test]
#[ignore = "requires compiled SBF program"]
fn r4_token2022_tip_purchase_claim_transfer_checked_and_atomic_failures() {
    let mut f = Fixture::new();
    let legacy_destination = f.author_destination;
    f.approve_token2022();
    let absent_positions = [
        f.leaf_key(&f.proof()),
        f.position_key(&f.proof(), Who::Author),
    ];
    // The instruction writes its prospective deadline before invoking Token-2022.
    // Insufficient source tokens must roll back those writes and every balance.
    let before = f.custody_snapshot(&absent_positions);
    let failure = f
        .send(f.tip_ix(1_000_001), &[Who::Buyer])
        .expect_err("insufficient source funds must reject");
    assert!(
        failure.contains(&anchor_spl::token_2022::ID.to_string())
            && failure.contains("Instruction: TransferChecked")
    );
    f.assert_unchanged(&before);
    assert_eq!(f.read::<Content>(f.content).normal_deadline, 0);
    assert_eq!(f.read::<RevenueEpoch>(f.epoch).deadline, 0);
    f.assert_token2022_ledger(0, 0, 0, 0, 0);
    let logs = f.send(f.tip_ix(1000), &[Who::Buyer]).unwrap();
    checked_token2022_transfer(&logs);
    assert_eq!(f.balance(f.funding), 999_000);
    assert_eq!(f.balance(f.vault), 1000);
    f.assert_token2022_ledger(1000, 0, 0, 1000, 0);
    for (destination, token_program) in [
        (legacy_destination, f.token_program),
        (f.source_destination, f.token_program),
        (f.author_destination, spl_token::ID),
    ] {
        let before = f.custody_snapshot(&absent_positions);
        let mut accounts = f.claim_accounts(&f.proof(), Who::Author);
        accounts.destination = destination;
        accounts.token_program = token_program;
        assert!(f
            .send(
                Instruction {
                    program_id: protocol::ID,
                    accounts: accounts.to_account_metas(None),
                    data: instruction::ClaimLiquid {
                        proof: f.proof(),
                        amount: 1
                    }
                    .data()
                },
                &[Who::Author]
            )
            .is_err());
        f.assert_unchanged(&before);
    }
    let other_mint = Pubkey::new_unique();
    put_mint(&mut f.vm, other_mint);
    let mut mint_account = f.vm.get_account(&other_mint).unwrap();
    mint_account.owner = f.token_program;
    f.vm.set_account(other_mint, mint_account).unwrap();
    let before = f.custody_snapshot(&absent_positions);
    let mut wrong_mint = f.claim_accounts(&f.proof(), Who::Author);
    wrong_mint.mint = other_mint;
    assert!(f
        .send(
            Instruction {
                program_id: protocol::ID,
                accounts: wrong_mint.to_account_metas(None),
                data: instruction::ClaimLiquid {
                    proof: f.proof(),
                    amount: 1
                }
                .data()
            },
            &[Who::Author]
        )
        .is_err());
    f.assert_unchanged(&before);
    let logs = f
        .send(f.claim_ix(f.proof(), Who::Author, 400), &[Who::Author])
        .unwrap();
    checked_token2022_transfer(&logs);
    assert_eq!(f.balance(f.author_destination), 400);
    f.assert_token2022_ledger(1000, 400, 0, 600, 0);
    let before = f.custody_snapshot(&absent_positions);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 601),
        &[Who::Author],
        ProtocolError::PrincipalProtected,
    );
    f.assert_unchanged(&before);
    let logs = f
        .send(f.claim_ix(f.proof(), Who::Author, 600), &[Who::Author])
        .unwrap();
    checked_token2022_transfer(&logs);
    assert_eq!(f.balance(f.author_destination), 1000);
    f.assert_token2022_ledger(1000, 1000, 0, 0, 0);
    let before = f.custody_snapshot(&absent_positions);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::PrincipalProtected,
    );
    f.assert_unchanged(&before);

    // A distinct paid-content fixture starts with its approved price asset, so no
    // production price mutation is required to exercise the SALE path.
    let mut paid = Fixture::new();
    paid.approve_token2022();
    let mut content: Content = paid.read(paid.content);
    content.mode = 1;
    content.price = 100;
    content.price_mint = paid.mint;
    put(&mut paid.vm, paid.content, &content);
    paid.new_epoch(1);
    let receipt = pda(&[
        b"access",
        paid.content.as_ref(),
        paid.buyer.pubkey().as_ref(),
    ]);
    let logs = paid.send(paid.purchase_ix(), &[Who::Buyer]).unwrap();
    checked_token2022_transfer(&logs);
    let access: AccessReceipt = paid.read(receipt);
    assert_eq!(access.content, paid.content);
    assert_eq!(access.buyer, paid.buyer.pubkey());
    assert_eq!(access.mint, paid.mint);
    assert_eq!(paid.balance(paid.funding), 999_900);
    paid.assert_token2022_ledger(100, 0, 0, 100, 0);
    let logs = paid
        .send(
            paid.claim_ix(paid.proof(), Who::Author, 100),
            &[Who::Author],
        )
        .unwrap();
    checked_token2022_transfer(&logs);
    assert_eq!(paid.balance(paid.author_destination), 100);
    paid.assert_token2022_ledger(100, 100, 0, 0, 0);
    let before = paid.custody_snapshot(&[receipt]);
    assert!(paid.send(paid.purchase_ix(), &[Who::Buyer]).is_err());
    paid.assert_unchanged(&before);
    let nonce = [50; 32];
    let node = pda(&[
        b"node",
        paid.content.as_ref(),
        paid.attacker.pubkey().as_ref(),
        &nonce,
    ]);
    let args = RepostArgs {
        nonce,
        tip_root: merkle_pair(
            payout_leaf(node, 0, 0, paid.author.pubkey(), 7000),
            payout_leaf(node, 0, 1, paid.attacker.pubkey(), 3000),
        ),
        sale_root: merkle_pair(
            payout_leaf(node, 1, 0, paid.author.pubkey(), 8000),
            payout_leaf(node, 1, 1, paid.attacker.pubkey(), 2000),
        ),
        tip_child_bps: 0,
        sale_child_bps: 0,
        tip_residual_bps: 3000,
        sale_residual_bps: 2000,
        provenance_commitment: [20; 32],
    };
    paid.succeeds(
        Instruction {
            program_id: protocol::ID,
            accounts: accounts::RepostNode {
                creator: paid.attacker.pubkey(),
                config: paid.config,
                rights: paid.rights.pubkey(),
                content: paid.content,
                node,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateRepostNode { args }.data(),
        },
        &[Who::Attacker, Who::Rights],
    );
    paid.node = node;
    paid.new_epoch(1);
    let before = paid.custody_snapshot(&[receipt]);
    assert!(paid.send(paid.purchase_ix(), &[Who::Buyer]).is_err());
    paid.assert_unchanged(&before);
    assert_ne!(paid.read::<AccessReceipt>(receipt).purchase_node, paid.node);
    paid.assert_token2022_ledger(0, 0, 0, 0, 0);
}

#[test]
#[ignore = "requires compiled SBF program"]
fn r4_token2022_derivative_claims_and_earned_fee_withdrawals_conserve_liabilities() {
    let mut f = Fixture::new();
    f.approve_token2022();
    f.open_case();
    let logs = f.send(f.tip_ix(10_000), &[Who::Buyer]).unwrap();
    checked_token2022_transfer(&logs);
    f.assert_token2022_ledger(10_000, 0, 0, 10_000, 0);
    let proof_accounts = [
        f.leaf_key(&f.proof()),
        f.position_key(&f.proof(), Who::Author),
        f.position_key(&f.proof(), Who::Source),
    ];
    let before = f.custody_snapshot(&proof_accounts);
    f.rejects(
        f.fee_withdraw_ix(f.treasury_destination, 1),
        &[Who::Admin],
        ProtocolError::PrincipalProtected,
    );
    f.assert_unchanged(&before);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::DisputeStillActive,
    );
    f.assert_unchanged(&before);
    f.at(DAY);
    f.derivative(7000);
    let logs = f
        .send(f.claim_ix(f.proof(), Who::Source, 6650), &[Who::Source])
        .unwrap();
    checked_token2022_transfer(&logs);
    assert_eq!(f.balance(f.source_destination), 6650);
    f.assert_token2022_ledger(10_000, 6650, 500, 2850, 500);
    let logs = f
        .send(f.claim_ix(f.proof(), Who::Author, 2850), &[Who::Author])
        .unwrap();
    checked_token2022_transfer(&logs);
    assert_eq!(f.balance(f.author_destination), 2850);
    f.assert_token2022_ledger(10_000, 9500, 500, 0, 500);
    let before = f.custody_snapshot(&proof_accounts);
    f.rejects(
        f.claim_ix(f.proof(), Who::Source, 1),
        &[Who::Source],
        ProtocolError::PrincipalProtected,
    );
    f.assert_unchanged(&before);
    f.rejects(
        f.fee_withdraw_ix(f.treasury_destination, 501),
        &[Who::Admin],
        ProtocolError::PrincipalProtected,
    );
    f.assert_unchanged(&before);
    assert!(f
        .send(
            f.fee_withdraw_ix(f.attacker_destination, 500),
            &[Who::Admin]
        )
        .is_err());
    f.assert_unchanged(&before);
    let logs = f
        .send(
            f.fee_withdraw_ix(f.treasury_destination, 500),
            &[Who::Admin],
        )
        .unwrap();
    checked_token2022_transfer(&logs);
    assert_eq!(f.balance(f.treasury_destination), 500);
    f.assert_token2022_ledger(10_000, 9500, 500, 0, 0);
    let before = f.custody_snapshot(&proof_accounts);
    f.rejects(
        f.fee_withdraw_ix(f.treasury_destination, 1),
        &[Who::Admin],
        ProtocolError::PrincipalProtected,
    );
    f.assert_unchanged(&before);
}

#[test]
#[ignore = "requires compiled SBF program"]
fn r4_token2022_safeguard_partial_exit_checks_cooldown_balance_and_rollback() {
    let mut f = Fixture::new();
    f.approve_token2022();
    let logs = f.send(f.tip_ix(1000), &[Who::Buyer]).unwrap();
    checked_token2022_transfer(&logs);
    f.assert_token2022_ledger(1000, 0, 0, 1000, 0);
    f.at(8 * DAY);
    let proof_accounts = [
        f.leaf_key(&f.proof()),
        f.position_key(&f.proof(), Who::Author),
    ];
    let before = f.custody_snapshot(&proof_accounts);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::SafeguardExitRequired,
    );
    f.assert_unchanged(&before);
    f.rejects(
        f.exit_ix(f.proof(), Who::Author, 1001),
        &[Who::Author],
        ProtocolError::InsufficientBalance,
    );
    f.assert_unchanged(&before);
    f.succeeds(f.exit_ix(f.proof(), Who::Author, 400), &[Who::Author]);
    f.assert_token2022_ledger(1000, 0, 0, 1000, 0);
    let before = f.custody_snapshot(&proof_accounts);
    f.at(10 * DAY - 1);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::ExitCooldownActive,
    );
    f.assert_unchanged(&before);
    f.at(10 * DAY);
    let logs = f
        .send(f.claim_ix(f.proof(), Who::Author, 100), &[Who::Author])
        .unwrap();
    checked_token2022_transfer(&logs);
    f.assert_token2022_ledger(1000, 100, 0, 900, 0);
    let position: ClaimPosition = f.read(f.position_key(&f.proof(), Who::Author));
    assert_eq!(
        (position.exit_requested_at, position.exit_amount),
        (START + 8 * DAY, 300)
    );
    let before = f.custody_snapshot(&proof_accounts);
    f.rejects(
        f.exit_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::ExitAlreadyPending,
    );
    f.assert_unchanged(&before);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 301),
        &[Who::Author],
        ProtocolError::InsufficientBalance,
    );
    f.assert_unchanged(&before);
    let logs = f
        .send(f.claim_ix(f.proof(), Who::Author, 300), &[Who::Author])
        .unwrap();
    checked_token2022_transfer(&logs);
    f.assert_token2022_ledger(1000, 400, 0, 600, 0);
    f.succeeds(f.exit_ix(f.proof(), Who::Author, 600), &[Who::Author]);
    f.at(12 * DAY);
    let logs = f
        .send(f.claim_ix(f.proof(), Who::Author, 600), &[Who::Author])
        .unwrap();
    checked_token2022_transfer(&logs);
    assert_eq!(f.balance(f.author_destination), 1000);
    assert_eq!(f.balance(f.funding), 999_000);
    f.assert_token2022_ledger(1000, 1000, 0, 0, 0);
    let before = f.custody_snapshot(&proof_accounts);
    f.rejects(
        f.claim_ix(f.proof(), Who::Author, 1),
        &[Who::Author],
        ProtocolError::PrincipalProtected,
    );
    f.assert_unchanged(&before);
}
