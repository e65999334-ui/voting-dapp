const { expect } = require("chai");
const { ethers } = require("hardhat");
const snarkjs = require("snarkjs");
const circomlib = require("circomlibjs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const WASM = path.join(
  ROOT,
  "build/zk/VoteValidity_js/VoteValidity.wasm"
);

const ZKEY = path.join(
  ROOT,
  "build/zk/VoteValidity.zkey"
);

let poseidon;
let F;

function hash(values) {
  return BigInt(
    F.toObject(
      poseidon(values.map(BigInt))
    ).toString()
  );
}

async function deployVoting(members, threshold) {
  const verifierFactory =
    await ethers.getContractFactory("Groth16Verifier");

  const verifier =
    await verifierFactory.deploy();

  await verifier.waitForDeployment();

  const poseidonFactory =
    await ethers.getContractFactory("PoseidonT3");

  const poseidonLibrary =
    await poseidonFactory.deploy();

  await poseidonLibrary.waitForDeployment();

  const votingFactory =
    await ethers.getContractFactory("ZKVoting", {
      libraries: {
        PoseidonT3:
          await poseidonLibrary.getAddress()
      }
    });

  const voting =
    await votingFactory.deploy(
      await verifier.getAddress(),
      members,
      threshold
    );

  await voting.waitForDeployment();

  return voting;
}

function eligibilityTree(leaves) {
  let level =
    Array.from(
      { length: 8 },
      (_, i) =>
        BigInt(leaves[i] || 0)
    );

  const levels = [level];

  while (level.length > 1) {
    const next = [];

    for (
      let i = 0;
      i < level.length;
      i += 2
    ) {
      next.push(
        hash([
          level[i],
          level[i + 1]
        ])
      );
    }

    level = next;
    levels.push(level);
  }

  return {
    root: level[0],

    pathFor(index) {
      const siblings = [];
      const indices = [];

      let position = index;

      for (
        let depth = 0;
        depth < 3;
        depth += 1
      ) {
        siblings.push(
          levels[depth][position ^ 1]
        );

        indices.push(
          position % 2
        );

        position =
          Math.floor(position / 2);
      }

      return {
        siblings,
        indices
      };
    }
  };
}

function candidateTree(candidateIds) {
  const sorted =
    [...candidateIds]
      .map(BigInt)
      .sort((a, b) =>
        a < b ? -1 :
        a > b ? 1 :
        0
      );

  let level =
    Array.from(
      { length: 8 },
      (_, i) =>
        i < sorted.length
          ? hash([
              sorted[i],
              0n
            ])
          : 0n
    );

  const levels = [level];

  while (level.length > 1) {
    const next = [];

    for (
      let i = 0;
      i < level.length;
      i += 2
    ) {
      next.push(
        hash([
          level[i],
          level[i + 1]
        ])
      );
    }

    level = next;
    levels.push(level);
  }

  return {
    root: level[0],

    pathFor(candidateId) {
      const index =
        sorted.findIndex(
          id =>
            id ===
            BigInt(candidateId)
        );

      if (index < 0) {
        throw new Error(
          "Candidate not registered"
        );
      }

      const siblings = [];
      const indices = [];

      let position = index;

      for (
        let depth = 0;
        depth < 3;
        depth += 1
      ) {
        siblings.push(
          levels[depth][position ^ 1]
        );

        indices.push(
          position % 2
        );

        position =
          Math.floor(position / 2);
      }

      return {
        siblings,
        indices
      };
    }
  };
}

async function makeBallot({
  credential,
  electionId,
  candidateChoice,
  voteSalt,
  leaves,
  participantIndex = 0,
  candidateIds = [7n, 8n]
}) {
  const eligibility =
    eligibilityTree(leaves);

  const eligibilityPath =
    eligibility.pathFor(
      participantIndex
    );

  const candidates =
    candidateTree(candidateIds);

  const candidatePath =
    candidates.pathFor(
      candidateChoice
    );

  const scopeRoot =
    hash([
      eligibility.root,
      candidates.root
    ]);

  const input = {
    credential:
      credential.toString(),

    electionId:
      electionId.toString(),

    candidateChoice:
      candidateChoice.toString(),

    voteSalt:
      voteSalt.toString(),

    eligibilityRoot:
      eligibility.root.toString(),

    eligibilityPathElements:
      eligibilityPath.siblings.map(
        x => x.toString()
      ),

    eligibilityPathIndices:
      eligibilityPath.indices.map(
        x => x.toString()
      ),

    candidateRoot:
      candidates.root.toString(),

    candidatePathElements:
      candidatePath.siblings.map(
        x => x.toString()
      ),

    candidatePathIndices:
      candidatePath.indices.map(
        x => x.toString()
      ),

    scopeRoot:
      scopeRoot.toString()
  };

  const { proof, publicSignals } =
    await snarkjs.groth16.fullProve(
      input,
      WASM,
      ZKEY
    );

  const calldata =
    await snarkjs.groth16.exportSolidityCallData(
      proof,
      publicSignals
    );

  const [a, b, c, signals] =
    JSON.parse(`[${calldata}]`);

  return {
    a,
    b,
    c,
    signals,

    voteCommitment:
      hash([
        candidateChoice,
        voteSalt
      ]),

    nullifierHash:
      hash([
        credential,
        electionId
      ])
  };
}

describe(
  "ZKVoting adversarial audit",
  function () {
    let voting;

    let member1;
    let member2;
    let member3;

    let participant;
    let attacker;

    const credential =
      123456789n;

    before(async function () {
      poseidon =
        await circomlib.buildPoseidon();

      F = poseidon.F;
    });

    beforeEach(async function () {
      [
        member1,
        member2,
        member3,
        participant,
        attacker
      ] = await ethers.getSigners();

      voting =
        await deployVoting(
          [
            member1.address,
            member2.address,
            member3.address
          ],
          2
        );
    });

    async function advance(seconds) {
      await ethers.provider.send(
        "evm_increaseTime",
        [seconds]
      );

      await ethers.provider.send(
        "evm_mine"
      );
    }

    async function setupElection() {
      const now =
        (
          await ethers.provider.getBlock(
            "latest"
          )
        ).timestamp;

      await voting.proposeElection(
        "Adversarial Test",
        0,
        now + 10,
        now + 1000,
        [7n, 8n]
      );

      /*
       * IMPORTANT:
       * Keep the eligibility leaf hashed.
       * This matches the ZK circuit / existing working
       * proof generation used by this test suite.
       */
      const credentialLeaf =
        hash([credential]);

      const nullifierHash =
        hash([
          credential,
          1n
        ]);

      await voting.registerParticipant(
        1,
        participant.address,
        credentialLeaf,
        nullifierHash
      );

      await voting
        .connect(member1)
        .approveElection(1);

      await voting
        .connect(member2)
        .approveElection(1);

      const leaves =
        await voting.getEligibilityLeaves(1);

      return Array.from(leaves).map(BigInt);
    }

    it(
      "rejects an unregistered wallet even with a valid ZK proof",
      async function () {
        const leaves =
          await setupElection();

        await advance(11);

        await voting.activateElection(1);

        const ballot =
          await makeBallot({
            credential,
            electionId: 1n,
            candidateChoice: 7n,
            voteSalt: 888n,
            leaves
          });

        await expect(
          voting
            .connect(attacker)
            .castPrivateVote(
              1,
              ballot.a,
              ballot.b,
              ballot.c,
              ballot.signals
            )
        ).to.be.revertedWith(
          "Not registered participant"
        );
      }
    );

    it(
      "binds the registered wallet to its credential nullifier",
      async function () {
        const leaves =
          await setupElection();

        await advance(11);

        await voting.activateElection(1);

        /*
         * First create a completely valid proof using
         * the participant's registered credential.
         */
        const ballot =
          await makeBallot({
            credential,
            electionId: 1n,
            candidateChoice: 7n,
            voteSalt: 999n,
            leaves
          });

        /*
         * Replace only the public nullifier signal.
         *
         * The contract checks the participant's registered
         * nullifier BEFORE calling the Groth16 verifier.
         *
         * Therefore this must be rejected because the wallet
         * is registered to a different nullifier.
         */
        const wrongNullifier =
          hash([
            987654321n,
            1n
          ]);

        const badSignals =
          [...ballot.signals];

        badSignals[0] =
          wrongNullifier.toString();

        await expect(
          voting
            .connect(participant)
            .castPrivateVote(
              1,
              ballot.a,
              ballot.b,
              ballot.c,
              badSignals
            )
        ).to.be.revertedWith(
          "Wrong participant credential"
        );
      }
    );

    it(
      "prevents duplicate credentials during participant registration",
      async function () {
        const now =
          (
            await ethers.provider.getBlock(
              "latest"
            )
          ).timestamp;

        await voting.proposeElection(
          "Duplicate Credential",
          0,
          now + 10,
          now + 1000,
          [7n, 8n]
        );

        const leaf =
          hash([credential]);

        const nullifier =
          hash([
            credential,
            1n
          ]);

        await voting.registerParticipant(
          1,
          participant.address,
          leaf,
          nullifier
        );

        await expect(
          voting.registerParticipant(
            1,
            attacker.address,
            leaf,
            hash([
              999999n,
              1n
            ])
          )
        ).to.be.revertedWith(
          "Credential leaf already used"
        );
      }
    );

    it(
      "prevents duplicate nullifiers during participant registration",
      async function () {
        const now =
          (
            await ethers.provider.getBlock(
              "latest"
            )
          ).timestamp;

        await voting.proposeElection(
          "Duplicate Nullifier",
          0,
          now + 10,
          now + 1000,
          [7n, 8n]
        );

        const leafA =
          hash([111111n]);

        const leafB =
          hash([222222n]);

        const nullifier =
          hash([
            111111n,
            1n
          ]);

        await voting.registerParticipant(
          1,
          participant.address,
          leafA,
          nullifier
        );

        await expect(
          voting.registerParticipant(
            1,
            attacker.address,
            leafB,
            nullifier
          )
        ).to.be.revertedWith(
          "Nullifier already registered"
        );
      }
    );

    it(
      "does not allow an attacker to control the election lifecycle",
      async function () {
        const now =
          (
            await ethers.provider.getBlock(
              "latest"
            )
          ).timestamp;

        await expect(
          voting
            .connect(attacker)
            .proposeElection(
              "Unauthorized",
              0,
              now + 10,
              now + 1000,
              [7n, 8n]
            )
        ).to.be.revertedWith(
          "Not election authority"
        );

        await voting.proposeElection(
          "Authorized",
          0,
          now + 10,
          now + 1000,
          [7n, 8n]
        );

        await expect(
          voting
            .connect(attacker)
            .activateElection(1)
        ).to.be.revertedWith(
          "Not election authority"
        );

        await expect(
          voting
            .connect(attacker)
            .endElection(1)
        ).to.be.revertedWith(
          "Not election authority"
        );

        await expect(
          voting
            .connect(attacker)
            .finalizeElection(1)
        ).to.be.revertedWith(
          "Not election authority"
        );
      }
    );

    it(
      "allows reveal after ending but prevents reveal after finalization",
      async function () {
        const leaves =
          await setupElection();

        await advance(11);

        await voting.activateElection(1);

        const ballot =
          await makeBallot({
            credential,
            electionId: 1n,
            candidateChoice: 7n,
            voteSalt: 888n,
            leaves
          });

        await voting
          .connect(participant)
          .castPrivateVote(
            1,
            ballot.a,
            ballot.b,
            ballot.c,
            ballot.signals
          );

        await advance(1000);

        await voting.endElection(1);

        await voting.revealVote(
          1,
          7n,
          888n
        );

        expect(
          await voting.getVoteCount(
            1,
            7n
          )
        ).to.equal(1n);

        await expect(
          voting.finalizeElection(1)
        ).to.be.revertedWith(
          "Reveal period active"
        );

        await advance(
          24 * 60 * 60 + 1
        );

        await voting.finalizeElection(1);

        expect(
          (await voting.elections(1)).finalized
        ).to.equal(true);

        await expect(
          voting.revealVote(
            1,
            7n,
            888n
          )
        ).to.be.revertedWith(
          "Finalized"
        );
      }
    );

    it(
      "does not allow an unapproved election to activate",
      async function () {
        const now =
          (
            await ethers.provider.getBlock(
              "latest"
            )
          ).timestamp;

        await voting.proposeElection(
          "Unapproved",
          0,
          now + 10,
          now + 1000,
          [7n, 8n]
        );

        await advance(11);

        await expect(
          voting.activateElection(1)
        ).to.be.revertedWith(
          "Not approved"
        );
      }
    );

    it(
      "does not expose a threshold-changing function",
      async function () {
        expect(
          await voting.approvalThreshold()
        ).to.equal(2n);

        const functionNames =
          voting.interface.fragments
            .filter(
              fragment =>
                fragment.type === "function"
            )
            .map(
              fragment =>
                fragment.name
            );

        expect(
          functionNames
        ).to.not.include(
          "setApprovalThreshold"
        );

        expect(
          functionNames
        ).to.not.include(
          "proposeThresholdChange"
        );
      }
    );
  }
);