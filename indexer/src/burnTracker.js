import { db } from "./db.js";
import { detectSac } from "./sac.js";
import { publishBurn } from "./wsEvents.js";

const NATIVE_SAC_IDS = new Set([
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
]);

const NATIVE_SAC_LABEL = "XLM";

function isNativeSac(contractId) {
  return NATIVE_SAC_IDS.has(contractId);
}

function extractBurnData(decoded) {
  const { contract_id, function: fn, raw_topics, raw_data, ledger, tx_hash } = decoded;
  if (fn !== "burn" || !contract_id) return null;

  const topics = raw_topics;
  if (!topics || topics.length < 2) return null;

  const fromAddr = topics[1] ? String(topics[1]) : null;

  let amount;
  try {
    const parsed = JSON.parse(raw_data);
    if (typeof parsed === "object" && parsed !== null) {
      amount = parsed.amount !== undefined ? String(parsed.amount) : String(parsed);
    } else {
      amount = String(parsed);
    }
  } catch {
    amount = raw_data ? String(raw_data) : "0";
  }

  const { isSac, assetCode } = detectSac(contract_id);
  const isNative = isNativeSac(contract_id);
  const sacBridge = isSac || isNative;
  const code = isNative ? NATIVE_SAC_LABEL : (assetCode || null);

  return {
    contract_id,
    asset_code: code,
    from_address: fromAddr,
    amount,
    ledger,
    tx_hash,
    is_sac_bridge: sacBridge,
  };
}

export async function handleBurnEvent(decoded) {
  const burn = extractBurnData(decoded);
  if (!burn) return null;

  await db.recordBridgeBurn(burn);

  publishBurn({
    contract_id: burn.contract_id,
    asset_code: burn.asset_code,
    amount: burn.amount,
    from_address: burn.from_address,
    ledger: burn.ledger,
    is_sac_bridge: burn.is_sac_bridge,
  });

  const label = burn.asset_code || burn.contract_id.slice(0, 8);
  const bridgeTag = burn.is_sac_bridge ? "bridge-burn" : "burn";
  console.log(
    `[burns] ${bridgeTag} ${label} amount=${burn.amount} from=${burn.from_address?.slice(0, 6)}… @ ledger=${burn.ledger}`
  );

  return burn;
}

export async function computeBurnMetrics(ledger) {
  try {
    const rows = await db.getBurnAggregation();

    for (const row of rows) {
      await db.upsertBurnMetric({
        asset_code: row.asset_code,
        contract_id: row.contract_id,
        total_burned: row.total_burned,
        burn_count: row.burn_count,
        ledger,
      });
    }

    if (rows.length > 0) {
      console.log(`[burns] Computed metrics for ${rows.length} asset(s) @ ledger=${ledger}`);
    }
  } catch (err) {
    console.error(`[burns] computeBurnMetrics error: ${err.message}`);
  }
}

export async function bootstrapBurnTracker() {
  try {
    const { SorobanRpc } = await import("@stellar/stellar-sdk");
    const rpcUrl = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
    const server = new SorobanRpc.Server(rpcUrl, { allowHttp: true });
    const ledger = await server.getLatestLedger();
    await computeBurnMetrics(ledger.sequence);
    console.log(`[burns] Bootstrap complete @ ledger=${ledger.sequence}`);
  } catch (err) {
    console.error(`[burns] Bootstrap error: ${err.message}`);
  }
}
