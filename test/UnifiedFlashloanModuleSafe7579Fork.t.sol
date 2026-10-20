// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {
    UnifiedFlashloanModule,
    Execution,
    FlashloanProvider
} from "../src/module/UnifiedFlashloanModule.sol";

interface IGuardedExecModule {
    error TargetSelectorNotWhitelisted(address target, bytes4 selector);
    error UnauthorizedERC20Transfer(address token, address to);
    error UnauthorizedERC20Approve(address token, address spender);

    function executeGuardedBatch(Execution[] calldata executions) external;
    function registry() external view returns (address);
}

interface ITargetRegistryAdmin {
    function owner() external view returns (address);
    function whitelist(address target, bytes4 selector) external view returns (bool);
    function addToWhitelist(address[] calldata targets, bytes4[] calldata selectors) external;
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function enableModule(address module) external;
}

struct ModuleInit {
    address module;
    bytes initData;
}

struct RegistryInit {
    address registry;
    address[] attesters;
    uint8 threshold;
}

interface ISafe7579 {
    error ExecutionFailed();

    function initializeAccount(
        ModuleInit[] calldata validators,
        ModuleInit[] calldata executors,
        ModuleInit[] calldata fallbacks,
        ModuleInit[] calldata hooks,
        RegistryInit calldata registryInit
    ) external;
    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata additionalContext)
        external
        view
        returns (bool);
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
}

interface IAdapter {
    function supplyForSelf(address pool, address asset, uint256 amount) external;
    function withdrawForSelf(address pool, address asset, uint256 amount) external returns (uint256);
}

interface IAaveV3Pool {
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/**
 * @title UnifiedFlashloanModuleSafe7579ForkTest
 * @notice Base fork test: a real Safe (SafeL2 1.4.1 + Safe7579 adapter) with the prod
 *         GuardedExecModule and a fresh v5 UnifiedFlashloanModule installed as executors.
 *         Calls enter the account the way a session-key UserOp does after validation:
 *         EntryPoint -> Safe7579.execute -> GuardedExec.executeGuardedBatch -> initiateFlashloan.
 *
 * Run with:
 *   forge test --match-contract UnifiedFlashloanModuleSafe7579ForkTest -vv
 *   (optionally set BASE_RPC_URL env variable for a custom RPC)
 */
contract UnifiedFlashloanModuleSafe7579ForkTest is Test {
    address constant GUARDED_EXEC = 0xF659d30D4EB88B06A909F20839D8959Bd77d8790;
    address constant ADAPTER = 0xaffD3c3cD06cf499deddf78b26868018A93f2C31;
    address constant SAFE7579 = 0x7579EE8307284F293B1927136486880611F20002;
    address constant SAFE_SINGLETON_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762; // v1.4.1
    address constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67; // v1.4.1
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032; // v0.7

    address constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant A_USDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    address constant WETH = 0x4200000000000000000000000000000000000006;

    uint256 constant MODULE_TYPE_EXECUTOR = 2;
    bytes32 constant SINGLE_EXEC_MODE = bytes32(0);
    uint256 constant FLASH_AMOUNT = 1_000e6;

    UnifiedFlashloanModule public module;
    address public safe;
    address public attacker;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        attacker = makeAddr("attacker");

        UnifiedFlashloanModule implementation = new UnifiedFlashloanModule();
        module = UnifiedFlashloanModule(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(
                        UnifiedFlashloanModule.initialize,
                        (makeAddr("ModuleOwner"), MORPHO_BLUE, AAVE_POOL, GUARDED_EXEC)
                    )
                )
            )
        );

        safe = _deploySafe7579(makeAddr("SafeOwner"));
        assertTrue(ISafe7579(safe).isModuleInstalled(MODULE_TYPE_EXECUTOR, GUARDED_EXEC, ""));
        assertTrue(ISafe7579(safe).isModuleInstalled(MODULE_TYPE_EXECUTOR, address(module), ""));

        // The prod registry already lists USDC/aUSDC approve, USDC transfer and the Adapter's
        // supplyForSelf/withdrawForSelf. The new module's entry point is the only missing pair.
        ITargetRegistryAdmin registry = ITargetRegistryAdmin(IGuardedExecModule(GUARDED_EXEC).registry());
        address[] memory targets = new address[](1);
        bytes4[] memory selectors = new bytes4[](1);
        (targets[0], selectors[0]) = (address(module), UnifiedFlashloanModule.initiateFlashloan.selector);
        vm.prank(registry.owner());
        registry.addToWhitelist(targets, selectors);
    }

    /// @notice Nested executor calls work and a flashloan round trip through the Adapter repays
    function test_Fork_FlashloanRoundTripThroughGuardedExecAndAdapter() public {
        // Aave rounds the aToken balance down by up to 1 wei; the buffer covers that shortfall.
        deal(USDC, safe, 1e6);
        uint256 morphoBefore = IERC20(USDC).balanceOf(MORPHO_BLUE);
        uint256 safeBefore = IERC20(USDC).balanceOf(safe);

        Execution[] memory inner = new Execution[](4);
        inner[0] = _exec(USDC, abi.encodeCall(IERC20.approve, (ADAPTER, FLASH_AMOUNT)));
        inner[1] = _exec(ADAPTER, abi.encodeCall(IAdapter.supplyForSelf, (AAVE_POOL, USDC, FLASH_AMOUNT)));
        inner[2] = _exec(A_USDC, abi.encodeCall(IERC20.approve, (ADAPTER, FLASH_AMOUNT - 1)));
        inner[3] = _exec(ADAPTER, abi.encodeCall(IAdapter.withdrawForSelf, (AAVE_POOL, USDC, FLASH_AMOUNT - 1)));

        // GuardedExec is entered twice: the outer session-key batch and the callback's inner batch
        vm.expectCall(GUARDED_EXEC, abi.encodeCall(IGuardedExecModule.executeGuardedBatch, (inner)), 1);
        _flashloanViaSessionPath(FlashloanProvider.MORPHO, inner);

        assertEq(IERC20(USDC).balanceOf(MORPHO_BLUE), morphoBefore, "Morpho repaid");
        assertApproxEqAbs(IERC20(USDC).balanceOf(safe), safeBefore, 2, "Safe USDC unchanged up to Aave rounding");
        assertLe(IERC20(A_USDC).balanceOf(safe), 2, "aUSDC dust only");
        assertEq(IERC20(USDC).balanceOf(address(module)), 0, "module holds nothing");
    }

    function test_Fork_RevertWhen_ApproveToAttackerInsideFlashloan() public {
        Execution[] memory inner = new Execution[](1);
        inner[0] = _exec(USDC, abi.encodeCall(IERC20.approve, (attacker, type(uint256).max)));

        _assertBlockedInsideFlashloan(
            inner, abi.encodeWithSelector(IGuardedExecModule.UnauthorizedERC20Approve.selector, USDC, attacker)
        );
    }

    function test_Fork_RevertWhen_TransferToAttackerInsideFlashloan() public {
        Execution[] memory inner = new Execution[](1);
        inner[0] = _exec(USDC, abi.encodeCall(IERC20.transfer, (attacker, FLASH_AMOUNT)));

        _assertBlockedInsideFlashloan(
            inner, abi.encodeWithSelector(IGuardedExecModule.UnauthorizedERC20Transfer.selector, USDC, attacker)
        );
    }

    /// @notice The reported drain: raw Aave withdraw to the attacker is not in the prod registry
    function test_Fork_RevertWhen_RawAaveWithdrawToAttackerInsideFlashloan() public {
        Execution[] memory inner = new Execution[](1);
        inner[0] = _exec(AAVE_POOL, abi.encodeCall(IAaveV3Pool.withdraw, (WETH, type(uint256).max, attacker)));

        _assertBlockedInsideFlashloan(
            inner,
            abi.encodeWithSelector(
                IGuardedExecModule.TargetSelectorNotWhitelisted.selector, AAVE_POOL, IAaveV3Pool.withdraw.selector
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev GuardedExec rejects `inner` for this account with `guardedExecError`. Inside the flashloan
    ///      the callback hands exactly `inner` to GuardedExec, and Safe7579 re-raises that revert as
    ///      ExecutionFailed(), unwinding the whole flashloan.
    function _assertBlockedInsideFlashloan(Execution[] memory inner, bytes memory guardedExecError) internal {
        vm.prank(safe);
        vm.expectRevert(guardedExecError);
        IGuardedExecModule(GUARDED_EXEC).executeGuardedBatch(inner);

        vm.expectCall(GUARDED_EXEC, abi.encodeCall(IGuardedExecModule.executeGuardedBatch, (inner)), 1);
        vm.expectRevert(ISafe7579.ExecutionFailed.selector);
        _flashloanViaSessionPath(FlashloanProvider.MORPHO, inner);
    }

    function _deploySafe7579(address owner) internal returns (address account) {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        account = ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(
            SAFE_SINGLETON_L2,
            abi.encodeCall(ISafe.setup, (owners, 1, address(0), "", SAFE7579, address(0), 0, payable(address(0)))),
            uint256(keccak256("UnifiedFlashloanModuleSafe7579ForkTest"))
        );

        ModuleInit[] memory executors = new ModuleInit[](2);
        executors[0] = ModuleInit({module: GUARDED_EXEC, initData: ""});
        executors[1] = ModuleInit({module: address(module), initData: ""});

        // Safe-owner transactions: enable Safe7579 as a Safe module, then initialise it
        vm.startPrank(account);
        ISafe(account).enableModule(SAFE7579);
        ISafe7579(account).initializeAccount(
            new ModuleInit[](0),
            executors,
            new ModuleInit[](0),
            new ModuleInit[](0),
            RegistryInit({registry: address(0), attesters: new address[](0), threshold: 0})
        );
        vm.stopPrank();
    }

    /// @dev Same call a session-key UserOp makes after validation: EntryPoint -> account.execute
    ///      -> GuardedExec.executeGuardedBatch([module.initiateFlashloan(...)])
    function _flashloanViaSessionPath(FlashloanProvider provider, Execution[] memory inner) internal {
        Execution[] memory outer = new Execution[](1);
        outer[0] = _exec(
            address(module),
            abi.encodeCall(UnifiedFlashloanModule.initiateFlashloan, (provider, USDC, FLASH_AMOUNT, inner))
        );
        vm.prank(ENTRY_POINT);
        ISafe7579(safe).execute(
            SINGLE_EXEC_MODE,
            abi.encodePacked(GUARDED_EXEC, uint256(0), abi.encodeCall(IGuardedExecModule.executeGuardedBatch, (outer)))
        );
    }

    function _exec(address target, bytes memory callData) internal pure returns (Execution memory) {
        return Execution({target: target, value: 0, callData: callData});
    }
}
