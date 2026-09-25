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
    throw new Error(
      "Merkle tree must contain exactly 8 leaves"
    );
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

  const governanceThreshold = 2n;

  const voting =
    await votingFactory.deploy(
      await verifier.getAddress(),
      governanceMembers,
      governanceThreshold
    );

  await voting.waitForDeployment();

  return {
    voting,
    verifier
  };
}

describe("ZKVoting adversarial audit", function () {
  this.timeout(120000);

  let creator;
  let voter;
  let attacker;
  let alice;
  let bob;

  let voting;
  let verifier;

  let electionId;

  const credential =
    123456789n;

  const candidateChoice =
    1n;

  const voteSalt =
    987654321n;

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
    alice = signers[2];
    bob = signers[3];
    attacker = signers[4];

    const deployed =
      await deployVoting(signers);

    voting = deployed.voting;
    verifier = deployed.verifier;

    electionId = 1n;

    const latestBlock =
      await ethers.provider.getBlock(
        "latest"
      );

    const startTime =
      BigInt(
        latestBlock.timestamp + 10
      );

    const endTime =
      BigInt(
        latestBlock.timestamp + 100
      );

    await voting
      .connect(creator)
      .createVote(
        "Adversarial Test",
        "Security test vote",
        startTime,
        endTime,
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

    const realCredentialLeaf =
      hash([
        credential
      ]);

    const realNullifier =
      hash([
        credential,
        electionId
      ]);

    /*
     * Registration MUST happen before the vote starts.
     */
    await voting
      .connect(creator)
      .registerParticipant(
        electionId,
        voter.address,
        realCredentialLeaf,
        realNullifier
      );

    /*
     * IMPORTANT:
     *
     * Do NOT activate here.
     *
     * Several tests specifically test participant
     * registration before voting starts.
     */
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

  async function generateProof() {
    /*
     * The vote must be active before generating
     * the proof used by castPrivateVote.
     */
    await activateVote();

    const leavesRaw =
      await voting.getEligibilityLeaves(
        electionId
      );

    const eligibilityLeaves =
      leavesRaw.map(
        (x) => BigInt(x.toString())
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
        0
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

    const candidatePath =
      getMerklePath(
        candidateTree,
        0
      );

    const scopeRoot =
      hash([
        eligibilityRoot,
        candidateRoot
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

      eligibilityPathElements:
        eligibilityPath.pathElements.map(
          (x) => x.toString()
        ),

      eligibilityPathIndices:
        eligibilityPath.pathIndices.map(
          (x) => x.toString()
        ),

      eligibilityRoot:
        eligibilityRoot.toString(),

      candidatePathElements:
        candidatePath.pathElements.map(
          (x) => x.toString()
        ),

      candidatePathIndices:
        candidatePath.pathIndices.map(
          (x) => x.toString()
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

    const a = [
      BigInt(
        result.proof.pi_a[0]
      ),
      BigInt(
        result.proof.pi_a[1]
      )
    ];

    const b = [
      [
        BigInt(
          result.proof.pi_b[0][1]
        ),
        BigInt(
          result.proof.pi_b[0][0]
        )
      ],
      [
        BigInt(
          result.proof.pi_b[1][1]
        ),
        BigInt(
          result.proof.pi_b[1][0]
        )
      ]
    ];

    const c = [
      BigInt(
        result.proof.pi_c[0]
      ),
      BigInt(
        result.proof.pi_c[1]
      )
    ];

    const publicSignals =
      result.publicSignals.map(
        (x) => BigInt(x)
      );

    return {
      a,
      b,
      c,
      publicSignals
    };
  }

  it(
    "rejects an unregistered wallet even with a valid ZK proof",
    async function () {
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
    "allows the vote creator to register a participant",
    async function () {
      const newCredential =
        555555n;

      const newLeaf =
        hash([
          newCredential
        ]);

      const newNullifier =
        hash([
          newCredential,
          electionId
        ]);

      await voting
        .connect(creator)
        .registerParticipant(
          electionId,
          attacker.address,
          newLeaf,
          newNullifier
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
    "rejects a zero participant address",
    async function () {
      await expect(
        voting
          .connect(creator)
          .registerParticipant(
            electionId,
            ethers.ZeroAddress,
            hash([999n]),
            hash([
              999n,
              electionId
            ])
          )
      ).to.be.revertedWith(
        "Zero participant"
      );
    }
  );

  it(
    "rejects duplicate participant registration",
    async function () {
      await expect(
        voting
          .connect(creator)
          .registerParticipant(
            electionId,
            voter.address,
            hash([999n]),
            hash([
              999n,
              electionId
            ])
          )
      ).to.be.revertedWith(
        "Participant already registered"
      );
    }
  );

  it(
    "rejects zero credential",
    async function () {
      await expect(
        voting
          .connect(creator)
          .registerParticipant(
            electionId,
            attacker.address,
            0n,
            hash([
              555n,
              electionId
            ])
          )
      ).to.be.revertedWith(
        "Zero credential"
      );
    }
  );

  it(
    "rejects zero nullifier",
    async function () {
      await expect(
        voting
          .connect(creator)
          .registerParticipant(
            electionId,
            attacker.address,
            hash([555n]),
            0n
          )
      ).to.be.revertedWith(
        "Zero nullifier"
      );
    }
  );

  it(
    "rejects unauthorized participant registration",
    async function () {
      await expect(
        voting
          .connect(attacker)
          .registerParticipant(
            electionId,
            attacker.address,
            hash([777n]),
            hash([
              777n,
              electionId
            ])
          )
      ).to.be.revertedWith(
        "Not vote creator"
      );
    }
  );

  it(
    "allows a non-creator to activate the vote",
    async function () {
      await activateVote();

      const status =
        await voting.getVoteStatus(
          electionId
        );

      expect(status).to.not.equal(
        undefined
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

      const status =
        await voting.getVoteStatus(
          electionId
        );

      expect(status).to.not.equal(
        undefined
      );
    }
  );

  it(
    "rejects invalid candidate during reveal",
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
    "rejects finalization before the reveal deadline",
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