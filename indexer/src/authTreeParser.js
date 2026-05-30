/**
 * Multi-sig authorization tree parser
 *
 * Recursively walks the ContractAuth (SorobanAuthorizationEntry) trees inside
 * a transaction's sorobanData to produce an ordered array of authorization
 * layers, each containing the signer address and its full sub-invocation
 * function scope.
 */

import { xdr, StrKey } from "@stellar/stellar-sdk";

/**
 * Decode a SorobanCredentials object to a signer address string.
 * Returns "source_account" for implicit source-account authorization.
 *
 * @param {xdr.SorobanCredentials} creds
 * @returns {string}
 */
function signerFromCredentials(creds) {
  if (creds.switch().name === "sorobanCredentialsSourceAccount") {
    return "source_account";
  }
  const scAddr = creds.address().address();
  const addrType = scAddr.switch().name;
  if (addrType === "scAddressTypeAccount") {
    return StrKey.encodeEd25519PublicKey(scAddr.accountId().ed25519());
  }
  if (addrType === "scAddressTypeContract") {
    return StrKey.encodeContract(scAddr.contractId());
  }
  return "unknown";
}

/**
 * Decode a SorobanAuthorizedFunction to a human-readable scope string.
 *
 * @param {xdr.SorobanAuthorizedFunction} fn
 * @returns {string}  e.g. "CONTRACT:CA…:transfer" or "CREATE_CONTRACT"
 */
function scopeFromFunction(fn) {
  if (fn.switch().name === "sorobanAuthorizedFunctionTypeContractFn") {
    const cf = fn.contractFn();
    const contractId = StrKey.encodeContract(cf.contractAddress().contractId());
    const fnName = cf.functionName().toString();
    return `${contractId}:${fnName}`;
  }
  return "CREATE_CONTRACT";
}

/**
 * Recursively walk a SorobanAuthorizedInvocation tree, collecting every
 * function scope in depth-first order.
 *
 * @param {xdr.SorobanAuthorizedInvocation} invocation
 * @param {number} depth  current nesting depth (0 = root)
 * @returns {Array<{ depth: number, scope: string }>}
 */
function walkInvocation(invocation, depth = 0) {
  const scope = scopeFromFunction(invocation.function());
  const result = [{ depth, scope }];
  for (const sub of invocation.subInvocations()) {
    result.push(...walkInvocation(sub, depth + 1));
  }
  return result;
}

/**
 * Parse an array of base64-encoded SorobanAuthorizationEntry XDR strings into
 * an ordered array of authorization layers.
 *
 * Each layer describes one signer and the complete tree of contract functions
 * that signer authorizes, in depth-first traversal order.
 *
 * @param {string[]} authEntryXdrs  base64-encoded SorobanAuthorizationEntry values
 * @returns {Array<{
 *   signer:       string,
 *   invocations:  Array<{ depth: number, scope: string }>
 * }>}
 */
export function parseAuthTree(authEntryXdrs) {
  return authEntryXdrs.map(b64 => {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(b64, "base64");
    return {
      signer:      signerFromCredentials(entry.credentials()),
      invocations: walkInvocation(entry.rootInvocation()),
    };
  });
}
