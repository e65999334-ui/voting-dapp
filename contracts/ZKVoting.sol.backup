// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IVerifier.sol";
import "./PoseidonT3.sol";

/**
 * Backend-only research prototype.
 *
 * Groth16 proofs bind an anonymous eligibility proof to an election-specific
 * candidate-set Merkle root. Candidate membership is fixed when the election
 * is proposed and cannot change after governance approval/activation.
 *
 * This contract still deliberately does not claim coercion resistance or
 * anonymous-credential issuance. Those are separate protocol layers.
 */
contract ZKVoting {
    uint256 public constant PUBLIC_SIGNAL_COUNT = 4;
    uint256 private constant CANDIDATE_TREE_LEAVES = 8;
    uint64 public constant REVEAL_PERIOD = 1 days;

    mapping(address => bool) public isGovernanceMember;
    address[] public governanceMembers;
    uint256 public approvalThreshold;

    mapping(uint256 => mapping(address => bool)) public electionApprovalByMember;
    mapping(uint256 => uint256) public electionApprovalCount;

    enum GovernanceChangeType {
        AddMember,
        RemoveMember
    }

    struct GovernanceChange {
        address member;
        GovernanceChangeType changeType;
        bool executed;
        uint256 approvalCount;
    }

    uint256 public nextGovernanceChangeId = 1;
    mapping(uint256 => GovernanceChange) public governanceChanges;
    mapping(uint256 => mapping(address => bool)) public governanceChangeApprovalByMember;

    IVerifier public immutable verifier;
    uint256 public nextElectionId = 1;

    struct Election {
        string title;
        uint256 eligibilityRoot;
        uint256 candidateRoot;
        uint64 startTime;
        uint64 endTime;
        uint64 revealDeadline;
        bool proposalApproved;
        bool votingStarted;
        bool ended;
        bool finalized;
        uint256 acceptedBallots;
        uint256 revealedBallots;
    }

    mapping(uint256 => Election) public elections;
    mapping(uint256 => mapping(uint256 => bool)) public nullifierUsed;
    mapping(uint256 => mapping(uint256 => bool)) public voteCommitmentUsed;
    mapping(uint256 => mapping(uint256 => bool)) public voteCommitmentRevealed;
    mapping(uint256 => mapping(uint256 => uint256)) private voteCounts;
    mapping(uint256 => mapping(uint256 => bool)) public candidateAllowed;
    mapping(uint256 => uint256[]) private electionCandidates;

    event ElectionProposed(
        uint256 indexed electionId,
        string title,
        uint256 eligibilityRoot,
        uint256 candidateRoot
    );
    event ElectionApprovalSubmitted(uint256 indexed electionId, address indexed member, uint256 approvalCount);
    event ElectionApproved(uint256 indexed electionId);
    event ElectionActivated(uint256 indexed electionId);
    event VoteAccepted(uint256 indexed electionId, uint256 indexed nullifierHash, uint256 voteCommitment);
    event VoteRevealed(uint256 indexed electionId, uint256 indexed voteCommitment, uint256 candidateId);
    event ElectionEnded(uint256 indexed electionId);
    event ElectionFinalized(uint256 indexed electionId, uint256 revealedBallots, uint256 acceptedBallots);
    event GovernanceChangeProposed(uint256 indexed changeId, address indexed member, GovernanceChangeType changeType);
    event GovernanceChangeApprovalSubmitted(uint256 indexed changeId, address indexed member, uint256 approvalCount);
    event GovernanceChangeExecuted(uint256 indexed changeId, address indexed member, GovernanceChangeType changeType);

    modifier onlyGovernanceMember() {
        require(isGovernanceMember[msg.sender], "Not governance member");
        _;
    }

    modifier electionExists(uint256 electionId) {
        require(bytes(elections[electionId].title).length > 0, "Unknown election");
        _;
    }

    constructor(address verifier_, address[] memory members_, uint256 threshold_) {
        require(verifier_ != address(0), "Zero verifier");
        require(members_.length > 0, "No governance members");
        require(threshold_ > 0 && threshold_ <= members_.length, "Invalid threshold");

        verifier = IVerifier(verifier_);
        approvalThreshold = threshold_;

        for (uint256 i = 0; i < members_.length; i++) {
            address member = members_[i];
            require(member != address(0), "Zero member");
            require(!isGovernanceMember[member], "Duplicate member");
            isGovernanceMember[member] = true;
            governanceMembers.push(member);
        }
    }

    /**
     * Candidate IDs are registered as part of the election proposal. The
     * contract sorts them, rejects duplicates/zero IDs, computes the exact
     * 8-leaf candidate Merkle root, and freezes that set for the election.
     */
    function proposeElection(
        string calldata title,
        uint256 eligibilityRoot,
        uint64 startTime,
        uint64 endTime,
        uint256[] calldata candidateIds
    ) external returns (uint256 electionId) {
        require(bytes(title).length > 0, "Empty title");
        require(eligibilityRoot != 0, "Zero eligibility root");
        require(startTime < endTime, "Invalid time range");
        require(endTime > block.timestamp, "Election already ended");
        require(endTime <= type(uint64).max - REVEAL_PERIOD, "Election too late");
        require(candidateIds.length > 0 && candidateIds.length <= CANDIDATE_TREE_LEAVES, "Invalid candidate count");

        uint256[] memory candidates = new uint256[](candidateIds.length);
        for (uint256 i = 0; i < candidateIds.length; i++) {
            require(candidateIds[i] != 0, "Zero candidate");
            candidates[i] = candidateIds[i];
        }
        _sort(candidates);
        for (uint256 i = 1; i < candidates.length; i++) {
            require(candidates[i] != candidates[i - 1], "Duplicate candidate");
        }

        uint256 candidateRoot = _candidateRoot(candidates);
        require(candidateRoot != 0, "Zero candidate root");

        electionId = nextElectionId++;
        Election storage election = elections[electionId];
        election.title = title;
        election.eligibilityRoot = eligibilityRoot;
        election.candidateRoot = candidateRoot;
        election.startTime = startTime;
        election.endTime = endTime;
        election.revealDeadline = endTime + REVEAL_PERIOD;

        for (uint256 i = 0; i < candidates.length; i++) {
            candidateAllowed[electionId][candidates[i]] = true;
            electionCandidates[electionId].push(candidates[i]);
        }

        emit ElectionProposed(electionId, title, eligibilityRoot, candidateRoot);
    }

    function getElectionCandidates(uint256 electionId)
        external
        view
        electionExists(electionId)
        returns (uint256[] memory)
    {
        return electionCandidates[electionId];
    }

    function approveElection(uint256 electionId) external onlyGovernanceMember electionExists(electionId) {
        Election storage election = elections[electionId];
        require(!election.proposalApproved, "Already approved");
        require(!electionApprovalByMember[electionId][msg.sender], "Already approved by member");

        electionApprovalByMember[electionId][msg.sender] = true;
        electionApprovalCount[electionId] += 1;
        emit ElectionApprovalSubmitted(electionId, msg.sender, electionApprovalCount[electionId]);

        if (electionApprovalCount[electionId] >= approvalThreshold) {
            election.proposalApproved = true;
            emit ElectionApproved(electionId);
        }
    }

    function proposeGovernanceMemberChange(address member, bool addMember)
        external
        onlyGovernanceMember
        returns (uint256 changeId)
    {
        require(member != address(0), "Zero member");
        if (addMember) {
            require(!isGovernanceMember[member], "Already governance member");
        } else {
            require(isGovernanceMember[member], "Not governance member");
            require(governanceMembers.length > approvalThreshold, "Cannot remove below threshold");
        }

        changeId = nextGovernanceChangeId++;
        governanceChanges[changeId] = GovernanceChange({
            member: member,
            changeType: addMember ? GovernanceChangeType.AddMember : GovernanceChangeType.RemoveMember,
            executed: false,
            approvalCount: 0
        });
        emit GovernanceChangeProposed(changeId, member, governanceChanges[changeId].changeType);
    }

    function approveGovernanceMemberChange(uint256 changeId) external onlyGovernanceMember {
        GovernanceChange storage change = governanceChanges[changeId];
        require(change.member != address(0), "Unknown governance change");
        require(!change.executed, "Already executed");
        require(!governanceChangeApprovalByMember[changeId][msg.sender], "Already approved by member");

        if (change.changeType == GovernanceChangeType.AddMember) {
            require(!isGovernanceMember[change.member], "Already governance member");
        } else {
            require(isGovernanceMember[change.member], "Not governance member");
        }

        governanceChangeApprovalByMember[changeId][msg.sender] = true;
        change.approvalCount += 1;
        emit GovernanceChangeApprovalSubmitted(changeId, msg.sender, change.approvalCount);

        if (change.approvalCount >= approvalThreshold) {
            _executeGovernanceChange(changeId, change);
        }
    }

    function _executeGovernanceChange(uint256 changeId, GovernanceChange storage change) internal {
        change.executed = true;
        if (change.changeType == GovernanceChangeType.AddMember) {
            isGovernanceMember[change.member] = true;
            governanceMembers.push(change.member);
        } else {
            require(governanceMembers.length > approvalThreshold, "Cannot remove below threshold");
            isGovernanceMember[change.member] = false;
            for (uint256 i = 0; i < governanceMembers.length; i++) {
                if (governanceMembers[i] == change.member) {
                    governanceMembers[i] = governanceMembers[governanceMembers.length - 1];
                    governanceMembers.pop();
                    break;
                }
            }
        }
        emit GovernanceChangeExecuted(changeId, change.member, change.changeType);
    }

    function activateElection(uint256 electionId) external electionExists(electionId) {
        Election storage election = elections[electionId];
        require(election.proposalApproved, "Not approved");
        require(block.timestamp >= election.startTime, "Not started");
        require(block.timestamp < election.endTime, "Already ended");
        require(!election.ended, "Ended");
        require(!election.votingStarted, "Already active");
        election.votingStarted = true;
        emit ElectionActivated(electionId);
    }

    function castPrivateVote(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[4] calldata publicSignals
    ) external electionExists(electionId) {
        Election storage election = elections[electionId];
        require(election.proposalApproved, "Not approved");
        require(election.votingStarted, "Not active");
        require(block.timestamp >= election.startTime, "Not started");
        require(block.timestamp < election.endTime, "Voting closed");
        require(!election.ended, "Ended");
        require(!election.finalized, "Finalized");

        // Public signal order: nullifierHash, voteCommitment, electionId, scopeRoot.
        require(publicSignals[2] == electionId, "Wrong election signal");
        uint256 expectedScopeRoot = PoseidonT3.hash([election.eligibilityRoot, election.candidateRoot]);
        require(publicSignals[3] == expectedScopeRoot, "Wrong scope root");

        uint256 nullifierHash = publicSignals[0];
        uint256 voteCommitment = publicSignals[1];
        require(nullifierHash != 0, "Zero nullifier");
        require(voteCommitment != 0, "Zero commitment");
        require(!nullifierUsed[electionId][nullifierHash], "Already voted");
        require(!voteCommitmentUsed[electionId][voteCommitment], "Duplicate commitment");
        require(verifier.verifyProof(a, b, c, publicSignals), "Invalid ZK proof");

        nullifierUsed[electionId][nullifierHash] = true;
        voteCommitmentUsed[electionId][voteCommitment] = true;
        election.acceptedBallots += 1;
        emit VoteAccepted(electionId, nullifierHash, voteCommitment);
    }

    function endElection(uint256 electionId) external electionExists(electionId) {
        Election storage election = elections[electionId];
        require(election.proposalApproved, "Not approved");
        require(block.timestamp >= election.endTime, "Election not finished");
        require(!election.ended, "Already ended");
        election.ended = true;
        emit ElectionEnded(electionId);
    }

    function revealVote(uint256 electionId, uint256 candidateId, uint256 voteSalt)
        external
        electionExists(electionId)
    {
        Election storage election = elections[electionId];
        require(election.ended, "Election not ended");
        require(!election.finalized, "Finalized");
        require(candidateAllowed[electionId][candidateId], "Candidate not registered");

        uint256 commitment = PoseidonT3.hash([candidateId, voteSalt]);
        require(voteCommitmentUsed[electionId][commitment], "Unknown commitment");
        require(!voteCommitmentRevealed[electionId][commitment], "Already revealed");

        voteCommitmentRevealed[electionId][commitment] = true;
        election.revealedBallots += 1;
        voteCounts[electionId][candidateId] += 1;
        emit VoteRevealed(electionId, commitment, candidateId);
    }

    /**
     * Finalization is terminal. Unrevealed commitments are excluded from the
     * tally, so finalization remains live even when a voter never reveals.
     * This is intentionally explicit: the protocol does not pretend that an
     * unrevealed commitment is a counted vote.
     */
    function finalizeElection(uint256 electionId) external electionExists(electionId) {
        Election storage election = elections[electionId];
        require(election.ended, "Election not ended");
        require(block.timestamp >= election.revealDeadline, "Reveal period active");
        require(!election.finalized, "Already finalized");
        election.finalized = true;
        emit ElectionFinalized(electionId, election.revealedBallots, election.acceptedBallots);
    }

    function getVoteCount(uint256 electionId, uint256 candidateId)
        external
        view
        returns (uint256)
    {
        return voteCounts[electionId][candidateId];
    }

    function _candidateRoot(uint256[] memory candidates) internal view returns (uint256) {
        uint256[8] memory nodes;
        for (uint256 i = 0; i < candidates.length; i++) {
            nodes[i] = PoseidonT3.hash([candidates[i], uint256(0)]);
        }
        for (uint256 level = 0; level < 3; level++) {
            uint256 count = 8 >> level;
            for (uint256 i = 0; i < count; i += 2) {
                nodes[i / 2] = PoseidonT3.hash([nodes[i], nodes[i + 1]]);
            }
        }
        return nodes[0];
    }

    function _sort(uint256[] memory values) internal pure {
        for (uint256 i = 1; i < values.length; i++) {
            uint256 key = values[i];
            uint256 j = i;
            while (j > 0 && values[j - 1] > key) {
                values[j] = values[j - 1];
                j--;
            }
            values[j] = key;
        }
    }
}
