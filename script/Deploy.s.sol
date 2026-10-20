// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UnifiedFlashloanModule} from "../src/module/UnifiedFlashloanModule.sol";

/**
 * @title Deploy
 * @notice Deploys UnifiedFlashloanModule (implementation + UUPS proxy)
 *
 * Required .env:
 *   PRIVATE_KEY       - deployer private key
 *   BASESCAN_API_KEY  - for verification
 *
 * Base mainnet addresses:
 *   Morpho Blue:       0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
 *   Aave V3:           0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
 *   GuardedExecModule: 0xF659d30D4EB88B06A909F20839D8959Bd77d8790 (Zyfai prod)
 */
contract DeployScript is Script {
    // Base mainnet
    address constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant GUARDED_EXEC = 0xF659d30D4EB88B06A909F20839D8959Bd77d8790;

    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        console2.log("Deployer:", deployer);
        console2.log("Chain ID:", block.chainid);
        console2.log("");

        vm.startBroadcast(deployerPk);

        // ─── 1. Deploy UnifiedFlashloanModule implementation ──────────
        UnifiedFlashloanModule implementation = new UnifiedFlashloanModule();
        console2.log("Module implementation:", address(implementation));

        // ─── 2. Deploy UUPS Proxy ─────────────────────────────────────
        bytes memory initData = abi.encodeCall(
            UnifiedFlashloanModule.initialize,
            (deployer, MORPHO_BLUE, AAVE_V3_POOL, GUARDED_EXEC)
        );

        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        console2.log("Module proxy:", address(proxy));

        // ─── 3. Verify initialization ─────────────────────────────────
        UnifiedFlashloanModule module = UnifiedFlashloanModule(address(proxy));
        console2.log("");
        console2.log("=== Verification ===");
        console2.log("Owner:", module.owner());
        console2.log("Morpho Blue:", module.morphoBlue());
        console2.log("Aave Pool:", module.aavePool());
        console2.log("GuardedExec:", module.guardedExec());
        console2.log("Name:", module.name());
        console2.log("Version:", module.version());

        vm.stopBroadcast();

        // ─── 4. Print summary ─────────────────────────────────────────
        console2.log("");
        console2.log("========================================");
        console2.log("  DEPLOYMENT COMPLETE");
        console2.log("========================================");
        console2.log("  Module Implementation:", address(implementation));
        console2.log("  Module Proxy:         ", address(proxy));
        console2.log("========================================");
        console2.log("");
        console2.log("Add to .env:");
        console2.log("  UNIFIED_MODULE_ADDRESS=", address(proxy));
    }
}
