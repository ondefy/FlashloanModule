import { type Address } from 'viem';

// ============================================================
//  BASE MAINNET ADDRESSES
// ============================================================

export const ADDRESSES = {
  WETH: '0x4200000000000000000000000000000000000006' as Address,
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  AAVE_POOL: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address,
  MORPHO_BLUE: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address,
} as const;

/** Morpho Blue market params for USDC/WETH on Base */
export const MORPHO_MARKET_PARAMS = {
  loanToken: ADDRESSES.USDC,
  collateralToken: ADDRESSES.WETH,
  oracle: '0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4' as Address,
  irm: '0x46415998764C29aB2a25CbeA6254146D50D22687' as Address,
  lltv: 860000000000000000n, // 0.86e18
} as const;

export const SAFE4337_MODULE_ADDRESS = '0x7579EE8307284F293B1927136486880611F20002' as Address;
export const ERC7579_LAUNCHPAD_ADDRESS = '0x7579011aB74c46090561ea277Ba79D510c6C00ff' as Address;

// Aave constants
export const AAVE_BASE_DECIMALS = 8;
export const USDC_DECIMALS = 6;
export const VARIABLE_RATE = 2n;
export const REPAY_BUFFER_MAX_USDC = 1_000_000n; // 1 USDC
export const FLASHLOAN_MIN_USDC = 100_000n; // 0.1 USDC

// FlashloanProvider enum (matches Solidity)
export const FlashloanProvider = {
  MORPHO: 0,
  AAVE: 1,
} as const;
