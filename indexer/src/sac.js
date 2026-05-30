/**
 * SAC (Stellar Asset Contract) bridge detection.
 *
 * The SAC contract ID is deterministically derived from a classic asset
 * using the Stellar SDK's Contract.fromAsset() helper.
 */
import { Asset, Contract, Networks } from "@stellar/stellar-sdk";

const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;

/**
 * Build a lookup map of SAC contract ID → classic asset code for a list of assets.
 * @param {Array<{code: string, issuer?: string}>} assets
 * @returns {Map<string, string>}  contractId → "USDC" | "XLM" etc.
 */
function buildSacMap(assets) {
  const map = new Map();
  for (const { code, issuer } of assets) {
    try {
      const asset = issuer ? new Asset(code, issuer) : Asset.native();
      const contractId = new Contract(asset.contractId(NETWORK_PASSPHRASE)).contractId();
      map.set(contractId, issuer ? code : "XLM");
    } catch {
      // skip malformed entries
    }
  }
  return map;
}

// Well-known SAC assets (extend as needed via env or config)
const KNOWN_ASSETS = [
  { code: "native" },   // XLM
  ...(process.env.SAC_ASSETS ? JSON.parse(process.env.SAC_ASSETS) : []),
];

const _sacMap = buildSacMap(KNOWN_ASSETS);

/**
 * Detect whether a contract ID corresponds to a classic Stellar Asset Contract.
 * @param {string} contractId  Strkey-encoded contract address
 * @returns {{ isSac: boolean, assetCode: string|null }}
 */
export function detectSac(contractId) {
  const assetCode = _sacMap.get(contractId) ?? null;
  return { isSac: assetCode !== null, assetCode };
}

/**
 * Given a contract ID and a token symbol string from an event, return the
 * display label: prefers the classic asset code when the contract is a SAC.
 * @param {string} contractId
 * @param {string} [fallback]
 * @returns {string}
 */
export function sacLabel(contractId, fallback = contractId) {
  const { isSac, assetCode } = detectSac(contractId);
  return isSac ? assetCode : fallback;
}
