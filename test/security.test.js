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
const ZKEY = path.join(ROOT, "build/zk/VoteValidity.zkey");

const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let poseidon;
let F;

function asBigInt(value) {
  return BigInt(value.toString());
}

function hash(values) {
  return asBigInt(F.toObject(poseidon(values.map(BigInt))));
}

async function deployGovernanceVoting(memberAddresses, threshold) {
  const verifierFactory =
    await ethers.getContractFactory("Groth16Verifier");

  const verifier = await verifierFactory.deploy();
  await verifier.waitForDeployment();

  const poseidonFactory =
    await ethers.getContractFactory("PoseidonT3");

  const poseidonLibrary = await poseidonFactory.deploy();
  await poseidonLibrary.waitForDeployment();

  const votingFactory = await ethers.getContractFactory("ZKVoting", {
    libraries: {
      PoseidonT3: await poseidonLibrary.getAddress(),
    },
  });

  const voting = await votingFactory.deploy(
    await verifier.getAddress(),
    memberAddresses,
    threshold
  );

  await voting.waitForDeployment();

  return {
    voting,
    verifier,
    poseidonLibrary,
  };
}

function candidateMerkleTree(candidateIds) {
  const sorted = [...candidateIds]
    .map(BigInt)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (sorted.length === 0 || sorted.length > 8) {
    throw new Error("candidateIds must contain 1..8 ids");
  }

  if (sorted.some((id) => id === 0n)) {
    throw new Error("candidate id cannot be zero");
  }

  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]) {
      throw new Error("duplicate candidate id");
    }
  }

  let level = Array.from({ length: 8 }, (_, i) =>
    i < sorted.length ? hash([sorted[i], 0n]) : 0n
  );

  const levels = [level];

  while (level.length > 1) {
    const next = [];

    for (let i = 0; i < level.length; i += 2) {
      next.push(hash([level[i], level[i + 1]]));
    }

    level = next;
    levels.push(level);
  }

  return {
    root: level[0],

    pathFor(candidateId) {
      const index = sorted.findIndex(
        (id) => id === BigInt(candidateId)
      );

      if (index < 0) {
        throw new Error("candidate is not registered");
      }

      const siblings = [];
      const indices = [];

      let position = index;

      for (let depth = 0; depth < 3; depth += 1) {
        siblings.push(levels[depth][position ^ 1]);
        indices.push(position % 2);
        position = Math.floor(position / 2);
      }

      return {
        siblings,
        indices,
      };
    },
  };
}

function eligibilityPath(leaves, targetIndex) {
  let level = leaves.map(BigInt);
  let position = targetIndex;

  const siblings = [];
  const indices = [];

  while (level.length > 1) {
    siblings.push(level[position ^ 1]);
    indices.push(position % 2);

    const next = [];

    for (let i = 0; i < level.length; i += 2) {
      next.push(hash([level[i], level[i + 1]]));
    }

    level = next;
    position = Math.floor(position / 2);
  }

  return {
    siblings,
    indices,
  };
}

async function makeBallot({
  credential,
  electionId,
  candidateChoice,
  voteSalt,
  siblings,
  indices,
  candidateIds = [7n, 8n, 9n],
}) {
  let node = hash([credential]);

  for (let i = 0; i < siblings.length; i += 1) {
    node =
      indices[i] === 0
        ? hash([node, siblings[i]])
        : hash([siblings[i], node]);
  }

  const eligibilityRoot = node;

  const candidates = candidateMerkleTree(candidateIds);
  const candidatePath =
    candidates.pathFor(candidateChoice);

  const scopeRoot = hash([
    eligibilityRoot,
    candidates.root,
  ]);

  const input = {
    credential: credential.toString(),
    electionId: electionId.toString(),
    candidateChoice: candidateChoice.toString(),
    voteSalt: voteSalt.toString(),

    eligibilityRoot: eligibilityRoot.toString(),

    eligibilityPathElements: siblings.map((x) =>
      x.toString()
    ),

    eligibilityPathIndices: indices.map((x) =>
      x.toString()
    ),

    candidateRoot: candidates.root.toString(),

    candidatePathElements: candidatePath.siblings.map(
      (x) => x.toString()
    ),

    candidatePathIndices: candidatePath.indices.map(
      (x) => x.toString()
    ),

    scopeRoot: scopeRoot.toString(),
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

    eligibilityRoot,
    candidateRoot: candidates.root,
    scopeRoot,

    voteCommitment: hash([
      candidateChoice,
      voteSalt,
    ]),

    nullifierHash: hash([
      credential,
      electionId,
    ]),
  };
}

describe("ZKVoting security", function () {
  let voting;
  let governanceMember1;
  let governanceMember2;
  let governanceMember3;
  let attacker;

  let validBallot;

  const credential = 123456789n;

  before(async function () {
    poseidon = await circomlib.buildPoseidon();
    F = poseidon.F;

    expect(FIELD).to.equal(F.p);
  });

  beforeEach(async function () {
    [
      governanceMember1,
      governanceMember2,
      governanceMember3,
      attacker,
    ] = await ethers.getSigners();

    ({ voting } = await deployGovernanceVoting(
      [
        governanceMember1.address,
        governanceMember2.address,
        governanceMember3.address,
      ],
      2
    ));

    const now =
      (await ethers.provider.getBlock("latest"))
        .timestamp;

    await voting.proposeElection(
      "Federal council",
      hash([credential]),
      now + 10,
      now + 1000,
      [7n, 8n, 9n]
    );

    await voting.registerParticipant(
      1,
      governanceMember1.address,
      hash([credential]),
      hash([credential, 1n])
    );

    await voting
      .connect(governanceMember1)
      .approveElection(1);

    await voting
      .connect(governanceMember2)
      .approveElection(1);

    const leaves =
      await voting.getEligibilityLeaves(1);

    const path = eligibilityPath(leaves, 0);

    validBallot = await makeBallot({
      credential,
      electionId: 1n,
      candidateChoice: 7n,
      voteSalt: 888n,
      siblings: path.siblings,
      indices: path.indices,
    });

    expect(
      (await voting.elections(1)).candidateRoot
    ).to.equal(validBallot.candidateRoot);

    expect(
      await voting.getElectionCandidates(1)
    ).to.deep.equal([7n, 8n, 9n]);
  });

  async function activate() {
    await ethers.provider.send(
      "evm_increaseTime",
      [11]
    );

    await ethers.provider.send("evm_mine");

    await voting.activateElection(1);
  }

  it(
    "rejects unauthorized approval and invalid election parameters",
    async function () {
      await expect(
        voting
          .connect(attacker)
          .approveElection(1)
      ).to.be.revertedWith(
        "Not governance member"
      );

      const now =
        (await ethers.provider.getBlock("latest"))
          .timestamp;

      await expect(
        voting.proposeElection(
          "bad",
          1,
          now + 200,
          now + 100,
          [7n]
        )
      ).to.be.revertedWith(
        "Invalid time range"
      );
    }
  );

  it(
    "requires the configured threshold before approving an election",
    async function () {
      const now =
        (await ethers.provider.getBlock("latest"))
          .timestamp;

      await voting.proposeElection(
        "Second council",
        hash([999n]),
        now + 10,
        now + 1000,
        [7n, 8n, 9n]
      );

      await voting
        .connect(governanceMember1)
        .approveElection(2);

      expect(
        (await voting.elections(2))
          .proposalApproved
      ).to.equal(false);

      expect(
        await voting.electionApprovalCount(2)
      ).to.equal(1n);

      await voting
        .connect(governanceMember2)
        .approveElection(2);

      expect(
        (await voting.elections(2))
          .proposalApproved
      ).to.equal(true);

      expect(
        await voting.electionApprovalCount(2)
      ).to.equal(2n);
    }
  );

  it(
    "rejects duplicate approval and approval of an already-approved election",
    async function () {
      const now =
        (await ethers.provider.getBlock("latest"))
          .timestamp;

      await voting.proposeElection(
        "Third council",
        hash([999n]),
        now + 10,
        now + 1000,
        [7n, 8n, 9n]
      );

      await voting
        .connect(governanceMember1)
        .approveElection(2);

      await expect(
        voting
          .connect(governanceMember1)
          .approveElection(2)
      ).to.be.revertedWith(
        "Already approved by member"
      );

      await expect(
        voting
          .connect(governanceMember1)
          .approveElection(1)
      ).to.be.revertedWith(
        "Already approved"
      );
    }
  );

  it(
    "requires threshold approval for membership changes",
    async function () {
      await expect(
        voting
          .connect(attacker)
          .proposeGovernanceMemberChange(
            attacker.address,
            true
          )
      ).to.be.revertedWith(
        "Not governance member"
      );

      await voting
        .connect(governanceMember1)
        .proposeGovernanceMemberChange(
          attacker.address,
          true
        );

      expect(
        await voting.isGovernanceMember(
          attacker.address
        )
      ).to.equal(false);

      await voting
        .connect(governanceMember1)
        .approveGovernanceMemberChange(1);

      expect(
        await voting.isGovernanceMember(
          attacker.address
        )
      ).to.equal(false);

      expect(
        (await voting.governanceChanges(1))
          .approvalCount
      ).to.equal(1n);

      await voting
        .connect(governanceMember2)
        .approveGovernanceMemberChange(1);

      expect(
        await voting.isGovernanceMember(
          attacker.address
        )
      ).to.equal(true);

      expect(
        (await voting.governanceChanges(1))
          .executed
      ).to.equal(true);
    }
  );

  it(
    "allows governed removal without dropping below the threshold",
    async function () {
      await voting
        .connect(governanceMember1)
        .proposeGovernanceMemberChange(
          governanceMember3.address,
          false
        );

      await voting
        .connect(governanceMember1)
        .approveGovernanceMemberChange(1);

      await voting
        .connect(governanceMember2)
        .approveGovernanceMemberChange(1);

      expect(
        await voting.isGovernanceMember(
          governanceMember3.address
        )
      ).to.equal(false);

      expect(
        await voting.governanceMembers(0)
      ).to.equal(
        governanceMember1.address
      );

      expect(
        await voting.governanceMembers(1)
      ).to.equal(
        governanceMember2.address
      );

      await expect(
        voting
          .connect(governanceMember3)
          .proposeGovernanceMemberChange(
            attacker.address,
            true
          )
      ).to.be.revertedWith(
        "Not governance member"
      );
    }
  );

  it(
    "rejects voting before activation and with a fake proof",
    async function () {
      const zeroA = [0, 0];

      const zeroB = [
        [0, 0],
        [0, 0],
      ];

      const zeroC = [0, 0];

      await expect(
        voting.castPrivateVote(
          1,
          zeroA,
          zeroB,
          zeroC,
          validBallot.signals
        )
      ).to.be.revertedWith(
        "Not active"
      );

      await activate();

      await expect(
        voting.castPrivateVote(
          1,
          zeroA,
          zeroB,
          zeroC,
          validBallot.signals
        )
      ).to.be.revertedWith(
        "Invalid ZK proof"
      );
    }
  );

  it(
    "accepts a real Groth16 proof and exposes no candidate in VoteAccepted",
    async function () {
      await activate();

      const tx =
        await voting.castPrivateVote(
          1,
          validBallot.a,
          validBallot.b,
          validBallot.c,
          validBallot.signals
        );

      const receipt = await tx.wait();

      const parsed = receipt.logs
        .map((log) => {
          try {
            return voting.interface.parseLog(log);
          } catch (_) {
            return null;
          }
        })
        .find(
          (log) =>
            log &&
            log.name === "VoteAccepted"
        );

      expect(
        parsed.args.electionId
      ).to.equal(1n);

      expect(
        parsed.args.nullifierHash
      ).to.equal(
        validBallot.nullifierHash
      );

      expect(
        parsed.args.voteCommitment
      ).to.equal(
        validBallot.voteCommitment
      );

      expect(parsed.args.length).to.equal(3);

      expect(
        await voting.nullifierUsed(
          1,
          validBallot.nullifierHash
        )
      ).to.equal(true);

      expect(
        (await voting.elections(1))
          .acceptedBallots
      ).to.equal(1n);
    }
  );

  it(
    "rejects a duplicate nullifier even when the second proof is otherwise valid",
    async function () {
      await activate();

      await voting.castPrivateVote(
        1,
        validBallot.a,
        validBallot.b,
        validBallot.c,
        validBallot.signals
      );

      const leaves =
        await voting.getEligibilityLeaves(1);

      const path = eligibilityPath(
        leaves,
        0
      );

      const second =
        await makeBallot({
          credential,
          electionId: 1n,
          candidateChoice: 8n,
          voteSalt: 999n,
          siblings: path.siblings,
          indices: path.indices,
        });

      expect(
        second.nullifierHash
      ).to.equal(
        validBallot.nullifierHash
      );

      await expect(
        voting.castPrivateVote(
          1,
          second.a,
          second.b,
          second.c,
          second.signals
        )
      ).to.be.revertedWith(
        "Already voted"
      );
    }
  );

  it(
    "rejects a proof whose public root does not match the election",
    async function () {
      await activate();

      const badSignals = [
        ...validBallot.signals,
      ];

      badSignals[3] =
        badSignals[3] === 0
          ? 1
          : 0;

      await expect(
        voting.castPrivateVote(
          1,
          validBallot.a,
          validBallot.b,
          validBallot.c,
          badSignals
        )
      ).to.be.revertedWith(
        "Wrong scope root"
      );
    }
  );

  it(
    "binds a proof to its election and rejects replay across elections",
    async function () {
      const now =
        (await ethers.provider.getBlock("latest"))
          .timestamp;

      await voting.proposeElection(
        "Second council",
        hash([999n]),
        now + 10,
        now + 1000,
        [7n, 8n, 9n]
      );

      await voting.registerParticipant(
        2,
        governanceMember1.address,
        hash([credential]),
        hash([credential, 2n])
      );

      await voting
        .connect(governanceMember1)
        .approveElection(2);

      await voting
        .connect(governanceMember2)
        .approveElection(2);

      const leaves =
        await voting.getEligibilityLeaves(2);

      const path = eligibilityPath(
        leaves,
        0
      );

      const election2Ballot =
        await makeBallot({
          credential,
          electionId: 2n,
          candidateChoice: 7n,
          voteSalt: 777n,
          siblings: path.siblings,
          indices: path.indices,
        });

      await ethers.provider.send(
        "evm_increaseTime",
        [11]
      );

      await ethers.provider.send("evm_mine");

      await voting.activateElection(2);

      const badSignals = [
        ...election2Ballot.signals,
      ];

      badSignals[2] = 1;

      await expect(
        voting.castPrivateVote(
          2,
          election2Ballot.a,
          election2Ballot.b,
          election2Ballot.c,
          badSignals
        )
      ).to.be.revertedWith(
        "Wrong election signal"
      );
    }
  );

  it(
    "does not end an election early and blocks votes after ending",
    async function () {
      await activate();

      await expect(
        voting.endElection(1)
      ).to.be.revertedWith(
        "Election not finished"
      );

      await ethers.provider.send(
        "evm_increaseTime",
        [1001]
      );

      await ethers.provider.send("evm_mine");

      await voting.endElection(1);

      await expect(
        voting.castPrivateVote(
          1,
          validBallot.a,
          validBallot.b,
          validBallot.c,
          validBallot.signals
        )
      ).to.be.revertedWith(
        "Voting closed"
      );
    }
  );

  it(
    "keeps tallying separate from private casting and rejects unknown/double reveals",
    async function () {
      await activate();

      await voting.castPrivateVote(
        1,
        validBallot.a,
        validBallot.b,
        validBallot.c,
        validBallot.signals
      );

      await ethers.provider.send(
        "evm_increaseTime",
        [1001]
      );

      await ethers.provider.send("evm_mine");

      await voting.endElection(1);

      await expect(
        voting.revealVote(
          1,
          999,
          111
        )
      ).to.be.revertedWith(
        "Candidate not registered"
      );

      await voting.revealVote(
        1,
        7,
        888
      );

      expect(
        await voting.getVoteCount(1, 7)
      ).to.equal(1n);

      await expect(
        voting.revealVote(
          1,
          7,
          888
        )
      ).to.be.revertedWith(
        "Already revealed"
      );
    }
  );
});

describe("ZKVoting governance constructor", function () {
  it(
    "rejects invalid thresholds and invalid governance member lists",
    async function () {
      const [
        member1,
        member2,
      ] = await ethers.getSigners();

      await expect(
        deployGovernanceVoting(
          [member1.address],
          0
        )
      ).to.be.revertedWith(
        "Invalid threshold"
      );

      await expect(
        deployGovernanceVoting(
          [member1.address],
          2
        )
      ).to.be.revertedWith(
        "Invalid threshold"
      );

      await expect(
        deployGovernanceVoting([], 1)
      ).to.be.revertedWith(
        "No governance members"
      );

      await expect(
        deployGovernanceVoting(
          [ethers.ZeroAddress],
          1
        )
      ).to.be.revertedWith(
        "Zero member"
      );

      await expect(
        deployGovernanceVoting(
          [
            member1.address,
            member1.address,
          ],
          1
        )
      ).to.be.revertedWith(
        "Duplicate member"
      );

      expect(member2.address).to.not.equal(
        member1.address
      );
    }
  );
});
