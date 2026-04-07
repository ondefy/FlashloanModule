// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UnifiedFlashloanModule} from "../src/module/UnifiedFlashloanModule.sol";
import {TargetRegistry} from "../src/registry/TargetRegistry.sol";

/**
 * @title Deploy
 * @notice Deploys TargetRegistry + UnifiedFlashloanModule (implementation + UUPS proxy)
 *
 * Required .env:
 *   PRIVATE_KEY       - deployer private key
 *   BASESCAN_API_KEY  - for verification
 *
 * Base mainnet addresses:
 *   Morpho Blue: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
 *   Aave V3:     0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
 */
contract DeployScript is Script {
    // Base mainnet
    address constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;

    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        console2.log("Deployer:", deployer);
        console2.log("Chain ID:", block.chainid);
        console2.log("");

        vm.startBroadcast(deployerPk);

        // ─── 1. Deploy TargetRegistry ─────────────────────────────────
        TargetRegistry registry = new TargetRegistry(deployer);
        console2.log("TargetRegistry deployed:", address(registry));

        // ─── 2. Deploy UnifiedFlashloanModule implementation ──────────
        UnifiedFlashloanModule implementation = new UnifiedFlashloanModule();
        console2.log("Module implementation:", address(implementation));

        // ─── 3. Deploy UUPS Proxy ─────────────────────────────────────
        bytes memory initData = abi.encodeCall(
            UnifiedFlashloanModule.initialize,
            (deployer, MORPHO_BLUE, AAVE_V3_POOL, address(registry))
        );

        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        console2.log("Module proxy:", address(proxy));

        // ─── 4. Verify initialization ─────────────────────────────────
        UnifiedFlashloanModule module = UnifiedFlashloanModule(address(proxy));
        console2.log("");
        console2.log("=== Verification ===");
        console2.log("Owner:", module.owner());
        console2.log("Morpho Blue:", module.morphoBlue());
        console2.log("Aave Pool:", module.aavePool());
        console2.log("Registry:", module.registry());
        console2.log("Name:", module.name());
        console2.log("Version:", module.version());

        vm.stopBroadcast();

        // ─── 5. Print summary ─────────────────────────────────────────
        console2.log("");
        console2.log("========================================");
        console2.log("  DEPLOYMENT COMPLETE");
        console2.log("========================================");
        console2.log("  TargetRegistry:      ", address(registry));
        console2.log("  Module Implementation:", address(implementation));
        console2.log("  Module Proxy:         ", address(proxy));
        console2.log("========================================");
        console2.log("");
        console2.log("Add to .env:");
        console2.log("  UNIFIED_MODULE_ADDRESS=", address(proxy));
        console2.log("  TARGET_REGISTRY_ADDRESS=", address(registry));
    }
}

