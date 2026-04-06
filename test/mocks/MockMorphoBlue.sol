// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IERC20
 * @notice Minimal ERC20 interface
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title IMorphoFlashLoanCallback
 * @notice Morpho Blue flashloan callback interface
 */
interface IMorphoFlashLoanCallback {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

/**
 * @title MockMorphoBlue
 * @author ZyFAI
 * @notice Mock Morpho Blue contract for testing flashloan functionality
 * @dev Simulates the behavior of Morpho Blue's flashLoan function:
 *      1. Transfers tokens to borrower
 *      2. Calls onMorphoFlashLoan callback
 *      3. Pulls back tokens (borrower must have approved)
 */
contract MockMorphoBlue {
    /*//////////////////////////////////////////////////////////////
                               EVENTS
    //////////////////////////////////////////////////////////////*/

    event FlashLoan(address indexed caller, address indexed token, uint256 assets, bytes data);

    event FlashLoanRepaid(address indexed caller, address indexed token, uint256 assets);

    /*//////////////////////////////////////////////////////////////
                               ERRORS
    //////////////////////////////////////////////////////////////*/

    error InsufficientRepayment();

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Execute a flashloan
     * @dev Mimics Morpho Blue behavior:
     *      1. Transfer `assets` of `token` to msg.sender
     *      2. Call onMorphoFlashLoan callback on msg.sender
     *      3. Pull back `assets` from msg.sender (requires approval)
     * @param token Token to flash borrow
     * @param assets Amount to borrow
     * @param data Arbitrary data to pass to callback
     */
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        // Get token balance before
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));

        // 1. Transfer tokens to borrower (msg.sender is the smart account or module)
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IERC20(token).transfer(msg.sender, assets);

        emit FlashLoan(msg.sender, token, assets, data);

        // 2. Call the callback on the borrower
        // The borrower MUST implement onMorphoFlashLoan and approve this contract
        IMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(assets, data);

        // 3. Pull back the tokens (borrower must have approved this contract)
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IERC20(token).transferFrom(msg.sender, address(this), assets);

        // Verify repayment (at minimum the same amount)
        uint256 balanceAfter = IERC20(token).balanceOf(address(this));
        if (balanceAfter < balanceBefore) {
            revert InsufficientRepayment();
        }

        emit FlashLoanRepaid(msg.sender, token, assets);
    }

    /**
     * @notice Fund the mock with tokens for flashloans
     * @dev Used in tests to provide liquidity
     * @param token Token to fund
     * @param amount Amount to fund
     */
    function fund(address token, uint256 amount) external {
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IERC20(token).transferFrom(msg.sender, address(this), amount);
    }
}
