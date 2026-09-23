// Offline, deterministic standard-JSON compilation; no deployment or RPC.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "tools", "registry-toolchain", "loader.cjs"));
const solc = require("solc");
const { keccak256 } = require("js-sha3");
const version = "0.8.30+commit.73712a01.Emscripten.clang";
if (solc.version() !== version) throw new Error(`Expected solc ${version}, got ${solc.version()}`);
const sourceName = "contracts/ECorpCheckpointRegistryV1.sol";
// Foundry canonicalizes source line endings. Match it across Windows/Unix checkouts.
const source = fs.readFileSync(path.join(root, "contracts", "ECorpCheckpointRegistryV1.sol"), "utf8").replace(/\r\n/g, "\n");
const settings = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "cancun",
  viaIR: false,
  metadata: { bytecodeHash: "ipfs", appendCBOR: true, useLiteralContent: false },
  outputSelection: { "*": { "*": ["abi", "metadata", "evm.bytecode", "evm.deployedBytecode", "storageLayout"] } },
};
const result = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { [sourceName]: { content: source } },
  settings,
})));
for (const diagnostic of result.errors ?? []) {
  if (diagnostic.severity === "error") throw new Error(diagnostic.formattedMessage);
  console.error(diagnostic.formattedMessage);
}
const contract = result.contracts[sourceName].ECorpCheckpointRegistryV1;
const runtimeHash = `0x${keccak256(Buffer.from(contract.evm.deployedBytecode.object, "hex"))}`;
const artifact = `${JSON.stringify({
  compiler_version: version,
  compiler_settings: settings,
  source_normalization: "UTF-8 with LF line endings",
  source_sha256: createHash("sha256").update(source).digest("hex"),
  runtime_code_hash: runtimeHash,
  contract,
}, null, 2)}\n`;
const target = path.join(root, "contracts", "ECorpCheckpointRegistryV1.compiled.json");
if (process.argv.includes("--check")) {
  if (fs.readFileSync(target, "utf8") !== artifact) throw new Error("Registry artifact differs from pinned reproducible build");
  console.log(`Registry artifact reproducible: ${runtimeHash}`);
} else {
  fs.writeFileSync(target, artifact);
  console.log(`Built registry runtime: ${runtimeHash}`);
}
if (process.argv.includes("--check-foundry")) {
  const foundryPath = path.join(root, "target", "foundry", "out", "ECorpCheckpointRegistryV1.sol", "ECorpCheckpointRegistryV1.json");
  const foundry = JSON.parse(fs.readFileSync(foundryPath, "utf8"));
  if (foundry.deployedBytecode.object !== `0x${contract.evm.deployedBytecode.object}` ||
      foundry.bytecode.object !== `0x${contract.evm.bytecode.object}`) {
    throw new Error("Native Foundry and solc-js creation/runtime bytecode differ");
  }
  console.log("Native Foundry and solc-js creation/runtime bytecode match exactly");
}
