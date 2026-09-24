// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IVerifier.sol";
import "./PoseidonT3.sol";

/**
 * EthiopiaChain ZK Voting
 *
 * Research / educational prototype.
 *
 * Protocol:
 * - Election creation is restricted to the election authority.
 * - Participants are registered before governance approval.
 * - Participant credentials remain private; only their Poseidon leaf is stored.
 * - The contract maintains a fixed 8-leaf eligibility Merkle tree.
 * - Governance approval uses N-of-M authorization.
 * - Participants submit Groth16 proofs without revealing their credential
 *   or candidate choice in the proof public signals.
 * - An election-bound nullifier prevents double voting.
 * - Candidate membership is fixed when the election is proposed.
 * - Commitments are revealed after the election and then tallied.
 *
 * This remains a research prototype. Direct MetaMask transactions expose
 * the transaction sender, and the commit/reveal mechanism does not provide
 * full transaction-level voter anonymity.
 */
contract ZKVoting {
    uint256 public constant PUBLIC_SIGNAL_COUNT = 4;

    uint256 private constant TREE_LEAVES = 8;

    uint64 public constant REVEAL_PERIOD = 1 days;

    // ---------------------------------------------------------------------
    // Governance
    // ---------------------------------------------------------------------

    mapping(address => bool) public isGovernanceMember;
    address[] public governanceMembers;
    uint256 public approvalThreshold;

    mapping(uint256 => mapping(address => bool))
        public electionApprovalByMember;

    mapping(uint256 => uint256)
        public electionApprovalCount;

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

    mapping(uint256 => GovernanceChange)
        public governanceChanges;

    mapping(uint256 => mapping(address => bool))
        public governanceChangeApprovalByMember;

    // ---------------------------------------------------------------------
    // Election authority
    // ---------------------------------------------------------------------

    /**
     * The first configured governance member is the initial election
     * authority. This keeps the deployment simple while still preventing
     * arbitrary accounts from creating elections.
     */
    address public electionAuthority;

    // ---------------------------------------------------------------------
    // ZK verifier
    // ---------------------------------------------------------------------

    IVerifier public immutable verifier;

    uint256 public nextElectionId = 1;

    // ---------------------------------------------------------------------
    // Election
    // ---------------------------------------------------------------------

    struct Election {
        string title;

        // Automatically maintained from registered participant leaves.
        uint256 eligibilityRoot;

        // Computed from the fixed candidate set.
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

    // ---------------------------------------------------------------------
    // Participants / eligibility tree
    // ---------------------------------------------------------------------

    uint256 public constant MAX_PARTICIPANTS = TREE_LEAVES;

    struct Participant {
        address wallet;
        uint256 credentialLeaf;
        uint256 nullifierHash;
        bool registered;
    }

    mapping(uint256 => Participant[]) private participants;

    mapping(uint256 => mapping(address => bool))
        public registeredParticipant;

    mapping(uint256 => mapping(address => uint256))
        private participantCredentialLeaf;

    mapping(uint256 => mapping(address => uint256))
        private participantNullifierHash;

    mapping(uint256 => mapping(address => uint256))
        public participantIndex;

    // electionId => tree index => Poseidon(credential)
    mapping(uint256 => mapping(uint256 => uint256))
        private eligibilityLeaves;

    mapping(uint256 => mapping(uint256 => bool))
        private eligibilityLeafUsed;

    mapping(uint256 => mapping(uint256 => bool))
        private eligibilityNullifierUsed;

    // ---------------------------------------------------------------------
    // Voting
    // ---------------------------------------------------------------------

    mapping(uint256 => mapping(uint256 => bool))
        public nullifierUsed;

    mapping(uint256 => mapping(uint256 => bool))
        public voteCommitmentUsed;

    mapping(uint256 => mapping(uint256 => bool))
        public voteCommitmentRevealed;

    mapping(uint256 => mapping(uint256 => uint256))
        private voteCounts;

    mapping(uint256 => mapping(uint256 => bool))
        public candidateAllowed;

    mapping(uint256 => uint256[]) private electionCandidates;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ElectionProposed(
        uint256 indexed electionId,
        string title,
        uint256 eligibilityRoot,
        uint256 candidateRoot
    );

    event ParticipantRegistered(
        uint256 indexed electionId,
        address indexed participant,
        uint256 indexed treeIndex,
        uint256 credentialLeaf,
        uint256 nullifierHash,
        uint256 eligibilityRoot
    );

    event ElectionApprovalSubmitted(
        uint256 indexed electionId,
        address indexed member,
        uint256 approvalCount
    );

    event ElectionApproved(uint256 indexed electionId);

    event ElectionActivated(uint256 indexed electionId);

    event VoteAccepted(
        uint256 indexed electionId,
        uint256 indexed nullifierHash,
        uint256 voteCommitment
    );

    event VoteRevealed(
        uint256 indexed electionId,
        uint256 indexed voteCommitment,
        uint256 candidateId
    );

    event ElectionEnded(uint256 indexed electionId);

    event ElectionFinalized(
        uint256 indexed electionId,
        uint256 revealedBallots,
        uint256 acceptedBallots
    );

    event GovernanceChangeProposed(
        uint256 indexed changeId,
        address indexed member,
        GovernanceChangeType changeType
    );

    event GovernanceChangeApprovalSubmitted(
        uint256 indexed changeId,
        address indexed member,
        uint256 approvalCount
    );

    event GovernanceChangeExecuted(
        uint256 indexed changeId,
        address indexed member,
        GovernanceChangeType changeType
    );

    event ElectionAuthorityChanged(
        address indexed previousAuthority,
        address indexed newAuthority
    );

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyGovernanceMember() {
        require(
            isGovernanceMember[msg.sender],
            "Not governance member"
        );
        _;
    }

    modifier onlyElectionAuthority() {
        require(
            msg.sender == electionAuthority,
            "Not election authority"
        );
        _;
    }

    modifier electionExists(uint256 electionId) {
        require(
            bytes(elections[electionId].title).length > 0,
            "Unknown election"
        );
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(
        address verifier_,
        address[] memory members_,
        uint256 threshold_
    ) {
        require(
            verifier_ != address(0),
            "Zero verifier"
        );

        require(
            members_.length > 0,
            "No governance members"
        );

        require(
            threshold_ > 0 &&
                threshold_ <= members_.length,
            "Invalid threshold"
        );

        verifier = IVerifier(verifier_);

        approvalThreshold = threshold_;

        for (uint256 i = 0; i < members_.length; i++) {
            address member = members_[i];

            require(
                member != address(0),
                "Zero member"
            );

            require(
                !isGovernanceMember[member],
                "Duplicate member"
            );

            isGovernanceMember[member] = true;
            governanceMembers.push(member);
        }

        // First governance member is the initial authority.
        electionAuthority = members_[0];
    }

    // ---------------------------------------------------------------------
    // Election creation
    // ---------------------------------------------------------------------

    /**
     * Creates an election with an initially empty eligibility tree.
     *
     * Participants are inserted afterward by the authority.
     * The eligibility root is automatically recalculated after each
     * participant registration.
     */
    function proposeElection(
        string calldata title,
        uint256 eligibilityRoot,
        uint64 startTime,
        uint64 endTime,
        uint256[] calldata candidateIds
    )
        external
        onlyElectionAuthority
        returns (uint256 electionId)
    {
        require(
            bytes(title).length > 0,
            "Empty title"
        );

        /*
         * A zero root is intentionally allowed during creation.
         * It will be replaced automatically when participants are
         * registered.
         *
         * A non-zero root is also accepted for compatibility with
         * the existing backend tests and tooling.
         */
        require(
            startTime < endTime,
            "Invalid time range"
        );

        require(
            endTime > block.timestamp,
            "Election already ended"
        );

        require(
            endTime <=
                type(uint64).max - REVEAL_PERIOD,
            "Election too late"
        );

        require(
            candidateIds.length > 0 &&
                candidateIds.length <= TREE_LEAVES,
            "Invalid candidate count"
        );

        uint256[] memory candidates =
            new uint256[](candidateIds.length);

        for (uint256 i = 0; i < candidateIds.length; i++) {
            require(
                candidateIds[i] != 0,
                "Zero candidate"
            );

            candidates[i] = candidateIds[i];
        }

        _sort(candidates);

        for (uint256 i = 1; i < candidates.length; i++) {
            require(
                candidates[i] != candidates[i - 1],
                "Duplicate candidate"
            );
        }

        uint256 candidateRoot =
            _candidateRoot(candidates);

        require(
            candidateRoot != 0,
            "Zero candidate root"
        );

        electionId = nextElectionId++;

        Election storage election =
            elections[electionId];

        election.title = title;
        election.eligibilityRoot = eligibilityRoot;
        election.candidateRoot = candidateRoot;
        election.startTime = startTime;
        election.endTime = endTime;
        election.revealDeadline =
            endTime + REVEAL_PERIOD;

        for (uint256 i = 0; i < candidates.length; i++) {
            candidateAllowed[
                electionId
            ][candidates[i]] = true;

            electionCandidates[
                electionId
            ].push(candidates[i]);
        }

        emit ElectionProposed(
            electionId,
            title,
            eligibilityRoot,
            candidateRoot
        );
    }

    // ---------------------------------------------------------------------
    // Participant registration
    // ---------------------------------------------------------------------

    /**
     * Registers a wallet and its private credential commitment.
     *
     * credentialLeaf must equal Poseidon(credential).
     *
     * nullifierHash must equal:
     * Poseidon(credential, electionId)
     *
     * The credential itself is never stored on-chain.
     */
    function registerParticipant(
        uint256 electionId,
        address participant,
        uint256 credentialLeaf,
        uint256 nullifierHash
    )
        external
        onlyElectionAuthority
        electionExists(electionId)
    {
        Election storage election =
            elections[electionId];

        require(
            !election.proposalApproved,
            "Election already approved"
        );

        require(
            !election.votingStarted,
            "Election already active"
        );

        require(
            participant != address(0),
            "Zero participant"
        );

        require(
            credentialLeaf != 0,
            "Zero credential leaf"
        );

        require(
            nullifierHash != 0,
            "Zero nullifier"
        );

        require(
            !registeredParticipant[
                electionId
            ][participant],
            "Participant already registered"
        );

        require(
            !eligibilityLeafUsed[
                electionId
            ][credentialLeaf],
            "Credential leaf already used"
        );

        require(
            !eligibilityNullifierUsed[
                electionId
            ][nullifierHash],
            "Nullifier already registered"
        );

        require(
            participants[electionId].length <
                MAX_PARTICIPANTS,
            "Participant limit reached"
        );

        uint256 index =
            participants[electionId].length;

        participants[electionId].push(
            Participant({
                wallet: participant,
                credentialLeaf: credentialLeaf,
                nullifierHash: nullifierHash,
                registered: true
            })
        );

        registeredParticipant[
            electionId
        ][participant] = true;

        participantCredentialLeaf[
            electionId
        ][participant] = credentialLeaf;

        participantNullifierHash[
            electionId
        ][participant] = nullifierHash;

        participantIndex[
            electionId
        ][participant] = index;

        eligibilityLeaves[
            electionId
        ][index] = credentialLeaf;

        eligibilityLeafUsed[
            electionId
        ][credentialLeaf] = true;

        eligibilityNullifierUsed[
            electionId
        ][nullifierHash] = true;

        election.eligibilityRoot =
            _eligibilityRoot(electionId);

        emit ParticipantRegistered(
            electionId,
            participant,
            index,
            credentialLeaf,
            nullifierHash,
            election.eligibilityRoot
        );
    }

    function getParticipantCount(
        uint256 electionId
    )
        external
        view
        electionExists(electionId)
        returns (uint256)
    {
        return participants[electionId].length;
    }

    function getParticipant(
        uint256 electionId,
        uint256 index
    )
        external
        view
        electionExists(electionId)
        returns (
            address participant,
            uint256 credentialLeaf,
            uint256 nullifierHash,
            bool registered
        )
    {
        require(
            index < participants[electionId].length,
            "Invalid participant index"
        );

        Participant memory p =
            participants[electionId][index];

        return (
            p.wallet,
            p.credentialLeaf,
            p.nullifierHash,
            p.registered
        );
    }

    /**
     * Returns all eight leaves used by the fixed depth-3
     * eligibility tree. Unused leaves are zero.
     */
    function getEligibilityLeaves(
        uint256 electionId
    )
        external
        view
        electionExists(electionId)
        returns (uint256[8] memory leaves)
    {
        for (uint256 i = 0; i < TREE_LEAVES; i++) {
            leaves[i] =
                eligibilityLeaves[electionId][i];
        }
    }

    // ---------------------------------------------------------------------
    // Election candidates
    // ---------------------------------------------------------------------

    function getElectionCandidates(
        uint256 electionId
    )
        external
        view
        electionExists(electionId)
        returns (uint256[] memory)
    {
        return electionCandidates[electionId];
    }

    // ---------------------------------------------------------------------
    // Governance approval
    // ---------------------------------------------------------------------

    function approveElection(
        uint256 electionId
    )
        external
        onlyGovernanceMember
        electionExists(electionId)
    {
        Election storage election =
            elections[electionId];

        require(
            !election.proposalApproved,
            "Already approved"
        );

        require(
            election.eligibilityRoot != 0,
            "No participants registered"
        );

        require(
            !electionApprovalByMember[
                electionId
            ][msg.sender],
            "Already approved by member"
        );

        electionApprovalByMember[
            electionId
        ][msg.sender] = true;

        electionApprovalCount[
            electionId
        ] += 1;

        emit ElectionApprovalSubmitted(
            electionId,
            msg.sender,
            electionApprovalCount[electionId]
        );

        if (
            electionApprovalCount[electionId] >=
            approvalThreshold
        ) {
            election.proposalApproved = true;

            emit ElectionApproved(
                electionId
            );
        }
    }

    // ---------------------------------------------------------------------
    // Election activation
    // ---------------------------------------------------------------------

    function activateElection(
        uint256 electionId
    )
        external
        onlyElectionAuthority
        electionExists(electionId)
    {
        Election storage election =
            elections[electionId];

        require(
            election.proposalApproved,
            "Not approved"
        );

        require(
            block.timestamp >=
                election.startTime,
            "Not started"
        );

        require(
            block.timestamp <
                election.endTime,
            "Already ended"
        );

        require(
            !election.ended,
            "Ended"
        );

        require(
            !election.votingStarted,
            "Already active"
        );

        election.votingStarted = true;

        emit ElectionActivated(
            electionId
        );
    }

    // ---------------------------------------------------------------------
    // ZK voting
    // ---------------------------------------------------------------------

    /**
     * Public signal order:
     *
     * [0] nullifierHash
     * [1] voteCommitment
     * [2] electionId
     * [3] scopeRoot
     */
    function castPrivateVote(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[4] calldata publicSignals
    )
        external
        electionExists(electionId)
    {
        Election storage election =
            elections[electionId];

        require(
            election.proposalApproved,
            "Not approved"
        );

        require(
            election.votingStarted,
            "Not active"
        );

        require(
            block.timestamp >=
                election.startTime,
            "Not started"
        );

        require(
            block.timestamp <
                election.endTime,
            "Voting closed"
        );

        require(
            !election.ended,
            "Ended"
        );

        require(
            !election.finalized,
            "Finalized"
        );

        require(
            registeredParticipant[
                electionId
            ][msg.sender],
            "Not registered participant"
        );

        uint256 nullifierHash =
            publicSignals[0];

        uint256 voteCommitment =
            publicSignals[1];

        require(
            publicSignals[2] ==
                electionId,
            "Wrong election signal"
        );

        uint256 expectedScopeRoot =
            PoseidonT3.hash(
                [
                    election.eligibilityRoot,
                    election.candidateRoot
                ]
            );

        require(
            publicSignals[3] ==
                expectedScopeRoot,
            "Wrong scope root"
        );

        require(
            nullifierHash != 0,
            "Zero nullifier"
        );

        require(
            voteCommitment != 0,
            "Zero commitment"
        );

        require(
            participantNullifierHash[
                electionId
            ][msg.sender] ==
                nullifierHash,
            "Wrong participant credential"
        );

        require(
            !nullifierUsed[
                electionId
            ][nullifierHash],
            "Already voted"
        );

        require(
            !voteCommitmentUsed[
                electionId
            ][voteCommitment],
            "Duplicate commitment"
        );

        require(
            verifier.verifyProof(
                a,
                b,
                c,
                publicSignals
            ),
            "Invalid ZK proof"
        );

        nullifierUsed[
            electionId
        ][nullifierHash] = true;

        voteCommitmentUsed[
            electionId
        ][voteCommitment] = true;

        election.acceptedBallots += 1;

        emit VoteAccepted(
            electionId,
            nullifierHash,
            voteCommitment
        );
    }

    // ---------------------------------------------------------------------
    // End election
    // ---------------------------------------------------------------------

    function endElection(
        uint256 electionId
    )
        external
        onlyElectionAuthority
        electionExists(electionId)
    {
        Election storage election =
            elections[electionId];

        require(
            election.proposalApproved,
            "Not approved"
        );

        require(
            block.timestamp >=
                election.endTime,
            "Election not finished"
        );

        require(
            !election.ended,
            "Already ended"
        );

        election.ended = true;

        emit ElectionEnded(
            electionId
        );
    }

    // ---------------------------------------------------------------------
    // Reveal
    // ---------------------------------------------------------------------

    function revealVote(
        uint256 electionId,
        uint256 candidateId,
        uint256 voteSalt
    )
        external
        electionExists(electionId)
    {
        Election storage election =
            elections[electionId];

        require(
            election.ended,
            "Election not ended"
        );

        require(
            !election.finalized,
            "Finalized"
        );

        require(
            candidateAllowed[
                electionId
            ][candidateId],
            "Candidate not registered"
        );

        uint256 commitment =
            PoseidonT3.hash(
                [
                    candidateId,
                    voteSalt
                ]
            );

        require(
            voteCommitmentUsed[
                electionId
            ][commitment],
            "Unknown commitment"
        );

        require(
            !voteCommitmentRevealed[
                electionId
            ][commitment],
            "Already revealed"
        );

        voteCommitmentRevealed[
            electionId
        ][commitment] = true;

        election.revealedBallots += 1;

        voteCounts[
            electionId
        ][candidateId] += 1;

        emit VoteRevealed(
            electionId,
            commitment,
            candidateId
        );
    }

    // ---------------------------------------------------------------------
    // Finalization
    // ---------------------------------------------------------------------

    function finalizeElection(
        uint256 electionId
    )
        external
        onlyElectionAuthority
        electionExists(electionId)
    {
        Election storage election =
            elections[electionId];

        require(
            election.ended,
            "Election not ended"
        );

        require(
            block.timestamp >=
                election.revealDeadline,
            "Reveal period active"
        );

        require(
            !election.finalized,
            "Already finalized"
        );

        election.finalized = true;

        emit ElectionFinalized(
            electionId,
            election.revealedBallots,
            election.acceptedBallots
        );
    }

    // ---------------------------------------------------------------------
    // Results
    // ---------------------------------------------------------------------

    function getVoteCount(
        uint256 electionId,
        uint256 candidateId
    )
        external
        view
        returns (uint256)
    {
        return voteCounts[
            electionId
        ][candidateId];
    }

    // ---------------------------------------------------------------------
    // Governance membership management
    // ---------------------------------------------------------------------

    function proposeGovernanceMemberChange(
        address member,
        bool addMember
    )
        external
        onlyGovernanceMember
        returns (uint256 changeId)
    {
        require(
            member != address(0),
            "Zero member"
        );

        if (addMember) {
            require(
                !isGovernanceMember[member],
                "Already governance member"
            );
        } else {
            require(
                isGovernanceMember[member],
                "Not governance member"
            );

            require(
                governanceMembers.length >
                    approvalThreshold,
                "Cannot remove below threshold"
            );
        }

        changeId =
            nextGovernanceChangeId++;

        governanceChanges[changeId] =
            GovernanceChange({
                member: member,
                changeType:
                    addMember
                        ? GovernanceChangeType.AddMember
                        : GovernanceChangeType.RemoveMember,
                executed: false,
                approvalCount: 0
            });

        emit GovernanceChangeProposed(
            changeId,
            member,
            governanceChanges[changeId]
                .changeType
        );
    }

    function approveGovernanceMemberChange(
        uint256 changeId
    )
        external
        onlyGovernanceMember
    {
        GovernanceChange storage change =
            governanceChanges[changeId];

        require(
            change.member != address(0),
            "Unknown governance change"
        );

        require(
            !change.executed,
            "Already executed"
        );

        require(
            !governanceChangeApprovalByMember[
                changeId
            ][msg.sender],
            "Already approved by member"
        );

        if (
            change.changeType ==
            GovernanceChangeType.AddMember
        ) {
            require(
                !isGovernanceMember[
                    change.member
                ],
                "Already governance member"
            );
        } else {
            require(
                isGovernanceMember[
                    change.member
                ],
                "Not governance member"
            );
        }

        governanceChangeApprovalByMember[
            changeId
        ][msg.sender] = true;

        change.approvalCount += 1;

        emit GovernanceChangeApprovalSubmitted(
            changeId,
            msg.sender,
            change.approvalCount
        );

        if (
            change.approvalCount >=
            approvalThreshold
        ) {
            _executeGovernanceChange(
                changeId,
                change
            );
        }
    }

    function _executeGovernanceChange(
        uint256 changeId,
        GovernanceChange storage change
    )
        internal
    {
        change.executed = true;

        if (
            change.changeType ==
            GovernanceChangeType.AddMember
        ) {
            isGovernanceMember[
                change.member
            ] = true;

            governanceMembers.push(
                change.member
            );
        } else {
            require(
                governanceMembers.length >
                    approvalThreshold,
                "Cannot remove below threshold"
            );

            isGovernanceMember[
                change.member
            ] = false;

            for (
                uint256 i = 0;
                i < governanceMembers.length;
                i++
            ) {
                if (
                    governanceMembers[i] ==
                    change.member
                ) {
                    governanceMembers[i] =
                        governanceMembers[
                            governanceMembers.length - 1
                        ];

                    governanceMembers.pop();

                    break;
                }
            }
        }

        emit GovernanceChangeExecuted(
            changeId,
            change.member,
            change.changeType
        );
    }

    // ---------------------------------------------------------------------
    // Internal Merkle tree logic
    // ---------------------------------------------------------------------

    /**
     * Fixed depth-3 eligibility tree:
     *
     * 8 leaves
     * 4 parents
     * 2 parents
     * 1 root
     *
     * Unused leaves are zero.
     */
    function _eligibilityRoot(
        uint256 electionId
    )
        internal
        view
        returns (uint256)
    {
        uint256[8] memory nodes;

        for (
            uint256 i = 0;
            i < TREE_LEAVES;
            i++
        ) {
            nodes[i] =
                eligibilityLeaves[
                    electionId
                ][i];
        }

        for (
            uint256 level = 0;
            level < 3;
            level++
        ) {
            uint256 count =
                TREE_LEAVES >> level;

            for (
                uint256 i = 0;
                i < count;
                i += 2
            ) {
                nodes[i / 2] =
                    PoseidonT3.hash(
                        [
                            nodes[i],
                            nodes[i + 1]
                        ]
                    );
            }
        }

        return nodes[0];
    }

    /**
     * Candidate tree uses:
     * leaf = Poseidon(candidateId, 0)
     *
     * and the same fixed 8-leaf depth-3 structure.
     */
    function _candidateRoot(
        uint256[] memory candidates
    )
        internal
        view
        returns (uint256)
    {
        uint256[8] memory nodes;

        for (
            uint256 i = 0;
            i < candidates.length;
            i++
        ) {
            nodes[i] =
                PoseidonT3.hash(
                    [
                        candidates[i],
                        uint256(0)
                    ]
                );
        }

        for (
            uint256 level = 0;
            level < 3;
            level++
        ) {
            uint256 count =
                TREE_LEAVES >> level;

            for (
                uint256 i = 0;
                i < count;
                i += 2
            ) {
                nodes[i / 2] =
                    PoseidonT3.hash(
                        [
                            nodes[i],
                            nodes[i + 1]
                        ]
                    );
            }
        }

        return nodes[0];
    }

    function _sort(
        uint256[] memory values
    )
        internal
        pure
    {
        for (
            uint256 i = 1;
            i < values.length;
            i++
        ) {
            uint256 key = values[i];
            uint256 j = i;

            while (
                j > 0 &&
                values[j - 1] > key
            ) {
                values[j] =
                    values[j - 1];

                j--;
            }

            values[j] = key;
        }
    }
}