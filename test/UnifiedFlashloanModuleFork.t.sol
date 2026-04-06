// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {
    UnifiedFlashloanModule,
    Execution,
    FlashloanProvider
} from "../src/module/UnifiedFlashloanModule.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockSmartAccount} from "./mocks/MockSmartAccount.sol";
import {MockTargetRegistry} from "./mocks/MockTargetRegistry.sol";

// ---- Inline interfaces for real Base mainnet contracts ----

interface IWETH {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;
    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

/// @dev Morpho Blue market params (same struct layout as on-chain)
struct MorphoMarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IMorphoBlue {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
    function supplyCollateral(
        MorphoMarketParams memory marketParams,
        uint256 assets,
        address onBehalf,
        bytes memory data
    ) external;
    function borrow(
        MorphoMarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);
}

/**
 * @title UnifiedFlashloanModuleForkTest
 * @notice Fork-based mainnet tests for UnifiedFlashloanModule v4 on Base (no signatures)
 * @dev Tests both Morpho and Aave flashloan paths against real Base contracts.
 *
 * Run with:
 *   forge test --match-contract UnifiedFlashloanModuleForkTest -vv
 *   (optionally set BASE_RPC_URL env variable for a custom RPC)
 */
contract UnifiedFlashloanModuleForkTest is Test {
    /*//////////////////////////////////////////////////////////////
                          BASE MAINNET ADDRESSES
    //////////////////////////////////////////////////////////////*/

    address constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant WETH_BASE = 0x4200000000000000000000000000000000000006;
    address constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // Morpho Blue USDC/WETH market params
    address constant MORPHO_ORACLE = 0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4;
    address constant MORPHO_IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;
    uint256 constant MORPHO_LLTV = 860000000000000000; // 0.86e18

    uint256 constant AAVE_INTEREST_RATE_MODE = 2; // variable rate
    uint256 constant AAVE_BASE_CURRENCY_DECIMALS = 8;
    uint256 constant USDC_DECIMALS = 6;
    uint256 constant BORROW_SAFETY_BPS = 5000; // 50% of max borrow

    /*//////////////////////////////////////////////////////////////
                               STORAGE
    //////////////////////////////////////////////////////////////*/

    UnifiedFlashloanModule public module;
    MockSmartAccount public smartAccount;
    MockTargetRegistry public registry;

    address public moduleOwner;

    /*//////////////////////////////////////////////////////////////
                               SETUP
    //////////////////////////////////////////////////////////////*/

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"));
        vm.createSelectFork(rpc);

        moduleOwner = makeAddr("ModuleOwner");

        // Deploy registry and whitelist all DeFi selectors used in collateral swap
        registry = new MockTargetRegistry();
        // ERC20 approve on USDC and WETH
        registry.addToWhitelist(USDC_BASE, IERC20Balance.approve.selector);
        registry.addToWhitelist(WETH_BASE, IERC20Balance.approve.selector);
        // Aave operations
        registry.addToWhitelist(AAVE_POOL, IAavePool.repay.selector);
        registry.addToWhitelist(AAVE_POOL, IAavePool.withdraw.selector);
        registry.addToWhitelist(AAVE_POOL, IAavePool.supply.selector);
        registry.addToWhitelist(AAVE_POOL, IAavePool.borrow.selector);
        // Morpho operations
        registry.addToWhitelist(MORPHO_BLUE, IMorphoBlue.supplyCollateral.selector);
        registry.addToWhitelist(MORPHO_BLUE, IMorphoBlue.borrow.selector);

        // Deploy unified module behind ERC1967Proxy with real Base provider addresses + registry
        UnifiedFlashloanModule implementation = new UnifiedFlashloanModule();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(UnifiedFlashloanModule.initialize, (moduleOwner, MORPHO_BLUE, AAVE_POOL, address(registry)))
        );
        module = UnifiedFlashloanModule(address(proxy));
        vm.label(address(module), "UnifiedModule(Proxy)");

        // Deploy mock smart account (ERC-7579 compatible)
        smartAccount = new MockSmartAccount(makeAddr("AccountOwner"));
        vm.label(address(smartAccount), "SmartAccount");

        // Install module as executor (type 2)
        smartAccount.installExecutor(address(module));
    }

    /*//////////////////////////////////////////////////////////////
                          DEPLOYMENT TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ForkModuleDeployed() public view {
        assertEq(module.name(), "UnifiedFlashloanModule");
        assertEq(module.version(), "4.0.0");
        assertTrue(module.isModuleType(2), "Should support executor");
        assertFalse(module.isModuleType(3), "Should not support fallback");
        assertEq(module.owner(), moduleOwner);
        assertFalse(module.paused());
        assertEq(module.morphoBlue(), MORPHO_BLUE);
        assertEq(module.aavePool(), AAVE_POOL);
    }

    /*//////////////////////////////////////////////////////////////
                  MORPHO: SIMPLE FLASHLOAN ROUND-TRIP
    //////////////////////////////////////////////////////////////*/

    /// @notice Borrow USDC from real Morpho Blue and repay atomically
    function test_MorphoSimpleFlashloanRoundTrip() public {
        uint256 flashAmount = 1000 * 1e6; // 1,000 USDC

        Execution[] memory executions = _createNoOpExecution();

        uint256 morphoUsdcBefore = IERC20Balance(USDC_BASE).balanceOf(MORPHO_BLUE);
        uint256 accountUsdcBefore = IERC20Balance(USDC_BASE).balanceOf(address(smartAccount));

        vm.prank(address(smartAccount));
        module.initiateFlashloan(FlashloanProvider.MORPHO, USDC_BASE, flashAmount, executions);

        assertEq(
            IERC20Balance(USDC_BASE).balanceOf(MORPHO_BLUE),
            morphoUsdcBefore,
            "Morpho USDC should be unchanged (fully repaid)"
        );
        assertEq(
            IERC20Balance(USDC_BASE).balanceOf(address(smartAccount)),
            accountUsdcBefore,
            "Smart account USDC should be unchanged (no fee)"
        );

        console.log("Morpho simple flashloan round-trip: SUCCESS (0% fee)");
    }

    /*//////////////////////////////////////////////////////////////
                   AAVE: SIMPLE FLASHLOAN ROUND-TRIP
    //////////////////////////////////////////////////////////////*/

    /// @notice Borrow USDC from real Aave V3 and repay atomically (with fee)
    function test_AaveSimpleFlashloanRoundTrip() public {
        uint256 flashAmount = 1000 * 1e6; // 1,000 USDC

        // Read actual premium from Aave
        uint128 premiumBps = IAavePool(AAVE_POOL).FLASHLOAN_PREMIUM_TOTAL();
        uint256 premium = (flashAmount * premiumBps) / 10000;
        console.log("Aave premium bps:", premiumBps);
        console.log("Aave premium USDC:", premium);

        // Fund smart account with enough USDC to cover the fee
        deal(USDC_BASE, address(smartAccount), premium + 1e6);

        Execution[] memory executions = _createNoOpExecution();

        uint256 accountUsdcBefore = IERC20Balance(USDC_BASE).balanceOf(address(smartAccount));

        vm.prank(address(smartAccount));
        module.initiateFlashloan(FlashloanProvider.AAVE, USDC_BASE, flashAmount, executions);

        uint256 accountUsdcAfter = IERC20Balance(USDC_BASE).balanceOf(address(smartAccount));
        uint256 spent = accountUsdcBefore - accountUsdcAfter;

        assertEq(spent, premium, "Should spend exactly the premium amount");

        console.log("Aave simple flashloan round-trip: SUCCESS");
        console.log("Fee paid (USDC wei):", spent);
        console.log("Premium (bps):", premiumBps);
    }

    /*//////////////////////////////////////////////////////////////
            MORPHO: COLLATERAL SWAP AAVE -> MORPHO BLUE
    //////////////////////////////////////////////////////////////*/

    /// @notice Full collateral swap using Morpho flashloan (free)
    function test_MorphoCollateralSwapAaveToMorpho() public {
        uint256 wethAmount = 0.01 ether;

        // Create Aave position
        _setupAavePosition(wethAmount);

        (, uint256 debtBefore, , , , uint256 healthBefore) =
            IAavePool(AAVE_POOL).getUserAccountData(address(smartAccount));
        assertGt(debtBefore, 0, "Should have Aave debt");

        console.log("=== Before (Morpho flashloan) ===");
        console.log("Aave debt (8 dec):", debtBefore);
        console.log("Health factor:", healthBefore);

        // Build flashloan
        uint256 debtUsdc = (debtBefore * (10 ** USDC_DECIMALS)) / (10 ** AAVE_BASE_CURRENCY_DECIMALS);
        uint256 flashAmount = debtUsdc + 1e6; // +1 USDC buffer
        uint256 expectedWeth = wethAmount - 1; // Aave rounds down by 1 wei

        Execution[] memory executions = _buildCollateralSwapExecutions(flashAmount, expectedWeth);

        vm.prank(address(smartAccount));
        module.initiateFlashloan(FlashloanProvider.MORPHO, USDC_BASE, flashAmount, executions);

        // Verify
        (uint256 collAfter, uint256 debtAfter, , , , ) =
            IAavePool(AAVE_POOL).getUserAccountData(address(smartAccount));

        assertEq(debtAfter, 0, "Aave debt should be 0");
        assertEq(collAfter, 0, "Aave collateral should be 0");

        console.log("=== After (Morpho flashloan) ===");
        console.log("Aave debt:", debtAfter);
        console.log("Aave collateral:", collAfter);
        console.log("Collateral swap via Morpho flashloan: SUCCESS (0% fee)");
    }

    /*//////////////////////////////////////////////////////////////
             AAVE: COLLATERAL SWAP AAVE -> MORPHO BLUE
    //////////////////////////////////////////////////////////////*/

    /// @notice Same collateral swap but using Aave flashloan (with fee)
    function test_AaveCollateralSwapAaveToMorpho() public {
        uint256 wethAmount = 0.01 ether;

        // Create Aave position
        _setupAavePosition(wethAmount);

        (, uint256 debtBefore, , , , ) =
            IAavePool(AAVE_POOL).getUserAccountData(address(smartAccount));
        assertGt(debtBefore, 0, "Should have Aave debt");

        // Calculate flashloan amount including Aave fee
        uint256 debtUsdc = (debtBefore * (10 ** USDC_DECIMALS)) / (10 ** AAVE_BASE_CURRENCY_DECIMALS);
        uint128 premiumBps = IAavePool(AAVE_POOL).FLASHLOAN_PREMIUM_TOTAL();
        uint256 flashAmount = debtUsdc + 1e6; // +1 USDC buffer
        uint256 premium = (flashAmount * premiumBps) / 10000;

        console.log("=== Aave Flashloan Collateral Swap ===");
        console.log("Debt USDC:", debtUsdc);
        console.log("Flash amount:", flashAmount);
        console.log("Aave premium:", premium);

        // The last borrow step must borrow flashAmount + premium (to cover Aave fee)
        uint256 expectedWeth = wethAmount - 1;
        Execution[] memory executions = _buildCollateralSwapExecutionsWithFee(
            flashAmount, expectedWeth, premium
        );

        vm.prank(address(smartAccount));
        module.initiateFlashloan(FlashloanProvider.AAVE, USDC_BASE, flashAmount, executions);

        // Verify
        (uint256 collAfter, uint256 debtAfter, , , , ) =
            IAavePool(AAVE_POOL).getUserAccountData(address(smartAccount));

        assertEq(debtAfter, 0, "Aave debt should be 0");
        assertEq(collAfter, 0, "Aave collateral should be 0");

        console.log("Collateral swap via Aave flashloan: SUCCESS (fee:", premium, "USDC wei)");
    }

    /*//////////////////////////////////////////////////////////////
                     SEQUENTIAL MULTI-PROVIDER
    //////////////////////////////////////////////////////////////*/

    /// @notice Alternate between Morpho and Aave flashloans
    function test_ForkSequentialMultiProvider() public {
        uint256 flashAmount = 500 * 1e6;

        // Flashloan 1: Morpho
        {
            Execution[] memory executions = _createNoOpExecution();
            vm.prank(address(smartAccount));
            module.initiateFlashloan(FlashloanProvider.MORPHO, USDC_BASE, flashAmount, executions);
        }

        // Flashloan 2: Aave
        {
            uint128 premiumBps = IAavePool(AAVE_POOL).FLASHLOAN_PREMIUM_TOTAL();
            uint256 premium = (flashAmount * premiumBps) / 10000;
            deal(USDC_BASE, address(smartAccount), premium + 1e6);

            Execution[] memory executions = _createNoOpExecution();
            vm.prank(address(smartAccount));
            module.initiateFlashloan(FlashloanProvider.AAVE, USDC_BASE, flashAmount, executions);
        }

        console.log("Sequential multi-provider flashloans: SUCCESS");
    }

    /*//////////////////////////////////////////////////////////////
                          HELPER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _createNoOpExecution() internal view returns (Execution[] memory) {
        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({
            target: USDC_BASE,
            value: 0,
            callData: abi.encodeWithSelector(IERC20Balance.approve.selector, address(this), uint256(0))
        });
        return executions;
    }

    function _setupAavePosition(uint256 wethAmount) internal {
        vm.deal(address(smartAccount), wethAmount);
        vm.startPrank(address(smartAccount));

        IWETH(WETH_BASE).deposit{value: wethAmount}();
        IERC20Balance(WETH_BASE).approve(AAVE_POOL, wethAmount);
        IAavePool(AAVE_POOL).supply(WETH_BASE, wethAmount, address(smartAccount), 0);

        (, , uint256 availableBorrows, , , ) =
            IAavePool(AAVE_POOL).getUserAccountData(address(smartAccount));
        uint256 maxUsdc = (availableBorrows * (10 ** USDC_DECIMALS)) / (10 ** AAVE_BASE_CURRENCY_DECIMALS);
        uint256 borrowAmount = (maxUsdc * BORROW_SAFETY_BPS) / 10_000;

        IAavePool(AAVE_POOL).borrow(USDC_BASE, borrowAmount, AAVE_INTEREST_RATE_MODE, 0, address(smartAccount));
        vm.stopPrank();
    }

    /// @dev 6-step Aave→Morpho swap (Morpho flashloan — no fee, borrow flashAmount)
    function _buildCollateralSwapExecutions(uint256 flashAmount, uint256 wethToSupply)
        internal
        view
        returns (Execution[] memory executions)
    {
        MorphoMarketParams memory morphoParams = MorphoMarketParams({
            loanToken: USDC_BASE,
            collateralToken: WETH_BASE,
            oracle: MORPHO_ORACLE,
            irm: MORPHO_IRM,
            lltv: MORPHO_LLTV
        });

        executions = new Execution[](6);

        // 1. Approve USDC to Aave
        executions[0] = Execution({
            target: USDC_BASE,
            value: 0,
            callData: abi.encodeWithSelector(IERC20Balance.approve.selector, AAVE_POOL, type(uint256).max)
        });

        // 2. Repay all Aave debt
        executions[1] = Execution({
            target: AAVE_POOL,
            value: 0,
            callData: abi.encodeWithSelector(
                IAavePool.repay.selector, USDC_BASE, type(uint256).max, AAVE_INTEREST_RATE_MODE, address(smartAccount)
            )
        });

        // 3. Withdraw all WETH from Aave
        executions[2] = Execution({
            target: AAVE_POOL,
            value: 0,
            callData: abi.encodeWithSelector(
                IAavePool.withdraw.selector, WETH_BASE, type(uint256).max, address(smartAccount)
            )
        });

        // 4. Approve WETH to Morpho
        executions[3] = Execution({
            target: WETH_BASE,
            value: 0,
            callData: abi.encodeWithSelector(IERC20Balance.approve.selector, MORPHO_BLUE, type(uint256).max)
        });

        // 5. Supply WETH as collateral on Morpho
        executions[4] = Execution({
            target: MORPHO_BLUE,
            value: 0,
            callData: abi.encodeWithSelector(
                IMorphoBlue.supplyCollateral.selector, morphoParams, wethToSupply, address(smartAccount), new bytes(0)
            )
        });

        // 6. Borrow USDC from Morpho (exact flashloan amount — no fee for Morpho)
        executions[5] = Execution({
            target: MORPHO_BLUE,
            value: 0,
            callData: abi.encodeWithSelector(
                IMorphoBlue.borrow.selector, morphoParams, flashAmount, uint256(0), address(smartAccount), address(smartAccount)
            )
        });
    }

    /// @dev 6-step Aave→Morpho swap (Aave flashloan — must borrow flashAmount + premium)
    function _buildCollateralSwapExecutionsWithFee(
        uint256 flashAmount,
        uint256 wethToSupply,
        uint256 premium
    ) internal view returns (Execution[] memory executions) {
        MorphoMarketParams memory morphoParams = MorphoMarketParams({
            loanToken: USDC_BASE,
            collateralToken: WETH_BASE,
            oracle: MORPHO_ORACLE,
            irm: MORPHO_IRM,
            lltv: MORPHO_LLTV
        });

        executions = new Execution[](6);

        // Steps 1-5 are identical
        executions[0] = Execution({
            target: USDC_BASE,
            value: 0,
            callData: abi.encodeWithSelector(IERC20Balance.approve.selector, AAVE_POOL, type(uint256).max)
        });

        executions[1] = Execution({
            target: AAVE_POOL,
            value: 0,
            callData: abi.encodeWithSelector(
                IAavePool.repay.selector, USDC_BASE, type(uint256).max, AAVE_INTEREST_RATE_MODE, address(smartAccount)
            )
        });

        executions[2] = Execution({
            target: AAVE_POOL,
            value: 0,
            callData: abi.encodeWithSelector(
                IAavePool.withdraw.selector, WETH_BASE, type(uint256).max, address(smartAccount)
            )
        });

        executions[3] = Execution({
            target: WETH_BASE,
            value: 0,
            callData: abi.encodeWithSelector(IERC20Balance.approve.selector, MORPHO_BLUE, type(uint256).max)
        });

        executions[4] = Execution({
            target: MORPHO_BLUE,
            value: 0,
            callData: abi.encodeWithSelector(
                IMorphoBlue.supplyCollateral.selector, morphoParams, wethToSupply, address(smartAccount), new bytes(0)
            )
        });

        // 6. Borrow flashAmount + premium (to cover Aave fee)
        executions[5] = Execution({
            target: MORPHO_BLUE,
            value: 0,
            callData: abi.encodeWithSelector(
                IMorphoBlue.borrow.selector,
                morphoParams,
                flashAmount + premium, // ← extra to cover Aave flashloan fee
                uint256(0),
                address(smartAccount),
                address(smartAccount)
            )
        });
    }
}
