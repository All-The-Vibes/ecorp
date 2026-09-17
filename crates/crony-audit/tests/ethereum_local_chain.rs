use revm::{
    Evm, InMemoryDB,
    primitives::{AccountInfo, Address, Bytes, ExecutionResult, Output, TxKind, U256, keccak256},
};
use serde_json::Value;
use sha2::{Digest, Sha256};

const ARTIFACT: &str = include_str!("../../../contracts/StateAuditAnchor.compiled.json");
const CONTRACT: &str = include_str!("../../../contracts/StateAuditAnchor.sol");
const VECTOR: &str = include_str!("../../../docs/state-audit-v1-vector.json");

fn address(byte: u8) -> Address {
    Address::from([byte; 20])
}

fn selector(signature: &str) -> [u8; 4] {
    keccak256(signature.as_bytes())[..4].try_into().unwrap()
}

fn word_address(value: Address) -> [u8; 32] {
    let mut word = [0; 32];
    word[12..].copy_from_slice(value.as_slice());
    word
}

fn word_bytes16(value: [u8; 16]) -> [u8; 32] {
    let mut word = [0; 32];
    word[..16].copy_from_slice(&value);
    word
}

fn word_u64(value: u64) -> [u8; 32] {
    let mut word = [0; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

fn call_data(signature: &str, words: &[[u8; 32]]) -> Bytes {
    let mut data = selector(signature).to_vec();
    for word in words {
        data.extend(word);
    }
    data.into()
}

fn protobuf_varint(mut value: usize) -> Vec<u8> {
    let mut encoded = Vec::new();
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        encoded.push(byte);
        if value == 0 {
            return encoded;
        }
    }
}

fn ipfs_unixfs_file_digest(bytes: &[u8]) -> [u8; 32] {
    let mut unixfs = vec![0x08, 0x02, 0x12];
    unixfs.extend(protobuf_varint(bytes.len()));
    unixfs.extend(bytes);
    unixfs.push(0x18);
    unixfs.extend(protobuf_varint(bytes.len()));
    let mut dag_pb = vec![0x0a];
    dag_pb.extend(protobuf_varint(unixfs.len()));
    dag_pb.extend(unixfs);
    Sha256::digest(dag_pb).into()
}

fn execute(
    evm: &mut Evm<'_, (), InMemoryDB>,
    caller: Address,
    target: Address,
    data: Bytes,
) -> ExecutionResult {
    let tx = &mut evm.context.evm.env.tx;
    tx.caller = caller;
    tx.transact_to = TxKind::Call(target);
    tx.data = data;
    tx.value = U256::ZERO;
    tx.gas_limit = 10_000_000;
    evm.transact_commit().unwrap()
}

fn assert_success(result: ExecutionResult) {
    assert!(
        matches!(result, ExecutionResult::Success { .. }),
        "expected EVM success, got {result:?}"
    );
}

fn assert_revert(result: ExecutionResult) {
    assert!(
        matches!(
            result,
            ExecutionResult::Revert { .. } | ExecutionResult::Halt { .. }
        ),
        "expected EVM rejection, got {result:?}"
    );
}

#[test]
fn v1_checkpoint_executes_against_local_anchor_contract() {
    let artifact: Value = serde_json::from_str(ARTIFACT).unwrap();
    assert!(
        artifact["compiler_version"]
            .as_str()
            .unwrap()
            .starts_with("0.8.30+")
    );
    let metadata_text = artifact["contract"]["metadata"].as_str().unwrap();
    let metadata: Value = serde_json::from_str(metadata_text).unwrap();
    assert_eq!(
        metadata["sources"]["StateAuditAnchor.sol"]["keccak256"],
        format!("0x{}", hex::encode(keccak256(CONTRACT.as_bytes())))
    );
    assert_eq!(metadata["settings"]["optimizer"]["enabled"], true);
    assert_eq!(metadata["settings"]["optimizer"]["runs"], 200);
    let init_code = hex::decode(
        artifact["contract"]["evm"]["bytecode"]["object"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let mut metadata_multihash = vec![0x12, 0x20];
    metadata_multihash.extend(ipfs_unixfs_file_digest(metadata_text.as_bytes()));
    assert!(
        init_code
            .windows(metadata_multihash.len())
            .any(|window| window == metadata_multihash),
        "compiled bytecode is not bound to the checked-in compiler metadata"
    );
    let init_code: Bytes = init_code.into();
    let vector: Value = serde_json::from_str(VECTOR).unwrap();
    let ledger: [u8; 16] = hex::decode(
        vector["checkpoint"]["ledger_id"]
            .as_str()
            .unwrap()
            .replace('-', ""),
    )
    .unwrap()
    .try_into()
    .unwrap();
    let checkpoint: [u8; 32] = hex::decode(vector["digest"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let checkpoint_three = [0x33; 32];
    let conflicting = [0x44; 32];
    let zero = [0; 32];

    let authority = address(0x11);
    let publisher = address(0x22);
    let rotated_publisher = address(0x33);
    let attacker = address(0x44);
    let mut evm = Evm::builder()
        .with_db(InMemoryDB::default())
        .modify_db(|db| {
            for account in [authority, publisher, rotated_publisher, attacker] {
                db.insert_account_info(
                    account,
                    AccountInfo {
                        balance: U256::MAX,
                        ..Default::default()
                    },
                );
            }
        })
        .modify_tx_env(|tx| {
            tx.caller = authority;
            tx.transact_to = TxKind::Create;
            tx.data = init_code;
            tx.gas_limit = 10_000_000;
            tx.gas_price = U256::ZERO;
        })
        .build();
    let deployed = evm.transact_commit().unwrap();
    let contract = match deployed {
        ExecutionResult::Success {
            output: Output::Create(_, Some(address)),
            ..
        } => address,
        other => panic!("contract deployment failed: {other:?}"),
    };

    let register = call_data(
        "registerLedger(bytes16,address)",
        &[word_bytes16(ledger), word_address(publisher)],
    );
    assert_success(execute(&mut evm, authority, contract, register.clone()));
    assert_revert(execute(&mut evm, authority, contract, register));
    assert_revert(execute(
        &mut evm,
        attacker,
        contract,
        call_data(
            "registerLedger(bytes16,address)",
            &[word_bytes16([0x55; 16]), word_address(attacker)],
        ),
    ));

    let first = call_data(
        "anchor(bytes16,uint64,bytes32,bytes32)",
        &[word_bytes16(ledger), word_u64(1), checkpoint, zero],
    );
    assert_revert(execute(&mut evm, attacker, contract, first.clone()));
    assert_success(execute(&mut evm, publisher, contract, first.clone()));
    assert_success(execute(&mut evm, publisher, contract, first));
    assert_revert(execute(
        &mut evm,
        publisher,
        contract,
        call_data(
            "anchor(bytes16,uint64,bytes32,bytes32)",
            &[word_bytes16(ledger), word_u64(1), conflicting, zero],
        ),
    ));
    assert_revert(execute(
        &mut evm,
        publisher,
        contract,
        call_data(
            "anchor(bytes16,uint64,bytes32,bytes32)",
            &[
                word_bytes16(ledger),
                word_u64(3),
                checkpoint_three,
                conflicting,
            ],
        ),
    ));
    assert_success(execute(
        &mut evm,
        publisher,
        contract,
        call_data(
            "anchor(bytes16,uint64,bytes32,bytes32)",
            &[
                word_bytes16(ledger),
                word_u64(3),
                checkpoint_three,
                checkpoint,
            ],
        ),
    ));
    assert_revert(execute(
        &mut evm,
        publisher,
        contract,
        call_data(
            "anchor(bytes16,uint64,bytes32,bytes32)",
            &[
                word_bytes16(ledger),
                word_u64(2),
                conflicting,
                checkpoint_three,
            ],
        ),
    ));

    let rotate = call_data(
        "rotatePublisher(bytes16,address)",
        &[word_bytes16(ledger), word_address(rotated_publisher)],
    );
    assert_revert(execute(&mut evm, attacker, contract, rotate.clone()));
    assert_success(execute(&mut evm, authority, contract, rotate));
    let fourth = call_data(
        "anchor(bytes16,uint64,bytes32,bytes32)",
        &[
            word_bytes16(ledger),
            word_u64(4),
            conflicting,
            checkpoint_three,
        ],
    );
    assert_revert(execute(&mut evm, publisher, contract, fourth.clone()));
    assert_success(execute(&mut evm, rotated_publisher, contract, fourth));
    assert_revert(execute(
        &mut evm,
        rotated_publisher,
        contract,
        call_data(
            "anchor(bytes16,uint64,bytes32,bytes32)",
            &[word_bytes16([0x77; 16]), word_u64(1), checkpoint, zero],
        ),
    ));
}
