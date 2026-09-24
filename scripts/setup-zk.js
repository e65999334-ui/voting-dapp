const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const zkDir = path.join(root, "build", "zk");
const circuitName = "VoteValidity";
const r1cs = path.join(zkDir, `${circuitName}.r1cs`);
const wasm = path.join(zkDir, `${circuitName}_js`, `${circuitName}.wasm`);
const ptau0 = path.join(zkDir, "pot14_0000.ptau");
const ptauContributed = path.join(zkDir, "pot14_contributed.ptau");
const ptauPrepared = path.join(zkDir, "pot14_prepared.tmp.ptau");
const ptauFinal = path.join(zkDir, "pot14_final.ptau");
const zkey0 = path.join(zkDir, `${circuitName}_0000.zkey`);
const zkeyPrepared = path.join(zkDir, `${circuitName}.tmp.zkey`);
const zkey = path.join(zkDir, `${circuitName}.zkey`);
const vkey = path.join(zkDir, "verification_key.json");
const verifier = path.join(root, "contracts", "Groth16Verifier.sol");
const poseidon = path.join(root, "contracts", "PoseidonT3.sol");

function run(args) {
  execFileSync(
    process.execPath,
    [path.join(root, "node_modules", "snarkjs", "build", "cli.cjs"), ...args],
    { cwd: root, stdio: "inherit" }
  );
}

fs.mkdirSync(zkDir, { recursive: true });

// The proving key and Solidity verifier are circuit-specific. Invalidate all
// circuit-derived artifacts when VoteValidity.circom changes; otherwise a
// clean-looking build can accidentally keep a verifier for an older circuit.
const circuitSource = fs.readFileSync(path.join(root, "circuits", "VoteValidity.circom"));
const circuitHash = crypto.createHash("sha256").update(circuitSource).digest("hex");
const stampFile = path.join(zkDir, "VoteValidity.circuit.sha256");
const previousHash = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, "utf8").trim() : "";
if (previousHash !== circuitHash) {
  for (const file of [zkey0, zkeyPrepared, zkey, vkey, verifier]) {
    fs.rmSync(file, { force: true });
  }
  fs.rmSync(path.join(zkDir, "VoteValidity_js"), { recursive: true, force: true });
  fs.rmSync(r1cs, { force: true });
  fs.rmSync(path.join(zkDir, "VoteValidity.sym"), { force: true });
}
execFileSync(
  process.execPath,
  [path.join(root, "scripts", "compile-circuit.js")],
  { cwd: root, stdio: "inherit" }
);

if (!fs.existsSync(ptauFinal)) {
  for (const file of [ptau0, ptauContributed, ptauPrepared]) {
    fs.rmSync(file, { force: true });
  }
  run(["powersoftau", "new", "bn128", "14", ptau0, "-v"]);
  run(["powersoftau", "contribute", ptau0, ptauContributed, "--name=local-test-contribution", "-e=local deterministic entropy for tests"]);
  run(["powersoftau", "prepare", "phase2", ptauContributed, ptauPrepared, "-v"]);
  fs.renameSync(ptauPrepared, ptauFinal);
}

if (!fs.existsSync(zkey)) {
  for (const file of [zkey0, zkeyPrepared]) {
    fs.rmSync(file, { force: true });
  }
  run(["groth16", "setup", r1cs, ptauFinal, zkey0]);
  run(["zkey", "contribute", zkey0, zkeyPrepared, "--name=local-test-contribution", "-e=local deterministic entropy for tests"]);
  fs.renameSync(zkeyPrepared, zkey);
}

if (!fs.existsSync(vkey)) {
  run(["zkey", "export", "verificationkey", zkey, vkey]);
}

// The verifier is generated from the proving key. It is not handwritten and
// must be regenerated whenever the circuit changes.
if (!fs.existsSync(verifier)) {
  run(["zkey", "export", "solidityverifier", zkey, verifier]);
}

if (!fs.existsSync(poseidon)) {
  fs.copyFileSync(
    path.join(root, "node_modules", "poseidon-solidity", "PoseidonT3.sol"),
    poseidon
  );
}

fs.writeFileSync(stampFile, `${circuitHash}\n`);
console.log(`ZK artifacts ready: ${wasm}, ${zkey}, ${verifier}`);