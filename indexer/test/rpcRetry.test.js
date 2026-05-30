import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/rpcRetry.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    assert.equal(result, "ok");
  });

  it("retries on 429 and eventually succeeds", async () => {
    let calls = 0;
    const fn = mock.fn(() => {
      calls++;
      if (calls < 3) return Promise.reject(Object.assign(new Error("Too Many Requests"), { status: 429 }));
      return Promise.resolve("recovered");
    });
    const result = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 10 });
    assert.equal(result, "recovered");
    assert.equal(calls, 3);
  });

  it("retries on ECONNRESET and succeeds", async () => {
    let calls = 0;
    const fn = mock.fn(() => {
      calls++;
      if (calls < 4) return Promise.reject(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      return Promise.resolve("ok");
    });
    const result = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 10 });
    assert.equal(result, "ok");
    assert.equal(calls, 4);
  });

  it("retries on ETIMEDOUT and succeeds", async () => {
    let calls = 0;
    const fn = mock.fn(() => {
      calls++;
      if (calls < 2) return Promise.reject(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
      return Promise.resolve("ok");
    });
    const result = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 10 });
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  it("retries on timeout message", async () => {
    let calls = 0;
    const fn = mock.fn(() => {
      calls++;
      if (calls < 2) return Promise.reject(new Error("timeout of 5000ms exceeded"));
      return Promise.resolve("ok");
    });
    const result = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 10 });
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  it("retries on rate limit message", async () => {
    let calls = 0;
    const fn = mock.fn(() => {
      calls++;
      if (calls < 2) return Promise.reject(new Error("rate limit exceeded"));
      return Promise.resolve("ok");
    });
    const result = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 10 });
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  it("survives 5 consecutive network failures and succeeds on 6th", async () => {
    let calls = 0;
    const fn = mock.fn(() => {
      calls++;
      if (calls <= 5) return Promise.reject(Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }));
      return Promise.resolve("survived");
    });
    const result = await withRetry(fn, { maxAttempts: 6, baseDelayMs: 10 });
    assert.equal(result, "survived");
    assert.equal(calls, 6);
  });

  it("throws after exhausting max attempts", async () => {
    const err = Object.assign(new Error("always 429"), { status: 429 });
    const fn = mock.fn(() => Promise.reject(err));
    await assert.rejects(() => withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 }), /always 429/);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = mock.fn(() => Promise.reject(new Error("bad request")));
    await assert.rejects(() => withRetry(fn, { baseDelayMs: 10 }), /bad request/);
    assert.equal(fn.mock.callCount(), 1);
  });

  it("uses correct exponential delay formula", async () => {
    let calls = 0;
    const timestamps = [];
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => {
      timestamps.push(ms);
      return realSetTimeout(fn, 0);
    };
    try {
      const fn = mock.fn(() => {
        calls++;
        if (calls < 3) return Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
        return Promise.resolve("ok");
      });
      await withRetry(fn, { maxAttempts: 5, baseDelayMs: 100 });
      assert.equal(timestamps.length, 2);
      assert.equal(timestamps[0], Math.pow(2, 1) * 100);
      assert.equal(timestamps[1], Math.pow(2, 2) * 100);
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });
});
