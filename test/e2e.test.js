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

function buildMerkleTree(leaves) {
  if (leaves.length !== 8) {
    throw new Error("Expected 8 leaves");
  }

  const tree = [[...leaves]];

  for (let level = 0; level < 3; level++) {
    const current = tree[level];
    const next = [];

    for (let i = 0; i < current.length; i += 2) {
      next.push(
        hash([
          current[i],
          current[i + 1]
        ])
      );
    }

    tree.push(next);
  }

  return tree;
}

function getMerklePath(tree, index) {
  const pathElements = [];
  const pathIndices = [];

  let currentIndex = index;

  for (let level = 0; level < 3; level++) {
    const siblingIndex =
      currentIndex % 2 === 0
        ? currentIndex + 1
        : currentIndex - 1;

    pathElements.push(
      tree[level][siblingIndex]
    );

    pathIndices.push(
      currentIndex % 2
    );

    currentIndex =
      Math.floor(currentIndex / 2);
  }

  return {
    pathElements,
    pathIndices
  };
}

async function deployVoting(signers) {
  const verifierFactory =
    await ethers.getContractFactory(
      "Groth16Verifier"
    );

  const verifier =
    await verifierFactory.deploy();

  await verifier.waitForDeployment();

  const poseidonFactory =
    await ethers.getContractFactory(
      "PoseidonT3"
    );

  const poseidonLibrary =
    await poseidonFactory.deploy();

  await poseidonLibrary.waitForDeployment();

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

  const governanceMembers = [
    signers[0].address,
    signers[1].address,
    signers[2].address
  ];

  const voting =
    await votingFactory.deploy(
      await verifier.getAddress(),
      governanceMembers,
      2n
    );

  await voting.waitForDeployment();

  return {
    voting,
    verifier
  };
}

describe("ZKVoting end-to-end", function () {
  this.timeout(120000);

  let creator;
  let voter;
  let voter2;
  let attacker;
  let alice;
  let bob;

  let voting;
  let electionId;

  const credential = 123456789n;
  const credential2 = 987654321n;
  const candidateChoice = 1n;
  const voteSalt = 111222333n;

  before(async function () {
    poseidon =
      await circomlib.buildPoseidon();

    F = poseidon.F;
  });

  beforeEach(async function () {
    const signers =
      await ethers.getSigners();

    creator = signers[0];
    voter = signers[1];
    voter2 = signers[2];
    alice = signers[3];
    bob = signers[4];
    attacker = signers[5];

    const deployed =
      await deployVoting(signers);

    voting = deployed.voting;

    electionId = 1n;

    const latest =
      await ethers.provider.getBlock(
        "latest"
      );

    const start =
      BigInt(latest.timestamp + 20);

    const end =
      BigInt(latest.timestamp + 120);

    await voting
      .connect(creator)
      .createVote(
        "E2E Test",
        "End to end ZK vote",
        start,
        end,
        [
          {
            id: 1n,
            candidateAddress:
              alice.address,
            name: "Alice"
          },
          {
            id: 2n,
            candidateAddress:
              bob.address,
            name: "Bob"
          }
        ]
      );

    await voting
      .connect(creator)
      .registerParticipant(
        electionId,
        voter.address,
        hash([credential]),
        hash([
          credential,
          electionId
        ])
      );

    await voting
      .connect(creator)
      .registerParticipant(
        electionId,
        voter2.address,
        hash([credential2]),
        hash([
          credential2,
          electionId
        ])
      );
  });

  async function activateVote() {
    const times =
      await voting.getVoteTimes(
        electionId
      );

    await ethers.provider.send(
      "evm_setNextBlockTimestamp",
      [
        Number(times[0])
      ]
    );

    await ethers.provider.send(
      "evm_mine"
    );

    await voting
      .connect(attacker)
      .activateVote(
        electionId
      );
  }

  async function generateProof({
    credentialValue = credential,
    candidate = candidateChoice,
    salt = voteSalt,
    participantIndex = 0
  } = {}) {
    const leavesRaw =
      await voting.getEligibilityLeaves(
        electionId
      );

    const eligibilityLeaves =
      leavesRaw.map(
        x => BigInt(x.toString())
      );

    const eligibilityTree =
      buildMerkleTree(
        eligibilityLeaves
      );

    const roots =
      await voting.getVoteRoots(
        electionId
      );

    const eligibilityRoot =
      BigInt(
        roots[0].toString()
      );

    const candidateRoot =
      BigInt(
        roots[1].toString()
      );

    const eligibilityPath =
      getMerklePath(
        eligibilityTree,
        participantIndex
      );

    const candidateLeaves = [
      hash([1n, 0n]),
      hash([2n, 0n]),
      0n,
      0n,
      0n,
      0n,
      0n,
      0n
    ];

    const candidateTree =
      buildMerkleTree(
        candidateLeaves
      );

    const candidateIndex =
      candidate === 1n
        ? 0
        : 1;

    const candidatePath =
      getMerklePath(
        candidateTree,
        candidateIndex
      );

    const scopeRoot =
      hash([
        eligibilityRoot,
        candidateRoot
      ]);

    const input = {
      credential:
        credentialValue.toString(),

      electionId:
        electionId.toString(),

      candidateChoice:
        candidate.toString(),

      voteSalt:
        salt.toString(),

      eligibilityPathElements:
        eligibilityPath.pathElements.map(
          x => x.toString()
        ),

      eligibilityPathIndices:
        eligibilityPath.pathIndices.map(
          x => x.toString()
        ),

      eligibilityRoot:
        eligibilityRoot.toString(),

      candidatePathElements:
        candidatePath.pathElements.map(
          x => x.toString()
        ),

      candidatePathIndices:
        candidatePath.pathIndices.map(
          x => x.toString()
        ),

      candidateRoot:
        candidateRoot.toString(),

      scopeRoot:
        scopeRoot.toString()
    };

    const result =
      await snarkjs.groth16.fullProve(
        input,
        WASM,
        ZKEY
      );

    return {
      a: [
        BigInt(result.proof.pi_a[0]),
        BigInt(result.proof.pi_a[1])
      ],

      b: [
        [
          BigInt(result.proof.pi_b[0][1]),
          BigInt(result.proof.pi_b[0][0])
        ],
        [
          BigInt(result.proof.pi_b[1][1]),
          BigInt(result.proof.pi_b[1][0])
        ]
      ],

      c: [
        BigInt(result.proof.pi_c[0]),
        BigInt(result.proof.pi_c[1])
      ],

      publicSignals:
        result.publicSignals.map(
          x => BigInt(x)
        )
    };
  }

  it(
    "allows a normal wallet to create a vote",
    async function () {
      const latest =
        await ethers.provider.getBlock(
          "latest"
        );

      const start =
        BigInt(
          latest.timestamp + 30
        );

      const end =
        BigInt(
          latest.timestamp + 150
        );

      await voting
        .connect(voter)
        .createVote(
          "Student Council",
          "Choose a representative",
          start,
          end,
          [
            {
              id: 1n,
              candidateAddress:
                alice.address,
              name: "Candidate A"
            },
            {
              id: 2n,
              candidateAddress:
                bob.address,
              name: "Candidate B"
            }
          ]
        );

      expect(
        await voting.nextElectionId()
      ).to.equal(3n);
    }
  );

  it(
    "allows the creator to register eligible participants before voting",
    async function () {
      const newCredential = 777777n;

      await voting
        .connect(creator)
        .registerParticipant(
          electionId,
          attacker.address,
          hash([newCredential]),
          hash([
            newCredential,
            electionId
          ])
        );

      expect(
        await voting.registeredParticipant(
          electionId,
          attacker.address
        )
      ).to.equal(true);
    }
  );

  it(
    "prevents participant registration after voting starts",
    async function () {
      await activateVote();

      await expect(
        voting
          .connect(creator)
          .registerParticipant(
            electionId,
            attacker.address,
            hash([777777n]),
            hash([
              777777n,
              electionId
            ])
          )
      ).to.be.revertedWith(
        "Voting already started"
      );
    }
  );

  it(
    "accepts a valid ZK vote from a registered participant",
    async function () {
      await activateVote();

      const proof =
        await generateProof();

      await voting
        .connect(voter)
        .castPrivateVote(
          electionId,
          proof.a,
          proof.b,
          proof.c,
          proof.publicSignals
        );
    }
  );

  it(
    "rejects the same nullifier twice",
    async function () {
      await activateVote();

      const proof =
        await generateProof();

      await voting
        .connect(voter)
        .castPrivateVote(
          electionId,
          proof.a,
          proof.b,
          proof.c,
          proof.publicSignals
        );

      await expect(
        voting
          .connect(voter)
          .castPrivateVote(
            electionId,
            proof.a,
            proof.b,
            proof.c,
            proof.publicSignals
          )
      ).to.be.revertedWith(
        "Nullifier already used"
      );
    }
  );

  it(
    "rejects an unregistered wallet with a valid proof",
    async function () {
      await activateVote();

      const proof =
        await generateProof();

      await expect(
        voting
          .connect(attacker)
          .castPrivateVote(
            electionId,
            proof.a,
            proof.b,
            proof.c,
            proof.publicSignals
          )
      ).to.be.revertedWith(
        "Not registered"
      );
    }
  );

  it(
    "rejects a malformed proof",
    async function () {
      await activateVote();

      const proof =
        await generateProof();

      proof.a[0] =
        proof.a[0] + 1n;

      await expect(
        voting
          .connect(voter)
          .castPrivateVote(
            electionId,
            proof.a,
            proof.b,
            proof.c,
            proof.publicSignals
          )
      ).to.be.reverted;
    }
  );

  it(
    "rejects an invalid candidate during reveal",
    async function () {
      await activateVote();

      const times =
        await voting.getVoteTimes(
          electionId
        );

      await ethers.provider.send(
        "evm_setNextBlockTimestamp",
        [
          Number(times[1])
        ]
      );

      await ethers.provider.send(
        "evm_mine"
      );

      await voting
        .connect(attacker)
        .endVote(
          electionId
        );

      await expect(
        voting
          .connect(attacker)
          .revealVote(
            electionId,
            999n,
            voteSalt
          )
      ).to.be.revertedWith(
        "Invalid candidate"
      );
    }
  );

  it(
    "allows a non-creator to end the vote",
    async function () {
      await activateVote();

      const times =
        await voting.getVoteTimes(
          electionId
        );

      await ethers.provider.send(
        "evm_setNextBlockTimestamp",
        [
          Number(times[1])
        ]
      );

      await ethers.provider.send(
        "evm_mine"
      );

      await voting
        .connect(attacker)
        .endVote(
          electionId
        );
    }
  );

  it(
    "rejects finalization while the reveal period is active",
    async function () {
      await activateVote();

      const times =
        await voting.getVoteTimes(
          electionId
        );

      await ethers.provider.send(
        "evm_setNextBlockTimestamp",
        [
          Number(times[1])
        ]
      );

      await ethers.provider.send(
        "evm_mine"
      );

      await voting
        .connect(attacker)
        .endVote(
          electionId
        );

      await expect(
        voting
          .connect(attacker)
          .finalizeVote(
            electionId
          )
      ).to.be.revertedWith(
        "Reveal period active"
      );
    }
  );
});