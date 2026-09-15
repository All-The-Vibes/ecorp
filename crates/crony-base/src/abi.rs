use crate::{Address, B256, Bytes, Error, Result};
use alloy::sol_types::{SolCall, SolValue};

alloy::sol! {
    interface ECorpCheckpointRegistryV1 {
        struct Head {
            bool registered;
            address owner;
            address pendingOwner;
            address publisher;
            bool paused;
            uint64 lastSequence;
            bytes32 lastDigest;
            bytes32 previousAnchorDigest;
            uint64 anchorOrdinal;
        }
        function register(bytes32 localStreamKey, address publisher) external returns (bytes32 streamId);
        function anchor(bytes32 streamId, uint64 sequence, bytes32 checkpointDigest, bytes32 previousAnchorDigest) external;
        function head(bytes32 streamId) external view returns (Head);
        function version() external view returns (uint256);
        function setPublisher(bytes32 streamId, address publisher) external;
        function setPaused(bytes32 streamId, bool paused) external;
        function proposeOwner(bytes32 streamId, address newOwner) external;
        function acceptOwner(bytes32 streamId) external;
        event Registered(bytes32 indexed streamId, address indexed owner, address publisher);
        event Anchored(bytes32 indexed streamId, uint64 indexed sequence, bytes32 checkpointDigest, bytes32 previousAnchorDigest, uint64 anchorOrdinal, address publisher);
        event PublisherChanged(bytes32 indexed streamId, address previousPublisher, address newPublisher);
        event PauseChanged(bytes32 indexed streamId, bool paused);
        event OwnerTransferProposed(bytes32 indexed streamId, address previousOwner, address proposedOwner);
        event OwnerTransferred(bytes32 indexed streamId, address previousOwner, address newOwner);
    }
    interface GasPriceOracle {
        function getL1Fee(bytes data) external view returns (uint256);
    }
}

pub fn stream_id(owner: Address, local_stream_key: B256) -> B256 {
    alloy::primitives::keccak256(
        ("ECORP_STATE_AUDIT_STREAM_V1", owner, local_stream_key).abi_encode_params(),
    )
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AnchorCall {
    pub stream_id: B256,
    pub sequence: u64,
    pub checkpoint_digest: B256,
    pub previous_anchor_digest: B256,
}

impl AnchorCall {
    pub fn from_checkpoint(
        trust: &crate::manifest::ManifestTrust,
        checkpoint: &crony_audit::SignedCheckpoint,
        previous_anchor_digest: B256,
    ) -> Result<Self> {
        let manifest = &trust.current().manifest;
        manifest.verify_checkpoint(checkpoint)?;
        let digest: [u8; 32] = hex::decode(&checkpoint.digest)
            .map_err(|_| Error::Evidence("invalid V1 checkpoint digest"))?
            .try_into()
            .map_err(|_| Error::Evidence("invalid V1 checkpoint digest length"))?;
        let call = Self {
            stream_id: manifest.stream_id,
            sequence: checkpoint.checkpoint.last_sequence,
            checkpoint_digest: B256::from(digest),
            previous_anchor_digest,
        };
        call.validate()?;
        Ok(call)
    }
    pub fn validate(&self) -> Result<()> {
        if self.stream_id.is_zero()
            || self.sequence == 0
            || self.sequence > i64::MAX as u64
            || self.checkpoint_digest.is_zero()
        {
            return Err(Error::Evidence("invalid anchor tuple"));
        }
        Ok(())
    }
    pub fn calldata(&self) -> Result<Bytes> {
        self.validate()?;
        Ok(ECorpCheckpointRegistryV1::anchorCall {
            streamId: self.stream_id,
            sequence: self.sequence,
            checkpointDigest: self.checkpoint_digest,
            previousAnchorDigest: self.previous_anchor_digest,
        }
        .abi_encode()
        .into())
    }
}
