const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");

const root = path.resolve(__dirname, "..");
const artifacts = {
  wasm: path.join(root, "build", "zk", "VoteValidity_js", "VoteValidity.wasm"),
  zkey: path.join(root, "build", "zk", "VoteValidity.zkey")
};

function assertArtifactsExist() {
  for (const file of Object.values(artifacts)) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing ZK artifact: ${file}. Run npm run compile first.`);
    }
  }
}

/**
 * Generate a real Groth16 proof for VoteValidity.circom.
 *
 * The caller is responsible for validating that the credential is eligible
 * and that the input values are field-compatible before passing them here.
 */
async function generateVoteProof(input) {
  assertArtifactsExist();
  const result = await snarkjs.groth16.fullProve(input, artifacts.wasm, artifacts.zkey);
  const solidityCalldata = await snarkjs.groth16.exportSolidityCallData(
    result.proof,
    result.publicSignals
  );
  return {
    proof: result.proof,
    publicSignals: result.publicSignals,
    solidityCalldata
  };
}

module.exports = {
  artifacts,
  generateVoteProof
};