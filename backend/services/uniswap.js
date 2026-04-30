const API_BASE = 'https://trade-api.gateway.uniswap.org/v1';

function getHeaders() {
  return {
    'x-api-key': process.env.UNISWAP_API_KEY || '',
    'Content-Type': 'application/json',
  };
}

/**
 * Check whether a token approval is needed before a swap.
 * Returns approval tx calldata if required, null otherwise.
 */
export async function checkApproval({ token, amount, walletAddress, chainId = 1 }) {
  const url = `${API_BASE}/check_approval?token=${token}&amount=${amount}&walletAddress=${walletAddress}&chainId=${chainId}`;
  const res = await fetch(url, { headers: getHeaders() });
  if (!res.ok) throw new Error(`Uniswap checkApproval failed: ${res.status}`);
  return res.json();
}

/**
 * Fetch a swap quote for tokenIn → tokenOut.
 */
export async function getQuote({ tokenIn, tokenOut, amount, swapper, chainId = 1 }) {
  const res = await fetch(`${API_BASE}/quote`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      tokenInChainId: chainId,
      tokenOutChainId: chainId,
      tokenIn,
      tokenOut,
      amount: String(amount),
      type: 'EXACT_INPUT',
      swapper,
      slippageTolerance: '0.5',
    }),
  });
  if (!res.ok) throw new Error(`Uniswap quote failed: ${res.status}`);
  return res.json();
}

/**
 * Build swap calldata from a quote (CLASSIC routing → Universal Router).
 */
export async function buildSwapCalldata({ quote, signature = null }) {
  const body = { quote };
  if (signature) body.signature = signature;

  const res = await fetch(`${API_BASE}/swap`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Uniswap swap calldata build failed: ${res.status}`);
  return res.json();
}

/**
 * Submit a Dutch V2 / Priority order (non-CLASSIC routing).
 */
export async function submitOrder({ quote, signature }) {
  const res = await fetch(`${API_BASE}/order`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ quote, signature }),
  });
  if (!res.ok) throw new Error(`Uniswap order submission failed: ${res.status}`);
  return res.json();
}
