use alloy::consensus::Header;
use crony_base::{
    B256,
    ancestry::{AncestryBinding, AncestrySegment, AncestryState, sealed_header},
    rpc::SealedHeader,
};

fn chain(count: u64) -> Vec<Header> {
    let mut headers = Vec::new();
    let mut parent = B256::ZERO;
    for number in 0..count {
        let header = Header {
            number,
            timestamp: number + 100,
            parent_hash: parent,
            ..Header::default()
        };
        parent = header.hash_slow();
        headers.push(header);
    }
    headers
}

#[test]
fn more_than_8192_headers_resume_from_serialized_segments_without_height_only_inference() {
    let headers = chain(9002);
    let binding = AncestryBinding {
        manifest_digest: B256::repeat_byte(1),
        chain_id: 84532,
        transaction_hash: B256::repeat_byte(2),
        provider_identity: "independent-fixture".into(),
        included: sealed_header(&headers[1]),
        finalized: sealed_header(headers.last().unwrap()),
        observed_at: chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
    };
    let mut state = None;
    for chunk in headers[1..]
        .iter()
        .rev()
        .cloned()
        .collect::<Vec<_>>()
        .chunks(512)
    {
        let segment = AncestrySegment {
            binding: binding.clone(),
            headers: chunk.to_vec(),
        };
        let next = AncestryState::apply_segment(state.as_ref(), &segment).unwrap();
        state = Some(
            serde_json::from_slice::<AncestryState>(&serde_json::to_vec(&next).unwrap()).unwrap(),
        );
    }
    let state = state.unwrap();
    assert!(state.complete);
    assert_eq!(state.header_count, 9001);
    assert_eq!(state.segments, 18);
    assert_ne!(state.commitment, B256::ZERO);
    let mut forged = headers.last().unwrap().clone();
    forged.parent_hash = headers[1].hash_slow();
    assert!(
        AncestryState::apply_segment(
            None,
            &AncestrySegment {
                binding: binding.clone(),
                headers: vec![forged]
            }
        )
        .is_err()
    );
    assert!(
        AncestryState::apply_segment(
            None,
            &AncestrySegment {
                binding,
                headers: vec![headers[1].clone()]
            }
        )
        .is_err()
    );
}

#[test]
fn segment_cannot_skip_reorder_mutate_or_change_its_bound_destination() {
    let headers = chain(5);
    let binding = AncestryBinding {
        manifest_digest: B256::repeat_byte(1),
        chain_id: 84532,
        transaction_hash: B256::repeat_byte(2),
        provider_identity: "fixture".into(),
        included: sealed_header(&headers[1]),
        finalized: sealed_header(&headers[4]),
        observed_at: chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
    };
    let first = AncestrySegment {
        binding: binding.clone(),
        headers: vec![headers[4].clone(), headers[3].clone()],
    };
    let state = AncestryState::apply_segment(None, &first).unwrap();
    assert!(!state.complete);
    assert!(AncestryState::apply_segment(Some(&state), &first).is_err());
    let mut wrong = AncestrySegment {
        binding,
        headers: vec![headers[2].clone(), headers[1].clone()],
    };
    wrong.binding.included = SealedHeader {
        hash: B256::repeat_byte(9),
        ..wrong.binding.included
    };
    assert!(AncestryState::apply_segment(Some(&state), &wrong).is_err());
}
