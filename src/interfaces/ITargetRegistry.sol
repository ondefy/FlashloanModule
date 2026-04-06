// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ITargetRegistry
 * @author ZyFAI
 * @notice Interface for the audited TargetRegistry contract.
 * @dev Used by UnifiedFlashloanModule to validate executions against a whitelist
 *      of allowed target+selector combinations. The underlying TargetRegistry contract
 *      (zyfai-executor-module/src/registry/TargetRegistry.sol) is already audited.
 */
interface ITargetRegistry {
    /// @notice Check if a target+selector combination is whitelisted
    /// @param target The contract address to check
    /// @param selector The function selector to check
    /// @return True if the target+selector is whitelisted
    function whitelist(address target, bytes4 selector) external view returns (bool);

    /// @notice Check if a target address has any whitelisted selector
    /// @param target The contract address to check
    /// @return True if the target has at least one whitelisted selector
    function whitelistedTargets(address target) external view returns (bool);
}
