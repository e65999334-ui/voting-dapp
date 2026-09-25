const { ethers } = require("hardhat");

async function main() {
  const [deployer, ...localAccounts] = await ethers.getSigners();
  const configuredMembers = process.env.GOVERNANCE_MEMBERS
    ? process.env.GOVERNANCE_MEMBERS.split(",").map((address) => address.trim())
    : [deployer.address, ...localAccounts.slice(0, 2).map((signer) => signer.address)];
  const threshold = BigInt(process.env.GOVERNANCE_THRESHOLD || "2");

  if (configuredMembers.length < Number(threshold)) {
    throw new Error("GOVERNANCE_MEMBERS must contain at least GOVERNANCE_THRESHOLD addresses");
  }

  const verifierFactory = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await verifierFactory.deploy();
  await verifier.waitForDeployment();

  const poseidonFactory = await ethers.getContractFactory("PoseidonT3");
  const poseidonLibrary = await poseidonFactory.deploy();
  await poseidonLibrary.waitForDeployment();

  const votingFactory = await ethers.getContractFactory("ZKVoting", {
    libraries: {
      PoseidonT3: await poseidonLibrary.getAddress()
    }
  });
  const voting = await votingFactory.deploy(
    await verifier.getAddress(),
    configuredMembers,
    threshold
  );
  await voting.waitForDeployment();

  console.log(JSON.stringify({
    deployer: deployer.address,
    verifier: await verifier.getAddress(),
    poseidonLibrary: await poseidonLibrary.getAddress(),
    voting: await voting.getAddress(),
    governanceMembers: configuredMembers,
    approvalThreshold: threshold.toString()
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});