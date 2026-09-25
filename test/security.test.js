const { expect } = require("chai");
const { ethers } = require("hardhat");

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

describe("ZKVoting security", function () {
  this.timeout(120000);

  let creator;
  let member2;
  let member3;
  let attacker;
  let candidateA;
  let candidateB;

  let voting;
  let electionId;

  beforeEach(async function () {
    const signers =
      await ethers.getSigners();

    creator = signers[0];
    member2 = signers[1];
    member3 = signers[2];
    candidateA = signers[3];
    candidateB = signers[4];
    attacker = signers[5];

    const deployed =
      await deployVoting(signers);

    voting =
      deployed.voting;

    electionId = 1n;
  });

  async function createVote() {
    const latest =
      await ethers.provider.getBlock(
        "latest"
      );

    const start =
      BigInt(
        latest.timestamp + 20
      );

    const end =
      BigInt(
        latest.timestamp + 120
      );

    await voting
      .connect(creator)
      .createVote(
        "Security Vote",
        "Security test",
        start,
        end,
        [
          {
            id: 1n,
            candidateAddress:
              candidateA.address,
            name: "Candidate A"
          },
          {
            id: 2n,
            candidateAddress:
              candidateB.address,
            name: "Candidate B"
          }
        ]
      );
  }

  async function createVoteWithParticipant() {
    await createVote();

    /*
     * The current contract requires at least
     * one registered participant before
     * activateVote() can succeed.
     */
    await voting
      .connect(creator)
      .registerParticipant(
        electionId,
        attacker.address,
        123n,
        456n
      );
  }

  async function moveToStartAndActivate() {
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

  async function moveToEnd() {
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
  }

  it(
    "deploys with the configured governance members",
    async function () {
      const members =
        await voting.getGovernanceMembers();

      expect(members.length).to.equal(3);

      expect(
        await voting.isGovernanceMember(
          creator.address
        )
      ).to.equal(true);

      expect(
        await voting.isGovernanceMember(
          member2.address
        )
      ).to.equal(true);

      expect(
        await voting.isGovernanceMember(
          member3.address
        )
      ).to.equal(true);

      expect(
        await voting.governanceThreshold()
      ).to.equal(2n);
    }
  );

  it(
    "allows a normal wallet to create a vote",
    async function () {
      await createVote();

      expect(
        await voting.nextElectionId()
      ).to.equal(2n);
    }
  );

  it(
    "rejects a zero verifier at deployment",
    async function () {
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

      await expect(
        votingFactory.deploy(
          ethers.ZeroAddress,
          [
            creator.address,
            member2.address,
            member3.address
          ],
          2n
        )
      ).to.be.revertedWith(
        "Zero verifier"
      );
    }
  );

  it(
    "rejects an empty governance member set",
    async function () {
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

      await expect(
        votingFactory.deploy(
          await verifier.getAddress(),
          [],
          1n
        )
      ).to.be.revertedWith(
        "No governance members"
      );
    }
  );

  it(
    "rejects an invalid governance threshold",
    async function () {
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

      await expect(
        votingFactory.deploy(
          await verifier.getAddress(),
          [
            creator.address,
            member2.address,
            member3.address
          ],
          4n
        )
      ).to.be.revertedWith(
        "Invalid governance threshold"
      );
    }
  );

  it(
    "does not allow an unrelated wallet to register participants",
    async function () {
      await createVote();

      await expect(
        voting
          .connect(attacker)
          .registerParticipant(
            electionId,
            attacker.address,
            123n,
            456n
          )
      ).to.be.revertedWith(
        "Not vote creator"
      );
    }
  );

  it(
    "allows the creator to register a participant",
    async function () {
      await createVote();

      await voting
        .connect(creator)
        .registerParticipant(
          electionId,
          attacker.address,
          123n,
          456n
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
    "rejects registration after the vote has started",
    async function () {
      await createVoteWithParticipant();

      await moveToStartAndActivate();

      await expect(
        voting
          .connect(creator)
          .registerParticipant(
            electionId,
            member3.address,
            789n,
            999n
          )
      ).to.be.revertedWith(
        "Voting already started"
      );
    }
  );

  it(
    "rejects a zero participant address",
    async function () {
      await createVote();

      await expect(
        voting
          .connect(creator)
          .registerParticipant(
            electionId,
            ethers.ZeroAddress,
            123n,
            456n
          )
      ).to.be.revertedWith(
        "Zero participant"
      );
    }
  );

  it(
    "rejects a zero credential",
    async function () {
      await createVote();

      await expect(
        voting
          .connect(creator)
          .registerParticipant(
            electionId,
            attacker.address,
            0n,
            456n
          )
      ).to.be.revertedWith(
        "Zero credential"
      );
    }
  );

  it(
    "rejects a zero nullifier",
    async function () {
      await createVote();

      await expect(
        voting
          .connect(creator)
          .registerParticipant(
            electionId,
            attacker.address,
            123n,
            0n
          )
      ).to.be.revertedWith(
        "Zero nullifier"
      );
    }
  );

  it(
    "rejects duplicate participant registration",
    async function () {
      await createVote();

      await voting
        .connect(creator)
        .registerParticipant(
          electionId,
          attacker.address,
          123n,
          456n
        );

      await expect(
        voting
          .connect(creator)
          .registerParticipant(
            electionId,
            attacker.address,
            789n,
            999n
          )
      ).to.be.revertedWith(
        "Participant already registered"
      );
    }
  );

  it(
    "allows anyone to activate after the start time",
    async function () {
      await createVoteWithParticipant();

      await moveToStartAndActivate();
    }
  );

  it(
    "allows anyone to end a vote after its deadline",
    async function () {
      await createVoteWithParticipant();

      await moveToStartAndActivate();

      await moveToEnd();

      await voting
        .connect(attacker)
        .endVote(
          electionId
        );
    }
  );

  it(
    "rejects finalization before the reveal period ends",
    async function () {
      await createVoteWithParticipant();

      await moveToStartAndActivate();

      await moveToEnd();

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