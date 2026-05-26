// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IEAS, AttestationRequest, AttestationRequestData, RevocationRequest, RevocationRequestData} from "@eas/IEAS.sol";

/// @notice EAS schema string this wrapper expects. Must be registered once
///         in the SchemaRegistry; the resulting UID is supplied to the
///         constructor. Field order is part of the schema identity — do not
///         reorder.
///
///         string subjectDid       — full humancard DID URI (e.g. did:wba:lcanady)
///         string claimType        — taxonomy bucket: "employment", "skill",
///                                   "endorsement", "education", "project"
///         string claimData        — free-form payload (JSON, markdown)
///         string evidenceUri      — IPFS or HTTPS URL with supporting evidence
///         uint64 validFrom        — unix ts the claim is valid from
///         uint64 validUntil       — unix ts (0 means open-ended / ongoing)
///
/// @dev    Off-chain indexers should subscribe to {HumancardAttestationCreated}
///         to build a (subject, claimType) → attestation index. EAS itself
///         doesn't provide subject-keyed queries on-chain.
contract HumancardAttestor {
    error EmptySubject();
    error EmptyClaimType();
    error InvalidValidityWindow();
    error NotOriginalAttestor();

    /// @dev IEAS at the canonical OP-stack predeploy on Base mainnet/Sepolia,
    ///      or whatever address is supplied for other chains.
    IEAS public immutable EAS;

    /// @dev UID returned by SchemaRegistry.register() for the schema above.
    bytes32 public immutable SCHEMA_UID;

    /// @notice EAS sees this contract as the attester since it makes the
    ///         attest call. We track the real humancard-level attestor here
    ///         so revocation can be authorized against the original signer
    ///         rather than against the wrapper contract itself.
    mapping(bytes32 uid => address humancardAttestor) public attestorOf;

    /// @notice Emitted on every successful humancard attestation so off-chain
    ///         indexers can hydrate (subject, attestor, uid) tuples without
    ///         re-fetching from EAS.
    /// @param subjectDidHash keccak256(subjectDid) — indexed for topic-filterable subscriptions.
    /// @param attestor msg.sender of the attest call.
    /// @param uid EAS attestation UID.
    /// @param claimType taxonomy bucket (not hashed; small enum-like values).
    /// @param subjectDid full DID URI (unhashed copy for readability).
    event HumancardAttestationCreated(
        bytes32 indexed subjectDidHash,
        address indexed attestor,
        bytes32 indexed uid,
        string claimType,
        string subjectDid
    );

    event HumancardAttestationRevoked(bytes32 indexed uid, address indexed attestor);

    constructor(IEAS eas, bytes32 schemaUid) {
        EAS = eas;
        SCHEMA_UID = schemaUid;
    }

    /// @notice Create a humancard attestation. Caller becomes the attestor on
    ///         EAS and can later revoke via {revoke}.
    /// @param subjectDid       full DID URI of the candidate being attested to.
    /// @param claimType        taxonomy bucket — see schema docs above.
    /// @param claimData        free-form claim payload.
    /// @param evidenceUri      IPFS/HTTPS pointer to supporting evidence.
    /// @param validFrom        unix ts the claim becomes valid.
    /// @param validUntil       unix ts the claim expires (0 = open-ended).
    /// @return uid             EAS attestation UID.
    function attest(
        string calldata subjectDid,
        string calldata claimType,
        string calldata claimData,
        string calldata evidenceUri,
        uint64 validFrom,
        uint64 validUntil
    ) external returns (bytes32 uid) {
        if (bytes(subjectDid).length == 0) revert EmptySubject();
        if (bytes(claimType).length == 0) revert EmptyClaimType();
        if (validUntil != 0 && validUntil < validFrom) revert InvalidValidityWindow();

        bytes memory data = abi.encode(
            subjectDid, claimType, claimData, evidenceUri, validFrom, validUntil
        );

        uid = EAS.attest(
            AttestationRequest({
                schema: SCHEMA_UID,
                data: AttestationRequestData({
                    recipient: address(0), // subject is identified by DID, not address
                    expirationTime: validUntil,
                    revocable: true,
                    refUID: bytes32(0),
                    data: data,
                    value: 0
                })
            })
        );

        attestorOf[uid] = msg.sender;

        emit HumancardAttestationCreated(
            keccak256(bytes(subjectDid)), msg.sender, uid, claimType, subjectDid
        );
    }

    /// @notice Revoke a previously created attestation. Only the address that
    ///         originally called {attest} may revoke; EAS sees this wrapper
    ///         contract as the attester and would otherwise let anyone do it.
    function revoke(bytes32 uid) external {
        if (attestorOf[uid] != msg.sender) revert NotOriginalAttestor();
        EAS.revoke(
            RevocationRequest({
                schema: SCHEMA_UID,
                data: RevocationRequestData({uid: uid, value: 0})
            })
        );
        emit HumancardAttestationRevoked(uid, msg.sender);
    }
}
