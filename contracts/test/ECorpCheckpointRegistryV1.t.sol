// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ECorpCheckpointRegistryV1 as Registry} from "../ECorpCheckpointRegistryV1.sol";

interface Vm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function prank(address) external;
    function expectRevert() external;
    function deal(address, uint256) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract RegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    Registry registry;
    address constant OWNER = address(0x1111);
    address constant PUBLISHER = address(0x2222);
    address constant OTHER = address(0x3333);
    bytes32 constant KEY = bytes32(uint256(0x9911));
    bytes32 constant DIGEST = 0xb162ef6763fe11a16f2bc75c50540a14790bcb18dcb56d71c5513e057fb9b507;
    bytes32 id;

    function setUp() public {
        registry = new Registry();
        vm.prank(OWNER);
        id = registry.register(KEY, PUBLISHER);
    }

    function testNamespaceAndRegistrationReplay() public {
        require(id == keccak256(abi.encode("ECORP_STATE_AUDIT_STREAM_V1", OWNER, KEY)));
        vm.recordLogs();
        vm.prank(OWNER);
        require(registry.register(KEY, PUBLISHER) == id);
        require(vm.getRecordedLogs().length == 0);
        vm.prank(OTHER);
        bytes32 other = registry.register(KEY, OTHER);
        require(other != id);
        vm.expectRevert();
        vm.prank(OWNER);
        registry.register(KEY, OTHER);
    }

    function testFrozenDigestGenesisSkipReplayAndEvents() public {
        vm.recordLogs();
        vm.prank(PUBLISHER);
        registry.anchor(id, 1, DIGEST, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1);
        require(logs[0].emitter == address(registry));
        require(logs[0].topics[0] == keccak256("Anchored(bytes32,uint64,bytes32,bytes32,uint64,address)"));
        require(logs[0].topics[1] == id && logs[0].topics[2] == bytes32(uint256(1)));
        require(keccak256(logs[0].data) == keccak256(abi.encode(DIGEST, bytes32(0), uint64(1), PUBLISHER)));
        vm.recordLogs();
        vm.prank(PUBLISHER);
        registry.anchor(id, 1, DIGEST, 0);
        require(vm.getRecordedLogs().length == 0);
        vm.prank(PUBLISHER);
        registry.anchor(id, 17, bytes32(uint256(2)), DIGEST);
        Registry.Head memory h = registry.head(id);
        require(h.lastSequence == 17 && h.lastDigest == bytes32(uint256(2)));
        require(h.previousAnchorDigest == DIGEST && h.anchorOrdinal == 2);
        vm.expectRevert();
        vm.prank(PUBLISHER);
        registry.anchor(id, 1, DIGEST, 0);
    }

    function testRejectInvalidAnchorsAndCurrentAuthorization() public {
        vm.expectRevert(); vm.prank(OWNER); registry.anchor(id, 1, DIGEST, 0);
        vm.expectRevert(); vm.prank(OTHER); registry.anchor(id, 1, DIGEST, 0);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.anchor(bytes32(uint256(3)), 1, DIGEST, 0);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.anchor(id, 0, DIGEST, 0);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.anchor(id, 1, 0, 0);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.anchor(id, 1, DIGEST, DIGEST);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.anchor(id, uint64(type(int64).max) + 1, DIGEST, 0);
        vm.prank(PUBLISHER); registry.anchor(id, uint64(type(int64).max), DIGEST, 0);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.anchor(id, uint64(type(int64).max), bytes32(uint256(2)), 0);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.anchor(id, uint64(type(int64).max), DIGEST, DIGEST);
    }

    function testPausePublisherOwnerRotationAndInitialRetryPreserveHead() public {
        vm.prank(PUBLISHER); registry.anchor(id, 7, DIGEST, 0);
        vm.prank(OWNER); registry.setPaused(id, true);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.anchor(id, 7, DIGEST, 0);
        vm.prank(OWNER); registry.setPublisher(id, OTHER);
        vm.expectRevert(); vm.prank(OWNER); registry.setPublisher(id, address(0));
        vm.prank(OWNER); registry.setPaused(id, false);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.anchor(id, 7, DIGEST, 0);
        vm.prank(OTHER); registry.anchor(id, 7, DIGEST, 0);
        vm.prank(OWNER); registry.proposeOwner(id, PUBLISHER);
        vm.prank(OWNER); registry.proposeOwner(id, OTHER);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.acceptOwner(id);
        vm.prank(OWNER); registry.proposeOwner(id, address(0));
        vm.expectRevert(); vm.prank(OTHER); registry.acceptOwner(id);
        vm.prank(OWNER); registry.proposeOwner(id, OTHER);
        vm.prank(OTHER); registry.acceptOwner(id);
        vm.expectRevert(); vm.prank(OWNER); registry.setPaused(id, true);
        vm.prank(OWNER); require(registry.register(KEY, PUBLISHER) == id);
        vm.expectRevert(); vm.prank(OWNER); registry.register(KEY, OTHER);
        Registry.Head memory h = registry.head(id);
        require(h.owner == OTHER && h.pendingOwner == address(0) && h.publisher == OTHER);
        require(h.lastSequence == 7 && h.lastDigest == DIGEST && h.anchorOrdinal == 1);
    }

    function testAllAdminMethodsRejectUnauthorizedOrUnknownStream() public {
        vm.expectRevert(); vm.prank(PUBLISHER); registry.setPublisher(id, OTHER);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.setPaused(id, true);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.proposeOwner(id, OTHER);
        vm.expectRevert(); vm.prank(OWNER); registry.acceptOwner(id);
        vm.expectRevert(); vm.prank(OWNER); registry.setPublisher(0, OTHER);
        vm.expectRevert(); vm.prank(OWNER); registry.setPaused(0, true);
        vm.expectRevert(); vm.prank(OWNER); registry.proposeOwner(0, OTHER);
        vm.expectRevert(); vm.prank(OWNER); registry.acceptOwner(0);
        vm.expectRevert(); vm.prank(OTHER); registry.register(KEY, address(0));
    }

    function testNonpayableAndNoFallback() public {
        vm.deal(OWNER, 100);
        bytes[] memory calls = new bytes[](8);
        calls[0] = abi.encodeCall(registry.register,(KEY,PUBLISHER));
        calls[1] = abi.encodeCall(registry.anchor,(id,uint64(1),DIGEST,bytes32(0)));
        calls[2] = abi.encodeCall(registry.head,(id));
        calls[3] = abi.encodeCall(registry.setPublisher,(id,OTHER));
        calls[4] = abi.encodeCall(registry.setPaused,(id,true));
        calls[5] = abi.encodeCall(registry.proposeOwner,(id,OTHER));
        calls[6] = abi.encodeCall(registry.acceptOwner,(id));
        calls[7] = abi.encodeCall(registry.version,());
        for (uint256 i; i<calls.length; ++i) {
            vm.prank(OWNER);
            (bool ok,) = address(registry).call{value:1}(calls[i]);
            require(!ok);
        }
        vm.prank(OWNER); (bool received,) = address(registry).call{value:1}("");
        require(!received);
        (bool fallbackAccepted,) = address(registry).call(hex"deadbeef");
        require(!fallbackAccepted);
    }

    function testFuzzNamespace(address owner, bytes32 key) public {
        if (owner == address(0)) owner = address(1);
        vm.prank(owner);
        bytes32 derived = registry.register(key, PUBLISHER);
        require(derived == keccak256(abi.encode("ECORP_STATE_AUDIT_STREAM_V1", owner, key)));
        require(registry.head(derived).owner == owner);
    }

    function testFuzzMonotonicSkipAndExactReplay(uint64 first, uint64 gap, bytes32 digest) public {
        first = 1 + first % (uint64(type(int64).max) / 2);
        gap = 1 + gap % (uint64(type(int64).max) / 2);
        if (digest == 0) digest = DIGEST;
        vm.prank(PUBLISHER); registry.anchor(id, first, digest, 0);
        vm.prank(PUBLISHER); registry.anchor(id, first+gap, DIGEST, digest);
        vm.recordLogs();
        vm.prank(PUBLISHER); registry.anchor(id, first+gap, DIGEST, digest);
        require(vm.getRecordedLogs().length == 0);
        Registry.Head memory h = registry.head(id);
        require(h.lastSequence == first+gap && h.anchorOrdinal == 2);
        require(h.lastDigest == DIGEST && h.previousAnchorDigest == digest);
        vm.expectRevert(); vm.prank(PUBLISHER); registry.anchor(id, first, digest, 0);
    }
}

contract RegistryHandler {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    Registry public registry;
    bytes32 public id;
    address public owner = address(0x1111);
    address public publisher = address(0x2222);
    uint64 public sequence;
    uint64 public ordinal;
    bytes32 public digest;
    bytes32 public previous;
    bool public paused;

    constructor(Registry r) {
        registry = r;
        vm.prank(owner);
        id = registry.register(bytes32(uint256(0x8877)), publisher);
    }

    function publish(uint32 gap, bytes32 next) public {
        if (paused || sequence > uint64(type(int64).max)-uint64(gap)-1) return;
        if (next == 0) next = bytes32(uint256(1));
        uint64 seq = sequence + uint64(gap) + 1;
        vm.recordLogs();
        vm.prank(publisher);
        registry.anchor(id, seq, next, digest);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(registry));
        require(logs[0].topics[0] == keccak256("Anchored(bytes32,uint64,bytes32,bytes32,uint64,address)"));
        require(logs[0].topics[1] == id && logs[0].topics[2] == bytes32(uint256(seq)));
        require(keccak256(logs[0].data) == keccak256(abi.encode(next,digest,ordinal+1,publisher)));
        previous = digest; digest = next; sequence = seq; ++ordinal;
    }

    function pause() public {
        paused = !paused;
        vm.prank(owner); registry.setPaused(id, paused);
    }

    function rotatePublisher() public {
        publisher = publisher == address(0x2222) ? address(0x4444) : address(0x2222);
        vm.prank(owner); registry.setPublisher(id, publisher);
    }

    function transferOwner() public {
        address next = owner == address(0x1111) ? address(0x3333) : address(0x1111);
        vm.prank(owner); registry.proposeOwner(id, next);
        vm.prank(next); registry.acceptOwner(id);
        owner = next;
    }

    function attack(bytes32 next) public {
        vm.prank(address(0x9999));
        (bool ok,) = address(registry).call(abi.encodeCall(registry.anchor,(id,sequence+1,next,digest)));
        require(!ok);
    }

    function replay() public {
        if (sequence == 0 || paused) return;
        vm.recordLogs();
        vm.prank(publisher); registry.anchor(id, sequence, digest, previous);
        require(vm.getRecordedLogs().length == 0);
    }
}

contract RegistryInvariantTest {
    Registry registry;
    RegistryHandler handler;
    function setUp() public {
        registry = new Registry();
        handler = new RegistryHandler(registry);
    }
    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }
    function invariantHeadMatchesAcceptedEventsAndAdminCannotEraseHistory() public view {
        Registry.Head memory h = registry.head(handler.id());
        require(h.registered && h.owner == handler.owner() && h.publisher == handler.publisher());
        require(h.paused == handler.paused() && h.pendingOwner == address(0));
        require(h.lastSequence == handler.sequence() && h.anchorOrdinal == handler.ordinal());
        require(h.lastDigest == handler.digest() && h.previousAnchorDigest == handler.previous());
        require(h.lastSequence <= uint64(type(int64).max));
    }
}
