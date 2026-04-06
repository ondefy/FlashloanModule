// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title Execution
 * @notice Struct representing a single execution in a batch
 */
struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

/**
 * @title MockSmartAccount
 * @notice Mock ERC-7579 smart account for testing
 * @dev Implements minimal interfaces needed for testing the flashloan module:
 *      - ERC-1271 signature validation
 *      - ERC-7579 executeFromExecutor
 *      - Fallback handling for module callbacks
 */
contract MockSmartAccount {
    using ECDSA for bytes32;

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    bytes4 internal constant ERC1271_INVALID = 0xffffffff;

    /*//////////////////////////////////////////////////////////////
                               STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Owner of this smart account (for signature validation)
    address public owner;

    /// @notice Installed executor modules
    mapping(address => bool) public isExecutor;

    /// @notice Installed fallback modules: selector => module address
    mapping(bytes4 => address) public fallbackHandlers;

    /*//////////////////////////////////////////////////////////////
                               EVENTS
    //////////////////////////////////////////////////////////////*/

    event ExecutorInstalled(address indexed module);
    event FallbackInstalled(bytes4 indexed selector, address indexed module);
    event Executed(address indexed target, uint256 value, bytes data, bool success);

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address _owner) {
        owner = _owner;
    }

    /*//////////////////////////////////////////////////////////////
                           RECEIVE ETH
    //////////////////////////////////////////////////////////////*/

    receive() external payable {}

    /*//////////////////////////////////////////////////////////////
                          MODULE MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Install a module as executor
     * @param module Module address to install
     */
    function installExecutor(address module) external {
        isExecutor[module] = true;
        emit ExecutorInstalled(module);
    }

    /**
     * @notice Install a module as fallback handler for a selector
     * @param selector Function selector to route
     * @param module Module address to handle the selector
     */
    function installFallback(bytes4 selector, address module) external {
        fallbackHandlers[selector] = module;
        emit FallbackInstalled(selector, module);
    }

    /*//////////////////////////////////////////////////////////////
                          ERC-7579 EXECUTION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Execute from an installed executor module
     * @dev Called by executor modules to perform operations on behalf of the account
     * @param mode Execution mode (batch, single, etc.)
     * @param executionCalldata Encoded execution data
     * @return returnData Array of return data from each execution
     */
    function executeFromExecutor(
        bytes32 mode,
        bytes calldata executionCalldata
    ) external returns (bytes[] memory returnData) {
        require(isExecutor[msg.sender], "not executor");

        // Decode based on mode - for simplicity, we handle batch mode
        // Mode 0x01... = CALLTYPE_BATCH
        // forge-lint: disable-next-line(unsafe-typecast)
        if (bytes1(mode) == 0x01) {
            Execution[] memory executions = abi.decode(executionCalldata, (Execution[]));
            returnData = new bytes[](executions.length);

            for (uint256 i = 0; i < executions.length; i++) {
                (bool success, bytes memory result) = executions[i].target.call{
                    value: executions[i].value
                }(executions[i].callData);

                emit Executed(executions[i].target, executions[i].value, executions[i].callData, success);

                if (!success) {
                    // Bubble up the revert reason
                    assembly {
                        revert(add(result, 32), mload(result))
                    }
                }
                returnData[i] = result;
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                          ERC-1271 SIGNATURE
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Validate a signature according to ERC-1271
     * @dev Validates that the signature was created by the owner
     * @param hash Hash that was signed
     * @param signature Signature bytes
     * @return magicValue ERC1271_MAGIC_VALUE if valid, ERC1271_INVALID otherwise
     */
    function isValidSignature(
        bytes32 hash,
        bytes memory signature
    ) external view returns (bytes4 magicValue) {
        address recovered = hash.recover(signature);
        if (recovered == owner) {
            return ERC1271_MAGIC_VALUE;
        }
        return ERC1271_INVALID;
    }

    /*//////////////////////////////////////////////////////////////
                             FALLBACK
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Fallback function that routes calls to installed fallback modules
     * @dev Extracts selector from calldata and forwards to the registered handler
     */
    fallback() external payable {
        bytes4 selector = bytes4(msg.data[:4]);
        address handler = fallbackHandlers[selector];

        if (handler != address(0)) {
            // Forward call to handler
            (bool success, bytes memory result) = handler.call(msg.data);

            if (!success) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }

            assembly {
                return(add(result, 32), mload(result))
            }
        }

        // No handler found - revert
        revert("no fallback handler");
    }
}
