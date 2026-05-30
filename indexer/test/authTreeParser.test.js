import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { xdr, StrKey } from "@stellar/stellar-sdk";
import { parseAuthTree } from "../src/authTreeParser.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CONTRACT_A = Buffer.alloc(32, 0x01);
const CONTRACT_B = Buffer.alloc(32, 0x02);
const CONTRACT_C = Buffer.alloc(32, 0x03);
const ACCOUNT_KEY = Buffer.alloc(32, 0xaa);

const CONTRACT_A_ID = StrKey.encodeContract(CONTRACT_A);
const CONTRACT_B_ID = StrKey.encodeContract(CONTRACT_B);
const CONTRACT_C_ID = StrKey.encodeContract(CONTRACT_C);
const ACCOUNT_ADDR  = StrKey.encodeEd25519PublicKey(ACCOUNT_KEY);

/**
 * Build a SorobanAuthorizedInvocation for a contract function call,
 * optionally with nested sub-invocations.
 */
function makeInvocation(contractBytes, fnName, subInvocations = []) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: xdr.ScAddress.scAddressTypeContract(contractBytes),
        functionName: fnName,
        args: [],
      })
    ),
    subInvocations,
  });
}

/**
 * Build a SorobanAuthorizationEntry with address credentials.
 */
function makeAddressAuthEntry(accountKeyBytes, rootInvocation) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: xdr.ScAddress.scAddressTypeAccount(
          xdr.AccountId.publicKeyTypeEd25519(accountKeyBytes)
        ),
        nonce: xdr.Int64.fromString("0"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation,
  }).toXDR("base64");
}

/**
 * Build a SorobanAuthorizationEntry with source-account credentials.
 */
function makeSourceAuthEntry(rootInvocation) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation,
  }).toXDR("base64");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("parseAuthTree", () => {
  it("returns empty array for no entries", () => {
    assert.deepEqual(parseAuthTree([]), []);
  });

  it("parses a single flat address-credential entry", () => {
    const xdrStr = makeAddressAuthEntry(ACCOUNT_KEY, makeInvocation(CONTRACT_A, "transfer"));
    const [layer] = parseAuthTree([xdrStr]);

    assert.equal(layer.signer, ACCOUNT_ADDR);
    assert.equal(layer.invocations.length, 1);
    assert.equal(layer.invocations[0].depth, 0);
    assert.equal(layer.invocations[0].scope, `${CONTRACT_A_ID}:transfer`);
  });

  it("parses a source_account credential entry", () => {
    const xdrStr = makeSourceAuthEntry(makeInvocation(CONTRACT_A, "mint"));
    const [layer] = parseAuthTree([xdrStr]);

    assert.equal(layer.signer, "source_account");
    assert.equal(layer.invocations[0].scope, `${CONTRACT_A_ID}:mint`);
  });

  it("recursively captures nested sub-invocations with correct depth", () => {
    const root = makeInvocation(CONTRACT_A, "swap", [
      makeInvocation(CONTRACT_B, "transfer", [
        makeInvocation(CONTRACT_C, "burn"),
      ]),
    ]);
    const xdrStr = makeAddressAuthEntry(ACCOUNT_KEY, root);
    const [layer] = parseAuthTree([xdrStr]);

    assert.equal(layer.invocations.length, 3);
    assert.deepEqual(layer.invocations, [
      { depth: 0, scope: `${CONTRACT_A_ID}:swap` },
      { depth: 1, scope: `${CONTRACT_B_ID}:transfer` },
      { depth: 2, scope: `${CONTRACT_C_ID}:burn` },
    ]);
  });

  it("handles multiple auth entries (multi-signer) preserving order", () => {
    const signerA = Buffer.alloc(32, 0xaa);
    const signerB = Buffer.alloc(32, 0xbb);

    const entries = [
      makeAddressAuthEntry(signerA, makeInvocation(CONTRACT_A, "approve")),
      makeAddressAuthEntry(signerB, makeInvocation(CONTRACT_B, "execute")),
    ];
    const layers = parseAuthTree(entries);

    assert.equal(layers.length, 2);
    assert.equal(layers[0].signer, StrKey.encodeEd25519PublicKey(signerA));
    assert.equal(layers[0].invocations[0].scope, `${CONTRACT_A_ID}:approve`);
    assert.equal(layers[1].signer, StrKey.encodeEd25519PublicKey(signerB));
    assert.equal(layers[1].invocations[0].scope, `${CONTRACT_B_ID}:execute`);
  });

  it("handles a root with multiple parallel sub-invocations", () => {
    const root = makeInvocation(CONTRACT_A, "batch", [
      makeInvocation(CONTRACT_B, "step1"),
      makeInvocation(CONTRACT_C, "step2"),
    ]);
    const [layer] = parseAuthTree([makeAddressAuthEntry(ACCOUNT_KEY, root)]);

    assert.equal(layer.invocations.length, 3);
    assert.equal(layer.invocations[0].scope, `${CONTRACT_A_ID}:batch`);
    assert.equal(layer.invocations[1].scope, `${CONTRACT_B_ID}:step1`);
    assert.equal(layer.invocations[2].scope, `${CONTRACT_C_ID}:step2`);
  });

  it("scope format is CONTRACT_ID:functionName", () => {
    const xdrStr = makeAddressAuthEntry(ACCOUNT_KEY, makeInvocation(CONTRACT_A, "my_fn"));
    const [layer] = parseAuthTree([xdrStr]);
    assert.match(layer.invocations[0].scope, /^C[A-Z2-7]{55}:my_fn$/);
  });
});
