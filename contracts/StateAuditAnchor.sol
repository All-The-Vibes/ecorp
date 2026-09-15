// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

contract StateAuditAnchor {
    struct Ledger {
        address owner;
        address publisher;
        uint64 sequence;
        bytes32 checkpointDigest;
        bytes32 previousAnchorDigest;
    }

    address public immutable registrationAuthority;
    mapping(bytes16 => Ledger) public ledgers;

    event LedgerRegistered(bytes16 indexed ledgerId, address indexed owner, address publisher);
    event PublisherRotated(bytes16 indexed ledgerId, address publisher);
    event Anchored(
        bytes16 indexed ledgerId,
        uint64 sequence,
        bytes32 checkpointDigest,
        bytes32 previousAnchorDigest,
        address indexed publisher
    );

    constructor() {
        registrationAuthority = msg.sender;
    }

    function registerLedger(bytes16 ledgerId, address publisher) external {
        require(msg.sender == registrationAuthority, "registration authority required");
        require(ledgerId != bytes16(0) && publisher != address(0), "zero identity");
        require(ledgers[ledgerId].owner == address(0), "ledger already registered");
        ledgers[ledgerId] = Ledger(msg.sender, publisher, 0, bytes32(0), bytes32(0));
        emit LedgerRegistered(ledgerId, msg.sender, publisher);
    }

    function rotatePublisher(bytes16 ledgerId, address publisher) external {
        Ledger storage ledger = ledgers[ledgerId];
        require(ledger.owner != address(0), "ledger not registered");
        require(msg.sender == ledger.owner, "ledger owner required");
        require(publisher != address(0), "zero publisher");
        ledger.publisher = publisher;
        emit PublisherRotated(ledgerId, publisher);
    }

    function anchor(
        bytes16 ledgerId,
        uint64 sequence,
        bytes32 checkpointDigest,
        bytes32 previousAnchorDigest
    ) external {
        Ledger storage ledger = ledgers[ledgerId];
        require(ledger.owner != address(0), "ledger not registered");
        require(msg.sender == ledger.publisher, "authorized publisher required");
        require(sequence != 0 && checkpointDigest != bytes32(0), "zero anchor");

        if (
            sequence == ledger.sequence
                && checkpointDigest == ledger.checkpointDigest
                && previousAnchorDigest == ledger.previousAnchorDigest
        ) {
            return;
        }

        require(sequence > ledger.sequence, "sequence must increase");
        require(previousAnchorDigest == ledger.checkpointDigest, "wrong predecessor");
        ledger.sequence = sequence;
        ledger.checkpointDigest = checkpointDigest;
        ledger.previousAnchorDigest = previousAnchorDigest;
        emit Anchored(
            ledgerId,
            sequence,
            checkpointDigest,
            previousAnchorDigest,
            msg.sender
        );
    }
}
