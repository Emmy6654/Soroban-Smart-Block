import { SorobanRpc, xdr, StrKey } from "@stellar/stellar-sdk";
import { withRetry } from "./rpcRetry.js";

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });

/**
 * Fetch the on-chain WASM spec for a contract.
 * Returns an array of { name: string, args: { name: string, type: string }[] }
 * or null if the contract doesn't exist.
 */
export async function fetchContractSpec(contractId) {
  try {
    const key = xdr.LedgerKey.contractData(
      xdr.LedgerKeyContractData.withContractId(
        StrKey.decodeContract(contractId)
      )
    );
    key.ext(xdr.LedgerKeyExtensionV0.withV0({}));

    const res = await withRetry(() => rpc.getLedgerEntry(key));
    if (!res?.val) return null;

    const data = res.val;
    if (data.contractData().ext().v() !== 0) return null;

    const entry = data.contractData().val();
    if (entry.switch().name !== "scvContractInstance") return null;

    const instance = entry.contractInstance();
    const spec = instance.spec();

    if (!spec) return [];

    const result = [];
    for (const entry of spec) {
      const funcDesc = xdr.ScSpecFunction.fromXDR(entry);
      result.push({
        name: funcDesc.name().toString(),
        args: funcDesc.inputs().map(input => ({
          name: input.name().toString(),
          type: input.type().name,
        })),
      });
    }

    return result;
  } catch (err) {
    console.error("Failed to fetch contract spec:", err.message);
    return null;
  }
}

/**
 * Verification result object.
 * @typedef {Object} VerificationResult
 * @property {boolean} valid - Whether the ABI passed verification
 * @property {string[]} errors - List of error messages if invalid
 * @property {Object[]} missingFunctions - Functions in ABI but not on-chain
 * @property {Object[]} argMismatch - Functions with mismatched argument counts
 */

/**
 * Verify an uploaded ABI against the on-chain contract spec.
 * @param {string} contractId - The contract ID (C... or hex)
 * @param {Object[]} abiFunctions - Array of { name: string, params: { name: string, kind: string }[] }
 * @returns {Promise<VerificationResult>}
 */
export async function verifyAbi(contractId, abiFunctions) {
  const spec = await fetchContractSpec(contractId);

  if (spec === null) {
    return {
      valid: false,
      errors: ["Contract not found on-chain or does not have a spec"],
      missingFunctions: [],
      argMismatch: [],
    };
  }

  const errors = [];
  const missingFunctions = [];
  const argMismatch = [];

  // Build a map of on-chain functions for quick lookup
  const specMap = new Map();
  for (const fn of spec) {
    specMap.set(fn.name, fn);
  }

  // Check each uploaded function
  for (const abiFn of abiFunctions) {
    const onChainFn = specMap.get(abiFn.name);

    if (!onChainFn) {
      missingFunctions.push({ name: abiFn.name });
      errors.push(`Function "${abiFn.name}" not found in on-chain spec`);
      continue;
    }

    // Compare argument counts
    const expectedArgs = onChainFn.args.length;
    const actualArgs = abiFn.params?.length || 0;

    if (expectedArgs !== actualArgs) {
      argMismatch.push({
        name: abiFn.name,
        expected: expectedArgs,
        actual: actualArgs,
      });
      errors.push(
        `Function "${abiFn.name}" has ${actualArgs} parameters but on-chain expects ${expectedArgs}`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFunctions,
    argMismatch,
  };
}

/**
 * Validate a single function name against the spec.
 * @returns {boolean} true if valid
 */
export function validateFunctionName(spec, functionName) {
  return spec.some(fn => fn.name === functionName);
}

/**
 * Validate argument count for a function.
 * @returns {boolean} true if counts match
 */
export function validateArgCount(spec, functionName, argCount) {
  const fn = spec.find(f => f.name === functionName);
  if (!fn) return false;
  return fn.args.length === argCount;
}