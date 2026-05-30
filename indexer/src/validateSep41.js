/**
 * SEP-41 compliance validator.
 *
 * Simulates each mandatory SEP-41 interface function against the target
 * contract. A simulation error means the function exists but rejected our
 * dummy args (expected). A "not found" / "no such function" error means the
 * function is absent (non-compliant).
 *
 * Usage:
 *   node src/validateSep41.js <contractId>
 */
import "dotenv/config";
import {
  SorobanRpc,
  TransactionBuilder,
  Networks,
  Account,
  Contract,
  nativeToScVal,
  Address,
} from "@stellar/stellar-sdk";

const RPC_URL            = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
const DUMMY_SOURCE       = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });

// Dummy ScVal arguments for each mandatory function signature
const DUMMY_ADDR = nativeToScVal(Address.fromString(DUMMY_SOURCE), { type: "address" });
const DUMMY_I128 = nativeToScVal(0n, { type: "i128" });

const SEP41_FUNCTIONS = [
  { name: "name",        args: [] },
  { name: "symbol",      args: [] },
  { name: "decimals",    args: [] },
  { name: "balance",     args: [DUMMY_ADDR] },
  { name: "allowance",   args: [DUMMY_ADDR, DUMMY_ADDR] },
  { name: "transfer",    args: [DUMMY_ADDR, DUMMY_ADDR, DUMMY_I128] },
  { name: "transfer_from", args: [DUMMY_ADDR, DUMMY_ADDR, DUMMY_ADDR, DUMMY_I128] },
  { name: "approve",     args: [DUMMY_ADDR, DUMMY_ADDR, DUMMY_I128, nativeToScVal(0, { type: "u32" })] },
  { name: "burn",        args: [DUMMY_ADDR, DUMMY_I128] },
  { name: "burn_from",   args: [DUMMY_ADDR, DUMMY_ADDR, DUMMY_I128] },
];

// Errors that indicate the function exists but rejected our dummy inputs
const EXECUTION_ERROR_PATTERNS = [
  /wasm trap/i,
  /contract error/i,
  /invalid/i,
  /unauthorized/i,
  /insufficient/i,
  /overflow/i,
];

function isExecutionError(msg) {
  return EXECUTION_ERROR_PATTERNS.some(p => p.test(msg));
}

async function functionExists(contract, fnName, args) {
  const account = new Account(DUMMY_SOURCE, "0");
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fnName, ...args))
    .setTimeout(30)
    .build();

  const result = await rpc.simulateTransaction(tx);

  if (!SorobanRpc.Api.isSimulationError(result)) return true; // success → exists

  // If the error looks like a runtime/logic error the function is present
  if (isExecutionError(result.error)) return true;

  // Otherwise assume the function is missing
  return false;
}

/**
 * Validate SEP-41 compliance for a contract.
 * @param {string} contractId
 * @returns {Promise<{ compliant: boolean, results: Record<string, boolean> }>}
 */
export async function validateSep41(contractId) {
  const contract = new Contract(contractId);
  const results  = {};

  await Promise.all(
    SEP41_FUNCTIONS.map(async ({ name, args }) => {
      try {
        results[name] = await functionExists(contract, name, args);
      } catch {
        results[name] = false;
      }
    })
  );

  const compliant = Object.values(results).every(Boolean);
  return { compliant, results };
}

// CLI entry point
if (process.argv[1].endsWith("validateSep41.js")) {
  const contractId = process.argv[2];
  if (!contractId) { console.error("Usage: node src/validateSep41.js <contractId>"); process.exit(1); }

  validateSep41(contractId).then(({ compliant, results }) => {
    console.log(`\nSEP-41 compliance for ${contractId}:`);
    for (const [fn, ok] of Object.entries(results)) {
      console.log(`  ${ok ? "✓" : "✗"} ${fn}`);
    }
    console.log(`\nResult: ${compliant ? "COMPLIANT ✓" : "NON-COMPLIANT ✗"}`);
    process.exit(compliant ? 0 : 1);
  }).catch(err => { console.error(err); process.exit(1); });
}
