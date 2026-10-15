/** @module Test-only funding: claim test USDC from Katara's faucet and approve Permit2 so upto payments work. */
import { createPublicClient, createWalletClient, http, maxUint256, parseAbi, type Hex } from 'viem';
import { avalancheFuji } from 'viem/chains';
import { PERMIT2, TEST, explorerTx, type Config } from './config.js';
import { TOKEN_ABI, retryingFetch } from './chain.js';
import { DemoError } from './types.js';

/** Katara's TestUSDCFaucet: claim() mints the configured amount to the caller once per interval. */
export const FAUCET_ABI = parseAbi([
  'function claim()', 'function token() view returns (address)', 'function amount() view returns (uint256)',
  'function canClaim(address account) view returns (bool)', 'function nextClaimAt(address account) view returns (uint64)',
]);
const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
/** Where a wallet gets Fuji AVAX for gas. */
export const FUJI_AVAX_FAUCET = 'https://core.app/tools/testnet-faucet/';

/** What the faucet step did. Amounts are base units: test USDC has six decimals, AVAX eighteen. */
export interface FaucetResult {
  address: string;
  claimed: boolean; claimTransaction?: string;
  /** Unix seconds when the wallet may claim again, when it cannot claim now. */
  nextClaimAt?: string;
  approved: boolean; approveTransaction?: string;
  balanceUnits: string; permit2AllowanceUnits: string; gasWei: string;
}
/** The chain operations the faucet step needs; injectable so tests never reach Fuji. */
export interface FaucetChain {
  chainId(): Promise<number>;
  code(address: Hex): Promise<string | undefined>;
  read(address: Hex, functionName: string, args?: readonly unknown[]): Promise<unknown>;
  gas(): Promise<bigint>;
  /** Estimate a call's total gas cost in wei; throws when the call would revert. */
  cost(address: Hex, abi: 'faucet' | 'approve', functionName: string, args: readonly unknown[]): Promise<bigint>;
  /** Send a call and wait for its successful receipt; returns the transaction hash. */
  send(address: Hex, abi: 'faucet' | 'approve', functionName: string, args: readonly unknown[]): Promise<string>;
}

/**
 * Bind the faucet step to Fuji through the configured RPC. Construction makes no request.
 */
export function fujiChain(config: Config): FaucetChain {
  const transport = http(config.rpc, { retryCount: 0, timeout: 180_000, fetchFn: retryingFetch() });
  const reader = createPublicClient({ chain: avalancheFuji, transport });
  const writer = createWalletClient({ chain: avalancheFuji, transport, account: config.wallet! });
  const abis = { faucet: FAUCET_ABI, approve: APPROVE_ABI };
  return {
    chainId: () => reader.getChainId(),
    code: address => reader.getCode({ address }),
    read: (address, functionName, args = []) => reader.readContract({ address, abi: [...FAUCET_ABI, ...TOKEN_ABI], functionName: functionName as any, args: args as any }),
    gas: () => reader.getBalance({ address: config.wallet!.address }),
    cost: async (address, abi, functionName, args) => {
      const [gas, price] = await Promise.all([
        reader.estimateContractGas({ address, abi: abis[abi], functionName: functionName as any, args: args as any, account: config.wallet! }),
        reader.getGasPrice(),
      ]);
      return gas * price;
    },
    send: async (address, abi, functionName, args) => {
      const hash = await writer.writeContract({ address, abi: abis[abi], functionName: functionName as any, args: args as any, chain: avalancheFuji, account: config.wallet! });
      const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success') throw new DemoError('faucet_transaction_failed');
      return hash;
    },
  };
}

/**
 * Claim test USDC when the wallet may, then approve Permit2 for test USDC when it has no allowance yet.
 * Runs on Avalanche Fuji only. Without enough Fuji AVAX for a transaction it stops before sending anything
 * and says where to get some. It never reads or writes Avalanche C-Chain.
 * @throws DemoError faucet_test_only outside Test mode, chain_configuration_mismatch for an unexpected chain or
 * faucet, and gas_required when the wallet cannot pay for the next transaction.
 */
export async function runFaucet(config: Config, log: (text: string) => void, chain?: FaucetChain): Promise<FaucetResult> {
  if (config.network !== TEST || !config.wallet) throw new DemoError('faucet_test_only', 'The faucet pays out test USDC on Avalanche Fuji. Set KATARA_MODE=test in .env first.');
  chain ??= fujiChain(config);
  const faucet = TEST.faucet; const address = config.wallet.address;
  const [chainId, code, token] = await Promise.all([chain.chainId(), chain.code(faucet), chain.read(faucet, 'token')]);
  if (chainId !== TEST.chainId || !code || code === '0x' || typeof token !== 'string' || token.toLowerCase() !== TEST.asset.toLowerCase()) throw new DemoError('chain_configuration_mismatch');
  const needGas = (step: string) => new DemoError('gas_required', `${step} needs a little Fuji AVAX for gas. Get some for ${address} from ${FUJI_AVAX_FAUCET}, then run npm run faucet again. Nothing was sent.`);
  const result: FaucetResult = { address, claimed: false, approved: false, balanceUnits: '0', permit2AllowanceUnits: '0', gasWei: '0' };
  if (await chain.read(faucet, 'canClaim', [address])) {
    const gas = await chain.gas();
    if (gas === 0n || gas < await chain.cost(faucet, 'faucet', 'claim', [])) throw needGas('Claiming test USDC');
    result.claimTransaction = await chain.send(faucet, 'faucet', 'claim', []);
    result.claimed = true;
    log(`Claimed test USDC for ${address}: ${explorerTx(TEST.network, result.claimTransaction)}`);
  } else {
    result.nextClaimAt = String(await chain.read(faucet, 'nextClaimAt', [address]));
    log(`This wallet already claimed today; it can claim again after ${new Date(Number(result.nextClaimAt) * 1000).toISOString()}.`);
  }
  if ((await chain.read(TEST.asset, 'allowance', [address, PERMIT2])) === 0n) {
    const gas = await chain.gas();
    if (gas === 0n || gas < await chain.cost(TEST.asset, 'approve', 'approve', [PERMIT2, maxUint256])) {
      if (!result.claimed) throw needGas('Approving Permit2');
      log(`Approving Permit2 needs a little more Fuji AVAX. Get some for ${address} from ${FUJI_AVAX_FAUCET} and run npm run faucet again; payments use exact until then.`);
    } else {
      result.approveTransaction = await chain.send(TEST.asset, 'approve', 'approve', [PERMIT2, maxUint256]);
      result.approved = true;
      log(`Approved Permit2 for test USDC, so payments can use upto: ${explorerTx(TEST.network, result.approveTransaction)}`);
    }
  }
  const [balance, allowance, gas] = await Promise.all([chain.read(TEST.asset, 'balanceOf', [address]), chain.read(TEST.asset, 'allowance', [address, PERMIT2]), chain.gas()]);
  Object.assign(result, { balanceUnits: String(balance), permit2AllowanceUnits: String(allowance), gasWei: String(gas) });
  return result;
}
