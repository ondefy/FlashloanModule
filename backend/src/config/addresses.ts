import type { Address } from 'viem';

// Base mainnet token addresses (lowercase)
export const TOKENS = {
  WETH: '0x4200000000000000000000000000000000000006' as Address,
  USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address,
  cbETH: '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22' as Address,
  wstETH: '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452' as Address,
} as const;

// Base mainnet protocol pool addresses (lowercase)
export const POOLS = {
  AAVE_V3: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5' as Address,
  MORPHO_BLUE: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb' as Address,
} as const;

// Morpho market parameters for WETH/USDC
export const MORPHO_MARKET = {
  loanToken: TOKENS.USDC,
  collateralToken: TOKENS.WETH,
  oracle: '0xfea2d58cefcb9fcb597723c6bae66ffe4193afe4' as Address,
  irm: '0x46415998764c29ab2a25cbea6254146d50d22687' as Address,
  lltv: BigInt('860000000000000000'), // 0.86e18
} as const;

// ERC-4337 / Safe infrastructure
export const INFRA = {
  SAFE_4337_MODULE: '0x7579ee8307284f293b1927136486880611f20002' as Address,
  ERC7579_LAUNCHPAD: '0x7579011ab74c46090561ea277ba79d510c6c00ff' as Address,
} as const;

// Chain
export const BASE_CHAIN_ID = 8453;
