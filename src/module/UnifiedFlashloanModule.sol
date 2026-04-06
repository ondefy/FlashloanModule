// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ITargetRegistry} from "../interfaces/ITargetRegistry.sol";

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
 * @dev Security relies on TargetRegistry whitelist validation of every execution's
 *      target+selector. The module is called via GuardedExecModule (session key authorized),
 *      providing defense-in-depth through the SmartSessions + TargetRegistry chain.
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
        address registry;
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

    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /*//////////////////////////////////////////////////////////////
                               ERRORS
    //////////////////////////////////////////////////////////////*/

    error UnauthorizedCaller();
    error InvalidExecutionsLength();
    error UnsupportedProvider();
    error InvalidProvider();
    error TargetSelectorNotWhitelisted(address target, bytes4 selector);
    error InvalidCalldata();
    error RegistryNotSet();
    error ZeroFlashloanAmount();

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
     * @notice Initialize the module with owner, provider addresses, and registry
     * @param initialOwner  Module owner (can pause, upgrade, set providers)
     * @param morphoBlue_   Morpho Blue contract address
     * @param aavePool_     Aave V3 Pool contract address
     * @param registry_     TargetRegistry address for whitelist validation
     */
    function initialize(
        address initialOwner,
        address morphoBlue_,
        address aavePool_,
        address registry_
    ) external initializer {
        if (initialOwner == address(0)) revert OwnableInvalidOwner(address(0));
        if (morphoBlue_ == address(0)) revert InvalidProvider();
        if (aavePool_ == address(0)) revert InvalidProvider();

        _transferOwnership(initialOwner);

        ModuleStorage storage s = _getModuleStorage();
        s.morphoBlue = morphoBlue_;
        s.aavePool = aavePool_;
        s.registry = registry_;

        emit ProviderUpdated(FlashloanProvider.MORPHO, morphoBlue_);
        emit ProviderUpdated(FlashloanProvider.AAVE, aavePool_);
        if (registry_ != address(0)) {
            emit RegistryUpdated(address(0), registry_);
        }
    }

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function name() external pure returns (string memory) {
        return "UnifiedFlashloanModule";
    }

    function version() external pure returns (string memory) {
        return "4.0.0";
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

    /**
     * @notice Get the registry contract address
     * @return The TargetRegistry address
     */
    function registry() external view returns (address) {
        return _getModuleStorage().registry;
    }

    /**
     * @notice Update the TargetRegistry address for whitelist validation
     * @param registry_ New TargetRegistry contract address
     */
    function setRegistry(address registry_) external onlyOwner {
        ModuleStorage storage s = _getModuleStorage();
        address oldRegistry = s.registry;
        s.registry = registry_;
        emit RegistryUpdated(oldRegistry, registry_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Initiate a flashloan from any supported provider
     * @dev Security: TargetRegistry validates every execution's target+selector in the callback.
     *      The caller (smart account) must be authorized via the session key + GuardedExecModule chain.
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

        emit FlashloanInitiated(account, provider, token, amount, executions.length);

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
    }

    /**
     * @notice Morpho Blue flashloan callback
     * @dev Only callable by the Morpho Blue contract. Morpho has 0% fee.
     */
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external override {
        address morpho = _getModuleStorage().morphoBlue;
        if (msg.sender != morpho) revert UnauthorizedCaller();

        (, address token,) = abi.decode(data, (address, address, Execution[]));

        _handleFlashloanCallback(FlashloanProvider.MORPHO, assets, assets, data);

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
     * @notice Shared callback logic: validate executions, execute operations, pull back tokens
     * @param assets      Flashloaned amount
     * @param repayAmount Amount to pull back (assets for Morpho, assets + premium for Aave)
     * @param data        Encoded (account, token, executions)
     */
    function _handleFlashloanCallback(
        FlashloanProvider provider,
        uint256 assets,
        uint256 repayAmount,
        bytes calldata data
    ) private {
        (address account, address token, Execution[] memory executions) =
            abi.decode(data, (address, address, Execution[]));

        // Validate executions against whitelist
        _validateExecutions(executions);

        IERC20(token).safeTransfer(account, assets);

        _executeOnAccount(account, executions);

        Execution[] memory pullBack = new Execution[](1);
        pullBack[0] = Execution({
            target: token,
            value: 0,
            callData: abi.encodeWithSelector(IERC20.transfer.selector, address(this), repayAmount)
        });
        _executeOnAccount(account, pullBack);

        emit FlashloanCallbackExecuted(
            account, provider, token, assets, executions.length
        );
    }

    /**
     * @notice Validate each execution against the TargetRegistry whitelist
     * @dev Reverts if no registry is set. Every execution's target+selector must be whitelisted.
     * @param executions The operations to validate
     */
    function _validateExecutions(Execution[] memory executions) private view {
        address reg = _getModuleStorage().registry;
        if (reg == address(0)) revert RegistryNotSet();

        uint256 length = executions.length;
        for (uint256 i = 0; i < length;) {
            bytes memory callData = executions[i].callData;
            if (callData.length < 4) revert InvalidCalldata();

            bytes4 selector;
            assembly {
                selector := mload(add(callData, 32))
            }

            if (!ITargetRegistry(reg).whitelist(executions[i].target, selector)) {
                revert TargetSelectorNotWhitelisted(executions[i].target, selector);
            }

            unchecked { ++i; }
        }
    }

    function _executeOnAccount(address account, Execution[] memory executions) private {
        IERC7579Account(account).executeFromExecutor(
            _BATCH_EXEC_MODE,
            abi.encode(executions)
        );
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
