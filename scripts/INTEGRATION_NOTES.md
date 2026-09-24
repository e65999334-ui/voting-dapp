# ZK integration notes

The backend uses a real Groth16 integration generated from
`circuits/VoteValidity.circom`.

Public signal order emitted by Circom is fixed:

1. `nullifierHash`
2. `voteCommitment`
3. `electionId`
4. `scopeRoot`

The circuit privately proves both:

- credential membership in `eligibilityRoot`, and
- candidate membership in `candidateRoot`.

The public `scopeRoot` binds those two election-specific roots:

`scopeRoot = Poseidon(eligibilityRoot, candidateRoot)`

The contract computes the same scope root and rejects proofs that do not match
the election. Candidate IDs are registered and frozen when the election is
proposed, with a maximum of eight candidates using a fixed-depth Merkle tree.

`scripts/setup-zk.js` compiles the circuit, creates local development proving
artifacts, generates the matching `Groth16Verifier.sol`, and generates the
matching `PoseidonT3.sol` helper. It hashes the circuit source and invalidates
stale circuit-derived artifacts whenever the circuit changes.

This remains a research prototype. The local ceremony is not suitable for
production, eligibility-root management is centralized per election, credential
issuance is not implemented, governance is configured as N-of-M, and tallying
uses a post-election commit/reveal process. The reveal process is not
coercion-resistant. None of these components should be described as secure for
a real election without independent review, a production ceremony, and a
well-specified credential/identity layer.
