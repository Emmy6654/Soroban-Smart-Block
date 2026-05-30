import { SorobanRpc, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { db } from "./db.js";
import { publishTVL } from "./wsEvents.js";
import { withRetry } from "./rpcRetry.js";

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const rpc     = new SorobanRpc.Server(RPC_URL, { allowHttp: true });

const RESERVE_FUNCTIONS = ["get_reserves", "getReserves", "reserves"];

function bigintOrZero(val) {
  if (val == null) return 0n;
  try {
    const str = String(val);
    return /^\d+$/.test(str) ? BigInt(str) : 0n;
  } catch { return 0n; }
}

async function simulateView(contractId, fn, ...args) {
  const contract = new Contract(contractId);
  const scArgs = args.map(a => nativeToScVal(a, { type: { type: "val" } }));
  const op = contract.call(fn, ...scArgs);

  const source = process.env.SIMULATE_SOURCE || "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
  const account = await withRetry(() => rpc.getAccount(source));
  const { TransactionBuilder, Networks, BASE_FEE, scValToNative } = await import("@stellar/stellar-sdk");

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await withRetry(() => rpc.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation error for ${contractId}.${fn}: ${sim.error}`);
  }

  const retval = sim.result?.retval;
  if (!retval) throw new Error(`No return value from ${contractId}.${fn}`);
  return scValToNative(retval);
}

async function fetchPoolReserves(poolId) {
  for (const fn of RESERVE_FUNCTIONS) {
    try {
      const result = await simulateView(poolId, fn);
      if (result && typeof result === "object") {
        const vals = Object.values(result).filter(v => typeof v === "bigint" || typeof v === "number" || typeof v === "string");
        if (vals.length >= 2) return vals.map(v => bigintOrZero(v));
      }
      if (Array.isArray(result) && result.length >= 2) {
        return result.map(v => bigintOrZero(v));
      }
    } catch {}
  }
  return null;
}

async function fetchTokenBalance(poolId, tokenId) {
  try {
    return bigintOrZero(await simulateView(tokenId, "balance", poolId));
  } catch {
    return null;
  }
}

async function computePoolReserves(poolId) {
  try {
    const pool = await db.getPool(poolId);
    if (!pool) return null;

    let reserves = await fetchPoolReserves(poolId);
    if (reserves && reserves.length >= 2) {
      const tokenReserves = [];
      if (pool.token_a) {
        tokenReserves.push({ token: pool.token_a, reserve: reserves[0] });
      }
      if (pool.token_b && reserves[1] !== undefined) {
        tokenReserves.push({ token: pool.token_b, reserve: reserves[1] });
      }
      return tokenReserves;
    }

    const tokenReserves = [];
    if (pool.token_a) {
      const bal = await fetchTokenBalance(poolId, pool.token_a);
      if (bal != null) tokenReserves.push({ token: pool.token_a, reserve: bal });
    }
    if (pool.token_b) {
      const bal = await fetchTokenBalance(poolId, pool.token_b);
      if (bal != null) tokenReserves.push({ token: pool.token_b, reserve: bal });
    }
    return tokenReserves.length > 0 ? tokenReserves : null;
  } catch (err) {
    console.error(`[tvl] Failed to compute reserves for ${poolId.slice(0, 8)}…: ${err.message}`);
    return null;
  }
}

async function computeTVL(protocol) {
  try {
    const pools = await db.getPoolsByProtocol(protocol);
    if (pools.length === 0) return null;

    const totalReserves = new Map();
    let totalTVL = 0n;

    for (const pool of pools) {
      const reserves = await computePoolReserves(pool.id);
      if (!reserves) continue;

      for (const { token, reserve } of reserves) {
        const current = totalReserves.get(token) || 0n;
        totalReserves.set(token, current + reserve);
        totalTVL += reserve;
      }
    }

    return {
      protocol,
      tvl_raw: String(totalTVL),
      token_breakdown: Array.from(totalReserves.entries()).map(([token, amount]) => ({
        token,
        amount: String(amount),
      })),
      pool_count: pools.length,
    };
  } catch (err) {
    console.error(`[tvl] computeTVL error for ${protocol}: ${err.message}`);
    return null;
  }
}

export async function refreshPool(poolId, ledger) {
  try {
    const pool = await db.getPool(poolId);
    if (!pool) return;

    const reserves = await computePoolReserves(poolId);
    if (!reserves) return;

    for (const { token, reserve } of reserves) {
      await db.upsertPoolReserve({
        pool_id: poolId,
        token,
        reserve: String(reserve),
        ledger,
      });
    }

    console.log(
      `[tvl] Pool ${poolId.slice(0, 8)}… reserves updated @ ledger=${ledger} ` +
      `(${reserves.map(r => `${r.token.slice(0, 6)}…=${r.reserve}`).join(", ")})`
    );
  } catch (err) {
    console.error(`[tvl] Failed to refresh pool ${poolId.slice(0, 8)}…: ${err.message}`);
  }
}

export async function computeAndStoreTVL(protocol, ledger) {
  try {
    const tvl = await computeTVL(protocol);
    if (!tvl) return;

    await db.upsertTVLSnapshot({
      protocol: tvl.protocol,
      tvl_raw: tvl.tvl_raw,
      token_breakdown: JSON.stringify(tvl.token_breakdown),
      pool_count: tvl.pool_count,
      ledger,
    });

    publishTVL(tvl);

    console.log(
      `[tvl] ${protocol} TVL=${tvl.tvl_raw} pools=${tvl.pool_count} @ ledger=${ledger}`
    );
  } catch (err) {
    console.error(`[tvl] computeAndStoreTVL error for ${protocol}: ${err.message}`);
  }
}

export async function refreshAllProtocols() {
  try {
    const protocols = await db.getDistinctProtocols();
    if (protocols.length === 0) return;

    const ledger = await withRetry(() => rpc.getLatestLedger());
    const seq = ledger.sequence;

    const poolIds = await db.getActivePoolIds();
    await Promise.allSettled(poolIds.map(id => refreshPool(id, seq)));

    await Promise.allSettled(protocols.map(p => computeAndStoreTVL(p, seq)));
  } catch (err) {
    console.error(`[tvl] refreshAllProtocols error: ${err.message}`);
  }
}

export async function bootstrapTVLIndexer() {
  try {
    const ledger = await withRetry(() => rpc.getLatestLedger());
    const seq = ledger.sequence;

    const poolIds = await db.getActivePoolIds();
    if (poolIds.length === 0) return;

    await Promise.allSettled(poolIds.map(id => refreshPool(id, seq)));

    const protocols = await db.getDistinctProtocols();
    await Promise.allSettled(protocols.map(p => computeAndStoreTVL(p, seq)));

    console.log(`[tvl] Bootstrap complete: ${poolIds.length} pools, ${protocols.length} protocols`);
  } catch (err) {
    console.error(`[tvl] Bootstrap error: ${err.message}`);
  }
}
