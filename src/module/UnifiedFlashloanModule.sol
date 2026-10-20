// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

interface IMorphoBlue {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IMorphoFlashLoanCallback {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

interface IERC7579Account {
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        returns (bytes[] memory returnData);
}

struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

interface IGuardedExecModule {
    function executeGuardedBatch(Execution[] calldata executions) external;
}

enum FlashloanProvider {
    MORPHO,
    AAVE
}

/**
 * @title UnifiedFlashloanModule
 * @author ZyFAI
 * @notice ERC-7579 executor module that enables smart accounts to initiate flashloans
 *         from multiple providers (Morpho Blue, Aave V3) via a single entry point.
 *         Uses UUPS upgradeable pattern with ERC-7201 namespaced storage.
 * @dev The module never runs caller-supplied executions on the account directly. Inside the
 *      flashloan callback it has the account call `GuardedExecModule.executeGuardedBatch`, so
 *      every inner execution passes the same checks as any session-key batch (target+selector
 *      whitelist, ERC20 transfer recipient, approve spender, and whatever else that GuardedExec
 *      version enforces). The account must have both this module and `guardedExec` installed as
 *      executors. The only call the module makes on the account itself is the repayment
 *      `token.transfer(address(this), repayAmount)`.
 */
contract UnifiedFlashloanModule is
    Initializable,
    UUPSUpgradeable,
    Ownable2Step,
    Pausable,
    ReentrancyGuardTransient,
    IMorphoFlashLoanCallback,
    IFlashLoanSimpleReceiver
{
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    bytes32 private constant _BATCH_EXEC_MODE =
        0x0100000000000000000000000000000000000000000000000000000000000000;

    /*//////////////////////////////////////////////////////////////
                               STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @custom:storage-location erc7201:zyfai.storage.UnifiedFlashloanModule
    struct ModuleStorage {
        address morphoBlue;
        address aavePool;
        /// @dev Deprecated since 5.0.0 (was the module's own TargetRegistry). Kept for layout.
        address registry;
        address guardedExec;
    }

    // keccak256(abi.encode(uint256(keccak256("zyfai.storage.UnifiedFlashloanModule")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant _MODULE_STORAGE_LOCATION =
        0x1326f637c5886074b57d190b4306fa412074c3e410bb749e6117119d5f42dd00;

    function _getModuleStorage() private pure returns (ModuleStorage storage s) {
        bytes32 position = _MODULE_STORAGE_LOCATION;
        assembly {
            s.slot := position
        }
    }

    /*//////////////////////////////////////////////////////////////
                               EVENTS
    //////////////////////////////////////////////////////////////*/

    event FlashloanInitiated(
        address indexed account,
        FlashloanProvider indexed provider,
        address indexed token,
        uint256 amount,
        uint256 executionsCount
    );

    event FlashloanCallbackExecuted(
        address indexed account,
        FlashloanProvider indexed provider,
        address indexed token,
        uint256 amount,
        uint256 executionsCount
    );

    event ProviderUpdated(FlashloanProvider indexed provider, address indexed newAddress);

    event GuardedExecUpdated(address indexed oldGuardedExec, address indexed newGuardedExec);

    /*//////////////////////////////////////////////////////////////
                               ERRORS
    //////////////////////////////////////////////////////////////*/

    error UnauthorizedCaller();
    error InvalidExecutionsLength();
    error UnsupportedProvider();
    error InvalidProvider();
    error InvalidGuardedExec();
    error GuardedExecNotSet();
    error ZeroFlashloanAmount();
    error RepaymentShortfall();

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() Ownable(msg.sender) {
        _disableInitializers();
    }

    /*//////////////////////////////////////////////////////////////
                             INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initialize the module with owner, provider addresses, and GuardedExecModule
     * @param initialOwner  Module owner (can pause, upgrade, set providers)
     * @param morphoBlue_   Morpho Blue contract address
     * @param aavePool_     Aave V3 Pool contract address
     * @param guardedExec_  GuardedExecModule that validates and runs the callback executions
     */
    function initialize(
        address initialOwner,
        address morphoBlue_,
        address aavePool_,
        address guardedExec_
    ) external initializer {
        if (initialOwner == address(0)) revert OwnableInvalidOwner(address(0));
        if (morphoBlue_ == address(0)) revert InvalidProvider();
        if (aavePool_ == address(0)) revert InvalidProvider();
        if (guardedExec_ == address(0)) revert InvalidGuardedExec();

        _transferOwnership(initialOwner);

        ModuleStorage storage s = _getModuleStorage();
        s.morphoBlue = morphoBlue_;
        s.aavePool = aavePool_;
        s.guardedExec = guardedExec_;

        emit ProviderUpdated(FlashloanProvider.MORPHO, morphoBlue_);
        emit ProviderUpdated(FlashloanProvider.AAVE, aavePool_);
        emit GuardedExecUpdated(address(0), guardedExec_);
    }

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function name() external pure returns (string memory) {
        return "UnifiedFlashloanModule";
    }

    function version() external pure returns (string memory) {
        return "5.0.0";
    }

    function isModuleType(uint256 typeId) external pure returns (bool) {
        return typeId == 2;
    }

    function isInitialized(address) external pure returns (bool) {
        return true;
    }

    function onInstall(bytes calldata) external {}

    function onUninstall(bytes calldata) external {}

    function morphoBlue() external view returns (address) {
        return _getModuleStorage().morphoBlue;
    }

    function aavePool() external view returns (address) {
        return _getModuleStorage().aavePool;
    }

    /**
     * @notice Update the Morpho Blue provider address
     * @param morphoBlue_ New Morpho Blue contract address
     */
    function setMorphoBlue(address morphoBlue_) external onlyOwner {
        if (morphoBlue_ == address(0)) revert InvalidProvider();
        _getModuleStorage().morphoBlue = morphoBlue_;
        emit ProviderUpdated(FlashloanProvider.MORPHO, morphoBlue_);
    }

    /**
     * @notice Update the Aave V3 Pool provider address
     * @param aavePool_ New Aave V3 Pool contract address
     */
    function setAavePool(address aavePool_) external onlyOwner {
        if (aavePool_ == address(0)) revert InvalidProvider();
        _getModuleStorage().aavePool = aavePool_;
        emit ProviderUpdated(FlashloanProvider.AAVE, aavePool_);
    }

    function guardedExec() external view returns (address) {
        return _getModuleStorage().guardedExec;
    }

    /**
     * @notice Update the GuardedExecModule that validates and runs the callback executions
     * @dev Must be a GuardedExecModule installed as an executor on every account using this module.
     * @param guardedExec_ New GuardedExecModule address
     */
    function setGuardedExec(address guardedExec_) external onlyOwner {
        if (guardedExec_ == address(0)) revert InvalidGuardedExec();
        ModuleStorage storage s = _getModuleStorage();
        address oldGuardedExec = s.guardedExec;
        s.guardedExec = guardedExec_;
        emit GuardedExecUpdated(oldGuardedExec, guardedExec_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Initiate a flashloan from any supported provider
     * @dev The caller is the account. `executions` run inside the callback through
     *      `GuardedExecModule.executeGuardedBatch` on that account, never directly.
     * @param provider   Flashloan provider (MORPHO or AAVE)
     * @param token      Token to borrow
     * @param amount     Amount to borrow
     * @param executions Operations to run inside the flashloan callback
     */
    function initiateFlashloan(
        FlashloanProvider provider,
        address token,
        uint256 amount,
        Execution[] calldata executions
    ) external whenNotPaused nonReentrant {
        if (executions.length == 0) revert InvalidExecutionsLength();
        if (amount == 0) revert ZeroFlashloanAmount();

        address account = msg.sender;
        bytes memory data = abi.encode(account, token, executions);

        if (provider == FlashloanProvider.MORPHO) {
            IMorphoBlue(_getModuleStorage().morphoBlue).flashLoan(token, amount, data);
        } else if (provider == FlashloanProvider.AAVE) {
            IAavePool(_getModuleStorage().aavePool).flashLoanSimple(
                address(this), token, amount, data, 0
            );
        } else {
            revert UnsupportedProvider();
        }

        emit FlashloanInitiated(account, provider, token, amount, executions.length);
    }

    /**
     * @notice Morpho Blue flashloan callback
     * @dev Only callable by the Morpho Blue contract. Morpho has 0% fee.
     */
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external override {
        address morpho = _getModuleStorage().morphoBlue;
        if (msg.sender != morpho) revert UnauthorizedCaller();

        address token = _handleFlashloanCallback(FlashloanProvider.MORPHO, assets, assets, data);

        IERC20(token).forceApprove(morpho, assets);
    }

    /**
     * @notice Aave V3 flashloan callback
     * @dev Only callable by the Aave Pool contract. Repays amount + premium.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        address pool = _getModuleStorage().aavePool;
        if (msg.sender != pool) revert UnauthorizedCaller();
        if (initiator != address(this)) revert UnauthorizedCaller();

        uint256 repayAmount = amount + premium;
        _handleFlashloanCallback(FlashloanProvider.AAVE, amount, repayAmount, params);

        IERC20(asset).forceApprove(pool, repayAmount);
        return true;
    }

    /*//////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Shared callback logic: send tokens to the account, run the executions through
     *         GuardedExec on the account, pull back tokens
     * @param assets      Flashloaned amount
     * @param repayAmount Amount to pull back (assets for Morpho, assets + premium for Aave)
     * @param data        Encoded (account, token, executions)
     */
    function _handleFlashloanCallback(
        FlashloanProvider provider,
        uint256 assets,
        uint256 repayAmount,
        bytes calldata data
    ) private returns (address token) {
        address guardedExec_ = _getModuleStorage().guardedExec;
        if (guardedExec_ == address(0)) revert GuardedExecNotSet();

        address account;
        Execution[] memory executions;
        (account, token, executions) = abi.decode(data, (address, address, Execution[]));

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));

        IERC20(token).safeTransfer(account, assets);

        Execution[] memory guarded = new Execution[](1);
        guarded[0] = Execution({
            target: guardedExec_,
            value: 0,
            callData: abi.encodeCall(IGuardedExecModule.executeGuardedBatch, (executions))
        });
        _executeOnAccount(account, guarded);

        Execution[] memory pullBack = new Execution[](1);
        pullBack[0] = Execution({
            target: token,
            value: 0,
            callData: abi.encodeWithSelector(IERC20.transfer.selector, address(this), repayAmount)
        });
        _executeOnAccount(account, pullBack);

        // Defensive: catch silent-fail / fee-on-transfer tokens. Checked subtraction reverts
        // if balanceAfter < balanceBefore (silent fail), otherwise asserts received >= premium.
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (received < repayAmount - assets) revert RepaymentShortfall();

        emit FlashloanCallbackExecuted(
            account, provider, token, assets, executions.length
        );
    }

    function _executeOnAccount(address account, Execution[] memory executions) private {
        IERC7579Account(account).executeFromExecutor(
            _BATCH_EXEC_MODE,
            abi.encode(executions)
        );
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
