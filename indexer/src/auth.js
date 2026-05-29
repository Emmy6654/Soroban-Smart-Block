import { xdr, StrKey } from "@stellar/stellar-sdk";
import { scValToJs } from "./scval.js";

/**
 * Extract and decode the ContractAuth (SorobanAuthorizationEntry) array
 * from an InvokeHostFunctionOp XDR base64 string or xdr.Operation object.
 *
 * @param {string|xdr.Operation} input - base64 XDR envelope/operation or parsed object
 * @returns {Array<{signer: string|null, nonce: BigInt|null, rootInvocation: object}>}
 */
export function extractContractAuth(input) {
  let op;

  if (typeof input === "string") {
    // Accept a full TransactionEnvelope or a bare Operation in base64
    try {
      const envelope = xdr.TransactionEnvelope.fromXDR(input, "base64");
      const tx = envelope.value().tx ? envelope.value().tx() : envelope.value();
      op = tx.operations()[0].body().invokeHostFunctionOp();
    } catch {
      op = xdr.Operation.fromXDR(input, "base64").body().invokeHostFunctionOp();
    }
  } else {
    // Already a parsed InvokeHostFunctionOp
    op = input;
  }

  const authEntries = op.auth() ?? [];

  return authEntries.map(decodeAuthEntry);
}

/**
 * Decode a single SorobanAuthorizationEntry into a plain object.
 *
 * @param {xdr.SorobanAuthorizationEntry} entry
 * @returns {{ signer: string|null, nonce: BigInt|null, rootInvocation: object }}
 */
function decodeAuthEntry(entry) {
  const credentials = entry.credentials();
  const credType = credentials.switch().name;

  let signer = null;
  let nonce = null;

  if (credType === "sorobanCredentialsAddress") {
    const addrCreds = credentials.address();
    const addr = addrCreds.address();
    const addrType = addr.switch().name;

    if (addrType === "scAddressTypeAccount") {
      signer = StrKey.encodeEd25519PublicKey(addr.accountId().ed25519());
    } else if (addrType === "scAddressTypeContract") {
      signer = StrKey.encodeContract(addr.contractId());
    }

    nonce = BigInt(addrCreds.nonce().toString());
  }
  // sorobanCredentialsSourceAccount has no signer/nonce fields

  const rootInvocation = decodeInvocation(entry.rootInvocation());

  return { signer, nonce, rootInvocation };
}

/**
 * Recursively decode a SorobanAuthorizedInvocation.
 *
 * @param {xdr.SorobanAuthorizedInvocation} invocation
 * @returns {{ function: object, subInvocations: object[] }}
 */
function decodeInvocation(invocation) {
  const fn = invocation.function();
  const fnType = fn.switch().name;

  let decodedFn;

  if (fnType === "sorobanAuthorizedFunctionTypeContractFn") {
    const contractFn = fn.contractFn();
    const contractAddress = contractFn.contractAddress();
    const addrType = contractAddress.switch().name;

    let contractId;
    if (addrType === "scAddressTypeContract") {
      contractId = StrKey.encodeContract(contractAddress.contractId());
    } else {
      contractId = contractAddress.toString();
    }

    decodedFn = {
      type: "contractFn",
      contractId,
      functionName: contractFn.functionName().toString(),
      args: (contractFn.args() ?? []).map(scValToJs),
    };
  } else if (fnType === "sorobanAuthorizedFunctionTypeCreateContractHostFn") {
    decodedFn = { type: "createContract" };
  } else {
    decodedFn = { type: fnType };
  }

  return {
    function: decodedFn,
    subInvocations: (invocation.subInvocations() ?? []).map(decodeInvocation),
  };
}
