// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITargetRegistry} from "../../src/interfaces/ITargetRegistry.sol";

/**
 * @title MockTargetRegistry
 * @notice Mock implementation of ITargetRegistry for testing.
 * @dev Mirrors the storage layout of the audited TargetRegistry (target → selector → bool).
 *      In production, the real audited TargetRegistry contract is used.
 */
contract MockTargetRegistry is ITargetRegistry {
    mapping(address => mapping(bytes4 => bool)) public override whitelist;
    mapping(address => bool) public override whitelistedTargets;

    /**
     * @notice Add a target+selector to the whitelist
     * @param target Contract address to whitelist
     * @param selector Function selector to whitelist
     */
    function addToWhitelist(address target, bytes4 selector) external {
        whitelist[target][selector] = true;
        whitelistedTargets[target] = true;
    }

    /**
     * @notice Remove a target+selector from the whitelist
     * @param target Contract address to remove
     * @param selector Function selector to remove
     */
    function removeFromWhitelist(address target, bytes4 selector) external {
        whitelist[target][selector] = false;
    }
}
