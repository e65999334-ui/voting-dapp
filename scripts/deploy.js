const hre = require("hardhat");
require("dotenv").config();

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
      governanceThreshold
    );

  await voting.waitForDeployment();

  const votingAddress =
    await voting.getAddress();

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