// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TargetRegistry} from "../src/registry/TargetRegistry.sol";

/**
 * @title SetupWhitelist
 * @notice Whitelists all required target+selector pairs in TargetRegistry
 *
 * Required .env:
 *   PRIVATE_KEY              - registry owner private key
 *   TARGET_REGISTRY_ADDRESS  - deployed TargetRegistry
 *   UNIFIED_MODULE_ADDRESS   - deployed module proxy
 */
contract SetupWhitelistScript is Script {
    // Base mainnet addresses
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address registryAddr = vm.envAddress("TARGET_REGISTRY_ADDRESS");
        address moduleAddr = vm.envAddress("UNIFIED_MODULE_ADDRESS");

        TargetRegistry registry = TargetRegistry(registryAddr);

        console2.log("Registry:", registryAddr);
        console2.log("Module:", moduleAddr);
        console2.log("");

        // Build target+selector arrays
        address[] memory targets = new address[](9);
        bytes4[] memory selectors = new bytes4[](9);

        // ERC20.approve on USDC and WETH
        targets[0] = USDC;
        selectors[0] = bytes4(keccak256("approve(address,uint256)"));

        targets[1] = WETH;
        selectors[1] = bytes4(keccak256("approve(address,uint256)"));

        // Aave V3 operations
        targets[2] = AAVE_V3_POOL;
        selectors[2] = bytes4(keccak256("supply(address,uint256,address,uint16)"));

        targets[3] = AAVE_V3_POOL;
        selectors[3] = bytes4(keccak256("borrow(address,uint256,uint256,uint16,address)"));

        targets[4] = AAVE_V3_POOL;
        selectors[4] = bytes4(keccak256("repay(address,uint256,uint256,address)"));

        targets[5] = AAVE_V3_POOL;
        selectors[5] = bytes4(keccak256("withdraw(address,uint256,address)"));

        // Morpho Blue operations
        targets[6] = MORPHO_BLUE;
        selectors[6] = bytes4(keccak256("supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)"));

        targets[7] = MORPHO_BLUE;
        selectors[7] = bytes4(keccak256("borrow((address,address,address,address,uint256),uint256,uint256,address,address)"));

        // Module entry point (for GuardedExecModule -> Module chain)
        targets[8] = moduleAddr;
        selectors[8] = bytes4(keccak256("initiateFlashloan(uint8,address,uint256,(address,uint256,bytes)[])"));

        vm.startBroadcast(deployerPk);

        registry.addToWhitelist(targets, selectors);

        vm.stopBroadcast();

        // Verify
        console2.log("=== Whitelisted Selectors ===");
        for (uint256 i = 0; i < targets.length; i++) {
            bool ok = registry.whitelist(targets[i], selectors[i]);
            console2.log(i, ": target=", targets[i], ok ? "OK" : "FAILED");
        }
        console2.log("");
        console2.log("Whitelist setup complete!");
    }
}
