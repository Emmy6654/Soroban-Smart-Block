import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("bigintOrZero helper", () => {
  const bigintOrZero = (val) => {
    if (val == null) return 0n;
    try {
      const str = String(val);
      return /^\d+$/.test(str) ? BigInt(str) : 0n;
    } catch { return 0n; }
  };

  it("converts valid inputs to BigInt", async () => {
    assert.equal(bigintOrZero("100"), 100n);
    assert.equal(bigintOrZero(42), 42n);
    assert.equal(bigintOrZero(100n), 100n);
    assert.equal(bigintOrZero("9999999999999999999"), 9999999999999999999n);
  });

  it("returns 0n for null/undefined/invalid", async () => {
    assert.equal(bigintOrZero(null), 0n);
    assert.equal(bigintOrZero(undefined), 0n);
    assert.equal(bigintOrZero("abc"), 0n);
    assert.equal(bigintOrZero("12.5"), 0n);
  });
});

describe("TVL computation logic", () => {
  it("sums reserves across pools for a protocol", async () => {
    const computeTVL = (pools) => {
      if (pools.length === 0) return null;
      let totalTVL = 0n;
      for (const pool of pools) {
        for (const reserve of pool.reserves) {
          totalTVL += typeof reserve === "bigint" ? reserve : BigInt(reserve);
        }
      }
      return { tvl_raw: String(totalTVL), pool_count: pools.length };
    };

    const pools = [
      { id: "pool_a", reserves: [1000n, 2000n] },
      { id: "pool_b", reserves: [500n, 1500n] },
    ];

    const result = computeTVL(pools);
    assert.equal(result.tvl_raw, "5000");
    assert.equal(result.pool_count, 2);
  });

  it("returns null for empty pool list", async () => {
    const computeTVL = (pools) => {
      if (pools.length === 0) return null;
      let totalTVL = 0n;
      for (const pool of pools) {
        for (const reserve of pool.reserves) {
          totalTVL += typeof reserve === "bigint" ? reserve : BigInt(reserve);
        }
      }
      return { tvl_raw: String(totalTVL), pool_count: pools.length };
    };

    assert.equal(computeTVL([]), null);
  });

  it("handles single pool with single reserve", async () => {
    const computeTVL = (pools) => {
      if (pools.length === 0) return null;
      let totalTVL = 0n;
      for (const pool of pools) {
        for (const reserve of pool.reserves) {
          totalTVL += typeof reserve === "bigint" ? reserve : BigInt(reserve);
        }
      }
      return { tvl_raw: String(totalTVL), pool_count: pools.length };
    };

    const result = computeTVL([{ id: "pool", reserves: [42n] }]);
    assert.equal(result.tvl_raw, "42");
    assert.equal(result.pool_count, 1);
  });
});

describe("reserve extraction", () => {
  it("maps pool reserves to token amounts", async () => {
    const buildTokenBreakdown = (reserves) => {
      const breakdown = [];
      for (const { token, reserve } of reserves) {
        breakdown.push({ token, amount: String(reserve) });
      }
      return breakdown;
    };

    const reserves = [
      { token: "token_a", reserve: 1000n },
      { token: "token_b", reserve: 2000n },
    ];

    const breakdown = buildTokenBreakdown(reserves);
    assert.equal(breakdown.length, 2);
    assert.equal(breakdown[0].token, "token_a");
    assert.equal(breakdown[0].amount, "1000");
    assert.equal(breakdown[1].token, "token_b");
    assert.equal(breakdown[1].amount, "2000");
  });

  it("aggregates reserves per token across pools", async () => {
    const aggregateReserves = (poolReserves) => {
      const total = new Map();
      for (const { token, reserve } of poolReserves) {
        const current = total.get(token) || 0n;
        total.set(token, current + (typeof reserve === "bigint" ? reserve : BigInt(reserve)));
      }
      return Array.from(total.entries()).map(([token, amount]) => ({
        token,
        amount: String(amount),
      }));
    };

    const poolReserves = [
      { token: "token_a", reserve: 1000n },
      { token: "token_b", reserve: 2000n },
      { token: "token_a", reserve: 500n },
    ];

    const breakdown = aggregateReserves(poolReserves);
    assert.equal(breakdown.length, 2);
    const tokenA = breakdown.find(b => b.token === "token_a");
    const tokenB = breakdown.find(b => b.token === "token_b");
    assert.equal(tokenA.amount, "1500");
    assert.equal(tokenB.amount, "2000");
  });
});
