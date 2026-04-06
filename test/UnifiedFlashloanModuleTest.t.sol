// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {
    UnifiedFlashloanModule,
    Execution,
    FlashloanProvider
} from "../src/module/UnifiedFlashloanModule.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {MockMorphoBlue} from "./mocks/MockMorphoBlue.sol";
import {MockAavePool} from "./mocks/MockAavePool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSmartAccount} from "./mocks/MockSmartAccount.sol";
import {MockTargetRegistry} from "./mocks/MockTargetRegistry.sol";

/**
 * @title UnifiedFlashloanModuleTest
 * @author ZyFAI
 * @notice Unit tests for UnifiedFlashloanModule v4 — multi-provider flashloan + registry whitelist (no signatures)
 */
contract UnifiedFlashloanModuleTest is Test {
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
                              CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 constant FLASHLOAN_AMOUNT = 10_000 * 1e6; // 10k USDC
    uint256 constant AAVE_PREMIUM_BPS = 5; // 0.05%

    /*//////////////////////////////////////////////////////////////
                               STORAGE
    //////////////////////////////////////////////////////////////*/

    UnifiedFlashloanModule public module;
    MockMorphoBlue public morphoBlue;
    MockAavePool public aavePool;
    MockSmartAccount public smartAccount;
    MockERC20 public usdc;
    MockTargetRegistry public registry;

    address public moduleOwner;

    /*//////////////////////////////////////////////////////////////
                                SETUP
    //////////////////////////////////////////////////////////////*/

    function setUp() public {
        moduleOwner = makeAddr("ModuleOwner");

        // Deploy mocks
        usdc = new MockERC20("USD Coin", "USDC", 6);
        morphoBlue = new MockMorphoBlue();
        aavePool = new MockAavePool();

        // Deploy registry and whitelist the approve selector on USDC
        registry = new MockTargetRegistry();
        registry.addToWhitelist(address(usdc), MockERC20.approve.selector);

        // Deploy unified module behind ERC1967 proxy
        module = _deployModule(moduleOwner, address(morphoBlue), address(aavePool), address(registry));

        // Fund mock protocols with liquidity
        usdc.mint(address(morphoBlue), 1_000_000 * 1e6);
        usdc.mint(address(aavePool), 1_000_000 * 1e6);

        // Deploy mock smart account and install module as executor
        smartAccount = new MockSmartAccount(makeAddr("AccountOwner"));
        smartAccount.installExecutor(address(module));

        // Fund smart account for repayments
        usdc.mint(address(smartAccount), 100_000 * 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                        1. INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    function test_Initialize_SetsCorrectState() public view {
        assertEq(module.owner(), moduleOwner);
        assertEq(module.morphoBlue(), address(morphoBlue));
        assertEq(module.aavePool(), address(aavePool));
        assertEq(module.registry(), address(registry));
        assertFalse(module.paused());
    }

    function test_Initialize_EmitsProviderAndRegistryEvents() public {
        UnifiedFlashloanModule impl = new UnifiedFlashloanModule();

        vm.expectEmit(true, true, false, false);
        emit ProviderUpdated(FlashloanProvider.MORPHO, address(morphoBlue));
        vm.expectEmit(true, true, false, false);
        emit ProviderUpdated(FlashloanProvider.AAVE, address(aavePool));
        vm.expectEmit(true, true, false, false);
        emit RegistryUpdated(address(0), address(registry));

        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                UnifiedFlashloanModule.initialize,
                (moduleOwner, address(morphoBlue), address(aavePool), address(registry))
            )
        );
    }

    function test_RevertWhen_InitializeZeroOwner() public {
        UnifiedFlashloanModule impl = new UnifiedFlashloanModule();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                UnifiedFlashloanModule.initialize,
                (address(0), address(morphoBlue), address(aavePool), address(registry))
            )
        );
    }

    function test_RevertWhen_InitializeZeroMorphoBlue() public {
        UnifiedFlashloanModule impl = new UnifiedFlashloanModule();
        vm.expectRevert(UnifiedFlashloanModule.InvalidProvider.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                UnifiedFlashloanModule.initialize,
                (moduleOwner, address(0), address(aavePool), address(registry))
            )
        );
    }

    function test_RevertWhen_InitializeZeroAavePool() public {
        UnifiedFlashloanModule impl = new UnifiedFlashloanModule();
        vm.expectRevert(UnifiedFlashloanModule.InvalidProvider.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                UnifiedFlashloanModule.initialize,
                (moduleOwner, address(morphoBlue), address(0), address(registry))
            )
        );
    }

    function test_RevertWhen_DoubleInitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        module.initialize(moduleOwner, address(morphoBlue), address(aavePool), address(registry));
    }

    /*//////////////////////////////////////////////////////////////
                   2. MODULE METADATA (ERC-7579)
    //////////////////////////////////////////////////////////////*/

    function test_Name() public view {
        assertEq(module.name(), "UnifiedFlashloanModule");
    }

    function test_Version() public view {
        assertEq(module.version(), "4.0.0");
    }

    function test_IsModuleType_Executor() public view {
        assertTrue(module.isModuleType(2), "Should support executor (type 2)");
    }

    function test_IsModuleType_RejectsOtherTypes() public view {
        assertFalse(module.isModuleType(1), "Should not support validator (type 1)");
        assertFalse(module.isModuleType(3), "Should not support fallback (type 3)");
        assertFalse(module.isModuleType(0), "Should not support type 0");
    }

    function test_IsInitialized_AlwaysTrue() public {
        assertTrue(module.isInitialized(address(smartAccount)));
        assertTrue(module.isInitialized(address(0)));
        assertTrue(module.isInitialized(makeAddr("random")));
    }

    function test_OnInstallAndOnUninstall_AreNoOps() public {
        module.onInstall("");
        module.onUninstall("");
        module.onInstall(abi.encode(uint256(123)));
        module.onUninstall(abi.encode(uint256(456)));
    }

    /*//////////////////////////////////////////////////////////////
                   3. ADMIN: PROVIDER MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    function test_ProviderAddresses() public view {
        assertEq(module.morphoBlue(), address(morphoBlue));
        assertEq(module.aavePool(), address(aavePool));
    }

    function test_SetMorphoBlue() public {
        address newMorpho = makeAddr("NewMorpho");
        vm.prank(moduleOwner);
        vm.expectEmit(true, true, false, false);
        emit ProviderUpdated(FlashloanProvider.MORPHO, newMorpho);
        module.setMorphoBlue(newMorpho);
        assertEq(module.morphoBlue(), newMorpho);
    }

    function test_SetAavePool() public {
        address newAave = makeAddr("NewAave");
        vm.prank(moduleOwner);
        vm.expectEmit(true, true, false, false);
        emit ProviderUpdated(FlashloanProvider.AAVE, newAave);
        module.setAavePool(newAave);
        assertEq(module.aavePool(), newAave);
    }

    function test_RevertWhen_SetMorphoBlueNotOwner() public {
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert();
        module.setMorphoBlue(makeAddr("NewMorpho"));
    }

    function test_RevertWhen_SetAavePoolNotOwner() public {
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert();
        module.setAavePool(makeAddr("NewAave"));
    }

    function test_RevertWhen_SetMorphoBlueZeroAddress() public {
        vm.prank(moduleOwner);
        vm.expectRevert(UnifiedFlashloanModule.InvalidProvider.selector);
        module.setMorphoBlue(address(0));
    }

    function test_RevertWhen_SetAavePoolZeroAddress() public {
        vm.prank(moduleOwner);
        vm.expectRevert(UnifiedFlashloanModule.InvalidProvider.selector);
        module.setAavePool(address(0));
    }

    /*//////////////////////////////////////////////////////////////
                   4. ADMIN: REGISTRY MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    function test_RegistryAddress() public view {
        assertEq(module.registry(), address(registry));
    }

    function test_SetRegistry() public {
        address newRegistry = makeAddr("NewRegistry");
        vm.prank(moduleOwner);
        vm.expectEmit(true, true, false, false);
        emit RegistryUpdated(address(registry), newRegistry);
        module.setRegistry(newRegistry);
        assertEq(module.registry(), newRegistry);
    }

    function test_RevertWhen_SetRegistryNotOwner() public {
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert();
        module.setRegistry(makeAddr("NewRegistry"));
    }

    function test_RevertWhen_FlashloanWithoutRegistry() public {
        // Disable registry
        vm.prank(moduleOwner);
        module.setRegistry(address(0));

        Execution[] memory executions = _createApproveExecution();
        vm.prank(address(smartAccount));
        vm.expectRevert(UnifiedFlashloanModule.RegistryNotSet.selector);
        module.initiateFlashloan(FlashloanProvider.MORPHO, address(usdc), FLASHLOAN_AMOUNT, executions);
    }

    /*//////////////////////////////////////////////////////////////
                    5. ADMIN: PAUSE & UNPAUSE
    //////////////////////////////////////////////////////////////*/

    function test_Pause() public {
        vm.prank(moduleOwner);
        module.pause();
        assertTrue(module.paused());
    }

    function test_Unpause() public {
        vm.startPrank(moduleOwner);
        module.pause();
        assertTrue(module.paused());
        module.unpause();
        assertFalse(module.paused());
        vm.stopPrank();
    }

    function test_UnpauseRestoresFlashloan() public {
        vm.startPrank(moduleOwner);
        module.pause();
        module.unpause();
        vm.stopPrank();

        _executeFlashloan(FlashloanProvider.MORPHO, FLASHLOAN_AMOUNT);
    }

    function test_RevertWhen_FlashloanWhilePaused() public {
        vm.prank(moduleOwner);
        module.pause();

        Execution[] memory executions = _createApproveExecution();
        vm.prank(address(smartAccount));
        vm.expectRevert(Pausable.EnforcedPause.selector);
        module.initiateFlashloan(FlashloanProvider.MORPHO, address(usdc), FLASHLOAN_AMOUNT, executions);
    }

    function test_RevertWhen_PauseNotOwner() public {
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert();
        module.pause();
    }

    function test_RevertWhen_UnpauseNotOwner() public {
        vm.prank(moduleOwner);
        module.pause();

        vm.prank(makeAddr("notOwner"));
        vm.expectRevert();
        module.unpause();
    }

    /*//////////////////////////////////////////////////////////////
                       6. ADMIN: OWNERSHIP
    //////////////////////////////////////////////////////////////*/

    function test_OwnershipTransfer_TwoStep() public {
        address newOwner = makeAddr("NewOwner");

        vm.prank(moduleOwner);
        module.transferOwnership(newOwner);
        assertEq(module.owner(), moduleOwner, "Owner unchanged before accept");
        assertEq(module.pendingOwner(), newOwner);

        vm.prank(newOwner);
        module.acceptOwnership();
        assertEq(module.owner(), newOwner);
        assertEq(module.pendingOwner(), address(0));
    }

    /*//////////////////////////////////////////////////////////////
                       7. ADMIN: UPGRADES
    //////////////////////////////////////////////////////////////*/

    function test_UpgradeToNewImplementation() public {
        UnifiedFlashloanModule newImpl = new UnifiedFlashloanModule();
        vm.prank(moduleOwner);
        module.upgradeToAndCall(address(newImpl), "");

        // State preserved after upgrade
        assertEq(module.morphoBlue(), address(morphoBlue));
        assertEq(module.aavePool(), address(aavePool));
        assertEq(module.registry(), address(registry));
        assertEq(module.owner(), moduleOwner);
        assertEq(module.version(), "4.0.0");
    }

    function test_RevertWhen_UpgradeNotOwner() public {
        UnifiedFlashloanModule newImpl = new UnifiedFlashloanModule();
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert();
        module.upgradeToAndCall(address(newImpl), "");
    }

    /*//////////////////////////////////////////////////////////////
                   8. FLASHLOAN: MORPHO PROVIDER
    //////////////////////////////////////////////////////////////*/

    function test_MorphoFlashloan_Success() public {
        uint256 balanceBefore = usdc.balanceOf(address(smartAccount));
        _executeFlashloan(FlashloanProvider.MORPHO, FLASHLOAN_AMOUNT);
        assertEq(usdc.balanceOf(address(smartAccount)), balanceBefore, "No fee for Morpho");
    }

    function test_MorphoFlashloan_EmitsEvents() public {
        Execution[] memory executions = _createApproveExecution();

        vm.expectEmit(true, true, true, true);
        emit FlashloanInitiated(
            address(smartAccount), FlashloanProvider.MORPHO, address(usdc), FLASHLOAN_AMOUNT, 1
        );

        vm.prank(address(smartAccount));
        module.initiateFlashloan(FlashloanProvider.MORPHO, address(usdc), FLASHLOAN_AMOUNT, executions);
    }

    /*//////////////////////////////////////////////////////////////
                    9. FLASHLOAN: AAVE PROVIDER
    //////////////////////////////////////////////////////////////*/

    function test_AaveFlashloan_Success() public {
        uint256 premium = _aavePremium(FLASHLOAN_AMOUNT);
        usdc.mint(address(smartAccount), premium);

        uint256 balanceBefore = usdc.balanceOf(address(smartAccount));
        _executeFlashloan(FlashloanProvider.AAVE, FLASHLOAN_AMOUNT);
        assertEq(usdc.balanceOf(address(smartAccount)), balanceBefore - premium, "Should pay Aave premium");
    }

    function test_AaveFlashloan_EmitsEvents() public {
        uint256 premium = _aavePremium(FLASHLOAN_AMOUNT);
        usdc.mint(address(smartAccount), premium);

        Execution[] memory executions = _createApproveExecution();

        vm.expectEmit(true, true, true, true);
        emit FlashloanInitiated(
            address(smartAccount), FlashloanProvider.AAVE, address(usdc), FLASHLOAN_AMOUNT, 1
        );

        vm.prank(address(smartAccount));
        module.initiateFlashloan(FlashloanProvider.AAVE, address(usdc), FLASHLOAN_AMOUNT, executions);
    }

    /*//////////////////////////////////////////////////////////////
              10. SEQUENTIAL FLASHLOANS
    //////////////////////////////////////////////////////////////*/

    function test_SequentialFlashloans_AcrossProviders() public {
        // Flashloan 1: Morpho
        _executeFlashloan(FlashloanProvider.MORPHO, FLASHLOAN_AMOUNT);

        // Flashloan 2: Aave
        usdc.mint(address(smartAccount), _aavePremium(FLASHLOAN_AMOUNT));
        _executeFlashloan(FlashloanProvider.AAVE, FLASHLOAN_AMOUNT);

        // Flashloan 3: Morpho again
        _executeFlashloan(FlashloanProvider.MORPHO, FLASHLOAN_AMOUNT);
    }

    /*//////////////////////////////////////////////////////////////
                11. SECURITY: CALLBACK AUTHORIZATION
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_UnauthorizedMorphoCallback() public {
        bytes memory data = abi.encode(address(smartAccount), address(usdc), new Execution[](1));

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(UnifiedFlashloanModule.UnauthorizedCaller.selector);
        module.onMorphoFlashLoan(FLASHLOAN_AMOUNT, data);
    }

    function test_RevertWhen_UnauthorizedAaveCallback() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(UnifiedFlashloanModule.UnauthorizedCaller.selector);
        module.executeOperation(address(usdc), FLASHLOAN_AMOUNT, 5000, address(module), "");
    }

    function test_RevertWhen_AaveCallbackWrongInitiator() public {
        vm.prank(address(aavePool));
        vm.expectRevert(UnifiedFlashloanModule.UnauthorizedCaller.selector);
        module.executeOperation(address(usdc), FLASHLOAN_AMOUNT, 5000, makeAddr("wrongInitiator"), "");
    }

    /*//////////////////////////////////////////////////////////////
            12. SECURITY: REGISTRY WHITELIST ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    function test_WhitelistedExecution_Succeeds() public {
        _executeFlashloan(FlashloanProvider.MORPHO, FLASHLOAN_AMOUNT);
    }

    function test_RevertWhen_TargetNotWhitelisted() public {
        address unknownTarget = makeAddr("UnknownDeFiProtocol");
        bytes4 selector = bytes4(0xdeadbeef);

        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: unknownTarget, value: 0, callData: abi.encodeWithSelector(selector, uint256(100))});

        vm.prank(address(smartAccount));
        vm.expectRevert(
            abi.encodeWithSelector(
                UnifiedFlashloanModule.TargetSelectorNotWhitelisted.selector, unknownTarget, selector
            )
        );
        module.initiateFlashloan(FlashloanProvider.MORPHO, address(usdc), FLASHLOAN_AMOUNT, executions);
    }

    function test_RevertWhen_SelectorNotWhitelisted() public {
        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({
            target: address(usdc),
            value: 0,
            callData: abi.encodeWithSelector(MockERC20.transfer.selector, address(module), FLASHLOAN_AMOUNT)
        });

        vm.prank(address(smartAccount));
        vm.expectRevert(
            abi.encodeWithSelector(
                UnifiedFlashloanModule.TargetSelectorNotWhitelisted.selector,
                address(usdc),
                MockERC20.transfer.selector
            )
        );
        module.initiateFlashloan(FlashloanProvider.MORPHO, address(usdc), FLASHLOAN_AMOUNT, executions);
    }

    function test_RevertWhen_PartiallyWhitelistedBatch() public {
        Execution[] memory executions = new Execution[](2);
        executions[0] = Execution({
            target: address(usdc),
            value: 0,
            callData: abi.encodeWithSelector(MockERC20.approve.selector, address(module), FLASHLOAN_AMOUNT)
        });
        executions[1] = Execution({
            target: address(usdc),
            value: 0,
            callData: abi.encodeWithSelector(MockERC20.transfer.selector, address(module), FLASHLOAN_AMOUNT)
        });

        vm.prank(address(smartAccount));
        vm.expectRevert(
            abi.encodeWithSelector(
                UnifiedFlashloanModule.TargetSelectorNotWhitelisted.selector,
                address(usdc),
                MockERC20.transfer.selector
            )
        );
        module.initiateFlashloan(FlashloanProvider.MORPHO, address(usdc), FLASHLOAN_AMOUNT, executions);
    }

    function test_WhitelistEnforcedForAaveProvider() public {
        address unknownTarget = makeAddr("UnknownDeFiProtocol");
        bytes4 selector = bytes4(0xdeadbeef);

        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: unknownTarget, value: 0, callData: abi.encodeWithSelector(selector, uint256(100))});

        usdc.mint(address(smartAccount), _aavePremium(FLASHLOAN_AMOUNT));

        vm.prank(address(smartAccount));
        vm.expectRevert(
            abi.encodeWithSelector(
                UnifiedFlashloanModule.TargetSelectorNotWhitelisted.selector, unknownTarget, selector
            )
        );
        module.initiateFlashloan(FlashloanProvider.AAVE, address(usdc), FLASHLOAN_AMOUNT, executions);
    }

    /*//////////////////////////////////////////////////////////////
                  13. SECURITY: INPUT VALIDATION
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_EmptyExecutions() public {
        Execution[] memory empty = new Execution[](0);

        vm.prank(address(smartAccount));
        vm.expectRevert(UnifiedFlashloanModule.InvalidExecutionsLength.selector);
        module.initiateFlashloan(FlashloanProvider.MORPHO, address(usdc), FLASHLOAN_AMOUNT, empty);
    }

    function test_RevertWhen_ZeroFlashloanAmount() public {
        Execution[] memory executions = _createApproveExecution();

        vm.prank(address(smartAccount));
        vm.expectRevert(UnifiedFlashloanModule.ZeroFlashloanAmount.selector);
        module.initiateFlashloan(FlashloanProvider.MORPHO, address(usdc), 0, executions);
    }

    function test_RevertWhen_InvalidCalldata() public {
        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: address(usdc), value: 0, callData: hex"dead"});

        vm.prank(address(smartAccount));
        vm.expectRevert(UnifiedFlashloanModule.InvalidCalldata.selector);
        module.initiateFlashloan(FlashloanProvider.MORPHO, address(usdc), FLASHLOAN_AMOUNT, executions);
    }

    /*//////////////////////////////////////////////////////////////
                          HELPER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _deployModule(
        address owner_,
        address morphoBlue_,
        address aavePool_,
        address registry_
    ) internal returns (UnifiedFlashloanModule) {
        UnifiedFlashloanModule impl = new UnifiedFlashloanModule();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(UnifiedFlashloanModule.initialize, (owner_, morphoBlue_, aavePool_, registry_))
        );
        return UnifiedFlashloanModule(address(proxy));
    }

    function _createApproveExecution() internal view returns (Execution[] memory executions) {
        executions = new Execution[](1);
        executions[0] = Execution({
            target: address(usdc),
            value: 0,
            callData: abi.encodeWithSelector(MockERC20.approve.selector, address(module), FLASHLOAN_AMOUNT)
        });
    }

    function _executeFlashloan(FlashloanProvider provider, uint256 amount) internal {
        Execution[] memory executions = _createApproveExecution();
        vm.prank(address(smartAccount));
        module.initiateFlashloan(provider, address(usdc), amount, executions);
    }

    function _aavePremium(uint256 amount) internal pure returns (uint256) {
        return (amount * AAVE_PREMIUM_BPS) / 10000;
    }
}
