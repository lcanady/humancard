// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {EAS} from "@eas/EAS.sol";
import {SchemaRegistry, ISchemaRegistry} from "@eas/SchemaRegistry.sol";
import {ISchemaResolver} from "@eas/resolver/ISchemaResolver.sol";
import {Attestation} from "@eas/Common.sol";
import {IEAS} from "@eas/IEAS.sol";

import {HumancardAttestor} from "../src/HumancardAttestor.sol";

contract HumancardAttestorTest is Test {
    string constant SCHEMA = "string subjectDid,string claimType,string claimData,string evidenceUri,uint64 validFrom,uint64 validUntil";

    SchemaRegistry registry;
    EAS eas;
    HumancardAttestor attestor;
    bytes32 schemaUid;

    address alice = makeAddr("alice"); // attestor (e.g. past employer)
    address bob = makeAddr("bob"); // arbitrary other party

    function setUp() public {
        registry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(registry)));
        schemaUid = registry.register(SCHEMA, ISchemaResolver(address(0)), true);
        attestor = new HumancardAttestor(IEAS(address(eas)), schemaUid);
    }

    function test_attest_emits_event_and_returns_uid() public {
        vm.prank(alice);
        bytes32 uid = attestor.attest(
            "did:wba:lcanady",
            "employment",
            "Lead Blockchain Developer at Gala Games, 2022-04 to 2024-12",
            "ipfs://QmEvidence",
            1648771200, // 2022-04
            1735603200 // 2024-12
        );

        Attestation memory a = eas.getAttestation(uid);
        // EAS sees the wrapper contract as the attester (it's the caller).
        // The real humancard attestor is tracked separately.
        assertEq(a.attester, address(attestor));
        assertEq(attestor.attestorOf(uid), alice);
        assertEq(a.schema, schemaUid);
        assertTrue(a.revocable);
        assertEq(a.recipient, address(0));
    }

    function test_attest_reverts_on_empty_subject() public {
        vm.prank(alice);
        vm.expectRevert(HumancardAttestor.EmptySubject.selector);
        attestor.attest("", "employment", "x", "ipfs://x", 0, 0);
    }

    function test_attest_reverts_on_empty_claim_type() public {
        vm.prank(alice);
        vm.expectRevert(HumancardAttestor.EmptyClaimType.selector);
        attestor.attest("did:wba:lcanady", "", "x", "ipfs://x", 0, 0);
    }

    function test_attest_reverts_on_inverted_validity_window() public {
        vm.prank(alice);
        vm.expectRevert(HumancardAttestor.InvalidValidityWindow.selector);
        attestor.attest("did:wba:lcanady", "employment", "x", "ipfs://x", 2000, 1000);
    }

    function test_attest_open_ended_validity_ok() public {
        vm.prank(alice);
        bytes32 uid = attestor.attest(
            "did:wba:lcanady", "employment", "Current role", "ipfs://x", 1700000000, 0
        );
        Attestation memory a = eas.getAttestation(uid);
        assertEq(a.expirationTime, 0);
    }

    function test_revoke_by_original_attestor() public {
        vm.prank(alice);
        bytes32 uid = attestor.attest(
            "did:wba:lcanady", "skill", "Solidity expert", "ipfs://x", 1700000000, 0
        );

        vm.prank(alice);
        attestor.revoke(uid);

        Attestation memory a = eas.getAttestation(uid);
        assertGt(a.revocationTime, 0);
    }

    function test_revoke_by_non_attestor_reverts() public {
        vm.prank(alice);
        bytes32 uid = attestor.attest(
            "did:wba:lcanady", "skill", "Solidity expert", "ipfs://x", 1700000000, 0
        );

        vm.prank(bob);
        vm.expectRevert(HumancardAttestor.NotOriginalAttestor.selector);
        attestor.revoke(uid);
    }

    function test_payload_round_trips_through_eas() public {
        string memory subject = "did:wba:lcanady";
        string memory claimType = "endorsement";
        string memory claimData = "Outstanding engineer";
        string memory evidenceUri = "https://example.com/letter.pdf";
        uint64 from = 1700000000;
        uint64 to = 1800000000;

        vm.prank(alice);
        bytes32 uid = attestor.attest(subject, claimType, claimData, evidenceUri, from, to);

        Attestation memory a = eas.getAttestation(uid);
        (
            string memory dSubject,
            string memory dClaimType,
            string memory dClaimData,
            string memory dEvidenceUri,
            uint64 dFrom,
            uint64 dTo
        ) = abi.decode(a.data, (string, string, string, string, uint64, uint64));

        assertEq(dSubject, subject);
        assertEq(dClaimType, claimType);
        assertEq(dClaimData, claimData);
        assertEq(dEvidenceUri, evidenceUri);
        assertEq(dFrom, from);
        assertEq(dTo, to);
    }
}
