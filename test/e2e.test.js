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

function asBigInt(value) {
  return BigInt(value.toString());
}

function hash(values) {
  return asBigInt(
    F.toObject(
      poseidon(values.map(BigInt))
    )
  );
}

function eligibilityMerkleTree(leaves) {
  let level = Array.from(
    { length: 8 },
    (_, i) => BigInt(leaves[i] || 0)
  );

  const levels = [level];

  while (level.length > 1) {
    const next = [];

    for (let i = 0; i < level.length; i += 2) {
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

      let position = Number(index);

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

function candidateMerkleTree(candidateIds) {
  const sorted = [...candidateIds]
    .map(BigInt)
    .sort(
      (a, b) =>
        a < b ? -1 :
        a > b ? 1 : 0
    );

  if (
    sorted.length === 0 ||
    sorted.length > 8
  ) {
    throw new Error(
      "candidateIds must contain 1..8 ids"
    );
  }

  if (
    sorted.some(
      (id) => id === 0n
    )
  ) {
    throw new Error(
      "candidate id cannot be zero"
    );
  }

  for (
    let i = 1;
    i < sorted.length;
    i += 1
  ) {
    if (
      sorted[i] === sorted[i - 1]
    ) {
      throw new Error(
        "duplicate candidate id"
      );
    }
  }

  let level = Array.from(
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
          (id) =>
            id === BigInt(candidateId)
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
          levels[depth][
            position ^ 1
          ]
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
  candidateIds
}) {
  const eligibility =
    eligibilityMerkleTree(
      leaves
    );

  const eligibilityPath =
    eligibility.pathFor(
      participantIndex
    );

  const candidates =
    candidateMerkleTree(
      candidateIds
    );

  const candidatePath =
    candidates.pathFor(
      candidateChoice
    );

  const scopeRoot =
    hash([
      eligibility.root,
      candidates.root
    ]);

  /*
   * IMPORTANT:
   *
   * These are the EXACT signal names
   * used by the working VoteValidity circuit.
   */
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
        (x) => x.toString()
      ),

    eligibilityPathIndices:
      eligibilityPath.indices.map(
        (x) => x.toString()
      ),

    candidateRoot:
      candidates.root.toString(),

    candidatePathElements:
      candidatePath.siblings.map(
        (x) => x.toString()
      ),

    candidatePathIndices:
      candidatePath.indices.map(
        (x) => x.toString()
      ),

    scopeRoot:
      scopeRoot.toString()
  };

  console.log(
    "\nGenerating ZK proof..."
  );

  const {
    proof,
    publicSignals
  } =
    await snarkjs.groth16.fullProve(
      input,
      WASM,
      ZKEY
    );

  console.log(
    "✅ ZK proof generated"
  );

  const calldata =
    await snarkjs.groth16.exportSolidityCallData(
      proof,
      publicSignals
    );

  const [
    a,
    b,
    c,
    signals
  ] =
    JSON.parse(
      `[${calldata}]`
    );

  return {
    a,
    b,
    c,
    signals,

    eligibilityRoot:
      eligibility.root,

    candidateRoot:
      candidates.root,

    scopeRoot,

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
  "ZKVoting end-to-end",
  function () {

    let voting;

    let gov1;
    let gov2;

    let voter;

    before(async function () {
      poseidon =
        await circomlib.buildPoseidon();

      F =
        poseidon.F;
    });

    async function deploy() {
      [
        gov1,
        gov2,
        voter
      ] =
        await ethers.getSigners();

      // ----------------------------------------------------------
      // Poseidon library
      // ----------------------------------------------------------

      const poseidonFactory =
        await ethers.getContractFactory(
          "PoseidonT3"
        );

      const poseidonLibrary =
        await poseidonFactory.deploy();

      await poseidonLibrary.waitForDeployment();

      // ----------------------------------------------------------
      // Groth16 verifier
      // ----------------------------------------------------------

      const verifierFactory =
        await ethers.getContractFactory(
          "Groth16Verifier"
        );

      const verifier =
        await verifierFactory.deploy();

      await verifier.waitForDeployment();

      // ----------------------------------------------------------
      // ZKVoting
      // ----------------------------------------------------------

      const votingFactory =
        await ethers.getContractFactory(
          "ZKVoting",
          {
            libraries: {
              PoseidonT3:
                await poseidonLibrary.getAddress()
            }
          }
        );

      voting =
        await votingFactory.deploy(
          await verifier.getAddress(),
          [
            gov1.address,
            gov2.address
          ],
          2
        );

      await voting.waitForDeployment();
    }

    it(
      "completes a full election lifecycle",
      async function () {

        // ========================================================
        // 1. DEPLOY
        // ========================================================

        await deploy();

        // ========================================================
        // 2. BASIC DATA
        // ========================================================

        const credential =
          123456789n;

        const candidateIds = [
          1n,
          2n
        ];

        // ========================================================
        // 3. CREATE ELECTION
        // ========================================================

        const block =
          await ethers.provider.getBlock(
            "latest"
          );

        const now =
          Number(block.timestamp);

        const startTime =
          now + 10;

        const endTime =
          now + 120;

        await voting.proposeElection(
          "Ethiopia National Election",
          0,
          startTime,
          endTime,
          candidateIds
        );

        const nextId =
          await voting.nextElectionId();

        const electionId =
          nextId - 1n;

        console.log(
          `\nElection ID: ${electionId}`
        );

        // ========================================================
        // 4. REGISTER PARTICIPANT
        // ========================================================

        const credentialLeaf =
          hash([
            credential
          ]);

        const nullifierHash =
          hash([
            credential,
            electionId
          ]);

        await voting.registerParticipant(
          electionId,
          voter.address,
          credentialLeaf,
          nullifierHash
        );

        expect(
          await voting.getParticipantCount(
            electionId
          )
        ).to.equal(1);

        console.log(
          "✅ Participant registered"
        );

        // ========================================================
        // 5. GET ACTUAL ON-CHAIN LEAVES
        // ========================================================

        const onChainLeaves =
          await voting.getEligibilityLeaves(
            electionId
          );

        const leaves =
          onChainLeaves.map(
            (x) => BigInt(x)
          );

        // ========================================================
        // 6. VERIFY LOCAL ELIGIBILITY ROOT
        // ========================================================

        const eligibility =
          eligibilityMerkleTree(
            leaves
          );

        const electionBeforeApproval =
          await voting.elections(
            electionId
          );

        expect(
          BigInt(
            electionBeforeApproval
              .eligibilityRoot
          )
        ).to.equal(
          eligibility.root
        );

        // ========================================================
        // 7. GOVERNANCE APPROVAL
        // ========================================================

        await voting
          .connect(gov1)
          .approveElection(
            electionId
          );

        await voting
          .connect(gov2)
          .approveElection(
            electionId
          );

        const approved =
          await voting.elections(
            electionId
          );

        expect(
          approved.proposalApproved
        ).to.equal(true);

        console.log(
          "✅ Election approved"
        );

        // ========================================================
        // 8. WAIT FOR START
        // ========================================================

        await ethers.provider.send(
          "evm_increaseTime",
          [11]
        );

        await ethers.provider.send(
          "evm_mine"
        );

        // ========================================================
        // 9. ACTIVATE
        // ========================================================

        await voting.activateElection(
          electionId
        );

        const active =
          await voting.elections(
            electionId
          );

        expect(
          active.votingStarted
        ).to.equal(true);

        console.log(
          "✅ Election activated"
        );

        // ========================================================
        // 10. BUILD VALID ZK BALLOT
        // ========================================================

        const candidateChoice =
          1n;

        const voteSalt =
          987654321n;

        const ballot =
          await makeBallot({
            credential,
            electionId,
            candidateChoice,
            voteSalt,
            leaves,
            participantIndex: 0,
            candidateIds
          });

        // ========================================================
        // 11. VERIFY ROOTS MATCH CONTRACT
        // ========================================================

        const electionForRoots =
          await voting.elections(
            electionId
          );

        expect(
          ballot.eligibilityRoot
        ).to.equal(
          BigInt(
            electionForRoots
              .eligibilityRoot
          )
        );

        expect(
          ballot.candidateRoot
        ).to.equal(
          BigInt(
            electionForRoots
              .candidateRoot
          )
        );

        // ========================================================
        // 12. CAST PRIVATE VOTE
        // ========================================================

        console.log(
          "Casting private vote..."
        );

        await voting
          .connect(voter)
          .castPrivateVote(
            electionId,
            ballot.a,
            ballot.b,
            ballot.c,
            ballot.signals
          );

        const afterVote =
          await voting.elections(
            electionId
          );

        expect(
          afterVote.acceptedBallots
        ).to.equal(1);

        console.log(
          "✅ Private vote accepted"
        );

        // ========================================================
        // 13. WAIT UNTIL ELECTION ENDS
        // ========================================================

        await ethers.provider.send(
          "evm_increaseTime",
          [120]
        );

        await ethers.provider.send(
          "evm_mine"
        );

        // ========================================================
        // 14. END ELECTION
        // ========================================================

        await voting.endElection(
          electionId
        );

        const ended =
          await voting.elections(
            electionId
          );

        expect(
          ended.ended
        ).to.equal(true);

        console.log(
          "✅ Election ended"
        );

        // ========================================================
        // 15. REVEAL
        // ========================================================

        await voting.revealVote(
          electionId,
          candidateChoice,
          voteSalt
        );

        const revealed =
          await voting.elections(
            electionId
          );

        expect(
          revealed.revealedBallots
        ).to.equal(1);

        const voteCount =
          await voting.getVoteCount(
            electionId,
            candidateChoice
          );

        expect(
          voteCount
        ).to.equal(1);

        console.log(
          "✅ Vote revealed and counted"
        );

        // ========================================================
        // 16. WAIT FOR REVEAL DEADLINE
        // ========================================================

        await ethers.provider.send(
          "evm_increaseTime",
          [
            7 * 24 * 60 * 60
          ]
        );

        await ethers.provider.send(
          "evm_mine"
        );

        // ========================================================
        // 17. FINALIZE
        // ========================================================

        await voting.finalizeElection(
          electionId
        );

        const finalized =
          await voting.elections(
            electionId
          );

        expect(
          finalized.finalized
        ).to.equal(true);

        console.log(
          "\n=========================================="
        );

        console.log(
          "✅ COMPLETE ELECTION LIFECYCLE PASSED"
        );

        console.log(
          "==========================================\n"
        );
      }
    );
  }
);