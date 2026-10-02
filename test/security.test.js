const { expect } = require("chai");
const { ethers } = require("hardhat");

async function signIdentityAttestation(issuer, voting, electionId, participant, identityHash) {
  const network = await ethers.provider.getNetwork();
  return issuer.signTypedData(
    {
      name: "EthiopiaChain ZKVoting",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await voting.getAddress()
    },
    {
      IdentityAttestation: [
        { name: "electionId", type: "uint256" },
        { name: "participant", type: "address" },
        { name: "identityHash", type: "bytes32" }
      ]
    },
    { electionId, participant, identityHash }
  );
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
      2n,
      signers[0].address
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
        456n,
        ethers.id("fixture-participant-identity")
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
    "stores only the poll access-code hash for participant verification",
    async function () {
      const latest = await ethers.provider.getBlock("latest");
      const registrationStart = BigInt(latest.timestamp);
      const registrationEnd = BigInt(latest.timestamp + 30);
      const voteStart = BigInt(latest.timestamp + 60);
      const voteEnd = BigInt(latest.timestamp + 120);
      const accessCodeHash = ethers.keccak256(ethers.toUtf8Bytes("organizer-shared-secret"));

      await voting
        .connect(creator)
        .createVoteWithRegistrationAndAccessCode(
          "Access Protected Vote",
          "The raw code is not stored",
          registrationStart,
          registrationEnd,
          voteStart,
          voteEnd,
          accessCodeHash,
          [{ id: 1n, candidateAddress: candidateA.address, name: "Candidate A" }]
        );

      expect(await voting.getElectionAccessCodeHash(electionId)).to.equal(accessCodeHash);
    }
  );

  it(
    "rejects poll creation with a zero access-code hash",
    async function () {
      const latest = await ethers.provider.getBlock("latest");

      await expect(
        voting
          .connect(creator)
          .createVoteWithRegistrationAndAccessCode(
            "No Access Code",
            "Must require a code",
            BigInt(latest.timestamp),
            BigInt(latest.timestamp + 30),
            BigInt(latest.timestamp + 60),
            BigInt(latest.timestamp + 120),
            ethers.ZeroHash,
            [{ id: 1n, candidateAddress: candidateA.address, name: "Candidate A" }]
          )
      ).to.be.revertedWith("Zero access code hash");
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
          2n,
          creator.address
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
          1n,
          creator.address
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
          4n,
          creator.address
        )
      ).to.be.revertedWith(
        "Invalid governance threshold"
      );
    }
  );

  it(
    "does not allow an unrelated wallet to register someone else",
    async function () {
      await createVote();

      await expect(
        voting
          .connect(attacker)
          .registerParticipant(
            electionId,
            member3.address,
            123n,
            456n,
            ethers.id("unauthorized-identity")
          )
      ).to.be.revertedWith(
        "Not identity issuer"
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
          456n,
          ethers.id("creator-registration-identity")
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
    "allows a participant to self-register with an issuer attestation",
    async function () {
      await createVote();
      const identityHash = ethers.id("self-registration-identity");
      const issuerSignature = await signIdentityAttestation(
        creator,
        voting,
        electionId,
        attacker.address,
        identityHash
      );

      await voting
        .connect(attacker)
        .registerVerifiedParticipant(
          electionId,
          attacker.address,
          789n,
          999n,
          identityHash,
          issuerSignature
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
    "rejects the same voter identity registering through a second wallet",
    async function () {
      await createVote();
      const identityHash = ethers.id("one-human-one-election");
      const firstSignature = await signIdentityAttestation(
        creator,
        voting,
        electionId,
        attacker.address,
        identityHash
      );

      await voting
        .connect(attacker)
        .registerVerifiedParticipant(
          electionId,
          attacker.address,
          2345n,
          3456n,
          identityHash,
          firstSignature
        );

      expect(
        await voting.identityRegistered(electionId, identityHash)
      ).to.equal(true);

      const secondSignature = await signIdentityAttestation(
        creator,
        voting,
        electionId,
        member3.address,
        identityHash
      );

      await expect(
        voting
          .connect(member3)
          .registerVerifiedParticipant(
            electionId,
            member3.address,
            4567n,
            5678n,
            identityHash,
            secondSignature
          )
      ).to.be.revertedWith("Identity already registered");
    }
  );

  it(
    "rejects a zero identity commitment",
    async function () {
      await createVote();

      await expect(
        voting
          .connect(creator)
          .registerParticipant(
            electionId,
            attacker.address,
            1234n,
            2345n,
            ethers.ZeroHash
          )
      ).to.be.revertedWith("Zero identity hash");
    }
  );

  it(
    "stores the registration schedule and participant status on-chain",
    async function () {
      const latest =
        await ethers.provider.getBlock("latest");
      const registrationStart =
        BigInt(latest.timestamp + 20);
      const registrationEnd =
        BigInt(latest.timestamp + 40);
      const voteStart =
        BigInt(latest.timestamp + 60);
      const voteEnd =
        BigInt(latest.timestamp + 120);

      await voting
        .connect(creator)
        .createVoteWithRegistration(
          "On-chain Registration Window",
          "Schedule and status are on-chain",
          registrationStart,
          registrationEnd,
          voteStart,
          voteEnd,
          [
            {
              id: 1n,
              candidateAddress: candidateA.address,
              name: "Candidate A"
            }
          ]
        );

      const storedTimes =
        await voting.getRegistrationTimes(electionId);
      expect(storedTimes[0]).to.equal(registrationStart);
      expect(storedTimes[1]).to.equal(registrationEnd);

      await ethers.provider.send(
        "evm_setNextBlockTimestamp",
        [Number(registrationStart)]
      );
      await voting
        .connect(creator)
        .registerParticipant(
          electionId,
          attacker.address,
          789n,
          999n,
          ethers.id("scheduled-registration-identity")
        );

      const participantStatus =
        await voting.getParticipantStatus(
          electionId,
          attacker.address
        );
      expect(participantStatus[0]).to.equal(true);
      expect(participantStatus[1]).to.equal(false);
    }
  );

  it(
    "reports voting active at its scheduled start without activation and allows ending on schedule",
    async function () {
      await createVoteWithParticipant();

      const times = await voting.getVoteTimes(electionId);
      await ethers.provider.send(
        "evm_setNextBlockTimestamp",
        [Number(times[0])]
      );
      await ethers.provider.send("evm_mine");

      let status = await voting.getVoteStatus(electionId);
      expect(status[1]).to.equal(true);
      expect(status[2]).to.equal(false);

      await expect(
        voting
          .connect(member3)
          .castPrivateVote(
            electionId,
            [0n, 0n],
            [[0n, 0n], [0n, 0n]],
            [0n, 0n],
            [0n, 0n, 0n, 0n]
          )
      ).to.be.revertedWith("Invalid election ID");

      await ethers.provider.send(
        "evm_setNextBlockTimestamp",
        [Number(times[1])]
      );
      await voting.connect(attacker).endVote(electionId);

      status = await voting.getVoteStatus(electionId);
      expect(status[1]).to.equal(false);
      expect(status[2]).to.equal(true);
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
            999n,
            ethers.id("late-registration-identity")
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
            456n,
            ethers.id("zero-participant-identity")
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
            456n,
            ethers.id("zero-credential-identity")
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
            0n,
            ethers.id("zero-nullifier-identity")
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
          456n,
          ethers.id("first-duplicate-wallet-identity")
        );

      await expect(
        voting
          .connect(creator)
          .registerParticipant(
            electionId,
            attacker.address,
            789n,
            999n,
            ethers.id("second-duplicate-wallet-identity")
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