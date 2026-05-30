export async function withRetry(fn, { maxAttempts = 5, baseDelayMs = 100 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable = isRetryableError(err);
      if (!isRetryable || attempt === maxAttempts) throw err;
      const delay = Math.pow(2, attempt) * baseDelayMs;
      console.warn(`[rpc-retry] attempt ${attempt}/${maxAttempts} failed (${err.message}), retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function isRetryableError(err) {
  if (!err) return false;
  const status = err?.response?.status ?? err?.status ?? err?.statusCode;
  if (status === 429) return true;
  if (err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT') return true;
  if (err?.message && /timeout|rate\s*limit|too\s*many\s*requests/i.test(err.message)) return true;
  return false;
}
