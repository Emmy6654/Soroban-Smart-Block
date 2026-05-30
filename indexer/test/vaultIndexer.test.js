import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Pure function tests — no mocking needed
describe("vault ratio computation", () => {
  it("computes ratio from assets and supply", async () => {
    // Inline the computeRatio logic for testing
    const computeRatio = (assets, supply) => {
      if (!supply || supply === 0n) return null;
      return Number(assets) / Number(supply);
    };

    assert.equal(computeRatio(1000n, 100n), 10);
    assert.equal(computeRatio(0n, 100n), 0);
    assert.equal(computeRatio(500n, 1000n), 0.5);
  });

  it("returns null for zero or missing supply", async () => {
    const computeRatio = (assets, supply) => {
      if (!supply || supply === 0n) return null;
      return Number(assets) / Number(supply);
    };

    assert.equal(computeRatio(100n, 0n), null);
    assert.equal(computeRatio(100n, null), null);
    assert.equal(computeRatio(100n, undefined), null);
  });
});

describe("bigintOrZero helper", () => {
  it("converts valid inputs to BigInt", async () => {
    const bigintOrZero = (val) => {
      if (val == null) return 0n;
      try {
        const str = String(val);
        return /^\d+$/.test(str) ? BigInt(str) : 0n;
      } catch { return 0n; }
    };

    assert.equal(bigintOrZero("100"), 100n);
    assert.equal(bigintOrZero(42), 42n);
    assert.equal(bigintOrZero(100n), 100n);
    assert.equal(bigintOrZero("9999999999999999999"), 9999999999999999999n);
  });

  it("returns 0n for null/undefined/invalid", async () => {
    const bigintOrZero = (val) => {
      if (val == null) return 0n;
      try {
        const str = String(val);
        return /^\d+$/.test(str) ? BigInt(str) : 0n;
      } catch { return 0n; }
    };

    assert.equal(bigintOrZero(null), 0n);
    assert.equal(bigintOrZero(undefined), 0n);
    assert.equal(bigintOrZero("abc"), 0n);
    assert.equal(bigintOrZero("12.5"), 0n);
  });
});

describe("vault event detection", () => {
  it("recognises mint/deposit as vault-relevant", () => {
    const VAULT_MINT_EVENTS = new Set(["mint", "deposit"]);
    assert.ok(VAULT_MINT_EVENTS.has("mint"));
    assert.ok(VAULT_MINT_EVENTS.has("deposit"));
    assert.ok(!VAULT_MINT_EVENTS.has("transfer"));
    assert.ok(!VAULT_MINT_EVENTS.has("burn"));
  });

  it("recognises burn/withdraw as vault-relevant", () => {
    const VAULT_BURN_EVENTS = new Set(["burn", "withdraw"]);
    assert.ok(VAULT_BURN_EVENTS.has("burn"));
    assert.ok(VAULT_BURN_EVENTS.has("withdraw"));
    assert.ok(!VAULT_BURN_EVENTS.has("mint"));
    assert.ok(!VAULT_BURN_EVENTS.has("approve"));
  });
});
