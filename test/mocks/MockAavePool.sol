// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IERC20
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title IFlashLoanSimpleReceiver
 */
interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/**
 * @title MockAavePool
 * @author ZyFAI
 * @notice Mock Aave V3 Pool for testing flashLoanSimple functionality
 * @dev Simulates the behavior of Aave's flashLoanSimple:
 *      1. Transfers tokens to receiver
 *      2. Calls executeOperation callback on receiver
 *      3. Pulls back tokens + premium from receiver
 */
contract MockAavePool {
    /*//////////////////////////////////////////////////////////////
                               STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Flashloan premium in bps (e.g. 5 = 0.05%)
    uint128 public FLASHLOAN_PREMIUM_TOTAL = 5;

    /*//////////////////////////////////////////////////////////////
                               EVENTS
    //////////////////////////////////////////////////////////////*/

    event FlashLoan(
        address indexed receiver,
        address indexed asset,
        uint256 amount,
        uint256 premium,
        uint16 referralCode
    );

    /*//////////////////////////////////////////////////////////////
                               ERRORS
    //////////////////////////////////////////////////////////////*/

    error InsufficientRepayment();
    error CallbackFailed();

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Execute a simple flashloan (single asset)
     * @dev Mimics Aave V3 flashLoanSimple behavior:
     *      1. Transfer `amount` of `asset` to `receiverAddress`
     *      2. Call executeOperation callback on `receiverAddress`
     *      3. Pull back `amount + premium` from `receiverAddress`
     * @param receiverAddress Address that receives the funds and gets the callback
     * @param asset Token to flash borrow
     * @param amount Amount to borrow
     * @param params Arbitrary data to pass to callback
     * @param referralCode Referral code (unused in mock)
     */
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external {
        uint256 premium = (amount * FLASHLOAN_PREMIUM_TOTAL) / 10000;

        // In real Aave, msg.sender is the initiator (the address that called flashLoanSimple).
        // The receiver gets the callback with initiator set to this original caller.
        address initiator = msg.sender;

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));

        // 1. Transfer tokens to receiver
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IERC20(asset).transfer(receiverAddress, amount);

        emit FlashLoan(receiverAddress, asset, amount, premium, referralCode);

        // 2. Call the callback on the receiver
        bool success = IFlashLoanSimpleReceiver(receiverAddress).executeOperation(
            asset,
            amount,
            premium,
            initiator,
            params
        );
        if (!success) revert CallbackFailed();

        // 3. Pull back tokens + premium
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IERC20(asset).transferFrom(receiverAddress, address(this), amount + premium);

        // Verify repayment
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        if (balanceAfter < balanceBefore + premium) {
            revert InsufficientRepayment();
        }
    }

    /**
     * @notice Set the flashloan premium (for testing different fee scenarios)
     * @param premiumBps Premium in basis points
     */
    function setFlashloanPremium(uint128 premiumBps) external {
        FLASHLOAN_PREMIUM_TOTAL = premiumBps;
    }
}
