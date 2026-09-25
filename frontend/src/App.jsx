import { useEffect, useState } from "react";
import { BrowserProvider, Contract } from "ethers";
import { poseidon1, poseidon2 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import "./App.css";

const CONTRACT_ADDRESS =
  "0x8d3F79399766E77c9F249FE1efe1C8E748c4E05c";

const SEPOLIA_CHAIN_ID = 11155111n;

const ABI = [
  "function nextElectionId() view returns (uint256)",

  "function createVote(string,string,uint64,uint64,tuple(uint256 id,address candidateAddress,string name)[]) returns (uint256)",

  "function activateVote(uint256)",
  "function endVote(uint256)",
  "function finalizeVote(uint256)",

  "function getVoteTitle(uint256) view returns (string)",
  "function getVoteDescription(uint256) view returns (string)",
  "function getVoteCreator(uint256) view returns (address)",
  "function getVoteRoots(uint256) view returns (uint256,uint256)",
  "function getVoteTimes(uint256) view returns (uint64,uint64,uint64)",
  "function getVoteStatus(uint256) view returns (bool,bool,bool,bool)",
  "function getVoteBallots(uint256) view returns (uint256,uint256)",

  "function getElectionCandidates(uint256) view returns (uint256[],address[],string[])",
  "function getVoteCount(uint256,uint256) view returns (uint256)",

  "function getParticipantCount(uint256) view returns (uint256)",
  "function getParticipant(uint256,address) view returns (uint256,uint256,uint256,bool)",
  "function registeredParticipant(uint256,address) view returns (bool)",
  "function participantIndex(uint256,address) view returns (uint256)",

  "function getEligibilityLeaves(uint256) view returns (uint256[])",

  "function registerParticipant(uint256,address,uint256,uint256)",

  "function castPrivateVote(uint256,uint256[2],uint256[2][2],uint256[2],uint256[4])",

  "function revealVote(uint256,uint256,uint256)",

  "function nullifierUsed(uint256,uint256) view returns (bool)",
  "function candidateAllowed(uint256,uint256) view returns (bool)",
  "function voteCommitmentUsed(uint256,uint256) view returns (bool)",
  "function voteCommitmentRevealed(uint256,uint256) view returns (bool)"
];

function poseidonOne(value) {
  return BigInt(poseidon1([BigInt(value)]));
}

function poseidonTwo(a, b) {
  return BigInt(poseidon2([BigInt(a), BigInt(b)]));
}

function shortAddress(address) {
  if (!address) return "";

  return (
    address.slice(0, 6) +
    "..." +
    address.slice(-4)
  );
}

function formatDate(timestamp) {
  if (!timestamp) return "—";

  const value = Number(timestamp);

  if (!Number.isFinite(value) || value <= 0) {
    return "—";
  }

  return new Date(value * 1000).toLocaleString();
}

function dateTimeToTimestamp(value) {
  if (!value) {
    throw new Error("Select a date and time.");
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid date and time.");
  }

  return Math.floor(date.getTime() / 1000);
}

function getErrorMessage(error) {
  if (!error) {
    return "Unknown error.";
  }

  if (error.reason) {
    return error.reason;
  }

  if (error.shortMessage) {
    return error.shortMessage;
  }

  if (error.message) {
    return error.message;
  }

  return String(error);
}

function buildMerkleLevels(leaves) {
  const levels = [leaves.map(BigInt)];

  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next = [];

    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];

      const right =
        i + 1 < current.length
          ? current[i + 1]
          : 0n;

      next.push(
        poseidonTwo(left, right)
      );
    }

    levels.push(next);
  }

  return levels;
}

function getMerklePath(
  leaves,
  index,
  depth = 3
) {
  const levels = buildMerkleLevels(leaves);

  const pathElements = [];
  const pathIndices = [];

  let currentIndex = index;

  for (
    let level = 0;
    level < depth;
    level++
  ) {
    const current = levels[level];

    const isRight =
      currentIndex % 2 === 1;

    pathIndices.push(
      isRight ? 1n : 0n
    );

    const siblingIndex = isRight
      ? currentIndex - 1
      : currentIndex + 1;

    pathElements.push(
      siblingIndex < current.length
        ? current[siblingIndex]
        : 0n
    );

    currentIndex = Math.floor(
      currentIndex / 2
    );
  }

  return {
    pathElements,
    pathIndices
  };
}

function padLeaves(
  leaves,
  size = 8
) {
  const result = leaves.map(BigInt);

  while (result.length < size) {
    result.push(0n);
  }

  if (result.length > size) {
    throw new Error(
      `Maximum of ${size} leaves supported.`
    );
  }

  return result;
}

export default function App() {
  const [provider, setProvider] =
    useState(null);

  const [signer, setSigner] =
    useState(null);

  const [contract, setContract] =
    useState(null);

  const [account, setAccount] =
    useState("");

  const [chainId, setChainId] =
    useState("");

  const [activeTab, setActiveTab] =
    useState("election");

  const [electionId, setElectionId] =
    useState("1");

  const [election, setElection] =
    useState(null);

  const [candidates, setCandidates] =
    useState([]);

  const [voteCounts, setVoteCounts] =
    useState({});

  const [message, setMessage] =
    useState("");

  const [error, setError] =
    useState("");

  const [loading, setLoading] =
    useState(false);

  const [createTitle, setCreateTitle] =
    useState("");

  const [
    createDescription,
    setCreateDescription
  ] = useState("");

  const [createStart, setCreateStart] =
    useState("");

  const [createEnd, setCreateEnd] =
    useState("");

  const [
    createCandidates,
    setCreateCandidates
  ] = useState([
    {
      id: "1",
      name: "",
      address: ""
    },
    {
      id: "2",
      name: "",
      address: ""
    }
  ]);

  const [
    participantElectionId,
    setParticipantElectionId
  ] = useState("1");

  const [
    participantWallet,
    setParticipantWallet
  ] = useState("");

  const [
    participantCredential,
    setParticipantCredential
  ] = useState("");

  const [
    privateElectionId,
    setPrivateElectionId
  ] = useState("1");

  const [
    privateCredential,
    setPrivateCredential
  ] = useState("");

  const [privateSalt, setPrivateSalt] =
    useState("");

  const [
    privateCandidateId,
    setPrivateCandidateId
  ] = useState("");

  const [proofResult, setProofResult] =
    useState(null);

  const [
    revealElectionId,
    setRevealElectionId
  ] = useState("1");

  const [
    revealCandidateId,
    setRevealCandidateId
  ] = useState("");

  const [revealSalt, setRevealSalt] =
    useState("");

  async function connectWallet() {
    setError("");
    setMessage("");

    try {
      if (!window.ethereum) {
        throw new Error(
          "MetaMask is not installed."
        );
      }

      const browserProvider =
        new BrowserProvider(
          window.ethereum
        );

      await browserProvider.send(
        "eth_requestAccounts",
        []
      );

      const network =
        await browserProvider.getNetwork();

      const signerInstance =
        await browserProvider.getSigner();

      const address =
        await signerInstance.getAddress();

      const contractInstance =
        new Contract(
          CONTRACT_ADDRESS,
          ABI,
          signerInstance
        );

      setProvider(browserProvider);
      setSigner(signerInstance);
      setContract(contractInstance);
      setAccount(address);

      setChainId(
        network.chainId.toString()
      );

      if (
        network.chainId !==
        SEPOLIA_CHAIN_ID
      ) {
        setError(
          "Please switch MetaMask to Sepolia."
        );

        return;
      }

      setMessage(
        "MetaMask connected successfully."
      );

      await loadElection(
        electionId,
        contractInstance
      );
    } catch (err) {
      console.error(err);

      setError(
        getErrorMessage(err)
      );
    }
  }

  async function loadElection(
    id,
    contractInstance = contract
  ) {
    if (!contractInstance) {
      setError(
        "Connect MetaMask first."
      );

      return;
    }

    setError("");

    try {
      const numericId =
        BigInt(id);

      if (numericId <= 0n) {
        throw new Error(
          "Election ID must be greater than zero."
        );
      }

      const nextId =
        await contractInstance.nextElectionId();

      if (numericId >= nextId) {
        setElection(null);
        setCandidates([]);
        setVoteCounts({});

        setMessage(
          "No election #" +
            numericId.toString() +
            " exists yet. Create an election first."
        );

        return;
      }

      setLoading(true);

      const [
        title,
        description,
        creator,
        roots,
        times,
        status,
        ballots,
        candidateData,
        participantCount
      ] = await Promise.all([
        contractInstance.getVoteTitle(
          numericId
        ),

        contractInstance.getVoteDescription(
          numericId
        ),

        contractInstance.getVoteCreator(
          numericId
        ),

        contractInstance.getVoteRoots(
          numericId
        ),

        contractInstance.getVoteTimes(
          numericId
        ),

        contractInstance.getVoteStatus(
          numericId
        ),

        contractInstance.getVoteBallots(
          numericId
        ),

        contractInstance.getElectionCandidates(
          numericId
        ),

        contractInstance.getParticipantCount(
          numericId
        )
      ]);

      const [
        eligibilityRoot,
        candidateRoot
      ] = roots;

      const [
        startTime,
        endTime,
        revealDeadline
      ] = times;

      const [
        pending,
        active,
        ended,
        finalized
      ] = status;

      const [
        acceptedBallots,
        revealedBallots
      ] = ballots;

      const [
        candidateIds,
        candidateAddresses,
        candidateNames
      ] = candidateData;

      const loadedCandidates =
        candidateIds.map(
          (candidateId, index) => ({
            id: candidateId.toString(),

            address:
              candidateAddresses[index],

            name:
              candidateNames[index]
          })
        );

      const counts = {};

      for (
        const candidate of loadedCandidates
      ) {
        try {
          counts[candidate.id] =
            (
              await contractInstance.getVoteCount(
                numericId,
                BigInt(candidate.id)
              )
            ).toString();
        } catch {
          counts[candidate.id] =
            "0";
        }
      }

      const numericElectionId =
        numericId.toString();

      setElectionId(
        numericElectionId
      );

      setElection({
        id:
          numericElectionId,

        title,

        description,

        creator,

        eligibilityRoot:
          eligibilityRoot.toString(),

        candidateRoot:
          candidateRoot.toString(),

        startTime:
          startTime.toString(),

        endTime:
          endTime.toString(),

        revealDeadline:
          revealDeadline.toString(),

        pending,

        active,

        ended,

        finalized,

        acceptedBallots:
          acceptedBallots.toString(),

        revealedBallots:
          revealedBallots.toString(),

        participantCount:
          participantCount.toString()
      });

      setCandidates(
        loadedCandidates
      );

      setVoteCounts(counts);

      setParticipantElectionId(
        numericElectionId
      );

      setPrivateElectionId(
        numericElectionId
      );

      setRevealElectionId(
        numericElectionId
      );

      if (
        loadedCandidates.length > 0
      ) {
        setPrivateCandidateId(
          loadedCandidates[0].id
        );

        setRevealCandidateId(
          loadedCandidates[0].id
        );
      }

      setMessage(
        "Election #" +
          numericElectionId +
          " loaded successfully."
      );
    } catch (err) {
      console.error(err);

      setElection(null);
      setCandidates([]);
      setVoteCounts({});

      setError(
        getErrorMessage(err)
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateVote(
    event
  ) {
    event.preventDefault();

    if (!contract || !signer) {
      setError(
        "Connect MetaMask first."
      );

      return;
    }

    try {
      setLoading(true);
      setError("");
      setMessage("");

      if (!createTitle.trim()) {
        throw new Error(
          "Enter an election title."
        );
      }

      if (!createDescription.trim()) {
        throw new Error(
          "Enter an election description."
        );
      }

      const startTime =
        dateTimeToTimestamp(
          createStart
        );

      const endTime =
        dateTimeToTimestamp(
          createEnd
        );

      if (endTime <= startTime) {
        throw new Error(
          "End time must be after start time."
        );
      }

      if (
        createCandidates.length === 0
      ) {
        throw new Error(
          "Add at least one candidate."
        );
      }

      const candidateIds =
        new Set();

      const candidatesForContract =
        createCandidates.map(
          (candidate) => {
            if (
              !candidate.name.trim()
            ) {
              throw new Error(
                "Every candidate needs a name."
              );
            }

            if (
              !/^0x[a-fA-F0-9]{40}$/.test(
                candidate.address
              )
            ) {
              throw new Error(
                "Invalid candidate wallet address: " +
                  candidate.name
              );
            }

            if (
              !/^\d+$/.test(
                candidate.id.trim()
              )
            ) {
              throw new Error(
                "Candidate ID must be a positive integer."
              );
            }

            const candidateId =
              BigInt(
                candidate.id
              );

            if (
              candidateId <= 0n
            ) {
              throw new Error(
                "Candidate ID must be greater than zero."
              );
            }

            const idKey =
              candidateId.toString();

            if (
              candidateIds.has(idKey)
            ) {
              throw new Error(
                "Duplicate candidate ID: " +
                  idKey
              );
            }

            candidateIds.add(idKey);

            return {
              id: candidateId,

              candidateAddress:
                candidate.address,

              name:
                candidate.name.trim()
            };
          }
        );

      const tx =
        await contract.createVote(
          createTitle.trim(),

          createDescription.trim(),

          startTime,

          endTime,

          candidatesForContract
        );

      setMessage(
        "Creating election..."
      );

      await tx.wait();

      let newId = null;

      try {
        const nextId =
          await contract.nextElectionId();

        newId =
          nextId - 1n;
      } catch (err) {
        console.error(
          "Could not determine new election ID:",
          err
        );
      }

      if (newId === null) {
        setMessage(
          "Vote created successfully. Enter the election ID manually."
        );
      } else {
        const newIdString =
          newId.toString();

        setElectionId(
          newIdString
        );

        setParticipantElectionId(
          newIdString
        );

        setPrivateElectionId(
          newIdString
        );

        setRevealElectionId(
          newIdString
        );

        await loadElection(
          newIdString
        );

        setMessage(
          "Vote #" +
            newIdString +
            " created successfully."
        );
      }

      setCreateTitle("");
      setCreateDescription("");
      setCreateStart("");
      setCreateEnd("");

      setCreateCandidates([
        {
          id: "1",
          name: "",
          address: ""
        },
        {
          id: "2",
          name: "",
          address: ""
        }
      ]);
    } catch (err) {
      console.error(err);

      setError(
        getErrorMessage(err)
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleRegisterParticipant(
    event
  ) {
    event.preventDefault();

    if (!contract || !signer) {
      setError(
        "Connect MetaMask first."
      );

      return;
    }

    try {
      setLoading(true);
      setError("");
      setMessage("");

      const id =
        BigInt(
          participantElectionId
        );

      if (id <= 0n) {
        throw new Error(
          "Election ID must be greater than zero."
        );
      }

      if (
        !/^0x[a-fA-F0-9]{40}$/.test(
          participantWallet
        )
      ) {
        throw new Error(
          "Invalid participant wallet address."
        );
      }

      if (
        !participantCredential.trim()
      ) {
        throw new Error(
          "Enter a participant credential."
        );
      }

      const creator =
        await contract.getVoteCreator(
          id
        );

      if (
        creator.toLowerCase() !==
        account.toLowerCase()
      ) {
        throw new Error(
          "Only the election creator can register participants."
        );
      }

      const credential =
        BigInt(
          participantCredential.trim()
        );

      const credentialLeaf =
        poseidonOne(
          credential
        );

      const nullifierHash =
        poseidonTwo(
          credential,
          id
        );

      const tx =
        await contract.registerParticipant(
          id,
          participantWallet,
          credentialLeaf,
          nullifierHash
        );

      setMessage(
        "Registering participant..."
      );

      await tx.wait();

      setMessage(
        "Participant registered successfully."
      );

      await loadElection(
        id.toString()
      );
    } catch (err) {
      console.error(err);

      setError(
        getErrorMessage(err)
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleActivateVote() {
    if (!contract) {
      setError(
        "Connect MetaMask first."
      );

      return;
    }

    if (!election) {
      setError(
        "Load an election first."
      );

      return;
    }

    try {
      setLoading(true);
      setError("");
      setMessage("");

      const id =
        BigInt(election.id);

      const tx =
        await contract.activateVote(
          id
        );

      setMessage(
        "Activating election..."
      );

      await tx.wait();

      await loadElection(
        id.toString()
      );

      setMessage(
        "Election activated successfully."
      );
    } catch (err) {
      console.error(err);

      setError(
        getErrorMessage(err)
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleEndVote() {
    if (!contract) {
      setError(
        "Connect MetaMask first."
      );

      return;
    }

    if (!election) {
      setError(
        "Load an election first."
      );

      return;
    }

    try {
      setLoading(true);
      setError("");
      setMessage("");

      const id =
        BigInt(election.id);

      const tx =
        await contract.endVote(
          id
        );

      setMessage(
        "Ending election..."
      );

      await tx.wait();

      await loadElection(
        id.toString()
      );

      setMessage(
        "Election ended successfully."
      );
    } catch (err) {
      console.error(err);

      setError(
        getErrorMessage(err)
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleFinalizeVote() {
    if (!contract) {
      setError(
        "Connect MetaMask first."
      );

      return;
    }

    if (!election) {
      setError(
        "Load an election first."
      );

      return;
    }

    try {
      setLoading(true);
      setError("");
      setMessage("");

      const id =
        BigInt(election.id);

      const tx =
        await contract.finalizeVote(
          id
        );

      setMessage(
        "Finalizing election..."
      );

      await tx.wait();

      await loadElection(
        id.toString()
      );

      setMessage(
        "Election finalized successfully."
      );
    } catch (err) {
      console.error(err);

      setError(
        getErrorMessage(err)
      );
    } finally {
      setLoading(false);
    }
  }

  async function handlePrivateVote(
    event
  ) {
    event.preventDefault();

    if (!contract || !signer) {
      setError(
        "Connect MetaMask first."
      );

      return;
    }

    try {
      setLoading(true);
      setError("");
      setMessage("");
      setProofResult(null);

      const id =
        BigInt(privateElectionId);

      if (!election) {
        throw new Error(
          "Load the election first."
        );
      }

      if (
        election.id !==
        id.toString()
      ) {
        throw new Error(
          "Load election #" +
            id.toString() +
            " first."
        );
      }

      if (!election.active) {
        throw new Error(
          "This election is not active."
        );
      }

      if (!privateCredential.trim()) {
        throw new Error(
          "Enter your credential."
        );
      }

      if (!privateSalt.trim()) {
        throw new Error(
          "Enter your vote salt."
        );
      }

      if (!privateCandidateId) {
        throw new Error(
          "Select a candidate."
        );
      }

      const credential =
        BigInt(
          privateCredential.trim()
        );

      const salt =
        BigInt(
          privateSalt.trim()
        );

      const candidateChoice =
        BigInt(
          privateCandidateId
        );

      const registered =
        await contract.registeredParticipant(
          id,
          account
        );

      if (!registered) {
        throw new Error(
          "This wallet is not registered as a participant for this election."
        );
      }

      const expectedNullifier =
        poseidonTwo(
          credential,
          id
        );

      const participantData =
        await contract.getParticipant(
          id,
          account
        );

      const storedCredentialLeaf =
        BigInt(
          participantData[0]
        );

      const storedNullifier =
        BigInt(
          participantData[1]
        );

      if (
        storedCredentialLeaf !==
        poseidonOne(credential)
      ) {
        throw new Error(
          "Credential does not match the registered participant."
        );
      }

      if (
        storedNullifier !==
        expectedNullifier
      ) {
        throw new Error(
          "Credential does not match the registered nullifier."
        );
      }

      const eligibilityLeavesRaw =
        await contract.getEligibilityLeaves(
          id
        );

      const eligibilityLeaves =
        padLeaves(
          eligibilityLeavesRaw
        );

      const credentialLeaf =
        poseidonOne(
          credential
        );

      const eligibilityIndex =
        eligibilityLeaves.findIndex(
          (leaf) =>
            BigInt(leaf) ===
            credentialLeaf
        );

      if (
        eligibilityIndex < 0
      ) {
        throw new Error(
          "Credential was not found in the election eligibility tree."
        );
      }

      const eligibilityPath =
        getMerklePath(
          eligibilityLeaves,
          eligibilityIndex,
          3
        );

      const candidateLeaf =
        poseidonTwo(
          candidateChoice,
          0n
        );

      const candidateLeaves =
        padLeaves(
          candidates.map(
            (candidate) =>
              poseidonTwo(
                BigInt(candidate.id),
                0n
              )
          )
        );

      const selectedCandidateIndex =
        candidates.findIndex(
          (candidate) =>
            BigInt(candidate.id) ===
            candidateChoice
        );

      if (
        selectedCandidateIndex < 0
      ) {
        throw new Error(
          "Selected candidate does not exist."
        );
      }

      candidateLeaves[
        selectedCandidateIndex
      ] = candidateLeaf;

      const candidatePath =
        getMerklePath(
          candidateLeaves,
          selectedCandidateIndex,
          3
        );

      const scopeRoot =
        poseidonTwo(
          BigInt(
            election.eligibilityRoot
          ),
          BigInt(
            election.candidateRoot
          )
        );

      const input = {
        credential:
          credential.toString(),

        electionId:
          id.toString(),

        candidateChoice:
          candidateChoice.toString(),

        voteSalt:
          salt.toString(),

        eligibilityPathElements:
          eligibilityPath.pathElements.map(
            String
          ),

        eligibilityPathIndices:
          eligibilityPath.pathIndices.map(
            String
          ),

        eligibilityRoot:
          election.eligibilityRoot,

        candidatePathElements:
          candidatePath.pathElements.map(
            String
          ),

        candidatePathIndices:
          candidatePath.pathIndices.map(
            String
          ),

        candidateRoot:
          election.candidateRoot,

        scopeRoot:
          scopeRoot.toString()
      };

      setMessage(
        "Generating zero-knowledge proof..."
      );

      const {
        proof,
        publicSignals
      } =
        await snarkjs.groth16.fullProve(
          input,
          "/zk/VoteValidity.wasm",
          "/zk/VoteValidity.zkey"
        );

      const calldata =
        await snarkjs.groth16.exportSolidityCallData(
          proof,
          publicSignals
        );

      const parsed =
        JSON.parse(
          "[" + calldata + "]"
        );

      const a = parsed[0];
      const b = parsed[1];
      const c = parsed[2];
      const inputs = parsed[3];

      const tx =
        await contract.castPrivateVote(
          id,
          a,
          b,
          c,
          inputs
        );

      setMessage(
        "Submitting private ZK vote..."
      );

      const receipt =
        await tx.wait();

      setProofResult({
        nullifierHash:
          publicSignals[0],

        voteCommitment:
          publicSignals[1],

        electionId:
          publicSignals[2],

        scopeRoot:
          publicSignals[3],

        transactionHash:
          receipt.hash
      });

      setMessage(
        "Private ZK vote accepted successfully."
      );

      await loadElection(
        id.toString()
      );
    } catch (err) {
      console.error(err);

      setError(
        getErrorMessage(err)
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleRevealVote(
    event
  ) {
    event.preventDefault();

    if (!contract) {
      setError(
        "Connect MetaMask first."
      );

      return;
    }

    try {
      setLoading(true);
      setError("");
      setMessage("");

      if (!revealCandidateId) {
        throw new Error(
          "Select a candidate."
        );
      }

      if (!revealSalt.trim()) {
        throw new Error(
          "Enter the vote salt."
        );
      }

      const id =
        BigInt(revealElectionId);

      if (!election) {
        throw new Error(
          "Load the election first."
        );
      }

      if (
        election.id !==
        id.toString()
      ) {
        throw new Error(
          "Load election #" +
            id.toString() +
            " first."
        );
      }

      const candidateId =
        BigInt(
          revealCandidateId
        );

      const salt =
        BigInt(
          revealSalt
        );

      const commitment =
        poseidonTwo(
          candidateId,
          salt
        );

      const tx =
        await contract.revealVote(
          id,
          candidateId,
          salt
        );

      setMessage(
        "Revealing vote..."
      );

      await tx.wait();

      setMessage(
        "Vote revealed successfully. Commitment: " +
          commitment.toString()
      );

      await loadElection(
        id.toString()
      );
    } catch (err) {
      console.error(err);

      setError(
        getErrorMessage(err)
      );
    } finally {
      setLoading(false);
    }
  }

  function updateCandidate(
    index,
    field,
    value
  ) {
    setCreateCandidates(
      (previous) =>
        previous.map(
          (
            candidate,
            candidateIndex
          ) =>
            candidateIndex === index
              ? {
                  ...candidate,
                  [field]: value
                }
              : candidate
        )
    );
  }

  function addCandidate() {
    setCreateCandidates(
      (previous) => {
        const highestId =
          previous.reduce(
            (highest, candidate) => {
              try {
                const value =
                  BigInt(candidate.id);

                return value > highest
                  ? value
                  : highest;
              } catch {
                return highest;
              }
            },
            0n
          );

        return [
          ...previous,
          {
            id: (
              highestId + 1n
            ).toString(),
            name: "",
            address: ""
          }
        ];
      }
    );
  }

  function removeCandidate(index) {
    setCreateCandidates(
      (previous) =>
        previous.filter(
          (
            _,
            candidateIndex
          ) =>
            candidateIndex !== index
        )
    );
  }

  useEffect(() => {
    if (!window.ethereum) {
      return;
    }

    function handleAccountsChanged(
      accounts
    ) {
      if (
        accounts &&
        accounts.length > 0
      ) {
        connectWallet();
      } else {
        setAccount("");
        setSigner(null);
        setContract(null);
        setElection(null);
      }
    }

    function handleChainChanged() {
      window.location.reload();
    }

    window.ethereum.on(
      "accountsChanged",
      handleAccountsChanged
    );

    window.ethereum.on(
      "chainChanged",
      handleChainChanged
    );

    return () => {
      window.ethereum.removeListener(
        "accountsChanged",
        handleAccountsChanged
      );

      window.ethereum.removeListener(
        "chainChanged",
        handleChainChanged
      );
    };
  }, []);

  const statusText =
    election
      ? election.finalized
        ? "FINALIZED"
        : election.ended
          ? "ENDED"
          : election.active
            ? "ACTIVE"
            : "PENDING"
      : "—";

  const statusClass =
    statusText.toLowerCase();

  const canActivate =
    Boolean(
      contract &&
      election &&
      election.pending &&
      !election.active &&
      !election.ended &&
      !election.finalized
    );

  const canEnd =
    Boolean(
      contract &&
      election &&
      election.active &&
      !election.ended &&
      !election.finalized
    );

  const canFinalize =
    Boolean(
      contract &&
      election &&
      election.ended &&
      !election.finalized
    );

  return (
    <div className="app">
      <div className="app-shell">

        <header className="app-header">

          <div className="brand">

            <div className="brand-mark">
              ZK
            </div>

            <div className="brand-text">

              <h1>
                EthiopiaChain ZK Voting
              </h1>

              <p>
                Zero-knowledge private voting platform
              </p>

            </div>

          </div>

          <div className="wallet-area">

            {account ? (
              <>

                <div className="wallet-info">

                  <div className="wallet-address">
                    {shortAddress(account)}
                  </div>

                  <div className="network-info">
                    Chain ID: {chainId}
                  </div>

                </div>

                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    loadElection(
                      electionId
                    )
                  }
                  disabled={loading}
                >
                  Refresh
                </button>

              </>
            ) : (

              <button
                type="button"
                className="btn btn-primary"
                onClick={connectWallet}
              >
                Connect MetaMask
              </button>

            )}

          </div>

        </header>

        {message && (
          <div className="message">
            {message}
          </div>
        )}

        {error && (
          <div className="error">
            {error}
          </div>
        )}

        <nav className="tabs">

          {[
            ["election", "ELECTION"],
            ["create", "CREATE VOTE"],
            ["participants", "PARTICIPANTS"],
            ["private", "PRIVATE VOTE"],
            ["reveal", "REVEAL"]
          ].map(
            ([key, label]) => (
              <button
                type="button"
                key={key}
                className={
                  "tab " +
                  (
                    activeTab === key
                      ? "active"
                      : ""
                  )
                }
                onClick={() =>
                  setActiveTab(key)
                }
              >
                {label}
              </button>
            )
          )}

        </nav>

        <main className="page">

          {activeTab === "election" && (
            <>

              <div>

                <h2 className="page-title">
                  Election
                </h2>

                <p className="page-subtitle">
                  Load an election from the blockchain.
                </p>

              </div>

              <div className="card">

                <div className="form-grid">

                  <div className="field">

                    <label>
                      Election ID
                    </label>

                    <input
                      value={electionId}
                      onChange={(event) =>
                        setElectionId(
                          event.target.value
                        )
                      }
                    />

                  </div>

                  <div className="actions">

                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() =>
                        loadElection(
                          electionId
                        )
                      }
                      disabled={
                        loading ||
                        !contract
                      }
                    >
                      Load Election
                    </button>

                  </div>

                </div>

              </div>

              {!election ? (

                <div className="empty-state">

                  <div className="empty-icon">
                    +
                  </div>

                  <h3>
                    No election loaded
                  </h3>

                  <p>
                    Connect MetaMask and load
                    an existing election, or
                    create a new one.
                  </p>

                </div>

              ) : (

                <>

                  <section className="election-hero">

                    <span
                      className={
                        "status " +
                        statusClass
                      }
                    >
                      {statusText}
                    </span>

                    <h2 className="election-title">
                      {election.title}
                    </h2>

                    <p className="election-description">
                      {election.description}
                    </p>

                  </section>

                  <div className="stats-grid">

                    <div className="stat-card">

                      <div className="stat-label">
                        Accepted ballots
                      </div>

                      <div className="stat-value">
                        {election.acceptedBallots}
                      </div>

                    </div>

                    <div className="stat-card">

                      <div className="stat-label">
                        Revealed ballots
                      </div>

                      <div className="stat-value">
                        {election.revealedBallots}
                      </div>

                    </div>

                    <div className="stat-card">

                      <div className="stat-label">
                        Participants
                      </div>

                      <div className="stat-value">
                        {election.participantCount}
                      </div>

                    </div>

                    <div className="stat-card">

                      <div className="stat-label">
                        Election ID
                      </div>

                      <div className="stat-value">
                        #{election.id}
                      </div>

                    </div>

                  </div>

                  <section className="card">

                    <div className="card-header">

                      <div>

                        <h3 className="card-title">
                          Election lifecycle
                        </h3>

                        <p className="card-description">
                          Manage the election state according
                          to the smart contract rules.
                        </p>

                      </div>

                    </div>

                    <div className="actions">

                      <button
                        type="button"
                        className="btn btn-success"
                        onClick={
                          handleActivateVote
                        }
                        disabled={
                          loading ||
                          !canActivate
                        }
                      >
                        Activate Vote
                      </button>

                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={
                          handleEndVote
                        }
                        disabled={
                          loading ||
                          !canEnd
                        }
                      >
                        End Vote
                      </button>

                      <button
                        type="button"
                        className="btn btn-outline"
                        onClick={
                          handleFinalizeVote
                        }
                        disabled={
                          loading ||
                          !canFinalize
                        }
                      >
                        Finalize Vote
                      </button>

                    </div>

                  </section>

                  <section className="card">

                    <div className="card-header">

                      <div>

                        <h3 className="card-title">
                          Election details
                        </h3>

                        <p className="card-description">
                          Blockchain-backed election metadata.
                        </p>

                      </div>

                    </div>

                    <div className="info-grid">

                      <div className="info-item">

                        <div className="info-label">
                          Creator
                        </div>

                        <div className="info-value">
                          {shortAddress(
                            election.creator
                          )}
                        </div>

                      </div>

                      <div className="info-item">

                        <div className="info-label">
                          Start
                        </div>

                        <div className="info-value">
                          {formatDate(
                            election.startTime
                          )}
                        </div>

                      </div>

                      <div className="info-item">

                        <div className="info-label">
                          End
                        </div>

                        <div className="info-value">
                          {formatDate(
                            election.endTime
                          )}
                        </div>

                      </div>

                      <div className="info-item">

                        <div className="info-label">
                          Reveal deadline
                        </div>

                        <div className="info-value">
                          {formatDate(
                            election.revealDeadline
                          )}
                        </div>

                      </div>

                    </div>

                  </section>

                  <section className="card">

                    <div className="card-header">

                      <div>

                        <h3 className="card-title">
                          Candidates
                        </h3>

                        <p className="card-description">
                          Candidates registered for this election.
                        </p>

                      </div>

                    </div>

                    {candidates.map(
                      (candidate) => (

                        <div
                          className="candidate-card"
                          key={candidate.id}
                        >

                          <div className="candidate-card-header">

                            <div>

                              <h4 className="candidate-name">
                                {candidate.name}
                              </h4>

                              <div className="candidate-id">
                                Candidate #
                                {candidate.id}
                              </div>

                            </div>

                            <strong>
                              Votes:{" "}
                              {voteCounts[
                                candidate.id
                              ] || "0"}
                            </strong>

                          </div>

                        </div>

                      )
                    )}

                  </section>

                </>

              )}

            </>
          )}

          {activeTab === "create" && (
            <>

              <div>

                <h2 className="page-title">
                  Create Vote
                </h2>

                <p className="page-subtitle">
                  Create a new election on Sepolia.
                </p>

              </div>

              {!account ? (

                <div className="warning">
                  Connect MetaMask before creating an election.
                </div>

              ) : (

                <form
                  className="card form"
                  onSubmit={
                    handleCreateVote
                  }
                >

                  <div className="form-grid">

                    <div className="field full">

                      <label>
                        Election title
                      </label>

                      <input
                        value={createTitle}
                        onChange={(event) =>
                          setCreateTitle(
                            event.target.value
                          )
                        }
                        placeholder="Test Election"
                      />

                    </div>

                    <div className="field full">

                      <label>
                        Description
                      </label>

                      <textarea
                        value={
                          createDescription
                        }
                        onChange={(event) =>
                          setCreateDescription(
                            event.target.value
                          )
                        }
                        placeholder="Election description"
                      />

                    </div>

                    <div className="field">

                      <label>
                        Start time
                      </label>

                      <input
                        type="datetime-local"
                        value={createStart}
                        onChange={(event) =>
                          setCreateStart(
                            event.target.value
                          )
                        }
                      />

                    </div>

                    <div className="field">

                      <label>
                        End time
                      </label>

                      <input
                        type="datetime-local"
                        value={createEnd}
                        onChange={(event) =>
                          setCreateEnd(
                            event.target.value
                          )
                        }
                      />

                    </div>

                  </div>

                  <div>

                    <h3 className="card-title">
                      Candidates
                    </h3>

                    <p className="card-description">
                      Add the candidates who can receive votes.
                    </p>

                  </div>

                  <div className="candidates">

                    {createCandidates.map(
                      (
                        candidate,
                        index
                      ) => (

                        <div
                          className="candidate-row"
                          key={index}
                        >

                          <div className="field">

                            <label>
                              ID
                            </label>

                            <input
                              value={
                                candidate.id
                              }
                              onChange={(
                                event
                              ) =>
                                updateCandidate(
                                  index,
                                  "id",
                                  event.target
                                    .value
                                )
                              }
                            />

                          </div>

                          <div className="field">

                            <label>
                              Candidate name
                            </label>

                            <input
                              value={
                                candidate.name
                              }
                              onChange={(
                                event
                              ) =>
                                updateCandidate(
                                  index,
                                  "name",
                                  event.target
                                    .value
                                )
                              }
                            />

                          </div>

                          <div className="field">

                            <label>
                              Wallet address
                            </label>

                            <input
                              value={
                                candidate.address
                              }
                              onChange={(
                                event
                              ) =>
                                updateCandidate(
                                  index,
                                  "address",
                                  event.target
                                    .value
                                )
                              }
                              placeholder="0x..."
                            />

                          </div>

                          <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() =>
                              removeCandidate(
                                index
                              )
                            }
                            disabled={
                              createCandidates.length <=
                              1
                            }
                          >
                            Remove
                          </button>

                        </div>

                      )
                    )}

                  </div>

                  <div className="actions">

                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={
                        addCandidate
                      }
                    >
                      + Add candidate
                    </button>

                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={loading}
                    >
                      {loading
                        ? "Creating..."
                        : "Create Vote"}
                    </button>

                  </div>

                </form>

              )}

            </>
          )}

          {activeTab === "participants" && (
            <>

              <div>

                <h2 className="page-title">
                  Register Participant
                </h2>

                <p className="page-subtitle">
                  Register an eligible participant credential.
                </p>

              </div>

              {!account ? (

                <div className="warning">
                  Connect MetaMask before registering participants.
                </div>

              ) : (

                <>

                  <div className="warning">
                    Only the election creator can register participants.
                    The deployed contract also associates the registered
                    participant with a wallet address.
                  </div>

                  <form
                    className="card form"
                    onSubmit={
                      handleRegisterParticipant
                    }
                  >

                    <div className="form-grid">

                      <div className="field">

                        <label>
                          Election ID
                        </label>

                        <input
                          value={
                            participantElectionId
                          }
                          onChange={(event) =>
                            setParticipantElectionId(
                              event.target.value
                            )
                          }
                        />

                      </div>

                      <div className="field">

                        <label>
                          Participant wallet
                        </label>

                        <input
                          value={
                            participantWallet
                          }
                          onChange={(event) =>
                            setParticipantWallet(
                              event.target.value
                            )
                          }
                          placeholder="0x..."
                        />

                      </div>

                      <div className="field full">

                        <label>
                          Credential
                        </label>

                        <input
                          type="password"
                          value={
                            participantCredential
                          }
                          onChange={(event) =>
                            setParticipantCredential(
                              event.target.value
                            )
                          }
                          placeholder="Private test credential"
                        />

                        <div className="field-help">
                          The contract stores the Poseidon-derived
                          credential leaf and nullifier hash.
                        </div>

                      </div>

                    </div>

                    <div className="warning">
                      For testing only, use a test credential.
                      Do not enter a real identity secret.
                    </div>

                    <div className="actions">

                      <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={loading}
                      >
                        {loading
                          ? "Registering..."
                          : "Register Participant"}
                      </button>

                    </div>

                  </form>

                </>

              )}

            </>
          )}

          {activeTab === "private" && (
            <>

              <div>

                <h2 className="page-title">
                  Private Vote
                </h2>

                <p className="page-subtitle">
                  Cast a vote using a zero-knowledge proof.
                </p>

              </div>

              <div className="warning">
                Never share your credential or vote salt.
                The deployed contract still requires the
                connected wallet to be a registered participant,
                while the ZK proof protects the credential and
                vote inputs from being submitted directly.
              </div>

              <form
                className="card form"
                onSubmit={
                  handlePrivateVote
                }
              >

                <div className="form-grid">

                  <div className="field">

                    <label>
                      Election ID
                    </label>

                    <input
                      value={
                        privateElectionId
                      }
                      onChange={(event) =>
                        setPrivateElectionId(
                          event.target.value
                        )
                      }
                    />

                  </div>

                  <div className="field">

                    <label>
                      Candidate
                    </label>

                    <select
                      value={
                        privateCandidateId
                      }
                      onChange={(event) =>
                        setPrivateCandidateId(
                          event.target.value
                        )
                      }
                    >

                      <option value="">
                        Select candidate
                      </option>

                      {candidates.map(
                        (candidate) => (

                          <option
                            key={candidate.id}
                            value={
                              candidate.id
                            }
                          >
                            {candidate.name} — #
                            {candidate.id}
                          </option>

                        )
                      )}

                    </select>

                  </div>

                  <div className="field">

                    <label>
                      Credential
                    </label>

                    <input
                      type="password"
                      value={
                        privateCredential
                      }
                      onChange={(event) =>
                        setPrivateCredential(
                          event.target.value
                        )
                      }
                    />

                  </div>

                  <div className="field">

                    <label>
                      Vote salt
                    </label>

                    <input
                      type="password"
                      value={
                        privateSalt
                      }
                      onChange={(event) =>
                        setPrivateSalt(
                          event.target.value
                        )
                      }
                    />

                  </div>

                </div>

                <div className="actions">

                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={
                      loading ||
                      !election ||
                      !election.active ||
                      election.id !==
                        privateElectionId
                    }
                  >
                    {loading
                      ? "Generating ZK proof..."
                      : "Cast Private Vote"}
                  </button>

                </div>

              </form>

              {proofResult && (

                <section className="card">

                  <h3 className="card-title">
                    ZK vote submitted
                  </h3>

                  <div className="info-grid">

                    <div className="info-item">

                      <div className="info-label">
                        Nullifier
                      </div>

                      <div className="hash">
                        {
                          proofResult.nullifierHash
                        }
                      </div>

                    </div>

                    <div className="info-item">

                      <div className="info-label">
                        Commitment
                      </div>

                      <div className="hash">
                        {
                          proofResult.voteCommitment
                        }
                      </div>

                    </div>

                    <div className="info-item">

                      <div className="info-label">
                        Transaction
                      </div>

                      <div className="hash">
                        {
                          proofResult.transactionHash
                        }
                      </div>

                    </div>

                  </div>

                </section>

              )}

            </>
          )}

          {activeTab === "reveal" && (
            <>

              <div>

                <h2 className="page-title">
                  Reveal
                </h2>

                <p className="page-subtitle">
                  Reveal a commitment after the voting period.
                </p>

              </div>

              <div className="warning">
                Anyone who knows the vote salt can submit
                the reveal transaction. Keep your salt private
                until you are ready to reveal.
              </div>

              <form
                className="card form"
                onSubmit={
                  handleRevealVote
                }
              >

                <div className="form-grid">

                  <div className="field">

                    <label>
                      Election ID
                    </label>

                    <input
                      value={
                        revealElectionId
                      }
                      onChange={(event) =>
                        setRevealElectionId(
                          event.target.value
                        )
                      }
                    />

                  </div>

                  <div className="field">

                    <label>
                      Candidate
                    </label>

                    <select
                      value={
                        revealCandidateId
                      }
                      onChange={(event) =>
                        setRevealCandidateId(
                          event.target.value
                        )
                      }
                    >

                      <option value="">
                        Select candidate
                      </option>

                      {candidates.map(
                        (candidate) => (

                          <option
                            key={candidate.id}
                            value={
                              candidate.id
                            }
                          >
                            {candidate.name}
                          </option>

                        )
                      )}

                    </select>

                  </div>

                  <div className="field full">

                    <label>
                      Vote salt
                    </label>

                    <input
                      type="password"
                      value={
                        revealSalt
                      }
                      onChange={(event) =>
                        setRevealSalt(
                          event.target.value
                        )
                      }
                    />

                  </div>

                </div>

                <div className="actions">

                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={
                      loading ||
                      !election ||
                      election.id !==
                        revealElectionId
                    }
                  >
                    Reveal Vote
                  </button>

                </div>

              </form>

            </>
          )}

        </main>

        <footer className="footer">
          EthiopiaChain ZK Voting · Sepolia
        </footer>

      </div>
    </div>
  );
}
