// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Immutable, owner-namespaced commitments to opaque V1 checkpoint digests.
contract ECorpCheckpointRegistryV1 {
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

    mapping(bytes32 => Head) private heads;
    // Registration retries refer to enrollment, not mutable current administration.
    mapping(bytes32 => address) private initialPublishers;

    error UnknownStream();
    error Unauthorized();
    error ZeroPublisher();
    error RegistrationConflict();
    error StreamPaused();
    error InvalidAnchor();
    error AnchorConflict();

    event Registered(bytes32 indexed streamId, address indexed owner, address publisher);
    event Anchored(
        bytes32 indexed streamId,
        uint64 indexed sequence,
        bytes32 checkpointDigest,
        bytes32 previousAnchorDigest,
        uint64 anchorOrdinal,
        address publisher
    );
    event PublisherChanged(bytes32 indexed streamId, address previousPublisher, address newPublisher);
    event PauseChanged(bytes32 indexed streamId, bool paused);
    event OwnerTransferProposed(bytes32 indexed streamId, address previousOwner, address proposedOwner);
    event OwnerTransferred(bytes32 indexed streamId, address previousOwner, address newOwner);

    function version() external pure returns (uint256) {
        return 1;
    }

    function register(bytes32 localStreamKey, address publisher) external returns (bytes32 streamId) {
        if (publisher == address(0)) revert ZeroPublisher();
        streamId = keccak256(abi.encode("ECORP_STATE_AUDIT_STREAM_V1", msg.sender, localStreamKey));
        Head storage h = heads[streamId];
        if (h.registered) {
            if (initialPublishers[streamId] != publisher) revert RegistrationConflict();
            return streamId;
        }
        h.registered = true;
        h.owner = msg.sender;
        h.publisher = publisher;
        initialPublishers[streamId] = publisher;
        emit Registered(streamId, msg.sender, publisher);
    }

    function anchor(
        bytes32 streamId,
        uint64 sequence,
        bytes32 checkpointDigest,
        bytes32 previousAnchorDigest
    ) external {
        Head storage h = heads[streamId];
        if (!h.registered) revert UnknownStream();
        if (msg.sender != h.publisher) revert Unauthorized();
        if (h.paused) revert StreamPaused();
        if (checkpointDigest == bytes32(0) || sequence == 0 || sequence > uint64(type(int64).max)) {
            revert InvalidAnchor();
        }
        // Replay is authorized against the current publisher and pause state too.
        if (
            sequence == h.lastSequence && checkpointDigest == h.lastDigest
                && previousAnchorDigest == h.previousAnchorDigest
        ) return;
        if (sequence <= h.lastSequence || previousAnchorDigest != h.lastDigest) {
            revert AnchorConflict();
        }
        h.lastSequence = sequence;
        h.lastDigest = checkpointDigest;
        h.previousAnchorDigest = previousAnchorDigest;
        ++h.anchorOrdinal;
        emit Anchored(streamId, sequence, checkpointDigest, previousAnchorDigest, h.anchorOrdinal, msg.sender);
    }

    function head(bytes32 streamId) external view returns (Head memory) {
        return heads[streamId];
    }

    function setPublisher(bytes32 streamId, address publisher) external {
        Head storage h = ownedHead(streamId);
        if (publisher == address(0)) revert ZeroPublisher();
        address previousPublisher = h.publisher;
        h.publisher = publisher;
        emit PublisherChanged(streamId, previousPublisher, publisher);
    }

    function setPaused(bytes32 streamId, bool paused) external {
        Head storage h = ownedHead(streamId);
        h.paused = paused;
        emit PauseChanged(streamId, paused);
    }

    /// @notice A zero proposal explicitly cancels any pending transfer.
    function proposeOwner(bytes32 streamId, address newOwner) external {
        Head storage h = ownedHead(streamId);
        h.pendingOwner = newOwner;
        emit OwnerTransferProposed(streamId, h.owner, newOwner);
    }

    function acceptOwner(bytes32 streamId) external {
        Head storage h = heads[streamId];
        if (!h.registered) revert UnknownStream();
        if (h.pendingOwner == address(0) || msg.sender != h.pendingOwner) revert Unauthorized();
        address previousOwner = h.owner;
        h.owner = msg.sender;
        h.pendingOwner = address(0);
        emit OwnerTransferred(streamId, previousOwner, msg.sender);
    }

    function ownedHead(bytes32 streamId) private view returns (Head storage h) {
        h = heads[streamId];
        if (!h.registered) revert UnknownStream();
        if (msg.sender != h.owner) revert Unauthorized();
    }
}
