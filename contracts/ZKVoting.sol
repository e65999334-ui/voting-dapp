// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IVerifier.sol";
import "./PoseidonT3.sol";

/**
 * EthiopiaChain ZK Voting
 *
 * General-purpose decentralized voting protocol.
 *
 * IMPORTANT DESIGN:
 * - Any wallet can create a vote.
 * - A trusted identity issuer attests participant registration before voting starts.
 * - Governance does NOT approve ordinary votes.
 * - Governance remains available for protocol-level governance.
 * - Vote configuration becomes locked once voting starts.
 * - Voting is enforced by the smart contract.
 * - ZK proofs verify eligibility and vote validity.
 * - Nullifiers prevent double voting.
 * - Vote commitments prevent changing a submitted ballot.
 * - Ending and finalization are permissionless once their conditions are met.
 *
 * This contract is intended for testing/development and should receive
 * independent security review before production use.
 */
contract ZKVoting {
    uint256 public constant PUBLIC_SIGNAL_COUNT = 4;

    uint256 private constant TREE_LEAVES = 8;

    bytes32 private constant IDENTITY_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant IDENTITY_ATTESTATION_TYPEHASH =
        keccak256("IdentityAttestation(uint256 electionId,address participant,bytes32 identityHash)");
    bytes32 private constant IDENTITY_NAME_HASH =
        keccak256("EthiopiaChain ZKVoting");
    bytes32 private constant IDENTITY_VERSION_HASH =
        keccak256("1");
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    uint64 public constant REVEAL_PERIOD = 1 days;

    uint256 public constant MAX_PARTICIPANTS = TREE_LEAVES;

    IVerifier public immutable verifier;

    address public immutable identityIssuer;

    uint256 public nextElectionId = 1;

    // =============================================================
    // PROTOCOL GOVERNANCE
    // =============================================================

    /*
     * Governance is now protocol-level governance.
     *
     * It does NOT control individual classroom, community,
     * company, club, or ordinary user-created votes.
     */
    uint256 public immutable governanceThreshold;

    mapping(address => bool) public isGovernanceMember;

    address[] public governanceMembers;

    struct GovernanceAction {
        uint256 approvalCount;
        bool executed;
        mapping(address => bool) approvedBy;
    }

    mapping(bytes32 => GovernanceAction)
        private governanceActions;

    event GovernanceMemberAdded(
        address indexed member
    );

    event GovernanceApproval(
        bytes32 indexed actionId,
        address indexed member,
        uint256 approvalCount
    );

    event GovernanceActionExecuted(
        bytes32 indexed actionId
    );

    modifier onlyGovernance() {
        require(
            isGovernanceMember[msg.sender],
            "Not governance member"
        );
        _;
    }

    modifier onlyIdentityIssuer() {
        require(
            msg.sender == identityIssuer,
            "Not identity issuer"
        );
        _;
    }

    constructor(
        address verifier_,
        address[] memory governanceMembers_,
        uint256 governanceThreshold_,
        address identityIssuer_
    ) {
        require(
            verifier_ != address(0),
            "Zero verifier"
        );

        require(
            identityIssuer_ != address(0),
            "Zero identity issuer"
        );

        require(
            governanceMembers_.length > 0,
            "No governance members"
        );

        require(
            governanceThreshold_ > 0 &&
            governanceThreshold_ <=
            governanceMembers_.length,
            "Invalid governance threshold"
        );

        verifier =
            IVerifier(verifier_);

        identityIssuer = identityIssuer_;

        governanceThreshold =
            governanceThreshold_;

        for (
            uint256 i = 0;
            i < governanceMembers_.length;
            i++
        ) {
            address member =
                governanceMembers_[i];

            require(
                member != address(0),
                "Zero governance member"
            );

            require(
                !isGovernanceMember[member],
                "Duplicate governance member"
            );

            isGovernanceMember[member] =
                true;

            governanceMembers.push(
                member
            );

            emit GovernanceMemberAdded(
                member
            );
        }
    }

    function getGovernanceMembers()
        external
        view
        returns (address[] memory)
    {
        return governanceMembers;
    }

    function getGovernanceApproval(
        bytes32 actionId,
        address member
    )
        external
        view
        returns (bool)
    {
        return
            governanceActions[actionId]
                .approvedBy[member];
    }

    function getGovernanceApprovalCount(
        bytes32 actionId
    )
        external
        view
        returns (uint256)
    {
        return
            governanceActions[actionId]
                .approvalCount;
    }

    function _approveGovernanceAction(
        bytes32 actionId
    )
        internal
        onlyGovernance
        returns (bool executed)
    {
        GovernanceAction storage action =
            governanceActions[actionId];

        require(
            !action.executed,
            "Action already executed"
        );

        require(
            !action.approvedBy[msg.sender],
            "Already approved"
        );

        action.approvedBy[msg.sender] =
            true;

        action.approvalCount++;

        emit GovernanceApproval(
            actionId,
            msg.sender,
            action.approvalCount
        );

        if (
            action.approvalCount >=
            governanceThreshold
        ) {
            action.executed = true;

            emit GovernanceActionExecuted(
                actionId
            );

            return true;
        }

        return false;
    }

    // =============================================================
    // ELECTION
    // =============================================================

    struct Election {
        string title;
        string description;

        address creator;

        uint256 eligibilityRoot;
        uint256 candidateRoot;

        uint64 registrationStartTime;
        uint64 registrationEndTime;
        uint64 startTime;
        uint64 endTime;
        uint64 revealDeadline;

        /*
         * proposalApproved is retained for ABI/UI compatibility.
         *
         * Permissionless votes are automatically approved when
         * created because governance no longer approves each vote.
         */
        bool proposalApproved;

        bool votingStarted;
        bool ended;
        bool finalized;

        uint256 acceptedBallots;
        uint256 revealedBallots;
    }

    struct VoteSchedule {
        uint64 registrationStartTime;
        uint64 registrationEndTime;
        uint64 startTime;
        uint64 endTime;
    }

    mapping(uint256 => Election)
        private elections;

    mapping(uint256 => bytes32)
        private electionAccessCodeHashes;

    struct Candidate {
        uint256 id;
        address candidateAddress;
        string name;
    }

    mapping(uint256 => Candidate[])
        private electionCandidates;

    mapping(uint256 => mapping(uint256 => bool))
        public candidateAllowed;

    // =============================================================
    // ELIGIBILITY
    // =============================================================

    struct Participant {
        address wallet;
        uint256 credentialLeaf;
        uint256 nullifierHash;
        bool registered;
    }

    mapping(uint256 => Participant[])
        private participants;

    mapping(uint256 => mapping(address => bool))
        public registeredParticipant;

    // Stores only a per-election commitment, never the raw voter identifier.
    mapping(uint256 => mapping(bytes32 => bool))
        public identityRegistered;

    mapping(uint256 => mapping(address => uint256))
        private participantCredentialLeaf;

    mapping(uint256 => mapping(address => uint256))
        private participantNullifierHash;

    mapping(uint256 => mapping(address => uint256))
        public participantIndex;

    mapping(uint256 => mapping(uint256 => uint256))
        private eligibilityLeaves;

    mapping(uint256 => mapping(uint256 => bool))
        private eligibilityLeafUsed;

    mapping(uint256 => mapping(uint256 => bool))
        private eligibilityNullifierUsed;

    mapping(uint256 => mapping(uint256 => bool))
        public nullifierUsed;

    // =============================================================
    // VOTE STORAGE
    // =============================================================

    mapping(uint256 => mapping(uint256 => bool))
        public voteCommitmentUsed;

    mapping(uint256 => mapping(uint256 => bool))
        public voteCommitmentRevealed;

    mapping(uint256 => mapping(uint256 => uint256))
        private voteCounts;

    // =============================================================
    // EVENTS
    // =============================================================

    event VoteCreated(
        uint256 indexed electionId,
        address indexed creator,
        string title,
        string description
    );

    event CandidateAdded(
        uint256 indexed electionId,
        uint256 indexed candidateId,
        address indexed candidateAddress,
        string name
    );

    event ParticipantRegistered(
        uint256 indexed electionId,
        address indexed participant,
        uint256 indexed treeIndex,
        uint256 credentialLeaf,
        uint256 nullifierHash,
        uint256 eligibilityRoot
    );

    event VoteApproved(
        uint256 indexed electionId
    );

    event VoteActivated(
        uint256 indexed electionId
    );

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

    event VoteEnded(
        uint256 indexed electionId
    );

    event VoteFinalized(
        uint256 indexed electionId,
        uint256 revealedBallots,
        uint256 acceptedBallots
    );

    // =============================================================
    // MODIFIERS
    // =============================================================

    modifier voteExists(
        uint256 electionId
    ) {
        require(
            bytes(
                elections[electionId].title
            ).length > 0,
            "Unknown vote"
        );

        _;
    }

    modifier onlyVoteCreator(
        uint256 electionId
    ) {
        require(
            elections[electionId].creator ==
                msg.sender,
            "Not vote creator"
        );

        _;
    }

    // =============================================================
    // CREATE VOTE
    // =============================================================

    /**
     * Anyone can create a vote.
     *
     * Examples:
     * - Teacher creates classroom vote
     * - Club member creates club vote
     * - Company organizer creates internal vote
     * - Community organizer creates community vote
     * - Authorized organization creates official election
     *
     * Governance is NOT required.
     */
    function createVote(
        string calldata title,
        string calldata description,
        uint64 startTime,
        uint64 endTime,
        Candidate[] calldata candidates
    )
        external
        returns (uint256 electionId)
    {
        uint64 registrationStart =
            uint64(block.timestamp);

        return _createVote(
            title,
            description,
            VoteSchedule(
                registrationStart,
                startTime,
                startTime,
                endTime
            ),
            candidates
        );
    }

    function createVoteWithRegistration(
        string calldata title,
        string calldata description,
        uint64 registrationStartTime,
        uint64 registrationEndTime,
        uint64 startTime,
        uint64 endTime,
        Candidate[] calldata candidates
    )
        external
        returns (uint256 electionId)
    {
        return _createVote(
            title,
            description,
            VoteSchedule(
                registrationStartTime,
                registrationEndTime,
                startTime,
                endTime
            ),
            candidates
        );
    }

    function createVoteWithRegistrationAndAccessCode(
        string calldata title,
        string calldata description,
        uint64 registrationStartTime,
        uint64 registrationEndTime,
        uint64 startTime,
        uint64 endTime,
        bytes32 accessCodeHash,
        Candidate[] calldata candidates
    )
        external
        returns (uint256 electionId)
    {
        require(accessCodeHash != bytes32(0), "Zero access code hash");

        electionId = _createVote(
            title,
            description,
            VoteSchedule(
                registrationStartTime,
                registrationEndTime,
                startTime,
                endTime
            ),
            candidates
        );

        electionAccessCodeHashes[electionId] = accessCodeHash;
    }

    function getElectionAccessCodeHash(uint256 electionId)
        external
        view
        voteExists(electionId)
        returns (bytes32)
    {
        return electionAccessCodeHashes[electionId];
    }

    function _createVote(
        string calldata title,
        string calldata description,
        VoteSchedule memory schedule,
        Candidate[] calldata candidates
    )
        private
        returns (uint256 electionId)
    {
        require(
            bytes(title).length > 0,
            "Empty title"
        );

        require(
            schedule.registrationStartTime <
                schedule.registrationEndTime,
            "Invalid registration range"
        );

        require(
            schedule.registrationEndTime <=
                schedule.startTime,
            "Registration after vote start"
        );

        require(
            schedule.registrationEndTime > block.timestamp,
            "Registration already ended"
        );

        require(
            schedule.startTime < schedule.endTime,
            "Invalid time range"
        );

        require(
            schedule.endTime > block.timestamp,
            "Vote already ended"
        );

        require(
            schedule.endTime <=
                type(uint64).max -
                REVEAL_PERIOD,
            "Vote too late"
        );

        uint256 candidateRoot =
            _buildCandidateRoot(candidates);

        electionId =
            nextElectionId++;

        Election storage e =
            elections[electionId];

        e.title =
            title;

        e.description =
            description;

        e.creator =
            msg.sender;

        e.candidateRoot =
            candidateRoot;

        e.registrationStartTime =
            schedule.registrationStartTime;

        e.registrationEndTime =
            schedule.registrationEndTime;

        e.startTime =
            schedule.startTime;

        e.endTime =
            schedule.endTime;

        e.revealDeadline =
            schedule.endTime +
            REVEAL_PERIOD;

        /*
         * Every valid user-created vote is automatically approved.
         *
         * This is the critical difference from the old architecture.
         */
        e.proposalApproved =
            true;

        _storeCandidates(electionId, candidates);

        _emitVoteCreated(
            electionId,
            title,
            description
        );

        emit VoteApproved(
            electionId
        );
    }

    function _buildCandidateRoot(
        Candidate[] calldata candidates
    )
        private
        pure
        returns (uint256 candidateRoot)
    {
        require(
            candidates.length > 0 &&
            candidates.length <= TREE_LEAVES,
            "Invalid candidate count"
        );

        uint256[] memory ids =
            new uint256[](candidates.length);

        for (uint256 i = 0; i < candidates.length; i++) {
            require(candidates[i].id != 0, "Zero candidate ID");
            require(candidates[i].candidateAddress != address(0), "Zero candidate address");
            require(bytes(candidates[i].name).length > 0, "Empty candidate name");
            ids[i] = candidates[i].id;

            for (uint256 j = 0; j < i; j++) {
                require(candidates[i].id != candidates[j].id, "Duplicate candidate ID");
                require(candidates[i].candidateAddress != candidates[j].candidateAddress, "Duplicate candidate address");
            }
        }

        _sort(ids);
        candidateRoot = _candidateRoot(ids);
        require(candidateRoot != 0, "Zero candidate root");
    }

    function _storeCandidates(
        uint256 electionId,
        Candidate[] calldata candidates
    )
        private
    {
        for (uint256 i = 0; i < candidates.length; i++) {
            candidateAllowed[electionId][candidates[i].id] = true;
            electionCandidates[electionId].push(candidates[i]);

            emit CandidateAdded(
                electionId,
                candidates[i].id,
                candidates[i].candidateAddress,
                candidates[i].name
            );
        }
    }

    function _emitVoteCreated(
        uint256 electionId,
        string calldata title,
        string calldata description
    )
        private
    {
        emit VoteCreated(
            electionId,
            msg.sender,
            title,
            description
        );
    }

    // =============================================================
    // ELECTION READ FUNCTIONS
    // =============================================================

    function getVoteTitle(
        uint256 electionId
    )
        external
        view
        voteExists(electionId)
        returns (string memory)
    {
        return elections[electionId].title;
    }

    function getVoteDescription(
        uint256 electionId
    )
        external
        view
        voteExists(electionId)
        returns (string memory)
    {
        return
            elections[electionId]
                .description;
    }

    function getVoteCreator(
        uint256 electionId
    )
        external
        view
        voteExists(electionId)
        returns (address)
    {
        return
            elections[electionId]
                .creator;
    }

    function getVoteRoots(
        uint256 electionId
    )
        external
        view
        voteExists(electionId)
        returns (
            uint256 eligibilityRoot,
            uint256 candidateRoot
        )
    {
        Election storage e =
            elections[electionId];

        return (
            e.eligibilityRoot,
            e.candidateRoot
        );
    }

    function getVoteTimes(
        uint256 electionId
    )
        external
        view
        voteExists(electionId)
        returns (
            uint64 startTime,
            uint64 endTime,
            uint64 revealDeadline
        )
    {
        Election storage e =
            elections[electionId];

        return (
            e.startTime,
            e.endTime,
            e.revealDeadline
        );
    }

    function getRegistrationTimes(
        uint256 electionId
    )
        external
        view
        voteExists(electionId)
        returns (
            uint64 registrationStartTime,
            uint64 registrationEndTime
        )
    {
        Election storage e =
            elections[electionId];

        return (
            e.registrationStartTime,
            e.registrationEndTime
        );
    }

    function getParticipantStatus(
        uint256 electionId,
        address participant
    )
        external
        view
        voteExists(electionId)
        returns (bool registered, bool voted)
    {
        registered =
            registeredParticipant[electionId][participant];

        voted = registered && nullifierUsed[
            electionId
        ][
            participantNullifierHash[electionId][participant]
        ];
    }

    function getVoteStatus(
        uint256 electionId
    )
        external
        view
        voteExists(electionId)
        returns (
            bool proposalApproved,
            bool votingStarted,
            bool ended,
            bool finalized
        )
    {
        Election storage e =
            elections[electionId];

        bool isVotingActive =
            (
                block.timestamp >= e.startTime &&
                block.timestamp < e.endTime &&
                !e.ended
            );

        bool hasEnded =
            e.ended ||
            block.timestamp >= e.endTime;

        return (
            e.proposalApproved,
            isVotingActive,
            hasEnded,
            e.finalized
        );
    }

    function getVoteBallots(
        uint256 electionId
    )
        external
        view
        voteExists(electionId)
        returns (
            uint256 acceptedBallots,
            uint256 revealedBallots
        )
    {
        Election storage e =
            elections[electionId];

        return (
            e.acceptedBallots,
            e.revealedBallots
        );
    }

    function getElectionCandidates(
        uint256 electionId
    )
        external
        view
        voteExists(electionId)
        returns (
            uint256[] memory ids,
            address[] memory addresses,
            string[] memory names
        )
    {
        Candidate[] storage candidates =
            electionCandidates[
                electionId
            ];

        uint256 length =
            candidates.length;

        ids =
            new uint256[](length);

        addresses =
            new address[](length);

        names =
            new string[](length);

        for (
            uint256 i = 0;
            i < length;
            i++
        ) {
            ids[i] =
                candidates[i].id;

            addresses[i] =
                candidates[i]
                    .candidateAddress;

            names[i] =
                candidates[i].name;
        }
    }

    // =============================================================
    // PARTICIPANT REGISTRATION
    // =============================================================

    /**
     * Legacy issuer-only registration entry point. A participant cannot
     * submit an arbitrary identity commitment through this function.
     */
    function registerParticipant(
        uint256 electionId,
        address participant,
        uint256 credentialLeaf,
        uint256 nullifierHash,
        bytes32 identityHash
    )
        external
        voteExists(electionId)
        onlyIdentityIssuer
    {
        _registerParticipant(
            electionId,
            participant,
            credentialLeaf,
            nullifierHash,
            identityHash
        );
    }

    /**
     * Allows the participant to submit their registration transaction while
     * requiring an issuer signature over this election, wallet, and identity.
     */
    function registerVerifiedParticipant(
        uint256 electionId,
        address participant,
        uint256 credentialLeaf,
        uint256 nullifierHash,
        bytes32 identityHash,
        bytes calldata issuerSignature
    )
        external
        voteExists(electionId)
    {
        require(
            msg.sender == participant,
            "Not participant"
        );
        require(
            _recoverIdentityIssuer(
                electionId,
                participant,
                identityHash,
                issuerSignature
            ) == identityIssuer,
            "Invalid identity issuer signature"
        );

        _registerParticipant(
            electionId,
            participant,
            credentialLeaf,
            nullifierHash,
            identityHash
        );
    }

    function _recoverIdentityIssuer(
        uint256 electionId,
        address participant,
        bytes32 identityHash,
        bytes calldata signature
    )
        private
        view
        returns (address)
    {
        require(
            signature.length == 65,
            "Invalid identity issuer signature"
        );

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(
            (v == 27 || v == 28) && uint256(s) <= SECP256K1_HALF_ORDER,
            "Invalid identity issuer signature"
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                IDENTITY_DOMAIN_TYPEHASH,
                IDENTITY_NAME_HASH,
                IDENTITY_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                IDENTITY_ATTESTATION_TYPEHASH,
                electionId,
                participant,
                identityHash
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );

        return ecrecover(digest, v, r, s);
    }

    function _registerParticipant(
        uint256 electionId,
        address participant,
        uint256 credentialLeaf,
        uint256 nullifierHash,
        bytes32 identityHash
    )
        private
    {
        Election storage e = elections[electionId];

        require(!e.votingStarted, "Voting already started");
        require(block.timestamp < e.registrationEndTime, "Registration closed");
        require(block.timestamp >= e.registrationStartTime, "Registration not open");
        require(participant != address(0), "Zero participant");
        require(!registeredParticipant[electionId][participant], "Participant already registered");
        require(identityHash != bytes32(0), "Zero identity hash");
        require(!identityRegistered[electionId][identityHash], "Identity already registered");
        require(credentialLeaf != 0, "Zero credential");
        require(nullifierHash != 0, "Zero nullifier");
        require(!eligibilityLeafUsed[electionId][credentialLeaf], "Credential already used");
        require(!eligibilityNullifierUsed[electionId][nullifierHash], "Nullifier already used");
        require(participants[electionId].length < MAX_PARTICIPANTS, "Maximum participants reached");

        uint256 treeIndex = participants[electionId].length;
        participants[electionId].push(
            Participant({
                wallet: participant,
                credentialLeaf: credentialLeaf,
                nullifierHash: nullifierHash,
                registered: true
            })
        );

        registeredParticipant[electionId][participant] = true;
        identityRegistered[electionId][identityHash] = true;
        participantCredentialLeaf[electionId][participant] = credentialLeaf;
        participantNullifierHash[electionId][participant] = nullifierHash;
        participantIndex[electionId][participant] = treeIndex;
        eligibilityLeaves[electionId][treeIndex] = credentialLeaf;
        eligibilityLeafUsed[electionId][credentialLeaf] = true;
        eligibilityNullifierUsed[electionId][nullifierHash] = true;

        uint256 root = _eligibilityRoot(electionId);
        e.eligibilityRoot = root;

        emit ParticipantRegistered(
            electionId,
            participant,
            treeIndex,
            credentialLeaf,
            nullifierHash,
            root
        );
    }

    function getParticipantCount(
        uint256 electionId
    )
        external
        view
        voteExists(electionId)
        returns (uint256)
    {
        return
            participants[electionId]
                .length;
    }

    function getParticipant(
        uint256 electionId,
        uint256 index
    )
        external
        view
        voteExists(electionId)
        returns (
            address wallet,
            uint256 credentialLeaf,
            uint256 nullifierHash,
            bool registered
        )
    {
        Participant storage p =
            participants[
                electionId
            ][index];

        return (
            p.wallet,
            p.credentialLeaf,
            p.nullifierHash,
            p.registered
        );
    }

    function getEligibilityLeaves(
        uint256 electionId
    )
        external
        view
        voteExists(electionId)
        returns (
            uint256[] memory leaves
        )
    {
        leaves =
            new uint256[](
                TREE_LEAVES
            );

        for (
            uint256 i = 0;
            i < TREE_LEAVES;
            i++
        ) {
            leaves[i] =
                eligibilityLeaves[
                    electionId
                ][i];
        }
    }

    // =============================================================
    // PERMISSIONLESS VOTE LIFECYCLE
    // =============================================================

    /**
     * Anyone can activate a vote once its start time arrives.
     *
     * This prevents the creator from having to be online just to
     * start the election.
     */
    function activateVote(
        uint256 electionId
    )
        external
        voteExists(electionId)
    {
        Election storage e =
            elections[electionId];

        require(
            e.proposalApproved,
            "Vote not approved"
        );

        require(
            participants[electionId].length > 0,
            "No participants"
        );

        require(
            e.eligibilityRoot != 0,
            "No eligibility root"
        );

        require(
            block.timestamp >=
                e.startTime,
            "Vote not started"
        );

        require(
            block.timestamp < e.endTime,
            "Vote ended"
        );

        require(
            !e.ended,
            "Vote already ended"
        );

        require(
            !e.votingStarted,
            "Vote already active"
        );

        e.votingStarted =
            true;

        emit VoteActivated(
            electionId
        );
    }

    /**
     * Anyone can end a vote after its end time.
     *
     * This removes another point of centralized control.
     */
    function endVote(
        uint256 electionId
    )
        external
        voteExists(electionId)
    {
        Election storage e =
            elections[electionId];

        require(
            block.timestamp >=
                e.endTime,
            "Vote still active"
        );

        require(
            !e.ended,
            "Vote already ended"
        );

        e.ended =
            true;

        emit VoteEnded(
            electionId
        );
    }

    /**
     * Anyone can finalize the vote after the reveal period.
     */
    function finalizeVote(
        uint256 electionId
    )
        external
        voteExists(electionId)
    {
        Election storage e =
            elections[electionId];

        require(
            e.ended,
            "Vote not ended"
        );

        require(
            block.timestamp >=
                e.revealDeadline,
            "Reveal period active"
        );

        require(
            !e.finalized,
            "Already finalized"
        );

        e.finalized =
            true;

        emit VoteFinalized(
            electionId,
            e.revealedBallots,
            e.acceptedBallots
        );
    }

    // =============================================================
    // PRIVATE ZK VOTING
    // =============================================================

    function castPrivateVote(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[PUBLIC_SIGNAL_COUNT]
            calldata publicSignals
    )
        external
        voteExists(electionId)
    {
        Election storage e =
            elections[electionId];

        require(
            e.proposalApproved,
            "Vote not approved"
        );

        require(
            block.timestamp >=
                e.startTime,
            "Vote not started"
        );

        require(
            block.timestamp < e.endTime,
            "Vote ended"
        );

        uint256 nullifierHash =
            publicSignals[0];

        uint256 voteCommitment =
            publicSignals[1];

        require(
            publicSignals[2] ==
                electionId,
            "Invalid election ID"
        );

        uint256 expectedScopeRoot =
            PoseidonT3.hash(
                [
                    e.eligibilityRoot,
                    e.candidateRoot
                ]
            );

        require(
            publicSignals[3] ==
                expectedScopeRoot,
            "Invalid scope root"
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
            !nullifierUsed[
                electionId
            ][nullifierHash],
            "Nullifier already used"
        );

        require(
            !voteCommitmentUsed[
                electionId
            ][voteCommitment],
            "Commitment already used"
        );

        require(
            verifier.verifyProof(
                a,
                b,
                c,
                publicSignals
            ),
            "Invalid proof"
        );

        nullifierUsed[
            electionId
        ][nullifierHash] =
            true;

        voteCommitmentUsed[
            electionId
        ][voteCommitment] =
            true;

        e.acceptedBallots++;

        emit VoteAccepted(
            electionId,
            nullifierHash,
            voteCommitment
        );
    }

    // =============================================================
    // REVEAL
    // =============================================================

    /**
     * Anyone may reveal a valid commitment.
     *
     * The commitment itself is only counted once.
     */
    function revealVote(
        uint256 electionId,
        uint256 candidateId,
        uint256 voteSalt
    )
        external
        voteExists(electionId)
    {
        Election storage e =
            elections[electionId];

        require(
            e.ended,
            "Vote not ended"
        );

        require(
            block.timestamp <=
                e.revealDeadline,
            "Reveal period ended"
        );

        require(
            candidateAllowed[
                electionId
            ][candidateId],
            "Invalid candidate"
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
        ][commitment] =
            true;

        e.revealedBallots++;

        voteCounts[
            electionId
        ][candidateId]++;

        emit VoteRevealed(
            electionId,
            commitment,
            candidateId
        );
    }

    function getVoteCount(
        uint256 electionId,
        uint256 candidateId
    )
        external
        view
        voteExists(electionId)
        returns (uint256)
    {
        return
            voteCounts[
                electionId
            ][candidateId];
    }

    // =============================================================
    // MERKLE ROOTS
    // =============================================================

    function _eligibilityRoot(
        uint256 electionId
    )
        internal
        view
        returns (uint256)
    {
        uint256[8] memory level0;

        for (
            uint256 i = 0;
            i < TREE_LEAVES;
            i++
        ) {
            level0[i] =
                eligibilityLeaves[
                    electionId
                ][i];
        }

        uint256[4] memory level1;

        for (
            uint256 i = 0;
            i < 4;
            i++
        ) {
            level1[i] =
                PoseidonT3.hash(
                    [
                        level0[i * 2],
                        level0[i * 2 + 1]
                    ]
                );
        }

        uint256[2] memory level2;

        level2[0] =
            PoseidonT3.hash(
                [
                    level1[0],
                    level1[1]
                ]
            );

        level2[1] =
            PoseidonT3.hash(
                [
                    level1[2],
                    level1[3]
                ]
            );

        return
            PoseidonT3.hash(
                [
                    level2[0],
                    level2[1]
                ]
            );
    }

    function _candidateRoot(
        uint256[] memory sortedIds
    )
        internal
        pure
        returns (uint256)
    {
        uint256[8] memory level0;

        for (
            uint256 i = 0;
            i < TREE_LEAVES;
            i++
        ) {
            if (
                i < sortedIds.length
            ) {
                level0[i] =
                    PoseidonT3.hash(
                        [
                            sortedIds[i],
                            0
                        ]
                    );
            } else {
                level0[i] =
                    0;
            }
        }

        uint256[4] memory level1;

        for (
            uint256 i = 0;
            i < 4;
            i++
        ) {
            level1[i] =
                PoseidonT3.hash(
                    [
                        level0[i * 2],
                        level0[i * 2 + 1]
                    ]
                );
        }

        uint256[2] memory level2;

        level2[0] =
            PoseidonT3.hash(
                [
                    level1[0],
                    level1[1]
                ]
            );

        level2[1] =
            PoseidonT3.hash(
                [
                    level1[2],
                    level1[3]
                ]
            );

        return
            PoseidonT3.hash(
                [
                    level2[0],
                    level2[1]
                ]
            );
    }

    // =============================================================
    // SORT
    // =============================================================

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
            uint256 key =
                values[i];

            uint256 j =
                i;

            while (
                j > 0 &&
                values[j - 1] > key
            ) {
                values[j] =
                    values[j - 1];

                j--;
            }

            values[j] =
                key;
        }
    }
}