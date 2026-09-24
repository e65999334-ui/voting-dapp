pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";

/*
 * Public signals, in the project's established Solidity integration order:
 *   0. nullifierHash
 *   1. voteCommitment
 *   2. electionId
 *   3. scopeRoot = Poseidon(eligibilityRoot, candidateRoot)
 *
 * Private signals include both Merkle paths. Candidate membership is proven
 * without revealing candidateChoice.
 */
template Merkle3() {
    signal input leaf;
    signal input root;
    signal input pathElements[3];
    signal input pathIndices[3];

    signal node[4];
    signal left[3];
    signal right[3];
    component pathHasher[3];
    component leftMux[3];
    component rightMux[3];
    node[0] <== leaf;

    for (var i = 0; i < 3; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;
        leftMux[i] = Mux1();
        leftMux[i].c[0] <== node[i];
        leftMux[i].c[1] <== pathElements[i];
        leftMux[i].s <== pathIndices[i];
        left[i] <== leftMux[i].out;

        rightMux[i] = Mux1();
        rightMux[i].c[0] <== pathElements[i];
        rightMux[i].c[1] <== node[i];
        rightMux[i].s <== pathIndices[i];
        right[i] <== rightMux[i].out;

        pathHasher[i] = Poseidon(2);
        pathHasher[i].inputs[0] <== left[i];
        pathHasher[i].inputs[1] <== right[i];
        node[i + 1] <== pathHasher[i].out;
    }

    root === node[3];
}

template VoteValidity() {
    signal input credential;
    signal input electionId;
    signal input candidateChoice;
    signal input voteSalt;
    signal input eligibilityPathElements[3];
    signal input eligibilityPathIndices[3];
    signal input eligibilityRoot;
    signal input candidatePathElements[3];
    signal input candidatePathIndices[3];
    signal input candidateRoot;
    signal input scopeRoot;

    signal output nullifierHash;
    signal output voteCommitment;

    component identityHasher = Poseidon(1);
    identityHasher.inputs[0] <== credential;

    component eligibilityMembership = Merkle3();
    eligibilityMembership.leaf <== identityHasher.out;
    eligibilityMembership.root <== eligibilityRoot;
    for (var i = 0; i < 3; i++) {
        eligibilityMembership.pathElements[i] <== eligibilityPathElements[i];
        eligibilityMembership.pathIndices[i] <== eligibilityPathIndices[i];
    }

    component candidateHasher = Poseidon(2);
    candidateHasher.inputs[0] <== candidateChoice;
    candidateHasher.inputs[1] <== 0;

    component candidateMembership = Merkle3();
    candidateMembership.leaf <== candidateHasher.out;
    candidateMembership.root <== candidateRoot;
    for (var j = 0; j < 3; j++) {
        candidateMembership.pathElements[j] <== candidatePathElements[j];
        candidateMembership.pathIndices[j] <== candidatePathIndices[j];
    }

    component scopeHasher = Poseidon(2);
    scopeHasher.inputs[0] <== eligibilityRoot;
    scopeHasher.inputs[1] <== candidateRoot;
    scopeHasher.out === scopeRoot;

    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== credential;
    nullifierHasher.inputs[1] <== electionId;
    nullifierHash <== nullifierHasher.out;

    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== candidateChoice;
    commitmentHasher.inputs[1] <== voteSalt;
    voteCommitment <== commitmentHasher.out;
}

component main {public [electionId, scopeRoot]} = VoteValidity();