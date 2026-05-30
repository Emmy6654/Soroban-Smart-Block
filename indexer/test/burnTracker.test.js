import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("burn event extraction", () => {
  const extractBurnData = (decoded) => {
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

    return {
      contract_id,
      from_address: fromAddr,
      amount,
      ledger,
      tx_hash,
    };
  };

  it("extracts burn event data from decoded event", async () => {
    const decoded = {
      contract_id: "CA3Q2KQ4ZPFH3QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5ABCD",
      function: "burn",
      ledger: 12345,
      tx_hash: "abc123",
      raw_topics: ["burn", "GDUV6J2Z7M7V5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5EXAMPLE"],
      raw_data: '{"amount":"5000000"}',
    };

    const result = extractBurnData(decoded);
    assert.notEqual(result, null);
    assert.equal(result.contract_id, decoded.contract_id);
    assert.equal(result.from_address, "GDUV6J2Z7M7V5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5EXAMPLE");
    assert.equal(result.amount, "5000000");
    assert.equal(result.ledger, 12345);
    assert.equal(result.tx_hash, "abc123");
  });

  it("returns null for non-burn events", async () => {
    const decoded = {
      contract_id: "CA3Q2KQ4ZPFH3QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5ABCD",
      function: "transfer",
      raw_topics: ["transfer", "from", "to"],
      raw_data: "100",
    };

    const result = extractBurnData(decoded);
    assert.equal(result, null);
  });

  it("handles burn with amount-only data (no object)", async () => {
    const decoded = {
      contract_id: "CA3Q2KQ4ZPFH3QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5ABCD",
      function: "burn",
      ledger: 54321,
      raw_topics: ["burn", "GDUV6J2Z7M7V5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5EXAMPLE"],
      raw_data: "10000000",
    };

    const result = extractBurnData(decoded);
    assert.notEqual(result, null);
    assert.equal(result.amount, "10000000");
  });

  it("returns null when contract_id is missing", async () => {
    const decoded = {
      contract_id: null,
      function: "burn",
      raw_topics: ["burn", "GDUV6J2Z7M7V5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5Z5X5EXAMPLE"],
      raw_data: "100",
    };

    const result = extractBurnData(decoded);
    assert.equal(result, null);
  });
});

describe("burn sac bridge detection", () => {
  const NATIVE_SAC_IDS = new Set([
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  ]);

  const isNativeSac = (contractId) => NATIVE_SAC_IDS.has(contractId);

  it("detects native XLM SAC burns as bridge", async () => {
    const testnetNative = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    assert.ok(isNativeSac(testnetNative));
  });

  it("does not flag non-SAC contracts as bridge", async () => {
    const randomContract = "CA3Q2KQ4ZPFH3QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5QJZ5ABCD";
    assert.ok(!isNativeSac(randomContract));
  });

  it("flags mainnet native XLM SAC as bridge", async () => {
    const mainnetNative = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
    assert.ok(isNativeSac(mainnetNative));
  });
});

describe("burn metrics computation", () => {
  it("aggregates burn amounts per asset", async () => {
    const aggregateBurns = (burns) => {
      const metrics = new Map();
      for (const b of burns) {
        const key = b.asset_code || b.contract_id;
        const existing = metrics.get(key) || { total_burned: 0n, burn_count: 0 };
        existing.total_burned += BigInt(b.amount);
        existing.burn_count += 1;
        metrics.set(key, existing);
      }
      return Array.from(metrics.entries()).map(([asset, m]) => ({
        asset,
        total_burned: String(m.total_burned),
        burn_count: m.burn_count,
      }));
    };

    const burns = [
      { asset_code: "XLM", amount: "10000000", contract_id: "sac_xlm" },
      { asset_code: "XLM", amount: "5000000", contract_id: "sac_xlm" },
      { asset_code: "USDC", amount: "2000000", contract_id: "sac_usdc" },
    ];

    const metrics = aggregateBurns(burns);
    assert.equal(metrics.length, 2);

    const xlm = metrics.find(m => m.asset === "XLM");
    const usdc = metrics.find(m => m.asset === "USDC");
    assert.equal(xlm.total_burned, "15000000");
    assert.equal(xlm.burn_count, 2);
    assert.equal(usdc.total_burned, "2000000");
    assert.equal(usdc.burn_count, 1);
  });

  it("returns empty for no burns", async () => {
    const aggregateBurns = (burns) => {
      const metrics = new Map();
      for (const b of burns) {
        const key = b.asset_code || b.contract_id;
        const existing = metrics.get(key) || { total_burned: 0n, burn_count: 0 };
        existing.total_burned += BigInt(b.amount);
        existing.burn_count += 1;
        metrics.set(key, existing);
      }
      return Array.from(metrics.entries()).map(([asset, m]) => ({
        asset,
        total_burned: String(m.total_burned),
        burn_count: m.burn_count,
      }));
    };

    const metrics = aggregateBurns([]);
    assert.equal(metrics.length, 0);
  });
});

describe("bridge classification", () => {
  it("classifies SAC contract burns as bridge", () => {
    const classifyBurn = (contractId, assetCode) => {
      const isSac = assetCode !== null;
      return { is_sac_bridge: isSac, asset_code: assetCode };
    };

    assert.equal(classifyBurn("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", "XLM").is_sac_bridge, true);
    assert.equal(classifyBurn("random_contract", null).is_sac_bridge, false);
  });
});
