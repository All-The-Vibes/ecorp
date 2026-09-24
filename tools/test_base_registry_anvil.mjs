// Local JSON-RPC acceptance only: unlocked Anvil fixture accounts, never real wallets.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "tools", "registry-toolchain", "loader.cjs"));
const { keccak256 } = require("js-sha3");
const port = Number(process.argv[2] ?? "18545");
assert(Number.isInteger(port) && port >= 1024 && port <= 65535, "Invalid local port");
const endpoint = `http://127.0.0.1:${port}`;
const pins = JSON.parse(fs.readFileSync(path.join(root, "tools", "registry-toolchain", "toolchain.json"), "utf8"));
const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "ECorpCheckpointRegistryV1.compiled.json"), "utf8"));
const vector = JSON.parse(fs.readFileSync(path.join(root, "docs", "state-audit-v1-vector.json"), "utf8"));
const zero = "0".repeat(64);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const addressWord = (address) => address.slice(2).padStart(64, "0");
const call = (signature, words = []) => `0x${keccak256(signature).slice(0, 8)}${words.join("")}`;
const transactions = [];
let requestId = 0;

class RpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error.message}`);
    this.code = error.code;
  }
}

async function rpc(method, params = []) {
  const id = ++requestId;
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  assert(response.ok, `${method}: HTTP ${response.status}`);
  const body = await response.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, id);
  if (body.error) throw new RpcError(method, body.error);
  assert(Object.hasOwn(body, "result"), `${method}: missing result`);
  return body.result;
}

async function receipt(hash) {
  for (let attempt = 0; attempt < 40; ++attempt) {
    const result = await rpc("eth_getTransactionReceipt", [hash]);
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Local receipt timeout: ${hash}`);
}

const client = await rpc("web3_clientVersion");
assert(client.startsWith(`anvil/v${pins.foundry.version}`), `Not pinned Anvil: ${client}`);
const chainId = Number(BigInt(await rpc("eth_chainId")));
assert([8453, 84532].includes(chainId), `Not a configured local Base ID: ${chainId}`);
const accounts = await rpc("eth_accounts");
assert(accounts.length >= 3, "Anvil fixture accounts unavailable");
const [owner, publisher, attacker] = accounts;

async function send(kind, from, data, success = true, to) {
  const nonce = await rpc("eth_getTransactionCount", [from, "latest"]);
  assert.equal(await rpc("eth_getTransactionCount", [from, "pending"]), nonce,
    "Fixture nonce lane has pending work; use an independent local node");
  const tx = { from, data, value: "0x0", gas: "0x989680", nonce };
  if (to !== undefined) tx.to = to;
  const hash = await rpc("eth_sendTransaction", [tx]);
  const result = await receipt(hash);
  assert.equal(result.transactionHash, hash);
  assert.equal(result.status, success ? "0x1" : "0x0", kind);
  assert.equal(result.from.toLowerCase(), from.toLowerCase());
  assert.equal(BigInt(await rpc("eth_getTransactionCount", [from, "latest"])), BigInt(nonce) + 1n);
  const observed = await rpc("eth_getTransactionByHash", [hash]);
  assert.equal(observed.nonce, nonce);
  assert.equal(observed.input, data);
  assert.equal(observed.value, "0x0");
  assert.equal(observed.blockHash, result.blockHash);
  const block = await rpc("eth_getBlockByHash", [result.blockHash, false]);
  assert(block.transactions.includes(hash), "Receipt not in its sealed local block");
  assert.equal(block.number, result.blockNumber);
  transactions.push({
    kind, hash, nonce, status: result.status, block_hash: result.blockHash,
    block_number: result.blockNumber, log_count: result.logs.length,
    gas_used: Number(BigInt(result.gasUsed)),
  });
  return result;
}

const deployed = await send("deployment", owner, `0x${artifact.contract.evm.bytecode.object}`);
const registry = deployed.contractAddress;
assert.match(registry, /^0x[0-9a-f]{40}$/);
const runtime = await rpc("eth_getCode", [registry, "latest"]);
assert.equal(runtime, `0x${artifact.contract.evm.deployedBytecode.object}`);
assert.equal(`0x${keccak256(Buffer.from(runtime.slice(2), "hex"))}`, artifact.runtime_code_hash);
assert.equal(await rpc("eth_call", [{ to: registry, data: call("version()") }, "latest"]), `0x${word(1)}`);

const localKey = randomBytes(32).toString("hex");
const domain = Buffer.from("ECORP_STATE_AUDIT_STREAM_V1").toString("hex");
const preimage = word(96) + addressWord(owner) + localKey + word(domain.length / 2) + domain.padEnd(64, "0");
const stream = keccak256(Buffer.from(preimage, "hex"));
const registered = await send("registration", owner,
  call("register(bytes32,address)", [localKey, addressWord(publisher)]), true, registry);
assert.equal(registered.logs.length, 1);
assert.deepEqual(registered.logs[0].topics, [
  `0x${keccak256("Registered(bytes32,address,address)")}`, `0x${stream}`, `0x${addressWord(owner)}`,
]);
assert.equal(registered.logs[0].data, `0x${addressWord(publisher)}`);
const registerReplay = await send("registration_replay", owner,
  call("register(bytes32,address)", [localKey, addressWord(publisher)]), true, registry);
assert.equal(registerReplay.logs.length, 0);

const anchorCall = (sequence, digest, previous) =>
  call("anchor(bytes32,uint64,bytes32,bytes32)", [stream, word(sequence), digest, previous]);
const readHead = () => rpc("eth_call", [{ to: registry, data: call("head(bytes32)", [stream]) }, "latest"]);
const initialHead = await readHead();
const unauthorized = await send("unauthorized_anchor", attacker,
  anchorCall(1, vector.digest, zero), false, registry);
assert.equal(unauthorized.logs.length, 0);
assert.equal(await readHead(), initialHead);

const firstData = anchorCall(1, vector.digest, zero);
const first = await send("first_anchor", publisher, firstData, true, registry);
const topic = `0x${keccak256("Anchored(bytes32,uint64,bytes32,bytes32,uint64,address)")}`;
assert.equal(first.logs.length, 1);
assert.deepEqual(first.logs[0].topics, [topic, `0x${stream}`, `0x${word(1)}`]);
assert.equal(first.logs[0].data, `0x${vector.digest}${zero}${word(1)}${addressWord(publisher)}`);
const genesis = `0x${word(1)}${addressWord(owner)}${zero}${addressWord(publisher)}${zero}${word(1)}${vector.digest}${zero}${word(1)}`;
assert.equal(await readHead(), genesis);

const replay = await send("exact_replay_new_nonce", publisher, firstData, true, registry);
assert.equal(replay.logs.length, 0);
assert.equal(await readHead(), genesis);
const afterReplayNonce = await rpc("eth_getTransactionCount", [publisher, "latest"]);
const firstTransaction = await rpc("eth_getTransactionByHash", [first.transactionHash]);
await assert.rejects(
  rpc("eth_sendTransaction", [{
    from: publisher, to: registry, data: firstData, value: "0x0",
    gas: "0x989680", nonce: firstTransaction.nonce,
  }]),
  (error) => error instanceof RpcError && /nonce too low|already known/i.test(error.message),
);
assert.equal(await rpc("eth_getTransactionCount", [publisher, "latest"]), afterReplayNonce);
assert.equal(await readHead(), genesis);

const laterDigest = "33".repeat(32);
const later = await send("skipped_sequence_anchor", publisher,
  anchorCall(17, laterDigest, vector.digest), true, registry);
assert.equal(later.logs.length, 1);
assert.deepEqual(later.logs[0].topics, [topic, `0x${stream}`, `0x${word(17)}`]);
assert.equal(later.logs[0].data, `0x${laterDigest}${vector.digest}${word(2)}${addressWord(publisher)}`);
const finalHead = `0x${word(1)}${addressWord(owner)}${zero}${addressWord(publisher)}${zero}${word(17)}${laterDigest}${vector.digest}${word(2)}`;
assert.equal(await readHead(), finalHead);
const stale = await send("stale_request_reverts", publisher, firstData, false, registry);
assert.equal(stale.logs.length, 0);
assert.equal(await readHead(), finalHead);

const logs = await rpc("eth_getLogs", [{
  address: registry, fromBlock: deployed.blockNumber, toBlock: "latest",
  topics: [topic, `0x${stream}`],
}]);
assert.equal(logs.length, 2, "Replays/reverts must not create anchor events");
assert.deepEqual(logs.map((log) => log.transactionHash), [first.transactionHash, later.transactionHash]);
assert(logs.every((log) => log.removed === false && log.address.toLowerCase() === registry));
const evidence = {
  assurance: "local-anvil-only", endpoint, chain_id: chainId, client,
  registry, stream_id: `0x${stream}`, owner, publisher,
  runtime_code_hash: artifact.runtime_code_hash, anchor_events: logs.length,
  final_sequence: 17, final_ordinal: 2, rejected_reused_nonce: true,
  transactions,
};
const evidenceDirectory = path.join(root, "target", "foundry", "anvil-evidence");
fs.mkdirSync(evidenceDirectory, { recursive: true });
const evidencePath = path.join(evidenceDirectory, `registry-${registry}.json`);
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, ...evidence, evidence_path: evidencePath }, null, 2));
