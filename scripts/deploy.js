const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const COMPROMISED_DEPLOYER_ADDRESSES = new Set([
  "0xb6f578bfd1aca6f3b4b4c518fa95d9a28d82aa2b"
]);

function updateFrontendContractAddress(address) {
  if (hre.network.name !== "sepolia") {
    console.log(
      `Skipping frontend/.env update for ${hre.network.name}; the frontend is configured for Sepolia.`
    );
    return;
  }

  const envPath = path.join(__dirname, "..", "frontend", ".env");
  const existing = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : "";
  const otherSettings = existing
    .replace(/^VITE_CONTRACT_ADDRESS=.*(?:\r?\n|$)/gm, "")
    .trimEnd();
  const updated = `${otherSettings ? `${otherSettings}\n` : ""}VITE_CONTRACT_ADDRESS=${address}\n`;

  fs.writeFileSync(envPath, updated, "utf8");
  console.log("✅ Updated frontend/.env with the new Sepolia ZKVoting address.");
}

async function main() {
  console.log("\n========================================");
  console.log(" EthiopiaChain ZK Voting - Sepolia");
  console.log(" Final Deployment");
  console.log("========================================\n");

  const [deployer] =
    await hre.ethers.getSigners();

  console.log(
    "Deployer:",
    deployer.address
  );

  if (
    hre.network.name === "sepolia" &&
    COMPROMISED_DEPLOYER_ADDRESSES.has(deployer.address.toLowerCase())
  ) {
    throw new Error(
      "Refusing Sepolia deployment from the previously exposed deployer wallet. Configure a fresh DEPLOYER_PRIVATE_KEY first."
    );
  }

  const balance =
    await hre.ethers.provider.getBalance(
      deployer.address
    );

  console.log(
    "Balance:",
    hre.ethers.formatEther(balance),
    "ETH"
  );

  if (balance === 0n) {
    throw new Error(
      "Deployer has no Sepolia ETH."
    );
  }

  /*
   * ------------------------------------------------
   * 1. Deploy PoseidonT3
   * ------------------------------------------------
   */

  console.log(
    "\n[1/3] Deploying PoseidonT3..."
  );

  const PoseidonT3 =
    await hre.ethers.getContractFactory(
      "PoseidonT3"
    );

  const poseidon =
    await PoseidonT3.deploy();

  await poseidon.waitForDeployment();

  const poseidonAddress =
    await poseidon.getAddress();

  console.log(
    "PoseidonT3:",
    poseidonAddress
  );

  /*
   * ------------------------------------------------
   * 2. Deploy Groth16Verifier
   * ------------------------------------------------
   */

  console.log(
    "\n[2/3] Deploying Groth16Verifier..."
  );

  const Groth16Verifier =
    await hre.ethers.getContractFactory(
      "Groth16Verifier"
    );

  const verifier =
    await Groth16Verifier.deploy();

  await verifier.waitForDeployment();

  const verifierAddress =
    await verifier.getAddress();

  console.log(
    "Groth16Verifier:",
    verifierAddress
  );

  /*
   * ------------------------------------------------
   * 3. Deploy ZKVoting
   * ------------------------------------------------
   */

  console.log(
    "\n[3/3] Deploying ZKVoting..."
  );

  const governanceMembers =
    (
      process.env.GOVERNANCE_MEMBERS || ""
    )
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);

  if (
    governanceMembers.length === 0
  ) {
    throw new Error(
      "GOVERNANCE_MEMBERS is empty."
    );
  }

  const governanceThreshold =
    BigInt(
      process.env.GOVERNANCE_THRESHOLD || "2"
    );
  const identityIssuer = process.env.IDENTITY_ISSUER_ADDRESS;
  if (!identityIssuer || !hre.ethers.isAddress(identityIssuer) || identityIssuer === hre.ethers.ZeroAddress) {
    throw new Error("IDENTITY_ISSUER_ADDRESS must be set to the trusted identity-signing wallet.");
  }

  console.log(
    "Governance members:"
  );

  for (
    const member of governanceMembers
  ) {
    console.log(
      " -",
      member
    );
  }

  console.log(
    "Governance threshold:",
    governanceThreshold.toString()
  );

  const ZKVoting =
    await hre.ethers.getContractFactory(
      "ZKVoting",
      {
        libraries: {
          PoseidonT3:
            poseidonAddress
        }
      }
    );

  const voting =
    await ZKVoting.deploy(
      verifierAddress,
      governanceMembers,
      governanceThreshold,
      identityIssuer
    );

  await voting.waitForDeployment();

  const votingAddress =
    await voting.getAddress();

  updateFrontendContractAddress(votingAddress);

  console.log(
    "ZKVoting:",
    votingAddress
  );

  /*
   * ------------------------------------------------
   * Summary
   * ------------------------------------------------
   */

  console.log(
    "\n========================================"
  );

  console.log(
    " DEPLOYMENT COMPLETE"
  );

  console.log(
    "========================================\n"
  );

  console.log(
    "Network:",
    hre.network.name
  );

  console.log(
    "Deployer:",
    deployer.address
  );

  console.log(
    "\nContracts:"
  );

  console.log(
    "PoseidonT3:",
    poseidonAddress
  );

  console.log(
    "Groth16Verifier:",
    verifierAddress
  );

  console.log(
    "ZKVoting:",
    votingAddress
  );

  console.log(
    "\nGovernance:"
  );

  console.log(
    "Members:",
    governanceMembers.join(", ")
  );

  console.log(
    "Threshold:",
    governanceThreshold.toString()
  );

  console.log(
    "\nSepolia Explorer:"
  );

  console.log(
    "ZKVoting:",
    `https://sepolia.etherscan.io/address/${votingAddress}`
  );

  console.log(
    "Groth16Verifier:",
    `https://sepolia.etherscan.io/address/${verifierAddress}`
  );

  console.log(
    "PoseidonT3:",
    `https://sepolia.etherscan.io/address/${poseidonAddress}`
  );

  console.log(
    "\n========================================\n"
  );

  /*
   * Machine-readable output for later scripts.
   */

  console.log(
    "DEPLOYMENT_JSON="
  );

  console.log(
    JSON.stringify(
      {
        network: hre.network.name,
        deployer: deployer.address,
        poseidonT3: poseidonAddress,
        groth16Verifier: verifierAddress,
        zkVoting: votingAddress,
        governanceMembers,
        governanceThreshold:
          governanceThreshold.toString()
      },
      null,
      2
    )
  );
}

main().catch(error => {
  console.error(
    "\nDEPLOYMENT FAILED\n"
  );

  console.error(error);

  process.exitCode = 1;
});