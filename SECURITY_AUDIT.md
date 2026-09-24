# EthiopiaChain ZK Voting — adversarial security audit (post-remediation)

## Scope

This audit covers `contracts/ZKVoting.sol`, `circuits/VoteValidity.circom`,
the generated-proof integration, and the adversarial test suite.

The remediation pass addresses candidate authorization and election
finalization while keeping the existing N-of-M governance model. The remaining
limitations are intentionally documented rather than presented as solved.

## Remediated findings

### Candidate authorization — remediated

Each election now receives a fixed candidate set of 1–8 non-zero candidate IDs.
The contract sorts and stores that set, computes an exact 8-leaf Poseidon Merkle
root, and exposes the registered candidates through `getElectionCandidates`.

The ZK circuit now proves candidate membership using a private candidate Merkle
path. The candidate root is cryptographically bound to the election together
with the eligibility root through a public `scopeRoot`:

`scopeRoot = Poseidon(eligibilityRoot, candidateRoot)`

This keeps the existing four-public-signal Groth16 interface while preventing a
proof for an unregistered candidate from being valid for the election.

`revealVote` also checks `candidateAllowed[electionId][candidateId]`, so an
unregistered candidate cannot be introduced at tally time.

Candidate sets are immutable after proposal and therefore cannot change during
an active election.

### Election finalization — remediated

The contract now has an explicit terminal `finalized` state and a
`finalizeElection` operation.

A fixed one-day reveal period begins at `endTime`. Finalization is unavailable
until that period expires, which prevents a caller from immediately ending the
reveal opportunity. Unrevealed commitments are excluded from the final tally.

Finalization is one-way and blocks subsequent vote casting/revealing.

## Remaining findings / protocol limitations

### High — reveal remains permissionless and is not coercion-resistant

Anyone who knows `(candidateId, voteSalt)` can reveal a valid commitment during
the reveal period. This remains a commit/reveal design limitation. A user-held
vote secret is not an authorization boundary and does not provide
coercion-resistance or protection against vote-selling/front-running.

A future production design should use a tally protocol whose security model
explicitly addresses coercion and reveal authorization.

### High — credential issuance and one-person uniqueness remain out of scope

The circuit proves that a private credential belongs to the election's
eligibility Merkle root. It does not prove that a real person received exactly
one credential.

If an eligibility root contains two credentials controlled by one person, both
credentials can produce distinct election nullifiers and both can vote.

A production deployment therefore needs a separately specified credential
issuance, revocation, expiry, and one-person-per-credential process.

### Medium — permissionless lifecycle calls are intentional

After governance approval, proposal creation, activation, ending, and reveal
submission are permissionless. The permissionless calls cannot bypass the
N-of-M approval gate or the election time checks.

This is retained for liveness: the system does not depend on one operator to
submit an otherwise-authorized state transition.

### Medium — pending governance approvals use historical approvals

A governance member's approval remains counted if that member is subsequently
removed. A removed member cannot create a new approval after removal, because
approval submission still requires current governance membership.

This is now treated as an explicit historical-approval policy rather than an
accidental behavior. A future governance redesign may instead snapshot the
entire governance set per proposal or invalidate approvals from removed
members; that choice should be made before adding dynamic threshold changes.

### Low / design limitation — threshold changes are not implemented

`approvalThreshold` remains deployment-configured. No runtime threshold change
operation exists. If dynamic thresholds are added later, the threshold change
must itself be governed and must define its interaction with pending proposals
and membership changes.

## Positive controls

- Groth16 proofs are verified by the generated verifier; there is no
  placeholder verifier path.
- Proofs bind to the election ID and the combined eligibility/candidate scope.
- Candidate membership is proved inside the ZK circuit.
- Candidate reveal values are checked against the registered election set.
- Election-specific nullifiers prevent reuse of the same credential in one
election.
- Duplicate commitments are rejected per election.
- Election approval requires distinct governance members.
- Governance removal cannot reduce membership below the configured threshold.
- Vote-accepted events contain the commitment and nullifier, not the candidate
  or credential.
- Finalization is terminal and delayed until the reveal period expires.

These controls still do not turn the prototype into a coercion-resistant,
real-world identity-backed election system.

## Verification

Run from a clean checkout:

```bash
npm install
npm test
```

The build script hashes `VoteValidity.circom` and automatically invalidates the
circuit-specific proving key, verification key, WASM artifacts, and generated
Solidity verifier when the circuit changes. This prevents a stale verifier from
being silently reused after a circuit modification.
