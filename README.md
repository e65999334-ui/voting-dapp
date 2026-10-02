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

`ZKVoting` has protocol governance plus a separate identity issuer. Its constructor requires:

```text
ZKVoting(verifierAddress, governanceMembers, approvalThreshold, identityIssuer)
```

The initial governance members and threshold are fixed at deployment. Election
approval requires distinct governance members to reach the threshold.
Membership additions and removals are also threshold-approved proposals; a
single member cannot change the membership alone. Removal is rejected when it
would leave fewer members than the configured threshold.

The identity issuer is a dedicated signing wallet configured with
`IDENTITY_ISSUER_ADDRESS` during deployment. Participant registration through
the frontend uses an EIP-712 attestation signed by that issuer and bound to the
election, participant wallet, chain, and deployed contract. The legacy
`registerParticipant` entry point is restricted to the issuer. Deploy a new
contract before using the updated frontend; the previous deployment does not
have this authorization flow.

## Identity verification prototype

The separate API is in [identity-server/server.js](identity-server/server.js)
and listens on port 3001. Copy
[identity-server/.env.example](identity-server/.env.example) to
`identity-server/.env`, configure the provider URL/key, issuer private key,
deployed contract address, RPC URL, chain ID, and a random
`IDENTITY_COMMITMENT_SECRET`, then install and start it with
`npm install --prefix identity-server` and `npm run identity:dev`. The issuer
private key and commitment secret must never be placed in frontend environment
variables.

The app sends the voter to the authorized provider's hosted document and
biometric experience; it does not collect ID numbers, document images, or face
data, and it does not attempt to assess a camera feed itself. The API exposes
`POST /api/identity/start` to create a provider session and
`POST /api/identity/complete` to validate the provider's opaque verification
reference server-to-server. Configure `IDENTITY_PROVIDER_SESSION_URL`,
`IDENTITY_PROVIDER_RESULT_URL`, and `IDENTITY_PROVIDER_API_KEY` in
`identity-server/.env`. The provider adapter must return a hosted `verificationUrl`
and `sessionId` when creating a session; result lookup must return verified
document type, document-detected/readable/complete/verified checks, liveness,
face-match status, and a stable provider subject identifier. Browser-supplied
verification booleans are never trusted. Since provider APIs differ, map the
provider's actual API to this adapter contract before enabling it; without that
configuration, the service fails closed.

After provider validation, the server derives an election-specific HMAC
commitment from the provider subject identifier (never the document number),
checks the on-chain identity registry, and signs an EIP-712 attestation. The
contract prevents duplicate commitments for an election. The frontend submits
that attestation for registration. Enrollment currently records the chosen
registration wallet alongside the credential leaf; ballot submission is
wallet-independent and uses the ZK proof plus an election-scoped nullifier to
prevent double voting. The credential must still be backed up securely for use
from a different wallet or device. This is a prototype, not a substitute for
independent identity-provider, privacy, and smart-contract security reviews.

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
