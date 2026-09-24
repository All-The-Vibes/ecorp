use alloy::sol_types::{SolCall, SolEvent, SolValue};
use crony_base::{
    Address, B256, Bytes, U256,
    abi::{AnchorCall, ECorpCheckpointRegistryV1 as Registry, stream_id},
};

#[test]
fn generated_alloy_bindings_match_independently_executed_registry_vector() {
    let vector: serde_json::Value = serde_json::from_str(include_str!(
        "../../../contracts/ECorpCheckpointRegistryV1.vector.json"
    ))
    .unwrap();
    let bytes = |field: &str| vector[field].as_str().unwrap().parse::<Bytes>().unwrap();
    let owner: Address = serde_json::from_value(vector["registering_owner"].clone()).unwrap();
    let other_owner: Address = serde_json::from_value(vector["other_owner"].clone()).unwrap();
    let publisher: Address = serde_json::from_value(vector["publisher"].clone()).unwrap();
    let local_key: B256 = serde_json::from_value(vector["local_stream_key"].clone()).unwrap();
    let stream: B256 = serde_json::from_value(vector["stream_id"].clone()).unwrap();
    let digest: B256 = serde_json::from_value(vector["checkpoint_digest"].clone()).unwrap();
    let previous: B256 = serde_json::from_value(vector["previous_anchor_digest"].clone()).unwrap();
    let sequence = vector["sequence"].as_u64().unwrap();
    assert_eq!(
        ("ECORP_STATE_AUDIT_STREAM_V1", owner, local_key).abi_encode_params(),
        bytes("stream_preimage").as_ref()
    );
    assert_eq!(stream_id(owner, local_key), stream);
    assert_eq!(
        stream_id(other_owner, local_key),
        serde_json::from_value::<B256>(vector["other_owner_stream_id"].clone()).unwrap()
    );
    assert_eq!(
        Registry::registerCall {
            localStreamKey: local_key,
            publisher,
        }
        .abi_encode(),
        bytes("register_calldata").as_ref()
    );
    assert_eq!(
        AnchorCall {
            stream_id: stream,
            sequence,
            checkpoint_digest: digest,
            previous_anchor_digest: previous,
        }
        .calldata()
        .unwrap(),
        bytes("anchor_calldata")
    );
    assert_eq!(
        Registry::headCall { streamId: stream }.abi_encode(),
        bytes("head_calldata").as_ref()
    );
    assert_eq!(
        Registry::versionCall {}.abi_encode(),
        bytes("version_calldata").as_ref()
    );
    assert_eq!(U256::from(1).abi_encode(), bytes("version_return").as_ref());
    let event = Registry::Anchored {
        streamId: stream,
        sequence,
        checkpointDigest: digest,
        previousAnchorDigest: previous,
        anchorOrdinal: 1,
        publisher,
    }
    .encode_log_data();
    assert_eq!(
        event.topics(),
        serde_json::from_value::<Vec<B256>>(vector["anchored_event_topics"].clone()).unwrap()
    );
    assert_eq!(event.data, bytes("anchored_event_data"));
    assert_eq!(
        Registry::Head {
            registered: true,
            owner,
            pendingOwner: Address::ZERO,
            publisher,
            paused: false,
            lastSequence: sequence,
            lastDigest: digest,
            previousAnchorDigest: previous,
            anchorOrdinal: 1,
        }
        .abi_encode(),
        bytes("head_after_genesis").as_ref()
    );
    let v1: serde_json::Value =
        serde_json::from_str(include_str!("../../../docs/state-audit-v1-vector.json")).unwrap();
    assert_eq!(hex::encode(digest), v1["digest"].as_str().unwrap());
}
