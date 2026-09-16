//! Always-on local EVM execution; no RPC, wallet, or external node is required.
use crony_audit::{SignedCheckpoint, VerifyingKey};
use revm::{
    Evm, InMemoryDB,
    primitives::{
        AccountInfo, Address, Bytes, ExecutionResult, Output, SpecId, TxKind, U256, keccak256,
    },
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

type Word = [u8; 32];
const ZERO: Word = [0; 32];
const KEY: Word = [0x91; 32];
const MAX_SEQUENCE: u64 = i64::MAX as u64;

fn address(byte: u8) -> Address {
    Address::from([byte; 20])
}

fn number(n: u64) -> Word {
    let mut word = ZERO;
    word[24..].copy_from_slice(&n.to_be_bytes());
    word
}

fn account(a: Address) -> Word {
    let mut word = ZERO;
    word[12..].copy_from_slice(a.as_slice());
    word
}

fn calldata(signature: &str, words: &[Word]) -> Bytes {
    let mut bytes = keccak256(signature.as_bytes())[..4].to_vec();
    bytes.extend(words.iter().flatten());
    bytes.into()
}

fn stream_preimage(owner: Address, key: Word) -> Vec<u8> {
    let domain = b"ECORP_STATE_AUDIT_STREAM_V1";
    let mut encoded = Vec::from(number(96));
    encoded.extend(account(owner));
    encoded.extend(key);
    encoded.extend(number(domain.len() as u64));
    encoded.extend(domain);
    encoded.resize(160, 0);
    encoded
}

fn stream(owner: Address, key: Word) -> Word {
    keccak256(stream_preimage(owner, key)).into()
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn artifact() -> Value {
    serde_json::from_slice(
        &fs::read(
            root()
                .join("contracts")
                .join("ECorpCheckpointRegistryV1.compiled.json"),
        )
        .expect("build registry artifact with node tools/build_base_registry.mjs"),
    )
    .unwrap()
}

fn output(result: &ExecutionResult) -> Vec<u8> {
    match result {
        ExecutionResult::Success { output, .. } => output.data().to_vec(),
        other => panic!("expected EVM success: {other:?}"),
    }
}

fn succeeds(result: &ExecutionResult, logs: usize) {
    output(result);
    assert_eq!(result.logs().len(), logs, "{result:?}");
}

fn rejects(result: &ExecutionResult) {
    assert!(
        matches!(result, ExecutionResult::Revert { .. }),
        "{result:?}"
    );
    assert!(result.logs().is_empty());
}

struct Chain {
    evm: Evm<'static, (), InMemoryDB>,
    registry: Address,
}

impl Chain {
    fn new(chain_id: u64) -> Self {
        let a = artifact();
        let code =
            hex::decode(a["contract"]["evm"]["bytecode"]["object"].as_str().unwrap()).unwrap();
        let mut evm = Evm::builder()
            .with_db(InMemoryDB::default())
            .with_spec_id(SpecId::CANCUN)
            .modify_cfg_env(|cfg| cfg.chain_id = chain_id)
            .modify_db(|db| {
                for byte in 1..=8 {
                    db.insert_account_info(
                        address(byte),
                        AccountInfo {
                            balance: U256::MAX,
                            ..Default::default()
                        },
                    );
                }
            })
            .modify_tx_env(|tx| {
                tx.caller = address(1);
                tx.transact_to = TxKind::Create;
                tx.data = code.into();
                tx.gas_limit = 10_000_000;
                tx.gas_price = U256::ZERO;
                tx.chain_id = Some(chain_id);
            })
            .build();
        let registry = match evm.transact_commit().unwrap() {
            ExecutionResult::Success {
                output: Output::Create(runtime, Some(registry)),
                ..
            } => {
                assert_eq!(
                    format!("0x{}", hex::encode(keccak256(runtime))),
                    a["runtime_code_hash"].as_str().unwrap(),
                );
                registry
            }
            other => panic!("local deployment failed: {other:?}"),
        };
        Self { evm, registry }
    }

    fn call_value(
        &mut self,
        who: u8,
        signature: &str,
        words: &[Word],
        value: u64,
    ) -> ExecutionResult {
        let tx = &mut self.evm.context.evm.env.tx;
        tx.caller = address(who);
        tx.transact_to = TxKind::Call(self.registry);
        tx.data = calldata(signature, words);
        tx.value = U256::from(value);
        tx.gas_limit = 10_000_000;
        self.evm.transact_commit().unwrap()
    }

    fn call(&mut self, who: u8, signature: &str, words: &[Word]) -> ExecutionResult {
        self.call_value(who, signature, words, 0)
    }

    fn register(&mut self, owner: u8, publisher: u8, key: Word) -> Word {
        let result = self.call(
            owner,
            "register(bytes32,address)",
            &[key, account(address(publisher))],
        );
        succeeds(&result, 1);
        let id = stream(address(owner), key);
        assert_eq!(output(&result), id);
        let log = &result.logs()[0];
        assert_eq!(log.address, self.registry);
        assert_eq!(
            log.topics(),
            &[
                keccak256("Registered(bytes32,address,address)"),
                id.into(),
                account(address(owner)).into(),
            ]
        );
        assert_eq!(log.data.data.as_ref(), account(address(publisher)));
        id
    }

    fn head(&mut self, id: Word) -> Vec<Word> {
        output(&self.call(8, "head(bytes32)", &[id]))
            .as_chunks::<32>()
            .0
            .to_vec()
    }

    fn anchor(&mut self, who: u8, id: Word, seq: u64, digest: Word, prev: Word) -> ExecutionResult {
        self.call(
            who,
            "anchor(bytes32,uint64,bytes32,bytes32)",
            &[id, number(seq), digest, prev],
        )
    }

    fn check_anchor_event(
        &self,
        r: &ExecutionResult,
        request: (Word, u64, Word, Word),
        ordinal: u64,
        publisher: u8,
    ) {
        let (id, seq, digest, prev) = request;
        succeeds(r, 1);
        let log = &r.logs()[0];
        assert_eq!(log.address, self.registry);
        assert_eq!(
            log.topics(),
            &[
                keccak256("Anchored(bytes32,uint64,bytes32,bytes32,uint64,address)"),
                id.into(),
                number(seq).into(),
            ]
        );
        assert_eq!(
            log.data.data.as_ref(),
            [digest, prev, number(ordinal), account(address(publisher))].concat()
        );
    }
}

#[test]
fn pinned_artifact_matches_source_settings_and_runtime() {
    let a = artifact();
    let source = fs::read_to_string(
        root()
            .join("contracts")
            .join("ECorpCheckpointRegistryV1.sol"),
    )
    .unwrap()
    .replace("\r\n", "\n");
    assert_eq!(
        a["compiler_version"],
        "0.8.30+commit.73712a01.Emscripten.clang"
    );
    assert_eq!(a["source_sha256"], hex::encode(Sha256::digest(&source)));
    let m: Value = serde_json::from_str(a["contract"]["metadata"].as_str().unwrap()).unwrap();
    assert_eq!(
        m["sources"]["contracts/ECorpCheckpointRegistryV1.sol"]["keccak256"],
        format!("0x{}", hex::encode(keccak256(source.as_bytes())))
    );
    assert_eq!(m["settings"]["optimizer"]["enabled"], true);
    assert_eq!(m["settings"]["optimizer"]["runs"], 200);
    assert_eq!(m["settings"]["evmVersion"], "cancun");
    assert_eq!(m["settings"]["metadata"]["bytecodeHash"], "ipfs");
    let runtime = hex::decode(
        a["contract"]["evm"]["deployedBytecode"]["object"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        a["runtime_code_hash"],
        format!("0x{}", hex::encode(keccak256(&runtime)))
    );
    let abi = a["contract"]["abi"].as_array().unwrap();
    let head = abi.iter().find(|entry| entry["name"] == "head").unwrap();
    let fields: Vec<_> = head["outputs"][0]["components"]
        .as_array()
        .unwrap()
        .iter()
        .map(|field| {
            (
                field["name"].as_str().unwrap(),
                field["type"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        fields,
        vec![
            ("registered", "bool"),
            ("owner", "address"),
            ("pendingOwner", "address"),
            ("publisher", "address"),
            ("paused", "bool"),
            ("lastSequence", "uint64"),
            ("lastDigest", "bytes32"),
            ("previousAnchorDigest", "bytes32"),
            ("anchorOrdinal", "uint64")
        ]
    );
    for entry in abi.iter().filter(|entry| entry["type"] == "function") {
        assert_ne!(entry["stateMutability"], "payable");
    }
    let functions: Vec<_> = abi
        .iter()
        .filter(|entry| entry["type"] == "function")
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        functions,
        [
            "acceptOwner",
            "anchor",
            "head",
            "proposeOwner",
            "register",
            "setPaused",
            "setPublisher",
            "version"
        ]
    );
    // Skip the trailing CBOR metadata and PUSH immediates when inspecting opcodes.
    let metadata_len =
        u16::from_be_bytes(runtime[runtime.len() - 2..].try_into().unwrap()) as usize;
    let executable_len = runtime.len() - metadata_len - 2;
    let mut pc = 0;
    while pc < executable_len {
        let opcode = runtime[pc];
        assert!(
            ![0xf0, 0xf1, 0xf2, 0xf4, 0xf5, 0xfa, 0xff].contains(&opcode),
            "creation/external-call/destruction opcode {opcode:#x} at {pc}"
        );
        pc += 1;
        if (0x60..=0x7f).contains(&opcode) {
            pc += usize::from(opcode - 0x5f);
        }
    }
}

#[test]
fn administrative_events_match_current_head_and_zero_cannot_accept() {
    let mut c = Chain::new(8453);
    let id = c.register(1, 2, KEY);
    succeeds(&c.anchor(2, id, 1, [0x77; 32], ZERO), 1);
    let history = c.head(id)[5..].to_vec();
    for (who, sig, arg, event, data) in [
        (
            1,
            "setPublisher(bytes32,address)",
            Some(account(address(4))),
            "PublisherChanged(bytes32,address,address)",
            vec![account(address(2)), account(address(4))],
        ),
        (
            1,
            "setPaused(bytes32,bool)",
            Some(number(1)),
            "PauseChanged(bytes32,bool)",
            vec![number(1)],
        ),
        (
            1,
            "proposeOwner(bytes32,address)",
            Some(account(address(3))),
            "OwnerTransferProposed(bytes32,address,address)",
            vec![account(address(1)), account(address(3))],
        ),
        (
            1,
            "proposeOwner(bytes32,address)",
            Some(ZERO),
            "OwnerTransferProposed(bytes32,address,address)",
            vec![account(address(1)), ZERO],
        ),
        (
            1,
            "proposeOwner(bytes32,address)",
            Some(account(address(5))),
            "OwnerTransferProposed(bytes32,address,address)",
            vec![account(address(1)), account(address(5))],
        ),
        (
            5,
            "acceptOwner(bytes32)",
            None,
            "OwnerTransferred(bytes32,address,address)",
            vec![account(address(1)), account(address(5))],
        ),
    ] {
        let mut words = vec![id];
        words.extend(arg);
        let r = c.call(who, sig, &words);
        succeeds(&r, 1);
        let log = &r.logs()[0];
        assert_eq!(log.address, c.registry);
        assert_eq!(log.topics(), &[keccak256(event), id.into()]);
        assert_eq!(log.data.data.as_ref(), data.concat());
        assert_eq!(&c.head(id)[5..], history);
    }
    let before = c.head(id);
    let tx = &mut c.evm.context.evm.env.tx;
    tx.caller = Address::ZERO;
    tx.data = calldata("acceptOwner(bytes32)", &[id]);
    rejects(&c.evm.transact_commit().unwrap());
    assert_eq!(c.head(id), before);
}

#[test]
fn frozen_cross_language_abi_stream_and_head_vector_executes() {
    let vector: Value = serde_json::from_str(include_str!(
        "../../../contracts/ECorpCheckpointRegistryV1.vector.json"
    ))
    .unwrap();
    let bytes = |field: &str| {
        hex::decode(vector[field].as_str().unwrap().strip_prefix("0x").unwrap()).unwrap()
    };
    let id: Word = bytes("stream_id").try_into().unwrap();
    let digest: Word = bytes("checkpoint_digest").try_into().unwrap();
    assert_eq!(vector["schema_version"], 1);
    assert_eq!(vector["chain_ids"], serde_json::json!([8453, 84532]));
    assert_eq!(vector["sequence"], 1);
    assert_eq!(bytes("registering_owner"), address(1).as_slice());
    assert_eq!(bytes("publisher"), address(2).as_slice());
    assert_eq!(bytes("other_owner"), address(3).as_slice());
    assert_eq!(bytes("local_stream_key"), KEY);
    assert_eq!(bytes("previous_anchor_digest"), ZERO);
    assert_eq!(bytes("stream_preimage"), stream_preimage(address(1), KEY));
    assert_eq!(id, stream(address(1), KEY));
    assert_eq!(bytes("other_owner_stream_id"), stream(address(3), KEY));
    let v1: Value =
        serde_json::from_str(include_str!("../../../docs/state-audit-v1-vector.json")).unwrap();
    assert_eq!(hex::encode(digest), v1["digest"].as_str().unwrap());
    assert_eq!(
        bytes("register_calldata"),
        calldata("register(bytes32,address)", &[KEY, account(address(2))])
    );
    assert_eq!(
        bytes("anchor_calldata"),
        calldata(
            "anchor(bytes32,uint64,bytes32,bytes32)",
            &[id, number(1), digest, ZERO]
        )
    );
    assert_eq!(bytes("head_calldata"), calldata("head(bytes32)", &[id]));
    assert_eq!(bytes("version_calldata"), calldata("version()", &[]));
    for chain_id in [8453, 84532] {
        let mut c = Chain::new(chain_id);
        assert_eq!(
            bytes("version_return"),
            output(&c.call(1, "version()", &[]))
        );
        assert_eq!(c.register(1, 2, KEY), id);
        let result = c.anchor(2, id, 1, digest, ZERO);
        succeeds(&result, 1);
        let event = &result.logs()[0];
        let topics: Vec<_> = event
            .topics()
            .iter()
            .map(|topic| format!("0x{}", hex::encode(topic)))
            .collect();
        assert_eq!(
            serde_json::to_value(topics).unwrap(),
            vector["anchored_event_topics"]
        );
        assert_eq!(event.data.data.as_ref(), bytes("anchored_event_data"));
        assert_eq!(
            output(&c.call(1, "head(bytes32)", &[id])),
            bytes("head_after_genesis")
        );
    }
}

#[test]
fn frozen_v1_bytes_signature_and_digest_anchor_unchanged_on_both_base_ids() {
    let vector: Value =
        serde_json::from_str(include_str!("../../../docs/state-audit-v1-vector.json")).unwrap();
    let signed = SignedCheckpoint {
        checkpoint: serde_json::from_value(vector["checkpoint"].clone()).unwrap(),
        payload: hex::decode(vector["payload_hex"].as_str().unwrap()).unwrap(),
        signature: hex::decode(vector["signature_hex"].as_str().unwrap()).unwrap(),
        digest: vector["digest"].as_str().unwrap().to_owned(),
    };
    let public: [u8; 32] = hex::decode(vector["public_key_hex"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    signed
        .verify(
            &VerifyingKey::from_bytes(&public).unwrap(),
            Some(&signed.digest),
        )
        .unwrap();
    assert_eq!(signed.checkpoint.bytes().unwrap(), signed.payload);
    let digest: Word = hex::decode(&signed.digest).unwrap().try_into().unwrap();
    assert_ne!(digest, <Word>::from(keccak256(digest)));
    for chain_id in [8453, 84532] {
        let mut chain = Chain::new(chain_id);
        assert_eq!(output(&chain.call(1, "version()", &[])), number(1));
        let id = chain.register(1, 2, KEY);
        let data = calldata(
            "anchor(bytes32,uint64,bytes32,bytes32)",
            &[id, number(1), digest, ZERO],
        );
        assert_eq!(&data[68..100], digest);
        let r = chain.anchor(2, id, 1, digest, ZERO);
        chain.check_anchor_event(&r, (id, 1, digest, ZERO), 1, 2);
        assert_eq!(
            chain.head(id),
            vec![
                number(1),
                account(address(1)),
                ZERO,
                account(address(2)),
                ZERO,
                number(1),
                digest,
                ZERO,
                number(1)
            ]
        );
    }
}

#[test]
fn registration_namespace_and_initial_configuration_retry_are_immutable() {
    let mut c = Chain::new(8453);
    rejects(&c.call(1, "register(bytes32,address)", &[KEY, ZERO]));
    let a = c.register(1, 2, KEY);
    let b = c.register(3, 4, KEY);
    assert_ne!(a, b);
    assert_eq!(c.head(a)[1], account(address(1)));
    assert_eq!(c.head(b)[1], account(address(3)));
    succeeds(
        &c.call(1, "register(bytes32,address)", &[KEY, account(address(2))]),
        0,
    );
    rejects(&c.call(1, "register(bytes32,address)", &[KEY, account(address(4))]));
    succeeds(
        &c.call(
            1,
            "setPublisher(bytes32,address)",
            &[a, account(address(4))],
        ),
        1,
    );
    succeeds(&c.call(1, "setPaused(bytes32,bool)", &[a, number(1)]), 1);
    let before = c.head(a);
    succeeds(
        &c.call(1, "register(bytes32,address)", &[KEY, account(address(2))]),
        0,
    );
    rejects(&c.call(1, "register(bytes32,address)", &[KEY, account(address(4))]));
    assert_eq!(c.head(a), before);
    succeeds(
        &c.call(
            1,
            "proposeOwner(bytes32,address)",
            &[a, account(address(5))],
        ),
        1,
    );
    succeeds(&c.call(5, "acceptOwner(bytes32)", &[a]), 1);
    let transferred = c.head(a);
    succeeds(
        &c.call(1, "register(bytes32,address)", &[KEY, account(address(2))]),
        0,
    );
    assert_eq!(c.head(a), transferred);
    assert_eq!(c.head(ZERO), vec![ZERO; 9]);
}

#[test]
fn genesis_skips_replay_conflicts_and_signed64_boundaries() {
    let mut c = Chain::new(84532);
    let id = c.register(1, 2, KEY);
    let first = [0x31; 32];
    rejects(&c.anchor(2, ZERO, 1, first, ZERO));
    for (seq, digest, prev) in [
        (0, first, ZERO),
        (1, ZERO, ZERO),
        (1, first, first),
        (MAX_SEQUENCE + 1, first, ZERO),
        (u64::MAX, first, ZERO),
    ] {
        rejects(&c.anchor(2, id, seq, digest, prev));
    }
    let r = c.anchor(2, id, 7, first, ZERO);
    c.check_anchor_event(&r, (id, 7, first, ZERO), 1, 2);
    let head = c.head(id);
    succeeds(&c.anchor(2, id, 7, first, ZERO), 0);
    assert_eq!(c.head(id), head);
    for (seq, digest, prev) in [
        (7, [1; 32], ZERO),
        (7, first, first),
        (6, first, ZERO),
        (8, [2; 32], ZERO),
    ] {
        rejects(&c.anchor(2, id, seq, digest, prev));
        assert_eq!(c.head(id), head);
    }
    let last = [0x32; 32];
    let r = c.anchor(2, id, MAX_SEQUENCE, last, first);
    c.check_anchor_event(&r, (id, MAX_SEQUENCE, last, first), 2, 2);
    succeeds(&c.anchor(2, id, MAX_SEQUENCE, last, first), 0);
    rejects(&c.anchor(2, id, 7, first, ZERO));
    rejects(&c.anchor(2, id, MAX_SEQUENCE + 1, first, last));
    assert_eq!(
        &c.head(id)[5..],
        &[number(MAX_SEQUENCE), last, first, number(2)]
    );
}

#[test]
fn authorization_pause_rotation_and_two_step_owner_preserve_history() {
    let mut c = Chain::new(8453);
    let id = c.register(1, 2, KEY);
    let digest = [0x44; 32];
    for who in [1, 3, 4, 8] {
        rejects(&c.anchor(who, id, 1, digest, ZERO));
    }
    succeeds(&c.anchor(2, id, 1, digest, ZERO), 1);
    let history = c.head(id)[5..].to_vec();
    for who in [2, 3, 8] {
        for (sig, arg) in [
            ("setPublisher(bytes32,address)", account(address(4))),
            ("setPaused(bytes32,bool)", number(1)),
            ("proposeOwner(bytes32,address)", account(address(4))),
        ] {
            rejects(&c.call(who, sig, &[id, arg]));
        }
        rejects(&c.call(who, "acceptOwner(bytes32)", &[id]));
    }
    for (sig, arg) in [
        ("setPublisher(bytes32,address)", account(address(4))),
        ("setPaused(bytes32,bool)", number(1)),
        ("proposeOwner(bytes32,address)", account(address(4))),
    ] {
        rejects(&c.call(1, sig, &[ZERO, arg]));
    }
    rejects(&c.call(1, "acceptOwner(bytes32)", &[ZERO]));
    rejects(&c.call(1, "setPublisher(bytes32,address)", &[id, ZERO]));
    succeeds(&c.call(1, "setPaused(bytes32,bool)", &[id, number(1)]), 1);
    rejects(&c.anchor(2, id, 1, digest, ZERO));
    rejects(&c.anchor(2, id, 2, [2; 32], digest));
    succeeds(
        &c.call(
            1,
            "setPublisher(bytes32,address)",
            &[id, account(address(4))],
        ),
        1,
    );
    succeeds(&c.call(1, "setPaused(bytes32,bool)", &[id, ZERO]), 1);
    rejects(&c.anchor(2, id, 1, digest, ZERO));
    succeeds(&c.anchor(4, id, 1, digest, ZERO), 0);
    succeeds(
        &c.call(
            1,
            "proposeOwner(bytes32,address)",
            &[id, account(address(3))],
        ),
        1,
    );
    succeeds(
        &c.call(
            1,
            "proposeOwner(bytes32,address)",
            &[id, account(address(5))],
        ),
        1,
    );
    rejects(&c.call(3, "acceptOwner(bytes32)", &[id]));
    succeeds(&c.call(1, "proposeOwner(bytes32,address)", &[id, ZERO]), 1);
    rejects(&c.call(5, "acceptOwner(bytes32)", &[id]));
    assert_eq!(c.head(id)[2], ZERO);
    succeeds(
        &c.call(
            1,
            "proposeOwner(bytes32,address)",
            &[id, account(address(5))],
        ),
        1,
    );
    succeeds(&c.call(5, "acceptOwner(bytes32)", &[id]), 1);
    rejects(&c.call(5, "acceptOwner(bytes32)", &[id]));
    rejects(&c.call(1, "setPaused(bytes32,bool)", &[id, number(1)]));
    assert_eq!(&c.head(id)[5..], history);
    assert_eq!(
        &c.head(id)[1..4],
        &[account(address(5)), ZERO, account(address(4))]
    );
    succeeds(
        &c.call(
            5,
            "setPublisher(bytes32,address)",
            &[id, account(address(6))],
        ),
        1,
    );
    let r = c.anchor(6, id, 100, [0x55; 32], digest);
    c.check_anchor_event(&r, (id, 100, [0x55; 32], digest), 2, 6);
}

#[test]
fn every_entrypoint_is_nonpayable_and_unknown_calls_revert() {
    let mut c = Chain::new(8453);
    let id = c.register(1, 2, KEY);
    for (who, sig, words) in [
        (
            1,
            "register(bytes32,address)",
            vec![KEY, account(address(2))],
        ),
        (
            2,
            "anchor(bytes32,uint64,bytes32,bytes32)",
            vec![id, number(1), [1; 32], ZERO],
        ),
        (1, "head(bytes32)", vec![id]),
        (1, "version()", vec![]),
        (
            1,
            "setPublisher(bytes32,address)",
            vec![id, account(address(3))],
        ),
        (1, "setPaused(bytes32,bool)", vec![id, number(1)]),
        (
            1,
            "proposeOwner(bytes32,address)",
            vec![id, account(address(3))],
        ),
        (3, "acceptOwner(bytes32)", vec![id]),
    ] {
        rejects(&c.call_value(who, sig, &words, 1));
    }
    rejects(&c.call(1, "upgradeTo(address)", &[account(address(3))]));
    let tx = &mut c.evm.context.evm.env.tx;
    tx.data = Bytes::new();
    tx.value = U256::from(1);
    rejects(&c.evm.transact_commit().unwrap());
    assert_eq!(c.head(id)[5..], [ZERO; 4]);
}

#[test]
fn seeded_state_machine_properties_hold_for_adversarial_sequences() {
    // Fixed seeds make failures reproducible without a fuzz-runner dependency.
    for seed in 1_u64..=12 {
        let mut random = seed;
        let mut c = Chain::new(if seed % 2 == 0 { 8453 } else { 84532 });
        let id = c.register(1, 2, KEY);
        let mut owner = 1;
        let mut publisher = 2;
        let mut paused = false;
        let mut sequence = 0;
        let mut digest = ZERO;
        let mut previous = ZERO;
        let mut ordinal = 0;
        for _ in 0..96 {
            random = random
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let before = c.head(id);
            match random % 7 {
                0 => {
                    let next = sequence + 1 + (random >> 8) % 1000;
                    let hash: Word = keccak256(random.to_be_bytes()).into();
                    let r = c.anchor(publisher, id, next, hash, digest);
                    if paused {
                        rejects(&r);
                    } else {
                        ordinal += 1;
                        c.check_anchor_event(&r, (id, next, hash, digest), ordinal, publisher);
                        previous = digest;
                        digest = hash;
                        sequence = next;
                    }
                }
                1 => {
                    rejects(&c.anchor(8, id, sequence + 1, [0x81; 32], digest));
                    assert_eq!(c.head(id), before);
                }
                2 => {
                    paused = !paused;
                    succeeds(
                        &c.call(
                            owner,
                            "setPaused(bytes32,bool)",
                            &[id, number(u64::from(paused))],
                        ),
                        1,
                    );
                }
                3 => {
                    publisher = if publisher == 2 { 4 } else { 2 };
                    succeeds(
                        &c.call(
                            owner,
                            "setPublisher(bytes32,address)",
                            &[id, account(address(publisher))],
                        ),
                        1,
                    );
                }
                4 => {
                    let next = if owner == 1 { 3 } else { 1 };
                    succeeds(
                        &c.call(
                            owner,
                            "proposeOwner(bytes32,address)",
                            &[id, account(address(next))],
                        ),
                        1,
                    );
                    succeeds(&c.call(next, "acceptOwner(bytes32)", &[id]), 1);
                    owner = next;
                }
                5 if sequence > 0 => {
                    let r = c.anchor(publisher, id, sequence, digest, previous);
                    if paused {
                        rejects(&r);
                    } else {
                        succeeds(&r, 0);
                    }
                    assert_eq!(c.head(id), before);
                }
                _ => {
                    rejects(&c.anchor(publisher, id, sequence, [0xfe; 32], digest));
                    assert_eq!(c.head(id), before);
                }
            }
            let head = c.head(id);
            assert_eq!(
                head,
                vec![
                    number(1),
                    account(address(owner)),
                    ZERO,
                    account(address(publisher)),
                    number(u64::from(paused)),
                    number(sequence),
                    digest,
                    previous,
                    number(ordinal)
                ]
            );
            assert!(head[5] >= before[5]);
        }
    }
}

#[test]
fn gas_benchmark_registration_genesis_and_later_anchor() {
    let mut c = Chain::new(8453);
    let r = c.call(1, "register(bytes32,address)", &[KEY, account(address(2))]);
    succeeds(&r, 1);
    let id = stream(address(1), KEY);
    let first = c.anchor(2, id, 1, [1; 32], ZERO);
    let later = c.anchor(2, id, 100, [2; 32], [1; 32]);
    let replay = c.anchor(2, id, 100, [2; 32], [1; 32]);
    succeeds(&first, 1);
    succeeds(&later, 1);
    succeeds(&replay, 0);
    println!(
        "BASE_REGISTRY_GAS register={} first_anchor={} later_anchor={} exact_replay={} (local Cancun execution incl intrinsic gas; excludes Base L1/operator fees)",
        r.gas_used(),
        first.gas_used(),
        later.gas_used(),
        replay.gas_used()
    );
    assert!(r.gas_used() < 200_000);
    assert!(first.gas_used() < 150_000);
    assert!(later.gas_used() < 120_000);
    assert!(replay.gas_used() < 60_000);
}
