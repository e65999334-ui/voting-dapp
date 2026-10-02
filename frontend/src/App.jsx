import { useEffect, useState } from "react";
import { BrowserProvider, Contract, keccak256, toUtf8Bytes } from "ethers";
import { poseidon1, poseidon2 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import "./App.css";

const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS;
const IDENTITY_API_URL = import.meta.env.VITE_IDENTITY_API_URL || "http://localhost:3001";
const SEPOLIA_CHAIN_ID = 11155111n;

const ABI = [
  "function nextElectionId() view returns (uint256)",
  "function createVote(string,string,uint64,uint64,tuple(uint256 id,address candidateAddress,string name)[]) returns (uint256)",
  "function createVoteWithRegistration(string,string,uint64,uint64,uint64,uint64,tuple(uint256 id,address candidateAddress,string name)[]) returns (uint256)",
    "function createVoteWithRegistrationAndAccessCode(string,string,uint64,uint64,uint64,uint64,bytes32,tuple(uint256 id,address candidateAddress,string name)[]) returns (uint256)",
  "function endVote(uint256)",
  "function finalizeVote(uint256)",
  "function getVoteTitle(uint256) view returns (string)",
    "function getElectionAccessCodeHash(uint256) view returns (bytes32)",
  "function getVoteDescription(uint256) view returns (string)",
  "function getVoteCreator(uint256) view returns (address)",
  "function getVoteRoots(uint256) view returns (uint256,uint256)",
  "function getRegistrationTimes(uint256) view returns (uint64,uint64)",
  "function getParticipantStatus(uint256,address) view returns (bool,bool)",
  "function getVoteTimes(uint256) view returns (uint64,uint64,uint64)",
  "function getVoteStatus(uint256) view returns (bool,bool,bool,bool)",
  "function getVoteBallots(uint256) view returns (uint256,uint256)",
  "function getElectionCandidates(uint256) view returns (uint256[],address[],string[])",
  "function getVoteCount(uint256,uint256) view returns (uint256)",
  "function getParticipantCount(uint256) view returns (uint256)",
  "function getEligibilityLeaves(uint256) view returns (uint256[])",
  "function registerVerifiedParticipant(uint256,address,uint256,uint256,bytes32,bytes)",
  "function identityRegistered(uint256,bytes32) view returns (bool)",
  "function castPrivateVote(uint256,uint256[2],uint256[2][2],uint256[2],uint256[4])",
  "function revealVote(uint256,uint256,uint256)",
  "event VoteAccepted(uint256 indexed electionId,uint256 indexed nullifierHash,uint256 voteCommitment)"
];

function poseidonOne(value) {
  return BigInt(poseidon1([BigInt(value)]));
}

function poseidonTwo(a, b) {
  return BigInt(poseidon2([BigInt(a), BigInt(b)]));
}

function getMerkleWitness(leaves, leafIndex) {
  if (leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error("Credential or candidate is missing from its Merkle tree.");
  }

  const pathElements = [];
  const pathIndices = [];
  let level = leaves.map(BigInt);
  let index = leafIndex;

  while (level.length > 1) {
    pathElements.push(level[index ^ 1]);
    pathIndices.push(index % 2);
    const parent = [];
    for (let i = 0; i < level.length; i += 2) {
      parent.push(poseidonTwo(level[i], level[i + 1]));
    }
    level = parent;
    index = Math.floor(index / 2);
  }

  return { pathElements, pathIndices, root: level[0] };
}

function shortAddress(address) {
  if (!address) return "";
  if (address.startsWith("0x000000000000000000000000000000000000")) return "General Option";
  return address.slice(0, 6) + "..." + address.slice(-4);
}

const ETHIOPIA_TIME_ZONE = "Africa/Addis_Ababa";
const ETHIOPIA_UTC_OFFSET_MINUTES = 180;

function getEthiopiaDateTimeParts(minutesFromNow = 5) {
  const target = new Date(Date.now() + minutesFromNow * 60 * 1000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: ETHIOPIA_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(target)
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

function dateTimeToTimestamp(dateValue, timeValue, offsetMinutes) {
  if (!dateValue || !timeValue) throw new Error("Choose both date and time.");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!match || !timeMatch) throw new Error("Invalid date or time format.");
  
  const utcMilliseconds = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(timeMatch[1]), Number(timeMatch[2]), 0, 0
  ) - offsetMinutes * 60 * 1000;
  return Math.floor(utcMilliseconds / 1000);
}

function formatTimestamp(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(Number(timestamp) * 1000));
}

function getErrorMessage(error) {
  if (!error) return "Unknown error.";
  const details = [error.reason, error.shortMessage, error.message, error.info?.error?.message]
    .filter(Boolean)
    .join(" ");
  if (/registration closed/i.test(details)) {
    return "Registration closes when voting starts. This poll has already reached its voting start time.";
  }
  if (/not authorized to register/i.test(details)) {
    return "This wallet is not authorized to register that participant. Participants may self-register only their connected wallet.";
  }
  if (/not vote creator/i.test(details)) {
    return "This deployed contract only allows the poll creator to register wallets. Connect the organizer wallet or use a deployment that allows participant self-registration.";
  }
  if (/registration not open/i.test(details)) {
    return "Registration is not open because voting has already started. Registration closes when voting starts.";
  }
  if (/missing revert data|no data present|could not decode result data|is not a function/i.test(details)) {
    return "This deployed ZKVoting contract does not support on-chain registration schedules/status yet. Deploy the updated contract and set VITE_CONTRACT_ADDRESS to that deployment.";
  }
  if (error.reason) return error.reason;
  if (error.shortMessage) return error.shortMessage;
  if (error.message) return error.message;
  return String(error);
}

function generateSecureBigInt() {
  const bytes = new Uint8Array(30);
  window.crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return BigInt(hex).toString();
}

function credentialStorageKey(pollId, walletAddress) {
  if (!pollId || !walletAddress) return "";
  return `ethiopia-zk-vote-credential:${SEPOLIA_CHAIN_ID}:${String(pollId)}:${walletAddress.toLowerCase()}`;
}

function getSavedCredential(pollId, walletAddress) {
  if (!pollId || !walletAddress) return "";
  try {
    const key = credentialStorageKey(pollId, walletAddress);
    return key ? window.localStorage.getItem(key) || "" : "";
  } catch {
    console.error("Could not read saved credential.");
    return "";
  }
}

function saveCredential(pollId, walletAddress, credential) {
  if (!pollId || !walletAddress || !credential) return false;
  try {
    window.localStorage.setItem(
      credentialStorageKey(pollId, walletAddress),
      String(credential)
    );
    return true;
  } catch {
    console.error("Could not save credential.");
    return false;
  }
}

function removeSavedCredential(pollId, walletAddress) {
  if (!pollId || !walletAddress) return;
  try {
    window.localStorage.removeItem(credentialStorageKey(pollId, walletAddress));
  } catch {
    console.error("Could not remove saved credential.");
  }
}

function organizerPollStorageKey(walletAddress) {
  if (!walletAddress) return "";
  return `ethiopia-zk-organizer-poll:${SEPOLIA_CHAIN_ID}:${walletAddress.toLowerCase()}`;
}

function organizerPollHistoryStorageKey(walletAddress) {
  const key = organizerPollStorageKey(walletAddress);
  return key ? `${key}:history` : "";
}

function getSavedOrganizerPoll(walletAddress) {
  if (!walletAddress) return null;
  try {
    const stored = window.localStorage.getItem(organizerPollStorageKey(walletAddress));
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function getSavedOrganizerPolls(walletAddress) {
  if (!walletAddress) return [];
  try {
    const history = JSON.parse(
      window.localStorage.getItem(organizerPollHistoryStorageKey(walletAddress)) || "[]"
    );
    const legacyPoll = getSavedOrganizerPoll(walletAddress);
    const polls = Array.isArray(history) ? history : [];
    return [...polls, ...(legacyPoll ? [legacyPoll] : [])].reduce((unique, item) => {
      if (!item?.pollId || unique.some((poll) => String(poll.pollId) === String(item.pollId))) return unique;
      unique.push(item);
      return unique;
    }, []);
  } catch {
    const legacyPoll = getSavedOrganizerPoll(walletAddress);
    return legacyPoll ? [legacyPoll] : [];
  }
}

function saveOrganizerPoll(walletAddress, pollDetails) {
  if (!walletAddress || !pollDetails?.pollId || !pollDetails?.accessCode) return false;
  try {
    const historyKey = organizerPollHistoryStorageKey(walletAddress);
    const previousPolls = getSavedOrganizerPolls(walletAddress);
    const updatedHistory = [
      pollDetails,
      ...previousPolls.filter((poll) => String(poll.pollId) !== String(pollDetails.pollId))
    ];
    window.localStorage.setItem(
      organizerPollStorageKey(walletAddress),
      JSON.stringify(pollDetails)
    );
    window.localStorage.setItem(historyKey, JSON.stringify(updatedHistory));
    return true;
  } catch {
    return false;
  }
}

function saveOrganizerOutcome(walletAddress, pollId, outcome) {
  if (!walletAddress || !pollId || !outcome) return false;
  try {
    window.localStorage.setItem(
      `${organizerPollStorageKey(walletAddress)}:${String(pollId)}:outcome`,
      JSON.stringify(outcome)
    );
    return true;
  } catch {
    return false;
  }
}

function getOrganizerOutcome(walletAddress, pollId) {
  if (!walletAddress || !pollId) return null;
  try {
    const saved = window.localStorage.getItem(
      `${organizerPollStorageKey(walletAddress)}:${String(pollId)}:outcome`
    );
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

function voteTransactionStorageKey(pollId, walletAddress) {
  return `ethiopia-zk-vote-tx:${SEPOLIA_CHAIN_ID}:${String(pollId)}:${walletAddress.toLowerCase()}`;
}

function getSavedVoteTransaction(pollId, walletAddress) {
  if (!pollId || !walletAddress) return "";
  try {
    return window.localStorage.getItem(voteTransactionStorageKey(pollId, walletAddress)) || "";
  } catch {
    return "";
  }
}

function saveVoteTransaction(pollId, walletAddress, transactionHash) {
  if (!pollId || !walletAddress || !transactionHash) return;
  try {
    window.localStorage.setItem(voteTransactionStorageKey(pollId, walletAddress), transactionHash);
  } catch {
    // The in-memory transaction link remains available for this session.
  }
}

export default function App() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [contract, setContract] = useState(null);
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState("");

  const [role, setRole] = useState(null);
  const [step, setStep] = useState(1);
  const [pollId, setPollId] = useState("1");
  const [poll, setPoll] = useState(null);
  const [options, setOptions] = useState([]);
  const [voteCounts, setVoteCounts] = useState({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [nowMilliseconds, setNowMilliseconds] = useState(Date.now());

  const [hasVotedLocally, setHasVotedLocally] = useState(false);
  const [registrationTxHash, setRegistrationTxHash] = useState("");
  const [lastTxHash, setLastTxHash] = useState("");
  const [chosenOptionName, setChosenOptionName] = useState("");

  const [pollCategory, setPollCategory] = useState("individual");
  const [createTitle, setCreateTitle] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [selectedTimeZone, setSelectedTimeZone] = useState(ETHIOPIA_TIME_ZONE);
  const [timeOffsetMinutes, setTimeOffsetMinutes] = useState(ETHIOPIA_UTC_OFFSET_MINUTES);
  
  const [registrationStartDate, setRegistrationStartDate] = useState(() => getEthiopiaDateTimeParts(0).date);
  const [registrationStartTime, setRegistrationStartTime] = useState(() => getEthiopiaDateTimeParts(0).time);
  const [registrationEndDate, setRegistrationEndDate] = useState(() => getEthiopiaDateTimeParts(30).date);
  const [registrationEndTime, setRegistrationEndTime] = useState(() => getEthiopiaDateTimeParts(30).time);
  const [createStartDate, setCreateStartDate] = useState(() => getEthiopiaDateTimeParts(60).date);
  const [createStartTime, setCreateStartTime] = useState(() => getEthiopiaDateTimeParts(60).time);
  const [createEndDate, setCreateEndDate] = useState(() => getEthiopiaDateTimeParts(180).date);
  const [createEndTime, setCreateEndTime] = useState(() => getEthiopiaDateTimeParts(180).time);
  
  const [pollOptions, setPollOptions] = useState([
    { id: "1", name: "", address: "" }
  ]);
  const [generatedPollCode, setGeneratedPollCode] = useState("");
  const [createdSchedule, setCreatedSchedule] = useState(null);
  const [adminOutcome, setAdminOutcome] = useState(null);
  const [organizerPolls, setOrganizerPolls] = useState([]);
  const [selectedPreviousPollId, setSelectedPreviousPollId] = useState("");
  const [showPreviousPolls, setShowPreviousPolls] = useState(false);

  const [joinPollId, setJoinPollId] = useState("");
  const [joinAccessCode, setJoinAccessCode] = useState("");

  const [participantCredential, setParticipantCredential] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [providerSessionId, setProviderSessionId] = useState("");
  const [providerVerificationUrl, setProviderVerificationUrl] = useState("");
  const [verificationReference, setVerificationReference] = useState("");
  const [identityStep, setIdentityStep] = useState("document");
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [showIdentityVerification, setShowIdentityVerification] = useState(false);
  const [identityDocumentType, setIdentityDocumentType] = useState("");
  const [identityDocument, setIdentityDocument] = useState(null);
  const [identityVerified, setIdentityVerified] = useState(false);
  const [identityCommitment, setIdentityCommitment] = useState("");
  const [identityIssuerSignature, setIdentityIssuerSignature] = useState("");
  const [credentialLoaded, setCredentialLoaded] = useState(false);
  const [privateCredential, setPrivateCredential] = useState("");
  const [privateSalt, setPrivateSalt] = useState("");
  const [privateOptionId, setPrivateOptionId] = useState("");
  const [revealOptionId, setRevealOptionId] = useState("");
  const [revealSalt, setRevealSalt] = useState("");

  useEffect(() => {
    if (!window.ethereum) return;
    const handleAccountsChanged = async (accounts) => {
      if (!accounts || accounts.length === 0) {
        setAccount("");
        setSigner(null);
        setContract(null);
        setRole(null);
        setParticipantCredential("");
        setPrivateCredential("");
        setDocumentType("");
        setProviderSessionId("");
        setProviderVerificationUrl("");
        setVerificationReference("");
        setIdentityStep("document");
        setVerificationLoading(false);
        setIdentityVerified(false);
        setIdentityCommitment("");
        setIdentityIssuerSignature("");
        setCredentialLoaded(false);
        setLastTxHash("");
        setRegistrationTxHash("");
        setHasVotedLocally(false);
        setChosenOptionName("");
        setStep(1);
        setMessage("");
      } else {
        const nextAccount = accounts[0];
        if (nextAccount.toLowerCase() === account.toLowerCase()) return;

        setLoading(true);
        setError("");
        setMessage("Wallet changed. Refreshing this poll for the selected account...");
        setRole(null);
        setParticipantCredential("");
        setPrivateCredential("");
        setDocumentType("");
        setProviderSessionId("");
        setProviderVerificationUrl("");
        setVerificationReference("");
        setIdentityStep("document");
        setVerificationLoading(false);
        setIdentityVerified(false);
        setIdentityCommitment("");
        setIdentityIssuerSignature("");
        setCredentialLoaded(false);
        setLastTxHash("");
        setRegistrationTxHash("");
        setHasVotedLocally(false);
        setChosenOptionName("");
        setStep(1);

        try {
          const browserProvider = new BrowserProvider(window.ethereum);
          const network = await browserProvider.getNetwork();
          if (network.chainId !== SEPOLIA_CHAIN_ID) {
            setAccount("");
            setSigner(null);
            setContract(null);
            setChainId(network.chainId.toString());
            setError("Please switch your MetaMask network to Sepolia.");
            return;
          }

          const walletSigner = await browserProvider.getSigner(nextAccount);
          setProvider(browserProvider);
          setSigner(walletSigner);
          setContract(new Contract(CONTRACT_ADDRESS, ABI, walletSigner));
          setAccount(nextAccount);
          setChainId(network.chainId.toString());
        } catch (err) {
          setError(getErrorMessage(err));
        } finally {
          setLoading(false);
        }
      }
    };
    window.ethereum.on("accountsChanged", handleAccountsChanged);
    return () => {
      if (window.ethereum.removeListener) window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
    };
  }, [account]);

  useEffect(() => {
    setDocumentType("");
    setProviderSessionId("");
    setProviderVerificationUrl("");
    setVerificationReference("");
    setIdentityStep("document");
    setIdentityVerified(false);
    setIdentityCommitment("");
    setIdentityIssuerSignature("");
  }, [account, poll?.id]);

  useEffect(() => {
    if (!account) {
      setOrganizerPolls([]);
      setGeneratedPollCode("");
      setCreatedSchedule(null);
      setAdminOutcome(null);
      setSelectedPreviousPollId("");
      return;
    }

    setOrganizerPolls(getSavedOrganizerPolls(account));
    setGeneratedPollCode("");
    setCreatedSchedule(null);
    setAdminOutcome(null);
    setSelectedPreviousPollId("");
  }, [account]);

  useEffect(() => {
    let cancelled = false;
    const updateChainTime = async () => {
      if (!provider) {
        setNowMilliseconds(Date.now());
        return;
      }

      try {
        const latestBlock = await provider.getBlock("latest");
        if (latestBlock && !cancelled) {
          setNowMilliseconds(Number(latestBlock.timestamp) * 1000);
        }
      } catch {
        if (!cancelled) setNowMilliseconds(Date.now());
      }
    };

    updateChainTime();
    const timer = window.setInterval(updateChainTime, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [provider]);

  useEffect(() => {
    if (!account) {
      setCredentialLoaded(false);
      setParticipantCredential("");
      setPrivateCredential("");
      setLastTxHash("");
      return;
    }

    const idToUse = poll?.id || joinPollId;
    if (!idToUse) {
      setCredentialLoaded(false);
      setParticipantCredential("");
      setPrivateCredential("");
      setLastTxHash("");
      return;
    }

    setCredentialLoaded(false);
    const savedCredential = getSavedCredential(idToUse, account);
    setParticipantCredential(savedCredential);
    setPrivateCredential(savedCredential);
    setCredentialLoaded(true);
    setLastTxHash(getSavedVoteTransaction(idToUse, account));
  }, [account, poll?.id, joinPollId, pollId]);

  async function copyCredential(credential) {
    try {
      await window.navigator.clipboard.writeText(credential);
      setMessage("Secret credential copied to clipboard.");
    } catch {
      setError("Clipboard access is unavailable. Select and copy the credential manually.");
    }
  }

  function downloadCredentialBackup() {
    if (!participantCredential) {
      setError("No participant credential is available to back up.");
      return;
    }

    try {
      const currentPollId = String(poll?.id || pollId);
      const backup = {
        app: "EthiopiaChain Secure ZK Polling",
        type: "Participant Credential Backup",
        pollId: currentPollId,
        wallet: account,
        credential: participantCredential,
        createdAt: new Date().toISOString()
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `ethiopiachain-poll-${currentPollId}-credential-backup.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setMessage("Credential backup downloaded. Store the file somewhere private and secure.");
    } catch (err) {
      console.error("Could not create credential backup.", err);
      setError("Could not create the credential backup.");
    }
  }

  function restoreCredentialFromBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const backup = JSON.parse(String(reader.result || ""));
        const backupPollId = String(backup.pollId || "");
        const credential = String(backup.credential || "");
        const currentPollId = String(poll?.id || pollId);

        if (!backupPollId) throw new Error("Backup does not contain a poll ID.");
        if (!credential) throw new Error("Backup does not contain a credential.");
        if (backupPollId !== currentPollId) {
          throw new Error(`This backup belongs to poll ${backupPollId}, not poll ${currentPollId}.`);
        }
        if (backup.wallet && account && backup.wallet.toLowerCase() !== account.toLowerCase()) {
          throw new Error("This backup belongs to a different wallet.");
        }

        if (poll?.registered && contract) {
          const leaves = await contract.getEligibilityLeaves(BigInt(currentPollId));
          const expectedCommitment = poseidonTwo(BigInt(credential), BigInt(currentPollId));
          if (!leaves.some((leaf) => BigInt(leaf) === expectedCommitment)) {
            throw new Error("This credential does not match the registered commitment for this poll.");
          }
        }

        if (!saveCredential(currentPollId, account, credential)) {
          throw new Error("Could not save the restored credential in this browser.");
        }

        setParticipantCredential(credential);
        setPrivateCredential(credential);
        setCredentialLoaded(true);
        setError("");
        setMessage("Participant credential restored successfully. Continue to vote and keep the backup file secure.");
      } catch (err) {
        console.error("Could not restore credential backup.", err);
        setError(err.message || "Invalid credential backup.");
      } finally {
        event.target.value = "";
      }
    };
    reader.onerror = () => {
      setError("Could not read the credential backup file.");
      event.target.value = "";
    };
    reader.readAsText(file);
  }

  async function connectWallet() {
    try {
      setLoading(true);
      setError("");
      if (!CONTRACT_ADDRESS) {
        throw new Error("VITE_CONTRACT_ADDRESS is not configured. Set it in the frontend environment and restart Vite.");
      }
      const browserProvider = new BrowserProvider(window.ethereum);
      await browserProvider.send("eth_requestAccounts", []);
      const network = await browserProvider.getNetwork();
      if (network.chainId !== SEPOLIA_CHAIN_ID) {
        setError("Please switch your MetaMask network to Sepolia.");
        return;
      }

      const walletSigner = await browserProvider.getSigner();
      const address = await walletSigner.getAddress();
      const votingContract = new Contract(CONTRACT_ADDRESS, ABI, walletSigner);

      setProvider(browserProvider);
      setSigner(walletSigner);
      setContract(votingContract);
      setAccount(address);
      setChainId(network.chainId.toString());

    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadPoll(requestedId) {
    if (!contract) return;
    try {
      const id = BigInt(requestedId);
      const [
        title, description, creator, roots, registrationTimes, times, status, ballots, optionData, participantCount, participantStatus
      ] = await Promise.all([
        contract.getVoteTitle(id),
        contract.getVoteDescription(id),
        contract.getVoteCreator(id),
        contract.getVoteRoots(id),
        contract.getRegistrationTimes(id),
        contract.getVoteTimes(id),
        contract.getVoteStatus(id),
        contract.getVoteBallots(id),
        contract.getElectionCandidates(id),
        contract.getParticipantCount(id),
        account
          ? contract.getParticipantStatus(id, account)
          : Promise.resolve([false, false])
      ]);

      const [eligibilityRoot, candidateRoot] = roots;
      const [registrationStartTime, registrationEndTime] = registrationTimes;
      const [startTime, endTime] = times;
      const [pending, active, ended, finalized] = status;
      const [acceptedBallots, revealedBallots] = ballots;
      const [optIds, optAddresses, optNames] = optionData;

      const loadedOptions = optIds.map((oId, index) => ({
        id: BigInt(oId).toString(),
        address: optAddresses[index],
        name: optNames[index]
      }));

      const loadedVoteCounts = {};
      for (const opt of loadedOptions) {
        loadedVoteCounts[opt.id] = BigInt(await contract.getVoteCount(id, BigInt(opt.id)));
      }
      setPoll({
        id: id.toString(),
        title,
        description,
        creator,
        eligibilityRoot: BigInt(eligibilityRoot).toString(),
        candidateRoot: BigInt(candidateRoot).toString(),
        registrationStartTime: BigInt(registrationStartTime).toString(),
        registrationEndTime: BigInt(registrationEndTime).toString(),
        startTime: BigInt(startTime).toString(),
        endTime: BigInt(endTime).toString(),
        pending, active, ended, finalized,
        registered: participantStatus[0],
        hasVotedOnChain: participantStatus[1],
        acceptedBallots: BigInt(acceptedBallots).toString(),
        revealedBallots: BigInt(revealedBallots).toString(),
        participantCount: BigInt(participantCount).toString()
      });
      setOptions(loadedOptions);
      setVoteCounts(loadedVoteCounts);

      if (loadedOptions.length > 0) {
        if (!privateOptionId) setPrivateOptionId(loadedOptions[0].id);
        if (!revealOptionId) setRevealOptionId(loadedOptions[0].id);
      }
      return true;
    } catch (err) {
      setError(`Could not load poll ${requestedId}. Check that the Poll ID is correct. If the contract reports missing revert data, it must be redeployed with on-chain registration schedule support.`);
      return false;
    }
  }

  async function handleCreatePoll() {
    try {
      if (!contract) throw new Error("Connect MetaMask first.");
      if (!createTitle.trim()) throw new Error("Enter a poll title.");
      if (!account) throw new Error("Wallet not connected.");
      if (pollOptions.length === 0) throw new Error("Add at least one option.");

      const registrationStart = dateTimeToTimestamp(registrationStartDate, registrationStartTime, timeOffsetMinutes);
      const registrationEnd = dateTimeToTimestamp(registrationEndDate, registrationEndTime, timeOffsetMinutes);
      const start = dateTimeToTimestamp(createStartDate, createStartTime, timeOffsetMinutes);
      const end = dateTimeToTimestamp(createEndDate, createEndTime, timeOffsetMinutes);
      const latestBlock = await provider.getBlock("latest");
      if (!latestBlock) throw new Error("Could not read the latest Sepolia block time. Try again.");
      if (registrationStart >= registrationEnd) throw new Error("Registration end time must be after registration start time.");
      if (registrationEnd <= Number(latestBlock.timestamp)) throw new Error("Registration end time must still be in the future.");
      if (registrationEnd > start) throw new Error("Registration must close at or before voting starts.");
      if (start <= Number(latestBlock.timestamp) + 60) {
        throw new Error("Set voting to start at least one minute in the future so there is time to register.");
      }
      if (start >= end) throw new Error("End time must be after start time.");

      const optionStructs = pollOptions.map((o, index) => {
        let candidateAddr;
        if (!o.name.trim()) {
          throw new Error(`Option #${index + 1} name cannot be empty.`);
        }

        if (pollCategory === "individual") {
          candidateAddr = o.address.trim();
          if (!candidateAddr) {
            throw new Error(`Please enter a valid Ethereum wallet address for ${o.name}`);
          }
        } else {
          candidateAddr = `0x000000000000000000000000000000000000${(index + 1).toString().padStart(4, "0")}`;
        }

        return {
          id: BigInt(index + 1),
          candidateAddress: candidateAddr,
          name: o.name.trim()
        };
      });

      if (pollCategory === "individual") {
        const addressSet = new Set(optionStructs.map((opt) => opt.candidateAddress.toLowerCase()));
        if (addressSet.size !== optionStructs.length) {
          throw new Error("Duplicate candidate addresses entered.");
        }
      }

      setLoading(true);
      setError("");
        setMessage("Creating poll and protecting it with an access code...");

        const accessCode = generateSecureBigInt();
        const accessCodeHash = keccak256(toUtf8Bytes(accessCode));

        const tx = await contract.createVoteWithRegistrationAndAccessCode(
        createTitle.trim(), 
        createDescription.trim(), 
        BigInt(registrationStart),
        BigInt(registrationEnd),
        BigInt(start), 
        BigInt(end), 
          accessCodeHash,
        optionStructs
      );
      await tx.wait();

      const nextId = await contract.nextElectionId();
      const newId = BigInt(nextId) - 1n;

      const schedule = { registrationStart, registrationEnd, start, end };
      const organizerPoll = {
        pollId: newId.toString(),
        title: createTitle.trim(),
        description: createDescription.trim(),
        accessCode,
        schedule,
        savedAt: new Date().toISOString()
      };
      const pollDetailsSaved = saveOrganizerPoll(account, organizerPoll);
      setGeneratedPollCode(accessCode);
      setPollId(newId.toString());
      setCreatedSchedule(schedule);
      setSelectedPreviousPollId(newId.toString());
      setOrganizerPolls(getSavedOrganizerPolls(account));

      setMessage(pollDetailsSaved
        ? `Poll successfully created! Organizer details are saved for this wallet. Registration closes at ${formatTimestamp(registrationEnd)}. Poll ID: ${newId}.`
        : `Poll created, but browser storage could not save the access code. Copy it now; it cannot be recovered from the on-chain hash. Poll ID: ${newId}.`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleVoterJoin() {
    try {
      if (!contract) throw new Error("Connect MetaMask first.");
      if (!joinPollId) throw new Error("Enter a Poll ID.");
      if (!joinAccessCode) throw new Error("Enter the Poll Access Code provided by the organizer.");

      setLoading(true);
      setError("");
      setMessage("Loading poll and restoring any saved credential...");

        const storedAccessCodeHash = await contract.getElectionAccessCodeHash(BigInt(joinPollId));
        if (storedAccessCodeHash === `0x${"00".repeat(32)}`) {
          throw new Error("This poll was created before access-code verification was added. Ask the organizer to create a poll using the updated app.");
        }
        const enteredAccessCodeHash = keccak256(toUtf8Bytes(joinAccessCode.trim()));
        if (enteredAccessCodeHash.toLowerCase() !== storedAccessCodeHash.toLowerCase()) {
          throw new Error("The Poll ID and Access Code do not match. Check the details from the organizer.");
        }

      const savedCredential = getSavedCredential(joinPollId, account);
      if (savedCredential) {
        setParticipantCredential(savedCredential);
        setPrivateCredential(savedCredential);
      }

      const loaded = await loadPoll(joinPollId);
      if (!loaded) return;
      setPollId(joinPollId);
      setParticipantCredential(savedCredential);
      setPrivateCredential(savedCredential);
      setCredentialLoaded(true);
      setLastTxHash(getSavedVoteTransaction(joinPollId, account));
      const [registered, hasVoted] = await contract.getParticipantStatus(BigInt(joinPollId), account);
      if (registered) {
        setMessage(savedCredential
          ? hasVoted
            ? "Welcome back! Your credential was restored. This wallet is already registered and has voted."
            : "Welcome back! Your saved secret credential was restored. You are already registered; proceed to Cast Vote."
          : "Sorry—we should have made it clearer at registration that you must keep a backup. Your wallet is registered, but this browser has no saved credential. Paste your backup on the Cast Vote step if you have one; the blockchain stores only a hash, so it cannot recreate the original.");
        setStep(2);
      } else {
        setMessage("Successfully connected to poll! Your saved credential was restored if you registered on this browser before. Proceed to register your wallet.");
        setStep(1);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function resetIdentityVerification() {
    setProviderSessionId("");
    setProviderVerificationUrl("");
    setVerificationReference("");
    setIdentityStep("document");
    setIdentityVerified(false);
    setIdentityCommitment("");
    setIdentityIssuerSignature("");
  }

  async function handleIdentityStart() {
    try {
      if (!account) throw new Error("Connect MetaMask first.");
      if (!poll) throw new Error("Join a poll before verifying your identity.");
      if (!documentType) throw new Error("Choose a National ID or passport.");

      setVerificationLoading(true);
      setError("");
      setMessage("");
      setIdentityVerified(false);
      setIdentityCommitment("");
      setIdentityIssuerSignature("");

      const response = await fetch(`${IDENTITY_API_URL.replace(/\/$/, "")}/api/identity/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentType,
          electionId: String(poll.id),
          participant: account
        })
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || "Could not start provider verification.");
      }
      if (typeof result.sessionId !== "string" || !result.sessionId || typeof result.verificationUrl !== "string") {
        throw new Error("Identity service returned an invalid provider session.");
      }
      const verificationUrl = new URL(result.verificationUrl);
      if (verificationUrl.protocol !== "https:") throw new Error("The identity provider returned an insecure verification URL.");

      setProviderSessionId(result.sessionId);
      setProviderVerificationUrl(verificationUrl.toString());
      setVerificationReference("");
      setIdentityStep("provider");
      setMessage("Continue in the authorized provider’s secure page. The app does not capture or assess your document or face.");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setVerificationLoading(false);
    }
  }

  async function handleIdentityComplete() {
    try {
      if (!providerSessionId) throw new Error("Start document verification first.");
      if (!verificationReference.trim()) throw new Error("Enter the verification reference returned by the provider.");

      setVerificationLoading(true);
      setError("");
      setMessage("");

      const response = await fetch(`${IDENTITY_API_URL.replace(/\/$/, "")}/api/identity/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: providerSessionId,
          verificationReference: verificationReference.trim()
        })
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || "The identity provider did not verify this session.");
      }
      if (result.verified !== true || result.documentType !== documentType ||
          typeof result.identityCommitment !== "string" || !/^0x[\da-fA-F]{64}$/.test(result.identityCommitment) ||
          typeof result.issuerSignature !== "string" || !/^0x[\da-fA-F]{130}$/.test(result.issuerSignature)) {
        throw new Error("The identity provider returned an invalid verification result.");
      }
      if (await contract.identityRegistered(BigInt(poll.id), result.identityCommitment)) {
        throw new Error("This person is already registered for this election.");
      }

      setIdentityCommitment(result.identityCommitment);
      setIdentityIssuerSignature(result.issuerSignature);
      setIdentityVerified(true);
      setIdentityStep("verified");
      setMessage("✅ The authorized provider verified your document, liveness, and face match.");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setVerificationLoading(false);
    }
  }

  async function handleSelfRegister() {
    setShowIdentityVerification(true);
    return;

    try {
      if (!contract) throw new Error("Connect MetaMask first.");
      if (!account) throw new Error("Wallet not connected.");
      if (!poll) throw new Error("Join a poll before registering.");
      const electionId = BigInt(poll.id || pollId);

      setLoading(true);
      setError("");
      setMessage("");

      const [registered, hasVoted] = await contract.getParticipantStatus(electionId, account);
      if (registered) {
        const savedCredential = getSavedCredential(electionId.toString(), account);
        setParticipantCredential(savedCredential);
        setPrivateCredential(savedCredential);
        setCredentialLoaded(true);
        setPoll((currentPoll) => currentPoll
          ? { ...currentPoll, registered: true, hasVotedOnChain: hasVoted }
          : currentPoll
        );

        if (savedCredential) {
          setMessage(hasVoted
            ? "You are already registered and have voted. Your original credential was restored."
            : "You are already registered. Your original credential was restored automatically.");
          await loadPoll(electionId.toString());
          setStep(2);
        } else {
          setMessage("This wallet is already registered, but the credential is unavailable in this browser. Restore your original credential from its backup; a replacement cannot be generated.");
        }
        return;
      }

      if (!identityVerified || !identityCommitment || !identityIssuerSignature) {
        throw new Error("Complete National ID and face verification first.");
      }

      const [registrationTimes, voteTimes, voteStatus, latestBlock] = await Promise.all([
        contract.getRegistrationTimes(electionId),
        contract.getVoteTimes(electionId),
        contract.getVoteStatus(electionId),
        provider.getBlock("latest")
      ]);
      if (!latestBlock) throw new Error("Could not read the latest Sepolia block time. Try again.");
      const chainTimestamp = Number(latestBlock.timestamp);
      const voteStart = Number(voteTimes[0]);
      const registrationStart = Number(registrationTimes[0]);
      const registrationEnd = Number(registrationTimes[1]);
      setNowMilliseconds(chainTimestamp * 1000);
      if (chainTimestamp < registrationStart) throw new Error(`Registration opens ${formatTimestamp(registrationStart)}.`);
      if (chainTimestamp >= registrationEnd) throw new Error(`Registration closed at ${formatTimestamp(registrationEnd)}.`);
      if (voteStatus[1] || chainTimestamp >= voteStart) {
        throw new Error("Registration closes when voting starts. This poll has already reached its voting start time.");
      }

      const credential = generateSecureBigInt();
      if (!saveCredential(electionId.toString(), account, credential)) {
        throw new Error("The credential could not be saved in this browser, so registration was cancelled. Enable browser storage or use another browser before registering.");
      }
      setParticipantCredential(credential);
      setPrivateCredential(credential);
      setCredentialLoaded(true);

      const commitment = poseidonTwo(credential, electionId);
      const nullifier = poseidonTwo(commitment, 1n);
      const identityHash = identityCommitment;

      setMessage("Waiting for registration transaction...");
      const tx = await contract.registerVerifiedParticipant(
        electionId,
        account,
        commitment,
        nullifier,
        identityHash,
        identityIssuerSignature
      );
      const receipt = await tx.wait();
      setRegistrationTxHash(receipt.hash);
      setProviderSessionId("");
      setProviderVerificationUrl("");
      setVerificationReference("");
      setDocumentType("");
      setIdentityStep("document");
      setIdentityVerified(false);
      setIdentityCommitment("");
      setIdentityIssuerSignature("");

      await loadPoll(electionId.toString());
      setMessage("✅ Registration successful! Your credential is saved in this browser. Download a backup and store it somewhere private and secure.");
      setStep(2);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleCastVote() {
    try {
      if (!contract) throw new Error("Connect MetaMask first.");
      if (!poll?.registered) throw new Error("Register for this poll before submitting a vote.");
      if (poll.hasVotedOnChain) throw new Error("This wallet has already submitted a vote for this poll.");
      const credentialValue = privateCredential || getSavedCredential(poll?.id, account);
      if (!credentialValue) {
        throw new Error("No credential was found for this poll and connected wallet. Reconnect the wallet used to register or paste your saved backup. Sorry—we should have made the need to keep a backup clearer. The blockchain stores only a hash, so it cannot recreate the original credential.");
      }
      if (!privateCredential) setPrivateCredential(credentialValue);
      
      const salt = privateSalt ? privateSalt : generateSecureBigInt();
      setPrivateSalt(salt);
      setRevealSalt(salt);

      const credential = BigInt(credentialValue);
      const optionId = BigInt(privateOptionId || options[0]?.id || "1");

      const selectedOpt = options.find((o) => o.id === optionId.toString());
      const candidateIndex = options.findIndex((o) => o.id === optionId.toString());
      if (candidateIndex < 0) throw new Error("Select a valid poll option.");
      if (selectedOpt) setChosenOptionName(selectedOpt.name);

      const leavesRaw = await contract.getEligibilityLeaves(BigInt(poll.id));
      const leaves = leavesRaw.map((v) => BigInt(v));
      const commitment = poseidonTwo(credential, BigInt(poll.id));

      let leafIndex = leaves.findIndex((l) => l === commitment);
      if (leafIndex === -1) throw new Error("Your commitment was not found in the Merkle eligibility tree.");

      const nullifier = poseidonTwo(commitment, 1n);
      const voteCommitment = poseidonTwo(optionId, BigInt(salt));

      const eligibilityWitness = getMerkleWitness(leaves, leafIndex);
      const candidateLeaves = Array(8).fill(0n);
      for (let index = 0; index < options.length; index++) {
        candidateLeaves[index] = poseidonTwo(BigInt(options[index].id), 0n);
      }
      const candidateWitness = getMerkleWitness(candidateLeaves, candidateIndex);

      if (eligibilityWitness.root !== BigInt(poll.eligibilityRoot)) {
        throw new Error("The on-chain eligibility tree does not match the poll root. Reload the poll and try again.");
      }
      if (candidateWitness.root !== BigInt(poll.candidateRoot)) {
        throw new Error("The poll options do not match the candidate root. Reload the poll before voting.");
      }

      setLoading(true);
      setError("");
      setMessage("Generating your private Groth16 proof...");

      const proofInput = {
        credential: credential.toString(),
        electionId: poll.id,
        candidateChoice: optionId.toString(),
        voteSalt: BigInt(salt).toString(),
        eligibilityPathElements: eligibilityWitness.pathElements.map(String),
        eligibilityPathIndices: eligibilityWitness.pathIndices.map(String),
        eligibilityRoot: eligibilityWitness.root.toString(),
        candidatePathElements: candidateWitness.pathElements.map(String),
        candidatePathIndices: candidateWitness.pathIndices.map(String),
        candidateRoot: candidateWitness.root.toString(),
        scopeRoot: poseidonTwo(eligibilityWitness.root, candidateWitness.root).toString()
      };
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        proofInput,
        "/zk/VoteValidity.wasm",
        "/zk/VoteValidity.zkey"
      );

      if (
        BigInt(publicSignals[0]) !== nullifier ||
        BigInt(publicSignals[1]) !== voteCommitment ||
        BigInt(publicSignals[2]) !== BigInt(poll.id)
      ) {
        throw new Error("Generated proof signals do not match this poll and ballot.");
      }

      const proofA = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];
      const proofB = [
        [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
        [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])]
      ];
      const proofC = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])];

      setMessage("Submitting the verified private vote transaction...");

      const tx = await contract.castPrivateVote(
        BigInt(poll.id),
        proofA,
        proofB,
        proofC,
        publicSignals.map((signal) => BigInt(signal))
      );
      
      const receipt = await tx.wait();
      setLastTxHash(receipt.hash);
      saveVoteTransaction(poll.id, account, receipt.hash);
      setHasVotedLocally(true);

      setMessage("Private vote cast successfully & permanently locked on-chain!");
      await loadPoll(poll.id);
      setStep(3); 
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleRevealVote() {
    try {
      if (!contract) throw new Error("Connect MetaMask first.");
      setLoading(true);
      setError("");
      setMessage("Revealing vote to tally board...");
      const tx = await contract.revealVote(BigInt(poll.id), BigInt(revealOptionId), BigInt(revealSalt));
      await tx.wait();
      setMessage("Vote successfully tallied!");
      await loadPoll(poll.id);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadAdminOutcome(requestedPollId) {
    try {
      if (!contract) throw new Error("Connect MetaMask first.");
      if (!account) throw new Error("Connect the organizer wallet first.");
      const organizerPollId = requestedPollId || selectedPreviousPollId || pollId;
      if (!organizerPollId) throw new Error("No poll ID is saved for this organizer wallet.");

      setLoading(true);
      setError("");
      setMessage("Loading the election tally from the contract...");

      const creator = await contract.getVoteCreator(BigInt(organizerPollId));
      if (creator.toLowerCase() !== account.toLowerCase()) {
        throw new Error("The connected wallet did not create this poll. Connect the organizer wallet to view its admin report.");
      }

      const loaded = await loadPoll(organizerPollId);
      if (!loaded) throw new Error(`Could not load poll ${organizerPollId}.`);

      const [title, times, status, ballots, candidateData] = await Promise.all([
        contract.getVoteTitle(BigInt(organizerPollId)),
        contract.getVoteTimes(BigInt(organizerPollId)),
        contract.getVoteStatus(BigInt(organizerPollId)),
        contract.getVoteBallots(BigInt(organizerPollId)),
        contract.getElectionCandidates(BigInt(organizerPollId))
      ]);
      const [acceptedBallots, revealedBallots] = ballots;
      const [ids, , names] = candidateData;
      const resultOptions = await Promise.all(ids.map(async (id, index) => ({
        id: BigInt(id).toString(),
        name: names[index],
        votes: BigInt(await contract.getVoteCount(BigInt(organizerPollId), BigInt(id))).toString()
      })));
      const resultSnapshot = {
        pollId: String(organizerPollId),
        title,
        creator,
        startTime: BigInt(times[0]).toString(),
        endTime: BigInt(times[1]).toString(),
        ended: Boolean(status[2]),
        finalized: Boolean(status[3]),
        acceptedBallots: BigInt(acceptedBallots).toString(),
        revealedBallots: BigInt(revealedBallots).toString(),
        unrevealedBallots: (BigInt(acceptedBallots) - BigInt(revealedBallots)).toString(),
        options: resultOptions,
        savedAt: new Date().toISOString()
      };

      setPollId(String(organizerPollId));
      setAdminOutcome(resultSnapshot);
      saveOrganizerOutcome(account, organizerPollId, resultSnapshot);
      setMessage("Election status and revealed-vote tally loaded and saved in this browser for the organizer wallet.");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleRestoreOrganizerPoll() {
    const previousPoll = organizerPolls.find(
      (item) => String(item.pollId) === String(selectedPreviousPollId)
    );
    if (!previousPoll) {
      setError("Choose a previous poll to restore or continue.");
      return;
    }

    setError("");
    setCreateTitle(String(previousPoll.title || ""));
    setCreateDescription(String(previousPoll.description || ""));
    setGeneratedPollCode(String(previousPoll.accessCode || ""));
    setCreatedSchedule(previousPoll.schedule || null);
    setPollId(String(previousPoll.pollId));
    setAdminOutcome(getOrganizerOutcome(account, previousPoll.pollId));
    await handleLoadAdminOutcome(String(previousPoll.pollId));
  }

  function downloadAdminOutcome() {
    if (!adminOutcome) return;
    const blob = new Blob([JSON.stringify(adminOutcome, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `poll-${adminOutcome.pollId}-outcome.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function enterVoterPortal() {
    setPoll(null);
    setPollId("1");
    setJoinPollId("");
    setJoinAccessCode("");
    setParticipantCredential("");
    setPrivateCredential("");
    setCredentialLoaded(false);
    setLastTxHash("");
    setRegistrationTxHash("");
    setHasVotedLocally(false);
    setChosenOptionName("");
    setStep(1);
    setMessage("");
    setError("");
    setRole("voter");
  }

  const currentTimestamp = Math.floor(nowMilliseconds / 1000);
  const scheduledVoteActive = Boolean(
    poll &&
    currentTimestamp >= Number(poll.startTime) &&
    currentTimestamp < Number(poll.endTime)
  );
  const scheduledVoteEnded = Boolean(
    poll && (poll.ended || currentTimestamp >= Number(poll.endTime))
  );
  const registrationOpen = Boolean(
    poll && !scheduledVoteActive && !scheduledVoteEnded &&
    currentTimestamp >= Number(poll.registrationStartTime) &&
    currentTimestamp < Number(poll.registrationEndTime) &&
    currentTimestamp < Number(poll.startTime)
  );
  const registrationStatus = poll
    ? registrationOpen
      ? `Registration is open until ${formatTimestamp(poll.registrationEndTime)}.`
      : currentTimestamp < Number(poll.registrationStartTime)
        ? `Registration opens ${formatTimestamp(poll.registrationStartTime)}.`
        : `Registration closed at ${formatTimestamp(poll.registrationEndTime)}.`
    : "";

  return (
    <div style={{ padding: "30px", maxWidth: "800px", margin: "0 auto", fontFamily: "Inter, sans-serif" }}>
      <h1>EthiopiaChain Secure ZK Polling</h1>

      <div style={{ background: "#ffffff", color: "#111", border: "1px solid #e2e8f0", padding: "15px", borderRadius: "12px", marginBottom: "20px", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.05)" }}>
        <div>
          {account ? (
            <span><strong>Connected:</strong> {shortAddress(account)} (Sepolia) — switch accounts in MetaMask; the app refreshes the poll for the selected wallet.</span>
          ) : (
            <span>Please connect your MetaMask wallet to start.</span>
          )}
        </div>
        <button onClick={connectWallet} disabled={loading} style={{ padding: "8px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600" }}>
          {account ? "Reconnect Wallet" : "Connect MetaMask"}
        </button>
      </div>

      {error && <div style={{ color: "#991b1b", background: "#fee2e2", border: "1px solid #f87171", padding: "12px", borderRadius: "8px", marginBottom: "15px" }}>{error}</div>}
      {message && <div style={{ color: "#065f46", background: "#d1fae5", border: "1px solid #34d399", padding: "12px", borderRadius: "8px", marginBottom: "15px" }}>{message}</div>}

      {!role && (
        <div>
          {/* Trust & Transparency Explainer Card */}
          <div style={{ background: "#ffffff", color: "#222", border: "1px solid #e2e8f0", padding: "25px", borderRadius: "16px", marginBottom: "25px", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)" }}>
            <h2 style={{ marginTop: 0, color: "#1e3a8a" }}>🛡️ Bank-Grade Blockchain Security & Trust</h2>
            <p style={{ color: "#4b5563", fontSize: "14px", lineHeight: "1.6" }}>
              This voting platform is built directly on decentralized smart contracts. Here is why it is 100% fraud-proof, irreversible, and verifiable:
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "15px", marginTop: "15px" }}>
              <div style={{ background: "#f8fafc", padding: "15px", borderRadius: "10px", borderLeft: "4px solid #2563eb" }}>
                <h4 style={{ margin: "0 0 5px 0", color: "#2563eb" }}>🔒 1. Immutable & Irreversible</h4>
                <p style={{ margin: 0, fontSize: "13px", color: "#4b5563" }}>Once deployed or recorded on-chain, nobody—not even the admin—can alter, delete, or reverse votes.</p>
              </div>
              <div style={{ background: "#f8fafc", padding: "15px", borderRadius: "10px", borderLeft: "4px solid #16a34a" }}>
                <h4 style={{ margin: "0 0 5px 0", color: "#16a34a" }}>🕵️‍♂️ 2. Zero-Knowledge Privacy</h4>
                <p style={{ margin: 0, fontSize: "13px", color: "#4b5563" }}>Your vote is cryptographically hidden. Anyone can verify <em>that</em> you voted legally, but nobody can see <em>who</em> you picked.</p>
              </div>
            </div>
          </div>

          <div style={{ textAlign: "center", background: "#ffffff", color: "#222", border: "1px solid #e2e8f0", padding: "30px", borderRadius: "16px", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)" }}>
            <h2>Please select your portal to begin:</h2>
            <div style={{ display: "flex", justifyContent: "center", gap: "20px", marginTop: "25px" }}>
              <button 
                onClick={enterVoterPortal} 
                style={{ padding: "16px 24px", fontSize: "15px", background: "#2563eb", color: "#fff", border: "none", borderRadius: "10px", cursor: "pointer", fontWeight: "bold", boxShadow: "0 4px 6px rgba(37,99,235,0.2)" }}
              >
                🗳️ Voter / Participant Portal
              </button>
              <button 
                onClick={() => setRole("admin")} 
                style={{ padding: "16px 24px", fontSize: "15px", background: "#475569", color: "#fff", border: "none", borderRadius: "10px", cursor: "pointer", fontWeight: "bold" }}
              >
                🛠️ Admin / Organizer Portal
              </button>
            </div>
          </div>
        </div>
      )}

      {role && (
        <div style={{ marginBottom: "20px" }}>
          <button onClick={() => setRole(null)} style={{ background: "none", border: "none", color: "#2563eb", cursor: "pointer", fontSize: "14px", padding: "0", textDecoration: "underline", fontWeight: "600" }}>
            ⬅ Switch Portal (Current: {role === "voter" ? "Voter / Participant" : "Admin / Organizer"})
          </button>
        </div>
      )}

      {role === "voter" && (
        <div>
          {!poll ? (
            <div style={{ background: "#ffffff", color: "#222", border: "1px solid #e2e8f0", padding: "25px", borderRadius: "16px", maxWidth: "450px", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)", margin: "0 auto" }}>
              <h3>Enter Poll Credentials</h3>
              <p style={{ fontSize: "14px", color: "#4b5563" }}>Enter the Poll ID and Access Code given by the organizer to join.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "15px" }}>
                <label style={{ fontWeight: "bold", fontSize: "13px" }}>Poll ID:</label>
                <input type="number" placeholder="e.g. 1" value={joinPollId} onChange={(e) => setJoinPollId(e.target.value)} style={{ padding: "10px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
                
                <label style={{ fontWeight: "bold", fontSize: "13px" }}>Access Code / Secret:</label>
                <input type="text" placeholder="Provided by organizer" value={joinAccessCode} onChange={(e) => setJoinAccessCode(e.target.value)} style={{ padding: "10px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />

                <button onClick={handleVoterJoin} disabled={loading} style={{ padding: "12px", background: "#2563eb", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: "bold", marginTop: "10px" }}>
                  {loading ? "Connecting..." : "Join Poll"}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ maxWidth: "550px", margin: "0 auto", background: "#ffffff", borderRadius: "16px", boxShadow: "0 20px 25px -5px rgba(0,0,0,0.05), 0 10px 10px -5px rgba(0,0,0,0.04)", overflow: "hidden", border: "1px solid #e2e8f0" }}>
              
              {/* Header Section */}
              <div style={{ background: "linear-gradient(to right, #2563eb, #4f46e5)", padding: "20px 24px", color: "#fff" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "700" }}>{poll.title}</h2>
                </div>
                <p style={{ color: "#e0e7ff", fontSize: "13px", margin: "6px 0 0 0" }}>{poll.description || "Cast your secure, zero-knowledge verified ballot."}</p>
                <div style={{ marginTop: "10px", fontSize: "12px", background: "rgba(255,255,255,0.2)", display: "inline-block", padding: "3px 8px", borderRadius: "20px" }}>
                  Status: {scheduledVoteActive ? "Active 🟢" : scheduledVoteEnded ? "Ended 🔴" : "Pending 🟡"}
                </div>
              </div>

              {/* Step Navigation Tabs */}
              <div style={{ display: "flex", borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
                <button onClick={() => setStep(1)} style={{ flex: 1, padding: "12px", fontWeight: step === 1 ? "bold" : "normal", background: step === 1 ? "#fff" : "transparent", border: "none", borderBottom: step === 1 ? "2px solid #2563eb" : "none", cursor: "pointer", color: step === 1 ? "#2563eb" : "#64748b", fontSize: "13px" }}>1. Self-Register</button>
                <button onClick={() => setStep(2)} style={{ flex: 1, padding: "12px", fontWeight: step === 2 ? "bold" : "normal", background: step === 2 ? "#fff" : "transparent", border: "none", borderBottom: step === 2 ? "2px solid #2563eb" : "none", cursor: "pointer", color: step === 2 ? "#2563eb" : "#64748b", fontSize: "13px" }}>2. Cast Vote</button>
                <button onClick={() => setStep(3)} style={{ flex: 1, padding: "12px", fontWeight: step === 3 ? "bold" : "normal", background: step === 3 ? "#fff" : "transparent", border: "none", borderBottom: step === 3 ? "2px solid #2563eb" : "none", cursor: "pointer", color: step === 3 ? "#2563eb" : "#64748b", fontSize: "13px" }}>3. Live Results</button>
              </div>

              {/* Body Content */}
              <div style={{ padding: "24px" }}>
                {step === 1 && (
                  <div>
                    <h3 style={{ marginTop: 0, fontSize: "16px" }}>Step 1: Self-Register Your Wallet</h3>
                    <p style={{ color: "#4b5563", fontSize: "13px", marginBottom: "15px" }}>Register your connected wallet ({shortAddress(account)}) into Poll #{poll.id} eligibility tree.</p>

                    <div style={{ background: registrationOpen ? "#ecfdf5" : "#fffbeb", border: `1px solid ${registrationOpen ? "#86efac" : "#fde68a"}`, padding: "12px", borderRadius: "8px", marginBottom: "15px", color: registrationOpen ? "#166534" : "#92400e", fontSize: "13px" }}>
                      <strong>{registrationStatus}</strong>
                      <div style={{ marginTop: "6px", lineHeight: "1.5" }}>
                        Registration window (on-chain): {formatTimestamp(poll.registrationStartTime)} – {formatTimestamp(poll.registrationEndTime)}<br />
                        Voting period: {formatTimestamp(poll.startTime)} – {formatTimestamp(poll.endTime)}
                      </div>
                    </div>

                    {poll.registered && (
                      <div style={{ background: "#ecfdf5", border: "1px solid #86efac", color: "#166534", padding: "12px", borderRadius: "8px", marginBottom: "15px", fontSize: "13px" }}>
                        <strong>Blockchain record:</strong> This wallet is registered for this poll.
                        {poll.hasVotedOnChain && <div>Your ballot is recorded on-chain. Your selected option is not linked to this wallet.</div>}
                        {poll.hasVotedOnChain && lastTxHash && (
                          <div style={{ marginTop: "6px" }}>
                            Vote transaction: <a href={`https://sepolia.etherscan.io/tx/${lastTxHash}`} target="_blank" rel="noreferrer" style={{ color: "#1d4ed8" }}>Track confirmed vote on Etherscan</a>
                          </div>
                        )}
                        {registrationTxHash && (
                          <div style={{ marginTop: "6px" }}>
                            Registration transaction: <a href={`https://sepolia.etherscan.io/tx/${registrationTxHash}`} target="_blank" rel="noreferrer" style={{ color: "#1d4ed8" }}>View on Etherscan</a>
                          </div>
                        )}
                      </div>
                    )}
                    
                    {/* Warning Triangle Info Box */}
                    <div style={{ background: "#fffbeb", border: "1px solid #fde68a", padding: "12px", borderRadius: "8px", marginBottom: "15px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
                      <span style={{ fontSize: "18px" }}>⚠️</span>
                      <div>
                        <strong style={{ color: "#92400e", fontSize: "13px", display: "block", marginBottom: "2px" }}>Keep Your Secret Credential Safe!</strong>
                        <p style={{ margin: 0, fontSize: "12px", color: "#b45309", lineHeight: "1.4" }}>
                          This credential is automatically saved in this browser for this wallet and poll. Keep a backup copy because it is required to cast your private vote.
                        </p>
                      </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      {!poll.registered && registrationOpen && (
                        <div style={{ display: "grid", gap: "10px", padding: "14px", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "8px" }}>
                          <h3 style={{ margin: 0, fontSize: "16px" }}>Identity Verification</h3>
                          {identityStep === "document" && (
                            <>
                              <label style={{ fontWeight: "bold", fontSize: "13px" }}>Choose document:</label>
                              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                {[{ value: "national_id", label: "National ID" }, { value: "passport", label: "Passport" }].map((document) => (
                                  <button
                                    key={document.value}
                                    type="button"
                                    onClick={() => {
                                      setDocumentType(document.value);
                                      resetIdentityVerification();
                                    }}
                                    aria-pressed={documentType === document.value}
                                    disabled={verificationLoading}
                                    style={{ padding: "9px 12px", background: documentType === document.value ? "#dbeafe" : "#fff", color: "#1e293b", border: documentType === document.value ? "2px solid #2563eb" : "1px solid #cbd5e1", borderRadius: "7px", cursor: "pointer", fontWeight: "600" }}
                                  >
                                    {document.label}
                                  </button>
                                ))}
                              </div>
                              {identityDocumentType && (
                                <div>
                                  <p>
                                    Upload your{" "}
                                    {identityDocumentType === "national_id"
                                      ? "National ID"
                                      : identityDocumentType === "passport"
                                        ? "Passport"
                                        : "Kebele ID"}
                                  </p>

                                  <input
                                    type="file"
                                    accept=".jpg,.jpeg,.png,.heif,.heic,.webp,.pdf"
                                    onChange={(event) => {
                                      const file = event.target.files?.[0] || null;
                                      setIdentityDocument(file);
                                    }}
                                  />

                                  {identityDocument && (
                                    <p>
                                      Selected: <strong>{identityDocument.name}</strong>
                                    </p>
                                  )}
                                </div>
                              )}
                              <p style={{ margin: 0, fontSize: "12px", color: "#475569" }}>
                                Document capture, readability checks, liveness, and face matching are performed by the authorized provider, not by this app.
                              </p>
                              <button
                                type="button"
                                onClick={handleIdentityStart}
                                disabled={verificationLoading || !documentType || !account || !poll}
                                style={{ padding: "10px", background: "#2563eb", color: "#fff", border: "none", borderRadius: "8px", cursor: verificationLoading ? "wait" : "pointer", fontWeight: "600" }}
                              >
                                {verificationLoading ? "Starting verification..." : "Start Document Verification"}
                              </button>
                            </>
                          )}
                          {identityStep === "provider" && (
                            <>
                              <p style={{ margin: 0, color: "#475569" }}>
                                Complete document and liveness checks in the provider’s secure flow. Return here after completion and enter its verification reference.
                              </p>
                              <a
                                href={providerVerificationUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ display: "inline-block", width: "fit-content", padding: "10px 12px", background: "#2563eb", color: "#fff", borderRadius: "8px", textDecoration: "none", fontWeight: "600" }}
                              >
                                Open Secure Provider Verification
                              </a>
                              <label htmlFor="provider-verification-reference" style={{ fontWeight: "bold", fontSize: "13px" }}>Provider verification reference:</label>
                              <input
                                id="provider-verification-reference"
                                type="text"
                                autoComplete="off"
                                value={verificationReference}
                                onChange={(event) => setVerificationReference(event.target.value)}
                                placeholder="Enter the reference provided after verification"
                                disabled={verificationLoading}
                                style={{ padding: "10px", background: "#f8fafc", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }}
                              />
                              <button
                                type="button"
                                onClick={handleIdentityComplete}
                                disabled={verificationLoading || !verificationReference.trim()}
                                style={{ padding: "10px", background: "#2563eb", color: "#fff", border: "none", borderRadius: "8px", cursor: verificationLoading ? "wait" : "pointer", fontWeight: "600" }}
                              >
                                {verificationLoading ? "Checking provider result..." : "Verify Provider Result"}
                              </button>
                              <button type="button" onClick={resetIdentityVerification} disabled={verificationLoading} style={{ width: "fit-content", padding: "8px 10px", background: "transparent", color: "#475569", border: "1px solid #cbd5e1", borderRadius: "7px", cursor: "pointer" }}>
                                Start over
                              </button>
                            </>
                          )}
                          {identityStep === "verified" && identityVerified && (
                            <div role="status" style={{ padding: "12px", color: "#166534", background: "#ecfdf5", border: "1px solid #86efac", borderRadius: "8px", fontSize: "13px" }}>
                              ✅ The authorized provider verified the {documentType === "passport" ? "passport" : "National ID"}, document quality, liveness, and face match for this poll. The app stores only the election-scoped commitment, not document images or biometric data.
                            </div>
                          )}
                        </div>
                      )}
                      {!credentialLoaded ? (
                        <div style={{ background: "#f8fafc", padding: "12px", borderRadius: "8px", color: "#64748b" }}>Loading your saved credential...</div>
                      ) : participantCredential ? (
                        <div style={{ background: "#ecfdf5", border: "1px solid #86efac", padding: "14px", borderRadius: "8px", overflowWrap: "anywhere" }}>
                          <strong style={{ color: "#166534" }}>✅ Your Secret Credential</strong>
                          <p style={{ margin: "6px 0", fontSize: "12px", color: "#475569" }}>This is the same credential used for your registration. Keep a backup copy for generating your private voting proof.</p>
                          <div style={{ background: "#fff", border: "1px solid #cbd5e1", padding: "10px", borderRadius: "6px", marginTop: "8px" }}>
                            <code style={{ wordBreak: "break-all", color: "#111827" }}>{participantCredential}</code>
                          </div>
                          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                            <button type="button" onClick={() => copyCredential(participantCredential)} style={{ marginTop: "8px", padding: "8px 12px", background: "#2563eb", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600" }}>📋 Copy Credential</button>
                            <button type="button" onClick={downloadCredentialBackup} style={{ marginTop: "8px", padding: "8px 12px", background: "#16a34a", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600" }}>💾 Download Backup</button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ background: poll.registered ? "#fff7ed" : "#fffbeb", border: "1px solid #fdba74", padding: "12px", borderRadius: "8px", color: "#92400e" }}>
                          {poll.registered
                            ? "⚠️ Already registered, but this browser has no saved credential. Restore the original credential backup; no replacement will be generated."
                            : "No credential is stored on this browser for this poll and wallet."}
                          {poll.registered && (
                            <label style={{ display: "block", marginTop: "10px", fontWeight: "600" }}>
                              Restore Credential Backup (JSON)
                              <input type="file" accept=".json,application/json" onChange={restoreCredentialFromBackup} style={{ display: "block", marginTop: "6px" }} />
                            </label>
                          )}
                        </div>
                      )}
                      {!poll.registered && registrationOpen && (
                        <div>
                          <label style={{ fontWeight: "bold", fontSize: "13px" }}>Secret Credential</label>
                          <p style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>It will be generated automatically when you register.</p>
                        </div>
                      )}
                      {poll.registered ? (
                        <button onClick={() => setStep(2)} style={{ padding: "12px", background: "#16a34a", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: "bold", marginTop: "10px", width: "100%" }}>
                          ✅ Already Registered — Continue to Vote ➡️
                        </button>
                      ) : (
                        <button onClick={handleSelfRegister} disabled={loading || !account || !registrationOpen} style={{ padding: "12px", background: registrationOpen ? "#2563eb" : "#94a3b8", color: "#fff", border: "none", borderRadius: "8px", cursor: registrationOpen ? "pointer" : "not-allowed", fontWeight: "bold", marginTop: "10px", width: "100%" }}>
                          {loading ? "Registering..." : registrationOpen ? "Register & Proceed to Vote ➡️" : "Registration Closed"}
                        </button>
                      )}
                    </div>
                    {showIdentityVerification && (
                      <div className="identity-verification">
                        <h3>Identity Verification</h3>

                        <p>
                          Verify your identity before registering for this poll.
                        </p>

                        <label>Choose identification document</label>

                        <div>
                          <button
                            type="button"
                            onClick={() => setIdentityDocumentType("national_id")}
                          >
                            National ID
                          </button>

                          <button
                            type="button"
                            onClick={() => setIdentityDocumentType("passport")}
                          >
                            Passport
                          </button>

                          <button
                            type="button"
                            onClick={() => setIdentityDocumentType("kebele_id")}
                          >
                            Kebele ID
                          </button>
                        </div>

                        {identityDocumentType && (
                          <div>
                            <p>
                              Selected:{" "}
                              <strong>
                                {identityDocumentType === "national_id"
                                  ? "National ID"
                                  : identityDocumentType === "passport"
                                    ? "Passport"
                                    : "Kebele ID"}
                              </strong>
                            </p>

                            <button
                              type="button"
                              disabled={loading || !identityDocumentType}
                              onClick={async () => {
                                if (!identityDocument) {
                                  setError("Please select your identification document first.");
                                  return;
                                }

                                try {
                                  setLoading(true);
                                  setError("");
                                  setMessage("");

                                  const formData = new FormData();
                                  formData.append("pollId", String(poll?.id || pollId));
                                  formData.append("documentType", identityDocumentType);
                                  formData.append("document", identityDocument);

                                  const response = await fetch(
                                    `${IDENTITY_API_URL.replace(/\/$/, "")}/api/identity/start`,
                                    {
                                      method: "POST",
                                      body: formData
                                    }
                                  );
                                  const data = await response.json();

                                  if (!response.ok) {
                                    throw new Error(data?.error || "Could not start identity verification.");
                                  }

                                  if (!data?.verificationUrl) {
                                    throw new Error("The identity provider did not return a verification URL.");
                                  }

                                  window.location.href = data.verificationUrl;
                                } catch (err) {
                                  setError(err?.message || "Identity verification could not be started.");
                                } finally {
                                  setLoading(false);
                                }
                              }}
                            >
                              {loading ? "Starting verification..." : "Continue"}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {step === 2 && (
                  <div>
                    <h3 style={{ marginTop: 0, fontSize: "16px" }}>Step 2: Cast Private ZK Vote</h3>
                    <p style={{ fontSize: "12px", color: "#dc2626", fontWeight: "600", marginBottom: "15px" }}>⚠️ Warning: Once sent and recorded on the blockchain, your vote is permanent and immutable!</p>
                    
                    {/* Warning Triangle Info Box */}
                    <div style={{ background: "#fffbeb", border: "1px solid #fde68a", padding: "12px", borderRadius: "8px", marginBottom: "15px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
                      <span style={{ fontSize: "18px" }}>⚠️</span>
                      <div>
                        <strong style={{ color: "#92400e", fontSize: "13px", display: "block", marginBottom: "2px" }}>Secret Credential Reminder</strong>
                        <p style={{ margin: 0, fontSize: "12px", color: "#b45309", lineHeight: "1.4" }}>
                          Make sure your secret credential below is correct. It links your eligibility without revealing who you voted for.
                        </p>
                      </div>
                    </div>

                    {!credentialLoaded ? (
                      <div style={{ background: "#f8fafc", padding: "12px", borderRadius: "8px", color: "#64748b", marginBottom: "14px" }}>Loading your saved credential...</div>
                    ) : privateCredential ? (
                      <div style={{ background: "#ecfdf5", border: "1px solid #86efac", padding: "14px", borderRadius: "8px", marginBottom: "14px", overflowWrap: "anywhere" }}>
                        <strong style={{ color: "#166534" }}>✅ Your Secret Credential</strong>
                        <p style={{ margin: "6px 0", fontSize: "12px", color: "#475569" }}>This is the same credential used for your registration. Keep a backup copy for generating your private voting proof.</p>
                        <div style={{ background: "#fff", border: "1px solid #cbd5e1", padding: "10px", borderRadius: "6px", marginTop: "8px" }}>
                          <code style={{ wordBreak: "break-all", color: "#111827" }}>{privateCredential}</code>
                        </div>
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                          <button type="button" onClick={() => copyCredential(privateCredential)} style={{ marginTop: "8px", padding: "8px 12px", background: "#2563eb", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600" }}>📋 Copy Credential</button>
                          <button type="button" onClick={downloadCredentialBackup} style={{ marginTop: "8px", padding: "8px 12px", background: "#16a34a", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600" }}>💾 Download Backup</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ background: "#fffbeb", border: "1px solid #fde68a", padding: "12px", borderRadius: "8px", color: "#92400e", marginBottom: "14px" }}>
                        ⚠️ No saved credential was found for this wallet and poll. The blockchain cannot recreate it. Restore the original JSON backup below; the app will not generate a replacement for an already-registered voter.
                        {poll.registered && (
                          <label style={{ display: "block", marginTop: "10px", fontWeight: "600" }}>
                            Restore Credential Backup (JSON)
                            <input type="file" accept=".json,application/json" onChange={restoreCredentialFromBackup} style={{ display: "block", marginTop: "6px" }} />
                          </label>
                        )}
                      </div>
                    )}

                    {hasVotedLocally || poll.hasVotedOnChain ? (
                      <div style={{ background: "#d1fae5", border: "1px solid #34d399", padding: "16px", borderRadius: "10px" }}>
                        <h4 style={{ color: "#065f46", margin: "0 0 6px 0" }}>✅ Blockchain confirms this wallet has voted.</h4>
                        {chosenOptionName && <p style={{ margin: "4px 0", color: "#065f46", fontSize: "14px" }}>You voted for: <strong>{chosenOptionName}</strong></p>}
                        <p style={{ margin: "4px 0", fontSize: "12px", color: "#047857" }}>Your privacy is cryptographically protected via Zero-Knowledge proofs.</p>
                        {lastTxHash && (
                          <p style={{ margin: "10px 0 0 0", fontSize: "12px" }}>
                            🔗 <strong>Blockchain Proof:</strong>{" "}
                            <a href={`https://sepolia.etherscan.io/tx/${lastTxHash}`} target="_blank" rel="noreferrer" style={{ color: "#1d4ed8", fontWeight: "600" }}>
                              {lastTxHash.slice(0, 10)}...{lastTxHash.slice(-8)}
                            </a>
                          </p>
                        )}
                        <button onClick={() => setStep(3)} style={{ marginTop: "15px", padding: "10px 16px", background: "#16a34a", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: "bold", width: "100%" }}>
                          View Live Tally & Results ➡️
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        {credentialLoaded && !privateCredential && (
                          <>
                            <label style={{ fontWeight: "bold", fontSize: "13px" }}>Enter your original credential if you saved it elsewhere:</label>
                            <input type="text" value={privateCredential} onChange={(e) => {
                              const value = e.target.value;
                              setPrivateCredential(value);
                              setParticipantCredential(value);
                              saveCredential(poll?.id, account, value);
                            }} style={{ padding: "10px", background: "#f8fafc", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
                          </>
                        )}

                        <label style={{ fontWeight: "bold", fontSize: "13px" }}>Select Candidate / Option:</label>
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          {options.map((o) => (
                            <label key={o.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderRadius: "10px", border: privateOptionId === o.id ? "2px solid #2563eb" : "1px solid #cbd5e1", background: privateOptionId === o.id ? "#eff6ff" : "#fff", cursor: "pointer" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                <input type="radio" name="poll_choice" checked={privateOptionId === o.id} onChange={() => setPrivateOptionId(o.id)} style={{ width: "16px", height: "16px" }} />
                                <span style={{ fontWeight: "600", color: "#1e293b", fontSize: "14px" }}>{o.name}</span>
                              </div>
                            </label>
                          ))}
                        </div>

                        <button onClick={handleCastVote} disabled={loading || !scheduledVoteActive} style={{ padding: "14px", background: scheduledVoteActive ? "linear-gradient(to right, #2563eb, #4f46e5)" : "#94a3b8", color: "#fff", border: "none", borderRadius: "10px", cursor: loading || !scheduledVoteActive ? "not-allowed" : "pointer", fontWeight: "bold", marginTop: "10px", boxShadow: "0 4px 6px rgba(37,99,235,0.2)" }}>
                          {loading ? "Generating proof / submitting..." : scheduledVoteActive ? "Vote Next →" : scheduledVoteEnded ? "Voting Has Ended" : `Voting Opens ${formatTimestamp(poll.startTime)}`}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {step === 3 && (
                  <div>
                    <h3 style={{ marginTop: 0, fontSize: "16px" }}>Step 3: Live Results & Tally Board</h3>
                    <div style={{ background: poll.finalized ? "#ecfdf5" : scheduledVoteEnded ? "#fffbeb" : "#eff6ff", border: `1px solid ${poll.finalized ? "#86efac" : scheduledVoteEnded ? "#fde68a" : "#bfdbfe"}`, padding: "12px", borderRadius: "8px", marginBottom: "14px", color: poll.finalized ? "#166534" : scheduledVoteEnded ? "#92400e" : "#1e40af", fontSize: "13px" }}>
                      {poll.finalized
                        ? `Election finalized. ${poll.revealedBallots} of ${poll.acceptedBallots} accepted ballots have been revealed and included in this tally.`
                        : scheduledVoteEnded
                          ? `Voting has ended. This is the revealed-vote tally so far: ${poll.revealedBallots} of ${poll.acceptedBallots} accepted ballots. Unrevealed ballots are not yet counted for candidates.`
                          : "Live tally of revealed ballots. Final results will be available after voting and the reveal period are complete."}
                    </div>
                    
                    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", padding: "16px", borderRadius: "12px", marginBottom: "20px" }}>
                      <h4 style={{ margin: "0 0 12px 0", color: "#1e293b" }}>Tally Board for Poll #{poll.id}</h4>
                      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        {options.map((o) => {
                          const count = voteCounts[o.id] ? Number(voteCounts[o.id]) : 0;
                          return (
                            <div key={o.id} style={{ background: "#fff", padding: "10px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px", fontWeight: "600", marginBottom: "4px", color: "#1e293b" }}>
                                <span>{o.name}</span>
                                <span style={{ color: "#2563eb" }}>{count} verified votes</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <h4 style={{ fontSize: "14px", marginBottom: "8px" }}>Reveal Your Vote (Optional / Post-Election)</h4>
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      <select value={revealOptionId} onChange={(e) => setRevealOptionId(e.target.value)} style={{ padding: "10px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }}>
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>{o.name}</option>
                        ))}
                      </select>
                      <button onClick={handleRevealVote} disabled={loading} style={{ padding: "10px", background: "#16a34a", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" }}>
                        {loading ? "Revealing..." : "Reveal Vote to Tally"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {role === "admin" && (
        <div style={{ background: "#ffffff", padding: "25px", border: "1px solid #e2e8f0", borderRadius: "16px", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)" }}>
          <h2>Admin Portal: Create Time-Locked Election / Poll</h2>
          <p style={{ fontSize: "14px", color: "#4b5563" }}>
            Choose registration and voting times. The Poll ID and access code are shared with participants; the contract stores only a hash of the access code.
          </p>

          <section style={{ background: "#f8fafc", border: "1px solid #cbd5e1", padding: "16px", borderRadius: "12px", margin: "18px 0" }}>
            <button
              type="button"
              onClick={() => setShowPreviousPolls((visible) => !visible)}
              style={{ padding: "9px 13px", background: "#334155", color: "#fff", border: "none", borderRadius: "7px", cursor: "pointer", fontWeight: "600" }}
            >
              {showPreviousPolls ? "Hide Previous Polls" : "See Previous Polls"}
            </button>
            {showPreviousPolls && (
              <div style={{ display: "grid", gap: "10px", marginTop: "14px", maxWidth: "600px" }}>
                <p style={{ margin: 0, color: "#475569", fontSize: "14px" }}>
                  Previous polls are not opened automatically. Select one to restore its saved organizer details and continue managing it.
                </p>
                {organizerPolls.length > 0 ? (
                  <>
                    <label htmlFor="previous-organizer-poll" style={{ fontWeight: "600", fontSize: "13px" }}>Choose a previous poll:</label>
                    <select
                      id="previous-organizer-poll"
                      value={selectedPreviousPollId}
                      onChange={(event) => setSelectedPreviousPollId(event.target.value)}
                      style={{ padding: "10px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }}
                    >
                      <option value="">Select a poll</option>
                      {organizerPolls.map((previousPoll) => (
                        <option key={previousPoll.pollId} value={previousPoll.pollId}>
                          {previousPoll.title || "Untitled poll"} — Poll #{previousPoll.pollId}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleRestoreOrganizerPoll}
                      disabled={loading || !selectedPreviousPollId}
                      style={{ padding: "10px 14px", width: "fit-content", background: "#2563eb", color: "#fff", border: "none", borderRadius: "7px", cursor: loading ? "wait" : "pointer", fontWeight: "600" }}
                    >
                      {loading ? "Loading Poll..." : "Restore / Continue Selected Poll"}
                    </button>
                  </>
                ) : (
                  <p style={{ margin: 0, color: "#64748b" }}>No previous polls are saved for this organizer wallet yet.</p>
                )}
              </div>
            )}
          </section>

          {(generatedPollCode || adminOutcome) && (
            <section style={{ background: "#f8fafc", border: "1px solid #cbd5e1", padding: "18px", borderRadius: "12px", margin: "18px 0" }}>
              <h3 style={{ marginTop: 0 }}>Organizer Election & Results</h3>
              {generatedPollCode && (
                <p style={{ margin: "4px 0 12px", color: "#475569" }}>
                  Saved election: <strong>{createTitle || adminOutcome?.title || "Poll"}</strong> · Poll ID <strong>{pollId}</strong>
                </p>
              )}
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                <button onClick={handleLoadAdminOutcome} disabled={loading} style={{ padding: "10px 14px", background: "#2563eb", color: "#fff", border: "none", borderRadius: "7px", cursor: loading ? "wait" : "pointer", fontWeight: "600" }}>
                  {loading ? "Loading..." : "Refresh Election Results"}
                </button>
                {adminOutcome && (
                  <button onClick={downloadAdminOutcome} style={{ padding: "10px 14px", background: "#16a34a", color: "#fff", border: "none", borderRadius: "7px", cursor: "pointer", fontWeight: "600" }}>
                    Download Outcome JSON
                  </button>
                )}
              </div>

              {adminOutcome && (
                <div style={{ marginTop: "16px" }}>
                  <h4 style={{ margin: "0 0 8px" }}>{adminOutcome.title} — Poll #{adminOutcome.pollId}</h4>
                  <p style={{ margin: "4px 0", color: "#475569" }}>
                    Status: {adminOutcome.finalized ? "Finalized" : adminOutcome.ended ? "Voting ended — tally may be provisional" : "Voting in progress"}
                  </p>
                  <p style={{ margin: "4px 0", color: "#475569" }}>
                    Accepted ballots: {adminOutcome.acceptedBallots} · Revealed: {adminOutcome.revealedBallots} · Unrevealed: {adminOutcome.unrevealedBallots}
                  </p>
                  <div style={{ display: "grid", gap: "8px", marginTop: "10px" }}>
                    {adminOutcome.options.map((option) => (
                      <div key={option.id} style={{ display: "flex", justifyContent: "space-between", padding: "10px 12px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: "7px" }}>
                        <strong>{option.name}</strong>
                        <span>{option.votes} revealed votes</span>
                      </div>
                    ))}
                  </div>
                  <p style={{ fontSize: "12px", color: "#64748b", marginBottom: 0 }}>
                    Updated {new Date(adminOutcome.savedAt).toLocaleString()}. On-chain ballot commitments are private; candidate totals include only ballots that have been revealed.
                  </p>
                </div>
              )}
            </section>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "600px", marginTop: "15px" }}>
            <label style={{ fontWeight: "bold", fontSize: "13px" }}>Poll Type:</label>
            <select 
              value={pollCategory} 
              onChange={(e) => {
                const val = e.target.value;
                setPollCategory(val);
                setPollOptions([{ id: "1", name: "", address: "" }]);
              }} 
              style={{ padding: "10px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }}
            >
              <option value="individual">👤 Individual Candidates (Requires Ethereum Wallet Addresses)</option>
              <option value="commodity">📦 General Poll / Options (Names Only)</option>
            </select>

            <input type="text" placeholder="Poll Title (e.g., Student Union Election 2026)" value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} style={{ padding: "10px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
            <textarea placeholder="Description" value={createDescription} onChange={(e) => setCreateDescription(e.target.value)} style={{ padding: "10px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />

            <label style={{ fontWeight: "bold", fontSize: "13px" }}>Time Zone:</label>
            <select 
              value={selectedTimeZone} 
              onChange={(e) => {
                const tz = e.target.value;
                setSelectedTimeZone(tz);
                if (tz === "Africa/Addis_Ababa") setTimeOffsetMinutes(180);
                else if (tz === "UTC") setTimeOffsetMinutes(0);
                else if (tz === "America/New_York") setTimeOffsetMinutes(-300);
              }} 
              style={{ padding: "10px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }}
            >
              <option value="Africa/Addis_Ababa">East Africa Time (EAT - Addis Ababa)</option>
              <option value="UTC">UTC (Coordinated Universal Time)</option>
              <option value="America/New_York">Eastern Time (US / New York)</option>
            </select>

            <label style={{ fontWeight: "bold", fontSize: "14px", marginTop: "6px" }}>Participant Registration Period</label>
            <p style={{ margin: 0, color: "#64748b", fontSize: "12px" }}>Registration schedule is enforced on-chain. The access code is checked against its on-chain hash before participants can join.</p>
            <div style={{ display: "flex", gap: "10px" }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: "13px", fontWeight: "bold" }}>Registration Opens:</label>
                <div style={{ display: "flex", gap: "5px", marginTop: "4px" }}>
                  <input type="date" value={registrationStartDate} onChange={(e) => setRegistrationStartDate(e.target.value)} style={{ padding: "8px", width: "100%", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
                  <input type="time" value={registrationStartTime} onChange={(e) => setRegistrationStartTime(e.target.value)} style={{ padding: "8px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: "13px", fontWeight: "bold" }}>Registration Closes:</label>
                <div style={{ display: "flex", gap: "5px", marginTop: "4px" }}>
                  <input type="date" value={registrationEndDate} onChange={(e) => setRegistrationEndDate(e.target.value)} style={{ padding: "8px", width: "100%", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
                  <input type="time" value={registrationEndTime} onChange={(e) => setRegistrationEndTime(e.target.value)} style={{ padding: "8px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
                </div>
              </div>
            </div>

            <label style={{ fontWeight: "bold", fontSize: "14px", marginTop: "6px" }}>Voting Period</label>
            <div style={{ display: "flex", gap: "10px" }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: "13px", fontWeight: "bold" }}>Voting Starts:</label>
                <div style={{ display: "flex", gap: "5px", marginTop: "4px" }}>
                  <input type="date" value={createStartDate} onChange={(e) => setCreateStartDate(e.target.value)} style={{ padding: "8px", width: "100%", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
                  <input type="time" value={createStartTime} onChange={(e) => setCreateStartTime(e.target.value)} style={{ padding: "8px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: "13px", fontWeight: "bold" }}>Voting Ends:</label>
                <div style={{ display: "flex", gap: "5px", marginTop: "4px" }}>
                  <input type="date" value={createEndDate} onChange={(e) => setCreateEndDate(e.target.value)} style={{ padding: "8px", width: "100%", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
                  <input type="time" value={createEndTime} onChange={(e) => setCreateEndTime(e.target.value)} style={{ padding: "8px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
                </div>
              </div>
            </div>

            <label style={{ fontWeight: "bold", fontSize: "13px" }}>Options / Choices:</label>
            {pollOptions.map((o, i) => (
              <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "8px", background: "#f8fafc", border: "1px solid #e2e8f0", padding: "10px", borderRadius: "8px" }}>
                <input 
                  placeholder={pollCategory === "individual" ? `Candidate ${i + 1} Name` : `Option ${i + 1} Name`} 
                  value={o.name} 
                  onChange={(e) => { 
                    const u = [...pollOptions]; 
                    u[i].name = e.target.value; 
                    setPollOptions(u); 
                  }} 
                  style={{ flex: 1, padding: "8px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "6px" }} 
                />
                {pollCategory === "individual" && (
                  <input 
                    placeholder="Wallet Address (0x...)" 
                    value={o.address} 
                    onChange={(e) => { 
                      const u = [...pollOptions]; 
                      u[i].address = e.target.value; 
                      setPollOptions(u); 
                    }} 
                    style={{ flex: 1.5, padding: "8px", background: "#fff", color: "#000", border: "1px solid #cbd5e1", borderRadius: "6px" }} 
                  />
                )}
              </div>
            ))}

            <button onClick={() => setPollOptions([...pollOptions, { id: String(pollOptions.length + 1), name: "", address: "" }])} style={{ padding: "8px", background: "#64748b", color: "#fff", border: "none", borderRadius: "6px", width: "160px", cursor: "pointer", fontWeight: "600" }}>
              + Add Option
            </button>

            <button onClick={handleCreatePoll} disabled={loading} style={{ padding: "12px", background: "#16a34a", color: "#fff", border: "none", borderRadius: "8px", fontWeight: "bold", marginTop: "10px", cursor: "pointer" }}>
              {loading ? "Creating..." : "Create Poll 🚀"}
            </button>

            {generatedPollCode && (
              <div style={{ background: "#d1fae5", border: "1px solid #34d399", color: "#065f46", padding: "15px", borderRadius: "10px", marginTop: "15px" }}>
                <h4 style={{ margin: "0 0 5px 0" }}>✅ Your Poll Details</h4>
                <p style={{ margin: "4px 0" }}>These details are saved for this organizer wallet. Use “See Previous Polls” to reopen them later. Share them with participants:</p>
                {createTitle && <p style={{ margin: "4px 0" }}><strong>Poll:</strong> {createTitle}</p>}
                <p style={{ margin: "4px 0" }}><strong>Poll ID:</strong> {pollId}</p>
                <p style={{ margin: "4px 0" }}><strong>Access Code:</strong> <code style={{ background: "#fff", color: "#000", padding: "3px 6px", border: "1px solid #cbd5e1", borderRadius: "4px" }}>{generatedPollCode}</code></p>
                <button type="button" onClick={() => copyCredential(generatedPollCode)} style={{ marginTop: "6px", padding: "8px 12px", background: "#2563eb", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600" }}>Copy Access Code</button>
                {createdSchedule && (
                  <>
                    <p style={{ margin: "8px 0 0" }}><strong>Registration:</strong> {formatTimestamp(createdSchedule.registrationStart)} – {formatTimestamp(createdSchedule.registrationEnd)}</p>
                    <p style={{ margin: "4px 0 0" }}><strong>Voting:</strong> {formatTimestamp(createdSchedule.start)} – {formatTimestamp(createdSchedule.end)}</p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}