// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {ISchemaRegistry} from "@eas/ISchemaRegistry.sol";
import {ISchemaResolver} from "@eas/resolver/ISchemaResolver.sol";
import {IEAS} from "@eas/IEAS.sol";

import {HumancardAttestor} from "../src/HumancardAttestor.sol";

/// @title DeployAttestor
/// @notice Two-phase deploy for the humancard attestation layer:
///         1. register the humancard schema in EAS's SchemaRegistry
///            (idempotent — repeated registrations of the same schema
///            string return the existing UID).
///         2. deploy HumancardAttestor wired to that schema UID.
///
///         EAS + SchemaRegistry addresses default to the Base / Base-Sepolia
///         predeploys but can be overridden via env for any EVM chain.
contract DeployAttestor is Script {
    /// Canonical Base / Base-Sepolia predeploy addresses (per the EAS team's
    /// official deployments under lib/eas-contracts/deployments/base-sepolia).
    address constant BASE_EAS = 0x4200000000000000000000000000000000000021;
    address constant BASE_SCHEMA_REGISTRY = 0x4200000000000000000000000000000000000020;

    string constant HUMANCARD_SCHEMA =
        "string subjectDid,string claimType,string claimData,string evidenceUri,uint64 validFrom,uint64 validUntil";

    function run() external returns (HumancardAttestor attestor, bytes32 schemaUid) {
        address easAddr = _envOr("EAS_ADDRESS", BASE_EAS);
        address registryAddr = _envOr("SCHEMA_REGISTRY_ADDRESS", BASE_SCHEMA_REGISTRY);

        console.log("EAS:            ", easAddr);
        console.log("SchemaRegistry: ", registryAddr);

        vm.startBroadcast();

        schemaUid = ISchemaRegistry(registryAddr).register(
            HUMANCARD_SCHEMA, ISchemaResolver(address(0)), true
        );
        console.log("Schema UID:");
        console.logBytes32(schemaUid);

        attestor = new HumancardAttestor(IEAS(easAddr), schemaUid);
        console.log("HumancardAttestor:", address(attestor));

        vm.stopBroadcast();
    }

    function _envOr(string memory key, address fallbackAddr) internal view returns (address) {
        try vm.envAddress(key) returns (address v) {
            return v;
        } catch {
            return fallbackAddr;
        }
    }
}
