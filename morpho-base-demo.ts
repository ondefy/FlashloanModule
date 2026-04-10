/**
 * Standalone demo: Fetch Morpho vault APY, TVL, liquidity, rewards, collateral,
 * and interest-rate strategy data on Base chain (chainId 8453).
 *
 * Run:  npx ts-node demo/morpho-base-demo.ts
 *
 * Requirements:
 *   - Node 18+
 *   - yarn add axios ethers@5 dotenv   (already in the project)
 *   - A .env file with BASE_RPC_URL (any Base JSON-RPC endpoint)
 *
 * This file is 100 % self-contained — every constant, query, address, and URL
 * is inlined so you can copy it into any project and run it.
 */

import axios from 'axios';
import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

// =============================================================================
// 1. CONSTANTS
// =============================================================================

const BASE_CHAIN_ID = 8453;
const MORPHO_SUBGRAPH_URL = 'https://api.morpho.org/graphql';

// CoinGecko endpoint used as a simple ETH price fallback
const COINGECKO_ETH_PRICE_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';

// All tracked Morpho vaults on Base.
// Each vault has an on-chain address, a human-readable name, its Morpho app URL,
// and a version flag (V1 uses `vaultByAddress`, V2 uses `vaultV2ByAddress`).
const MORPHO_POOLS = [
  {
    address: '0xB7890CEE6CF4792cdCC13489D36D9d42726ab863',
    name: 'Universal - USDC',
    url: 'https://app.morpho.org/base/vault/0xB7890CEE6CF4792cdCC13489D36D9d42726ab863/universal-usdc',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0x616a4E1db48e22028f6bbf20444Cd3b8e3273738',
    name: 'Seamless USDC Vault',
    url: 'https://app.morpho.org/base/vault/0x616a4E1db48e22028f6bbf20444Cd3b8e3273738/seamless-usdc-vault',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca',
    name: 'Moonwell Flagship USDC',
    url: 'https://app.morpho.org/base/vault/0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca/moonwell-flagship-usdc',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0xE74c499fA461AF1844fCa84204490877787cED56',
    name: 'HighYield Clearstar USDC',
    url: 'https://app.morpho.org/base/vault/0xE74c499fA461AF1844fCa84204490877787cED56/highyield-clearstar-usdc',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0x1D3b1Cd0a0f242d598834b3F2d126dC6bd774657',
    name: 'Clearstar USDC Reactor',
    url: 'https://app.morpho.org/base/vault/0x1D3b1Cd0a0f242d598834b3F2d126dC6bd774657/clearstar-usdc-reactor',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61',
    name: 'Gauntlet USDC Prime',
    url: 'https://app.morpho.org/base/vault/0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61/gauntlet-usdc-prime',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0xc0c5689e6f4D256E861F65465b691aeEcC0dEb12',
    name: 'Gauntlet USDC Core',
    url: 'https://app.morpho.org/base/vault/0xc0c5689e6f4D256E861F65465b691aeEcC0dEb12/gauntlet-usdc-core',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0x236919F11ff9eA9550A4287696C2FC9e18E6e890',
    name: 'Gauntlet USDC Frontier',
    url: 'https://app.morpho.org/base/vault/0x236919F11ff9eA9550A4287696C2FC9e18E6e890/gauntlet-usdc-frontier',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0x23479229e52Ab6aaD312D0B03DF9F33B46753B5e',
    name: 'ExtrafiXLend USDC',
    url: 'https://app.morpho.org/base/vault/0x23479229e52Ab6aaD312D0B03DF9F33B46753B5e/extrafi-xlend-usdc',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183',
    name: 'Steakhouse USDC',
    url: 'https://app.morpho.org/base/vault/0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183/steakhouse-usdc',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A',
    name: 'Spark USDC Vault',
    url: 'https://app.morpho.org/base/vault/0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A/spark-usdc-vault',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2',
    name: 'Steakhouse Prime USDC',
    url: 'https://app.morpho.org/base/vault/0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2/steakhouse-prime-usdc',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F',
    name: 'Steakhouse High Yield USDC',
    url: 'https://app.morpho.org/base/vault/0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F/steakhouse-high-yield-usdc-v11',
    token: { symbol: 'USDC', decimals: 6 },
  },
  {
    address: '0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1',
    name: 'Moonwell Flagship ETH',
    url: 'https://app.morpho.org/base/vault/0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1/moonwell-flagship-eth',
    token: { symbol: 'WETH', decimals: 18 },
  },
  {
    address: '0x27D8c7273fd3fcC6956a0B370cE5Fd4A7fc65c18',
    name: 'Seamless WETH Vault',
    url: 'https://app.morpho.org/base/vault/0x27D8c7273fd3fcC6956a0B370cE5Fd4A7fc65c18/seamless-weth-vault',
    token: { symbol: 'WETH', decimals: 18 },
  },
  {
    address: '0x6b13c060F13Af1fdB319F52315BbbF3fb1D88844',
    name: 'Gauntlet WETH Core',
    url: 'https://app.morpho.org/base/vault/0x6b13c060F13Af1fdB319F52315BbbF3fb1D88844/gauntlet-weth-core',
    token: { symbol: 'WETH', decimals: 18 },
  },
];

// =============================================================================
// 2. GRAPHQL QUERY — sent to Morpho's public API (api.morpho.org/graphql)
// =============================================================================

const MORPHO_QUERY = `query VaultDetails($address: String!, $chainId: Int!) {
  vaultByAddress(address: $address, chainId: $chainId) {
    address
    liquidity {
      underlying
      usd
    }
    asset {
      yield {
        apr
      }
    }
    state {
      fee
      apy
      netApy
      netApyWithoutRewards
      avgApy
      avgNetApy
      dailyApy
      dailyNetApy
      weeklyApy
      weeklyNetApy
      monthlyApy
      monthlyNetApy
      totalAssets
      totalAssetsUsd
      rewards {
        asset {
          address
          chain { id }
        }
        supplyApr
        yearlySupplyTokens
      }
      allocation {
        market {
          uniqueKey
          loanAsset { symbol }
          collateralAsset { symbol, address }
          lltv
          state {
            utilization
            supplyAssetsUsd
            borrowAssetsUsd
            supplyApy
            borrowApy
            rewards {
              asset { address, chain { id } }
              supplyApr
              borrowApr
            }
          }
        }
        supplyAssetsUsd
        supplyQueueIndex
        supplyCap
        supplyAssets
      }
    }
  }
}`;

// =============================================================================
// 3. HELPERS
// =============================================================================

async function fetchEthPriceUsd(): Promise<number> {
  try {
    const res = await axios.get(COINGECKO_ETH_PRICE_URL);
    return res.data?.ethereum?.usd ?? 0;
  } catch {
    console.warn('Could not fetch ETH price from CoinGecko, falling back to 0');
    return 0;
  }
}

interface VaultAllocation {
  vaultName: string;
  vaultId: string;
  percentage: number;
  apy: number | null;
  utilization: number;
  marketSupplyUsd: number;
  marketBorrowUsd: number;
  collateral: Array<{ symbol: string; exposure_usd: number }>;
}

interface NextMarketForSupply {
  marketId: string;
  marketName: string;
  supplyQueueIndex: number;
  currentSupplyApy: number;
  utilization: number;
  remainingCapUsd: number;
  marketSupplyUsd: number;
  marketBorrowUsd: number;
}

interface InterestRateStrategy {
  totalSupply: number;
  totalBorrow: number;
  utilization: number;
  modelType: string;
  baseRate: number;
  performanceFee?: number;
  currentSupplyApy?: number;
  maxMarketUtilization?: number;
  nextMarketForSupply?: NextMarketForSupply;
  protocol: string;
}

interface MorphoPoolResult {
  symbol: string;
  name: string;
  vaultAddress: string;
  url: string;
  poolApy: number;
  rewardsApy: number;
  combinedApy: number;
  tvl: number;
  liquidity: number;
  tvlUsd: number;
  liquidityUsd: number;
  token: { symbol: string; decimals: number };
  collateralSymbols: string[];
  collateralTokens: Array<{ symbol: string; address: string }>;
  vaultAllocations: VaultAllocation[];
  nextMarketForSupply?: NextMarketForSupply;
  interestRateStrategy: InterestRateStrategy | null;
  chain_id: number;
}

// =============================================================================
// 4. CORE: Fetch a single Morpho vault
// =============================================================================

async function fetchMorphoVault(
  pool: (typeof MORPHO_POOLS)[number],
  ethPrice: number,
): Promise<MorphoPoolResult | null> {
  const TIMEOUT_MS = 25_000;

  const res = await axios.post(
    MORPHO_SUBGRAPH_URL,
    {
      query: MORPHO_QUERY,
      variables: { address: pool.address, chainId: BASE_CHAIN_ID },
    },
    { timeout: TIMEOUT_MS },
  );

  const vault = res.data?.data?.vaultByAddress;
  if (!vault || !vault.state) return null;

  // -------------------------------------------------------------------------
  // Collateral symbols + token addresses from state.allocation
  // -------------------------------------------------------------------------
  const collateralSymbols: string[] = [];
  const collateralTokensMap = new Map<string, string>();

  if (Array.isArray(vault.state.allocation)) {
    for (const alloc of vault.state.allocation) {
      if (alloc.supplyAssetsUsd > 0 && alloc.market?.collateralAsset?.symbol) {
        collateralSymbols.push(alloc.market.collateralAsset.symbol);
        if (alloc.market.collateralAsset.address) {
          collateralTokensMap.set(
            alloc.market.collateralAsset.symbol,
            alloc.market.collateralAsset.address,
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // APY calculation
  //   poolApy = avgApy * 100 * (1 - fee)        (fee is a ratio 0..1)
  //   rewardsApy = vault-level rewards + weighted market-level rewards
  //   combinedApy = poolApy + rewardsApy
  // -------------------------------------------------------------------------
  const avgApy: number = vault.state.avgApy || 0;
  const fee: number = vault.state.fee || 0;
  const poolApy = fee > 0 ? avgApy * 100 * (1 - fee) : avgApy * 100;

  // Vault-level rewards (e.g. MORPHO token emissions on the vault itself)
  let vaultRewards = 0;
  if (Array.isArray(vault.state.rewards)) {
    vaultRewards = vault.state.rewards.reduce(
      (sum: number, r: any) => sum + (r.supplyApr || 0) * 100,
      0,
    );
  }

  // Market-level rewards, weighted by each market's share of total allocation
  let marketRewards = 0;
  if (Array.isArray(vault.state.allocation)) {
    const totalAllocUsd = vault.state.allocation.reduce(
      (s: number, a: any) => s + (a.supplyAssetsUsd || 0),
      0,
    );
    if (totalAllocUsd > 0) {
      marketRewards = vault.state.allocation.reduce((sum: number, alloc: any) => {
        const weight = (alloc.supplyAssetsUsd || 0) / totalAllocUsd;
        const mktRewardApr =
          alloc.market?.state?.rewards?.reduce(
            (s: number, r: any) => s + (r.supplyApr || 0),
            0,
          ) || 0;
        return sum + mktRewardApr * weight * 100;
      }, 0);
    }
  }

  const rewardsApy = vaultRewards + marketRewards;
  const combinedApy = poolApy + rewardsApy;

  // -------------------------------------------------------------------------
  // Vault allocations (per-market breakdown)
  // -------------------------------------------------------------------------
  const vaultAllocations: VaultAllocation[] = [];
  let maxMarketUtilization = 0;
  let totalMarketSupplyUsd = 0;
  let totalMarketBorrowUsd = 0;

  if (Array.isArray(vault.state.allocation)) {
    const totalAssetsUsd = vault.state.totalAssetsUsd || 0;

    for (const alloc of vault.state.allocation) {
      const supplyAssetsUsd = alloc.supplyAssetsUsd || 0;
      const marketUtil = alloc.market?.state?.utilization ?? 0;
      const marketSupplyApy = alloc.market?.state?.supplyApy ?? null;
      const marketSupplyUsd = alloc.market?.state?.supplyAssetsUsd ?? 0;
      const marketBorrowUsd = alloc.market?.state?.borrowAssetsUsd ?? 0;

      if (supplyAssetsUsd >= 10_000 && totalAssetsUsd > 0) {
        if (marketUtil > maxMarketUtilization) maxMarketUtilization = marketUtil;
        totalMarketSupplyUsd += marketSupplyUsd;
        totalMarketBorrowUsd += marketBorrowUsd;
      }

      if (supplyAssetsUsd > 0 && totalAssetsUsd > 0) {
        const pct = parseFloat(((supplyAssetsUsd / totalAssetsUsd) * 100).toFixed(2));
        if (pct > 0) {
          const collateral: Array<{ symbol: string; exposure_usd: number }> = [];
          if (alloc.market?.collateralAsset?.symbol) {
            collateral.push({
              symbol: alloc.market.collateralAsset.symbol,
              exposure_usd: parseFloat(supplyAssetsUsd.toFixed(2)),
            });
          }

          let vaultName = 'Unknown Market';
          if (alloc.market?.collateralAsset?.symbol) {
            const loanSym = alloc.market?.loanAsset?.symbol || 'USDC';
            vaultName = `${loanSym}/${alloc.market.collateralAsset.symbol} Market`;
          }

          vaultAllocations.push({
            vaultName,
            vaultId: alloc.market?.uniqueKey || 'unknown',
            percentage: pct,
            apy: marketSupplyApy !== null ? parseFloat((marketSupplyApy * 100).toFixed(2)) : null,
            utilization: parseFloat((marketUtil * 100).toFixed(2)),
            marketSupplyUsd: parseFloat(marketSupplyUsd.toFixed(2)),
            marketBorrowUsd: parseFloat(marketBorrowUsd.toFixed(2)),
            collateral,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // TVL & Liquidity
  //   - USDC vaults: values are already in USD-equivalent units
  //   - WETH vaults: native units × ETH price → USD
  // -------------------------------------------------------------------------
  const decimals = pool.token.decimals;
  const divisor = Math.pow(10, decimals);
  const isWethPool = pool.token.symbol === 'WETH' || pool.token.symbol === 'ETH';

  const tvlNative = vault.state.totalAssets ? vault.state.totalAssets / divisor : 0;
  const liquidityNative = vault.liquidity?.underlying ? vault.liquidity.underlying / divisor : 0;
  const tvlUsdFromApi = Number(vault.state?.totalAssetsUsd ?? 0);
  const liquidityUsdFromApi = Number(vault.liquidity?.usd ?? 0);

  const tvl = isWethPool
    ? ethPrice > 0 ? tvlNative * ethPrice : tvlUsdFromApi
    : tvlNative;
  const liquidity = isWethPool
    ? ethPrice > 0 ? liquidityNative * ethPrice : liquidityUsdFromApi
    : liquidityNative;

  // -------------------------------------------------------------------------
  // Next market in the supply queue that still has capacity
  // -------------------------------------------------------------------------
  let nextMarketForSupply: NextMarketForSupply | undefined;
  if (Array.isArray(vault.state.allocation)) {
    const sorted = [...vault.state.allocation]
      .filter((a: any) => a.supplyQueueIndex != null)
      .sort((a: any, b: any) => a.supplyQueueIndex - b.supplyQueueIndex);

    for (const alloc of sorted) {
      const cap = Number(alloc.supplyCap || 0);
      const current = Number(alloc.supplyAssets || 0);
      if (cap > current) {
        const loanSym = alloc.market?.loanAsset?.symbol || '';
        const colSym = alloc.market?.collateralAsset?.symbol || '';
        const marketName = colSym ? `${loanSym}/${colSym} Market` : loanSym;
        const remainingCapRaw = cap - current;
        const remainingCapUsd =
          alloc.supplyAssetsUsd && current > 0
            ? (remainingCapRaw / current) * alloc.supplyAssetsUsd
            : remainingCapRaw / divisor;

        nextMarketForSupply = {
          marketId: alloc.market?.uniqueKey || 'unknown',
          marketName,
          supplyQueueIndex: alloc.supplyQueueIndex,
          currentSupplyApy: parseFloat(((alloc.market?.state?.supplyApy ?? 0) * 100).toFixed(2)),
          utilization: parseFloat(((alloc.market?.state?.utilization ?? 0) * 100).toFixed(2)),
          remainingCapUsd: parseFloat(remainingCapUsd.toFixed(2)),
          marketSupplyUsd: parseFloat((alloc.market?.state?.supplyAssetsUsd ?? 0).toFixed(2)),
          marketBorrowUsd: parseFloat((alloc.market?.state?.borrowAssetsUsd ?? 0).toFixed(2)),
        };
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Interest Rate Strategy (Morpho "vault" model)
  // -------------------------------------------------------------------------
  const deployedNative = tvlNative - liquidityNative;
  const interestRateStrategy: InterestRateStrategy = {
    totalSupply: totalMarketSupplyUsd || tvlNative,
    totalBorrow: totalMarketBorrowUsd || deployedNative,
    utilization: 0,
    modelType: 'vault',
    baseRate: 0,
    performanceFee: fee,
    currentSupplyApy: poolApy,
    ...(vaultAllocations.length > 0 && maxMarketUtilization > 0
      ? { maxMarketUtilization }
      : {}),
    ...(nextMarketForSupply ? { nextMarketForSupply } : {}),
    protocol: 'Morpho',
  };

  return {
    symbol: pool.name,
    name: pool.name,
    vaultAddress: pool.address,
    url: pool.url,
    poolApy,
    rewardsApy,
    combinedApy,
    tvl,
    liquidity,
    tvlUsd: tvlUsdFromApi,
    liquidityUsd: liquidityUsdFromApi,
    token: pool.token,
    collateralSymbols,
    collateralTokens: Array.from(collateralTokensMap.entries()).map(([symbol, address]) => ({
      symbol,
      address,
    })),
    vaultAllocations,
    nextMarketForSupply,
    interestRateStrategy,
    chain_id: BASE_CHAIN_ID,
  };
}

// =============================================================================
// 5. MAIN: Fetch ALL Morpho vaults on Base
// =============================================================================

async function main() {
  console.log('=== Morpho Base Demo ===\n');
  console.log(`Morpho GraphQL URL : ${MORPHO_SUBGRAPH_URL}`);
  console.log(`Chain ID            : ${BASE_CHAIN_ID}`);
  console.log(`Vaults to query     : ${MORPHO_POOLS.length}\n`);

  const ethPrice = await fetchEthPriceUsd();
  console.log(`ETH price (USD)     : $${ethPrice.toFixed(2)}\n`);

  const results = await Promise.allSettled(
    MORPHO_POOLS.map((pool) => fetchMorphoVault(pool, ethPrice)),
  );

  const pools: MorphoPoolResult[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      console.warn(`FAIL  ${MORPHO_POOLS[i].name}: ${r.reason}`);
    } else if (r.value) {
      pools.push(r.value);
    }
  }

  console.log(`\nSuccessfully fetched ${pools.length} / ${MORPHO_POOLS.length} vaults\n`);
  console.log('─'.repeat(100));

  for (const pool of pools) {
    console.log(`\n📦  ${pool.name}`);
    console.log(`    Vault address   : ${pool.vaultAddress}`);
    console.log(`    Token           : ${pool.token.symbol} (${pool.token.decimals} decimals)`);
    console.log(`    URL             : ${pool.url}`);
    console.log(`    Pool APY        : ${pool.poolApy.toFixed(4)}%`);
    console.log(`    Rewards APY     : ${pool.rewardsApy.toFixed(4)}%`);
    console.log(`    Combined APY    : ${pool.combinedApy.toFixed(4)}%`);
    console.log(`    TVL             : ${pool.tvl.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${pool.token.symbol === 'WETH' ? 'USD' : pool.token.symbol}`);
    console.log(`    TVL (USD API)   : $${pool.tvlUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    console.log(`    Liquidity       : ${pool.liquidity.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${pool.token.symbol === 'WETH' ? 'USD' : pool.token.symbol}`);
    console.log(`    Liquidity (USD) : $${pool.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    console.log(`    Collaterals     : ${pool.collateralSymbols.length > 0 ? pool.collateralSymbols.join(', ') : '(none)'}`);

    if (pool.vaultAllocations.length > 0) {
      console.log(`    Allocations (${pool.vaultAllocations.length}):`);
      for (const a of pool.vaultAllocations) {
        console.log(
          `      - ${a.vaultName.padEnd(30)} ${a.percentage.toFixed(1).padStart(6)}%  APY=${a.apy !== null ? a.apy.toFixed(2) + '%' : 'N/A'}  Util=${a.utilization.toFixed(1)}%`,
        );
      }
    }

    if (pool.nextMarketForSupply) {
      const n = pool.nextMarketForSupply;
      console.log(`    Next supply mkt : ${n.marketName} (APY ${n.currentSupplyApy}%, util ${n.utilization}%, cap remaining $${n.remainingCapUsd.toLocaleString()})`);
    }

    const irm = pool.interestRateStrategy;
    if (irm) {
      console.log(`    IRM model       : ${irm.modelType}`);
      console.log(`    Perf. fee       : ${((irm.performanceFee ?? 0) * 100).toFixed(2)}%`);
      console.log(`    Supply APY (IRM): ${(irm.currentSupplyApy ?? 0).toFixed(4)}%`);
      if (irm.maxMarketUtilization !== undefined) {
        console.log(`    Max mkt util.   : ${(irm.maxMarketUtilization * 100).toFixed(2)}%`);
      }
    }

    console.log('─'.repeat(100));
  }

  // Print full JSON for the first vault as a reference
  if (pools.length > 0) {
    console.log('\n\n=== Full JSON for first vault ===\n');
    console.log(JSON.stringify(pools[0], null, 2));
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
