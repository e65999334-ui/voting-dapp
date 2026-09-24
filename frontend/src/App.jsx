import { useEffect, useMemo, useState } from "react";
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
} from "ethers";

const LOCAL_RPC_URL = "http://127.0.0.1:8545";

const CONTRACT_ABI = [
  "function nextElectionId() view returns (uint256)",
  "function approvalThreshold() view returns (uint256)",
  "function governanceMembers(uint256) view returns (address)",
  "function isGovernanceMember(address) view returns (bool)",
  "function elections(uint256) view returns (string title,uint256 eligibilityRoot,uint256 candidateRoot,uint64 startTime,uint64 endTime,uint64 revealDeadline,bool proposalApproved,bool votingStarted,bool ended,bool finalized,uint256 acceptedBallots,uint256 revealedBallots)",
  "function getElectionCandidates(uint256) view returns (uint256[])",
  "function getVoteCount(uint256,uint256) view returns (uint256)",
  "function proposeElection(string,uint256,uint64,uint64,uint256[]) returns (uint256)",
  "function approveElection(uint256)",
  "function activateElection(uint256)",
  "function endElection(uint256)",
  "function revealVote(uint256,uint256,uint256)",
  "function finalizeElection(uint256)",
];

function shortenAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatDate(timestamp) {
  if (!timestamp || Number(timestamp) === 0) return "";
  return new Date(Number(timestamp) * 1000).toLocaleString();
}

function statusForElection(election) {
  if (!election) return "NO ELECTION";
  if (election.finalized) return "FINALIZED";
  if (election.ended) return "REVEAL";
  if (election.votingStarted) return "VOTING";
  if (election.proposalApproved) return "APPROVED";
  return "PENDING APPROVAL";
}

export default function App() {
  const [account, setAccount] = useState("");
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);

  const [contractAddress, setContractAddress] = useState(
    localStorage.getItem("zkVotingContract") ||
      "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
  );

  const [electionId, setElectionId] = useState("1");
  const [election, setElection] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [voteCounts, setVoteCounts] = useState({});
  const [threshold, setThreshold] = useState(null);
  const [members, setMembers] = useState([]);
  const [message, setMessage] = useState("Connect MetaMask to begin.");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("election");

  const [newElectionTitle, setNewElectionTitle] = useState(
    "Ethiopia Federal Council Election"
  );
  const [newEligibilityRoot, setNewEligibilityRoot] = useState("");
  const [newCandidates, setNewCandidates] = useState("7,8,9");
  const [newStartMinutes, setNewStartMinutes] = useState("1");
  const [newDurationMinutes, setNewDurationMinutes] = useState("60");

  const contract = useMemo(() => {
    if (!provider || !contractAddress) return null;

    try {
      return new Contract(contractAddress, CONTRACT_ABI, provider);
    } catch {
      return null;
    }
  }, [provider, contractAddress]);

  async function connectWallet() {
    if (!window.ethereum) {
      setMessage("MetaMask is not installed.");
      return;
    }

    try {
      const browserProvider = new BrowserProvider(window.ethereum);

      await browserProvider.send("eth_requestAccounts", []);

      const walletSigner = await browserProvider.getSigner();
      const address = await walletSigner.getAddress();

      setSigner(walletSigner);
      setAccount(address);
      setMessage("Wallet connected.");
    } catch (error) {
      setMessage(
        error?.shortMessage ||
          error?.message ||
          "Wallet connection failed."
      );
    }
  }

  async function loadElection(contractOverride = contract) {
    if (!contractOverride) {
      setMessage("Connect to the ZKVoting contract first.");
      return;
    }

    setLoading(true);

    try {
      const id = BigInt(electionId);

      const data = await contractOverride.elections(id);

      if (!data.title) {
        setElection(null);
        setCandidates([]);
        setVoteCounts({});
        setMessage("No election found with that ID.");
        return;
      }

      setElection(data);

      const candidateList =
        await contractOverride.getElectionCandidates(id);

      const candidateStrings = candidateList.map((value) =>
        value.toString()
      );

      setCandidates(candidateStrings);

      const counts = {};

      for (const candidate of candidateList) {
        counts[candidate.toString()] = (
          await contractOverride.getVoteCount(id, candidate)
        ).toString();
      }

      setVoteCounts(counts);
      setMessage("Election data loaded.");
    } catch (error) {
      console.error("LOAD ELECTION ERROR:", error);

      setMessage(
        error?.shortMessage ||
          error?.reason ||
          error?.message ||
          "Could not load election."
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadGovernance(contractOverride = contract) {
    if (!contractOverride) return;

    try {
      const thresholdValue =
        await contractOverride.approvalThreshold();

      setThreshold(thresholdValue.toString());

      const memberList = [];

      for (let i = 0; i < 3; i++) {
        try {
          const member =
            await contractOverride.governanceMembers(i);

          memberList.push(member);
        } catch {
          break;
        }
      }

      setMembers(memberList);
    } catch (error) {
      console.error("LOAD GOVERNANCE ERROR:", error);
      setThreshold(null);
      setMembers([]);
    }
  }

  async function loadSystem() {
    const address = contractAddress.trim();

    if (!address) {
      setMessage("Enter the deployed ZKVoting contract address.");
      return;
    }

    try {
      setLoading(true);

      const readProvider = new JsonRpcProvider(LOCAL_RPC_URL);

      const readContract = new Contract(
        address,
        CONTRACT_ABI,
        readProvider
      );

      await readContract.approvalThreshold();

      localStorage.setItem("zkVotingContract", address);

      setProvider(readProvider);

      await loadElection(readContract);
      await loadGovernance(readContract);

      setMessage("ZKVoting system connected.");
    } catch (error) {
      console.error("LOAD SYSTEM ERROR:", error);

      setMessage(
        error?.shortMessage ||
          error?.reason ||
          error?.message ||
          "Could not connect to ZKVoting."
      );
    } finally {
      setLoading(false);
    }
  }

  async function executeTransaction(action, successMessage) {
    if (!signer) {
      setMessage("Connect the governance wallet first.");
      return;
    }

    try {
      setLoading(true);

      const writeContract = new Contract(
        contractAddress,
        CONTRACT_ABI,
        signer
      );

      const tx = await action(writeContract);

      setMessage(
        `Transaction submitted: ${tx.hash.slice(0, 14)}...`
      );

      await tx.wait();

      setMessage(successMessage);

      const readProvider =
        new JsonRpcProvider(LOCAL_RPC_URL);

      const readContract = new Contract(
        contractAddress,
        CONTRACT_ABI,
        readProvider
      );

      await loadElection(readContract);
      await loadGovernance(readContract);
    } catch (error) {
      console.error("TRANSACTION ERROR:", error);

      setMessage(
        error?.shortMessage ||
          error?.reason ||
          error?.message ||
          "Transaction failed."
      );
    } finally {
      setLoading(false);
    }
  }

  async function proposeElection() {
    if (!newElectionTitle.trim()) {
      setMessage("Enter an election title.");
      return;
    }

    if (!newEligibilityRoot.trim()) {
      setMessage("Enter the eligibility root.");
      return;
    }

    try {
      const candidateIds = newCandidates
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .map((id) => BigInt(id));

      if (candidateIds.length === 0) {
        setMessage("Enter at least one candidate ID.");
        return;
      }

      const startMinutes = Number(newStartMinutes);
      const durationMinutes = Number(newDurationMinutes);

      if (
        !Number.isFinite(startMinutes) ||
        !Number.isFinite(durationMinutes) ||
        startMinutes < 0 ||
        durationMinutes <= 0
      ) {
        setMessage("Invalid election timing.");
        return;
      }

      const now = Math.floor(Date.now() / 1000);

      const startTime =
        now + Math.floor(startMinutes * 60);

      const endTime =
        startTime + Math.floor(durationMinutes * 60);

      await executeTransaction(
        (writeContract) =>
          writeContract.proposeElection(
            newElectionTitle.trim(),
            BigInt(newEligibilityRoot.trim()),
            startTime,
            endTime,
            candidateIds
          ),
        "Election proposed successfully."
      );

      const readProvider =
        new JsonRpcProvider(LOCAL_RPC_URL);

      const readContract = new Contract(
        contractAddress,
        CONTRACT_ABI,
        readProvider
      );

      const nextId =
        await readContract.nextElectionId();

      setElectionId((nextId - 1n).toString());

      await loadElection(readContract);
    } catch (error) {
      console.error("PROPOSE ELECTION ERROR:", error);

      setMessage(
        error?.shortMessage ||
          error?.reason ||
          error?.message ||
          "Election creation failed."
      );
    }
  }

  async function approveElection() {
    await executeTransaction(
      (writeContract) =>
        writeContract.approveElection(BigInt(electionId)),
      "Election approval submitted."
    );
  }

  async function activateElection() {
    await executeTransaction(
      (writeContract) =>
        writeContract.activateElection(BigInt(electionId)),
      "Election activated."
    );
  }

  async function endElection() {
    await executeTransaction(
      (writeContract) =>
        writeContract.endElection(BigInt(electionId)),
      "Election ended."
    );
  }

  async function finalizeElection() {
    await executeTransaction(
      (writeContract) =>
        writeContract.finalizeElection(BigInt(electionId)),
      "Election finalized."
    );
  }

  useEffect(() => {
    if (!window.ethereum) return;

    const handleAccounts = (accounts) => {
      if (accounts.length === 0) {
        setAccount("");
        setSigner(null);
        return;
      }

      connectWallet();
    };

    window.ethereum.on("accountsChanged", handleAccounts);

    return () => {
      window.ethereum.removeListener(
        "accountsChanged",
        handleAccounts
      );
    };
  }, []);

  useEffect(() => {
    if (provider && contractAddress) {
      loadElection();
      loadGovernance();
    }
  }, [provider, contractAddress, electionId]);

  const status = statusForElection(election);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">EC</div>

          <div>
            <div className="brand-name">
              ETHIOPIACHAIN
            </div>

            <div className="brand-subtitle">
              ZERO-KNOWLEDGE VOTING
            </div>
          </div>
        </div>

        <button
          className="wallet-button"
          onClick={connectWallet}
        >
          {account
            ? shortenAddress(account)
            : "CONNECT WALLET"}
        </button>
      </header>

      <main className="container">
        <section className="hero">
          <div>
            <div className="eyebrow">
              PRIVATE&nbsp;&nbsp;&nbsp;VERIFIABLE&nbsp;&nbsp;&nbsp;ON-CHAIN
            </div>

            <h1>
              Democracy with
              <br />
              <span>cryptographic privacy.</span>
            </h1>

            <p>
              EthiopiaChain demonstrates anonymous eligibility
              proofs, nullifier-based double-vote prevention,
              and verifiable election governance.
            </p>
          </div>

          <div className="hero-card">
            <div className="hero-card-label">
              NETWORK STATUS
            </div>

            <div className="network-status">
              <span className="status-dot" />

              {provider
                ? "BLOCKCHAIN CONNECTED"
                : "WAITING FOR CONNECTION"}
            </div>

            <div className="hero-card-row">
              <span>Wallet</span>

              <strong>
                {account
                  ? shortenAddress(account)
                  : "Not connected"}
              </strong>
            </div>
          </div>
        </section>

        <section className="contract-panel">
          <div>
            <label>DEPLOYED ZKVOTING CONTRACT</label>

            <input
              value={contractAddress}
              onChange={(event) =>
                setContractAddress(event.target.value)
              }
              placeholder="0x..."
            />
          </div>

          <button
            className="primary-button"
            onClick={loadSystem}
            disabled={loading}
          >
            {loading ? "LOADING..." : "LOAD SYSTEM"}
          </button>
        </section>

        <div className="tabs">
          <button
            className={
              activeTab === "election"
                ? "tab active"
                : "tab"
            }
            onClick={() => setActiveTab("election")}
          >
            ELECTION
          </button>

          <button
            className={
              activeTab === "governance"
                ? "tab active"
                : "tab"
            }
            onClick={() => setActiveTab("governance")}
          >
            GOVERNANCE
          </button>
        </div>

        {activeTab === "election" && (
          <>
            <section className="content-card">
              <div className="eyebrow">
                ELECTION CREATION
              </div>

              <h2>Create an election</h2>

              <p>
                Propose an election with a fixed candidate
                set. Governance approval is required before
                activation.
              </p>

              <div className="info-grid">
                <div className="info-card">
                  <span>TITLE</span>

                  <input
                    value={newElectionTitle}
                    onChange={(event) =>
                      setNewElectionTitle(event.target.value)
                    }
                    placeholder="Election title"
                  />
                </div>

                <div className="info-card">
                  <span>ELIGIBILITY ROOT</span>

                  <input
                    value={newEligibilityRoot}
                    onChange={(event) =>
                      setNewEligibilityRoot(event.target.value)
                    }
                    placeholder="Merkle root"
                  />
                </div>

                <div className="info-card">
                  <span>CANDIDATE IDs</span>

                  <input
                    value={newCandidates}
                    onChange={(event) =>
                      setNewCandidates(event.target.value)
                    }
                    placeholder="7,8,9"
                  />
                </div>

                <div className="info-card">
                  <span>START IN MINUTES</span>

                  <input
                    type="number"
                    min="0"
                    value={newStartMinutes}
                    onChange={(event) =>
                      setNewStartMinutes(event.target.value)
                    }
                  />
                </div>

                <div className="info-card">
                  <span>VOTING DURATION</span>

                  <input
                    type="number"
                    min="1"
                    value={newDurationMinutes}
                    onChange={(event) =>
                      setNewDurationMinutes(event.target.value)
                    }
                  />
                </div>
              </div>

              <button
                className="primary-button"
                onClick={proposeElection}
                disabled={loading}
              >
                {loading
                  ? "CREATING..."
                  : "CREATE ELECTION"}
              </button>
            </section>

            <section className="section-heading">
              <div>
                <div className="eyebrow">
                  ELECTION EXPLORER
                </div>

                <h2>Inspect an election</h2>
              </div>

              <div className="election-selector">
                <label>ELECTION ID</label>

                <div className="selector-row">
                  <input
                    value={electionId}
                    onChange={(event) =>
                      setElectionId(event.target.value)
                    }
                    type="number"
                    min="1"
                  />

                  <button
                    className="secondary-button"
                    onClick={loadElection}
                    disabled={loading}
                  >
                    REFRESH
                  </button>
                </div>
              </div>
            </section>

            {election ? (
              <>
                <section className="election-header-card">
                  <div>
                    <div className="status-pill">
                      {status}
                    </div>

                    <h2>{election.title}</h2>

                    <p>Election #{electionId}</p>
                  </div>

                  <div className="ballot-stat">
                    <span>ACCEPTED BALLOTS</span>

                    <strong>
                      {election.acceptedBallots.toString()}
                    </strong>
                  </div>
                </section>

                <section className="info-grid">
                  <div className="info-card">
                    <span>START</span>

                    <strong>
                      {formatDate(election.startTime)}
                    </strong>
                  </div>

                  <div className="info-card">
                    <span>END</span>

                    <strong>
                      {formatDate(election.endTime)}
                    </strong>
                  </div>

                  <div className="info-card">
                    <span>REVEAL DEADLINE</span>

                    <strong>
                      {formatDate(election.revealDeadline)}
                    </strong>
                  </div>

                  <div className="info-card">
                    <span>REVEALED</span>

                    <strong>
                      {election.revealedBallots.toString()}
                    </strong>
                  </div>
                </section>

                <section className="content-card">
                  <div className="card-heading">
                    <div>
                      <div className="eyebrow">
                        CANDIDATE SET
                      </div>

                      <h3>Registered candidates</h3>
                    </div>

                    <span>
                      {candidates.length} candidates
                    </span>
                  </div>

                  <div className="candidate-list">
                    {candidates.map(
                      (candidate, index) => (
                        <div
                          className="candidate-row"
                          key={candidate}
                        >
                          <div className="candidate-number">
                            {index + 1}
                          </div>

                          <div className="candidate-id">
                            <span>CANDIDATE ID</span>

                            <strong>
                              {candidate}
                            </strong>
                          </div>

                          <div className="candidate-votes">
                            <span>VOTES</span>

                            <strong>
                              {voteCounts[candidate] || "0"}
                            </strong>
                          </div>
                        </div>
                      )
                    )}
                  </div>
                </section>

                <section className="action-grid">
                  <div className="action-card">
                    <div className="action-icon">01</div>

                    <h3>Governance approval</h3>

                    <p>
                      A governance member can approve the
                      proposed election.
                    </p>

                    <button
                      className="secondary-button"
                      onClick={approveElection}
                      disabled={loading}
                    >
                      APPROVE ELECTION
                    </button>
                  </div>

                  <div className="action-card">
                    <div className="action-icon">02</div>

                    <h3>Activate election</h3>

                    <p>
                      Activate the approved election once
                      its start time has arrived.
                    </p>

                    <button
                      className="secondary-button"
                      onClick={activateElection}
                      disabled={loading}
                    >
                      ACTIVATE
                    </button>
                  </div>

                  <div className="action-card">
                    <div className="action-icon">03</div>

                    <h3>End election</h3>

                    <p>
                      Close voting after the voting window.
                    </p>

                    <button
                      className="secondary-button"
                      onClick={endElection}
                      disabled={loading}
                    >
                      END ELECTION
                    </button>
                  </div>

                  <div className="action-card">
                    <div className="action-icon">04</div>

                    <h3>Finalize</h3>

                    <p>
                      Finalize after the reveal period.
                    </p>

                    <button
                      className="secondary-button"
                      onClick={finalizeElection}
                      disabled={loading}
                    >
                      FINALIZE
                    </button>
                  </div>
                </section>
              </>
            ) : (
              <section className="empty-state">
                <div className="empty-icon">ZK</div>

                <h2>No election loaded</h2>

                <p>
                  Create an election above or enter an
                  existing election ID.
                </p>
              </section>
            )}
          </>
        )}

        {activeTab === "governance" && (
          <section className="governance-layout">
            <div className="content-card">
              <div className="eyebrow">
                GOVERNANCE
              </div>

              <h2>N-of-M administration</h2>

              <p>
                Election approvals use the governance
                threshold configured when the contract was
                deployed.
              </p>

              <div className="governance-stat">
                <span>APPROVAL THRESHOLD</span>

                <strong>
                  {threshold ?? " "}
                </strong>
              </div>

              <div className="member-list">
                {members.map((member, index) => (
                  <div
                    className="member-row"
                    key={member}
                  >
                    <span>MEMBER {index + 1}</span>

                    <strong>
                      {shortenAddress(member)}
                    </strong>
                  </div>
                ))}
              </div>
            </div>

            <div className="content-card security-card">
              <div className="eyebrow">
                PROTOCOL
              </div>

              <h2>What the ZK layer protects</h2>

              <div className="protocol-item">
                <strong>Eligibility</strong>

                <span>
                  Merkle membership is verified inside the
                  ZK circuit.
                </span>
              </div>

              <div className="protocol-item">
                <strong>Privacy</strong>

                <span>
                  Candidate choice is not submitted during
                  private vote casting.
                </span>
              </div>

              <div className="protocol-item">
                <strong>Double voting</strong>

                <span>
                  Election-bound nullifiers prevent reuse
                  of the same credential.
                </span>
              </div>

              <div className="protocol-item">
                <strong>Integrity</strong>

                <span>
                  Groth16 proof verification happens
                  on-chain.
                </span>
              </div>
            </div>
          </section>
        )}

        <div className="message-bar">
          <span className="message-dot" />
          {message}
        </div>
      </main>

      <footer>
        <span>ETHIOPIACHAIN ZK VOTING</span>

        <span>
          EDUCATIONAL RESEARCH PROTOTYPE
          &nbsp;&nbsp; NOT FOR REAL ELECTIONS
        </span>
      </footer>
    </div>
  );
}