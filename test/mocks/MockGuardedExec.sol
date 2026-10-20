// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Execution} from "../../src/module/UnifiedFlashloanModule.sol";

interface IExecutorAccount {
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        returns (bytes[] memory returnData);
}

/**
 * @title MockGuardedExec
 * @notice Stand-in for GuardedExecModule: records each batch and, when `forward` is on, runs it on
 *         the calling account through executeFromExecutor. The real GuardedExec checks are
 *         exercised in UnifiedFlashloanModuleSafe7579Fork.t.sol.
 */
contract MockGuardedExec {
    bytes32 private constant _BATCH_EXEC_MODE =
        0x0100000000000000000000000000000000000000000000000000000000000000;

    bool public forward = true;
    uint256 public batchCount;
    address public lastAccount;
    bytes32 public lastBatchHash;

    function setForward(bool forward_) external {
        forward = forward_;
    }

    function executeGuardedBatch(Execution[] calldata executions) external {
        ++batchCount;
        lastAccount = msg.sender;
        lastBatchHash = keccak256(abi.encode(executions));
        if (forward) {
            IExecutorAccount(msg.sender).executeFromExecutor(_BATCH_EXEC_MODE, abi.encode(executions));
        }
    }
}
