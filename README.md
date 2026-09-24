# EthiopiaChain ZK Voting — Research Prototype

This is a staged educational prototype, not a production-ready election system.

## Goals
- Decentralized election proposals and approvals
- Private ballot design
- Double-voting prevention through nullifiers
- Verifiable cryptographic proofs
- Automated security testing

## Current phase
This backend contains:
1. A constructor-configured N-of-M governance contract with threshold approvals for elections and future membership changes.
2. A Circom circuit proving Poseidon/Merkle eligibility, election-bound nullifiers, private candidate commitments, and candidate-set membership.
3. A generated Groth16 Solidity verifier wired into the voting contract.
4. Security tests covering authorization, candidate-set binding, lifecycle checks, proof rejection, replay, nullifiers, finalization, and post-election reveals.

Candidate choices are not submitted to `castPrivateVote`. Each election has a fixed,
governance-approved candidate set of up to eight IDs. The ZK proof privately proves
that the chosen candidate belongs to that set. The commitment can be revealed
during a one-day post-election reveal period. This remains a commit/reveal design
and is not coercion-resistant or a production election system.

## Suggested setup
- Node.js 20+
- Hardhat
- Circom 2.x
- snarkjs

## Backend commands
```bash
npm install
npm test
```

`npm test` compiles the circuit, creates local Groth16 artifacts, generates the
Solidity verifier, compiles the contracts, and runs the security suite.

## Governance deployment

`ZKVoting` no longer has a single owner. Its constructor requires:

```text
ZKVoting(verifierAddress, governanceMembers, approvalThreshold)
```

The initial governance members and threshold are fixed at deployment. Election
approval requires distinct governance members to reach the threshold.
Membership additions and removals are also threshold-approved proposals; a
single member cannot change the membership alone. Removal is rejected when it
would leave fewer members than the configured threshold.

For a local Hardhat deployment, the script defaults to the first three local
accounts and a threshold of two:

```bash
npm run deploy:local
```

For another local network, provide comma-separated addresses:

```bash
GOVERNANCE_MEMBERS=0x...,0x...,0x... GOVERNANCE_THRESHOLD=2 npm run deploy:local
```

On PowerShell, use:

```powershell
$env:GOVERNANCE_MEMBERS="0x...,0x...,0x..."
$env:GOVERNANCE_THRESHOLD="2"
npm run deploy:local
```

To generate a proof from a JSON witness input after compilation:

```bash
node scripts/generate-proof.js path/to/input.json
```

The JSON must provide `credential`, `electionId`, `candidateChoice`, `voteSalt`,
`eligibilityRoot`, `eligibilityPathElements`, `eligibilityPathIndices`,
`candidateRoot`, `candidatePathElements`, `candidatePathIndices`, and `scopeRoot`. The script
uses the generated WASM witness calculator and proving key; it does not fake
verification or return a placeholder result.

## Windows and clean-machine setup

This project is self-contained and uses Node.js scripts rather than
Unix-specific shell commands. On Windows, install Node.js 20 or newer, then
run the commands above from PowerShell or Command Prompt. `npm install` reads
the committed `package-lock.json`; `npm test` creates the ignored `build/`
directory and all generated local ZK artifacts from source.

Separate installation required:

- Node.js 20+ and npm.
- No globally installed Hardhat, Circom, or snarkjs is required; the pinned
  npm packages provide those tools.
- A local Ethereum node is only needed for deployment/integration testing.
  The included Hardhat tests use Hardhat Network and do not require a node,
  wallet, RPC provider, or Replit service.

Copying this directory to another computer, excluding `node_modules/` if
desired, and running `npm install` followed by `npm test` is the supported
local verification path.

Do not use real personal identity data or real elections with this prototype.

### Generated verifier artifacts

`contracts/Groth16Verifier.sol` and the `build/` directory are generated from
`VoteValidity.circom` and are intentionally not treated as hand-maintained
source. `npm test` / `npm run compile` regenerates them. The setup script detects
circuit changes and invalidates stale proving/verifier artifacts automatically.
