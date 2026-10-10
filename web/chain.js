/**
 * Minimal Base Sepolia reader shared by the monitor and the inspector.
 *
 * Hand-rolled rather than bundling a library: every call here returns a single
 * 32-byte word, so the "ABI encoding" is one left-pad and the decoding is one
 * BigInt. Pulling in a full client to avoid twelve lines of padding would be the
 * larger liability on a static page with a strict CSP.
 *
 * Selectors and addresses come from `generated/data.js`, which `build.mjs`
 * derives from the deployment manifests and `cast sig`. Three hand-written
 * selectors elsewhere in this project were all wrong, which is the argument for
 * never typing one again.
 */
import { BASE, SELECTORS } from './generated/data.js';

let rpcId = 0;

export class ChainError extends Error {}

export async function call(to, data) {
  let res;
  try {
    res = await fetch(BASE.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    throw new ChainError(`${BASE.rpcUrl} unreachable`, { cause });
  }
  if (!res.ok) throw new ChainError(`RPC returned HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new ChainError(body.error.message ?? 'RPC error');
  return body.result;
}

/** A selector, failing loudly rather than concatenating `undefined`. */
export function selector(signature) {
  const sel = SELECTORS[signature];
  if (!sel) throw new ChainError(`no generated selector for ${signature}`);
  return sel;
}

/** Left-pad a hex value into one ABI word. Addresses and bytes32 both fit. */
const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** `f(bytes32)` / `f(address)` with one argument. */
export const callWith = (to, signature, arg) => call(to, selector(signature) + pad(arg));

/** `f()` with none. */
export const callNullary = (to, signature) => call(to, selector(signature));

/** Empty returndata is 0, not NaN: a view on a fresh mapping returns nothing. */
export const toBig = (hex) => (!hex || hex === '0x' ? 0n : BigInt(hex));

/** USDC has 6 decimals. Grouped, two places, never floating point. */
export function usdc(value) {
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n) / 10_000n;
  return `${whole.toLocaleString('en-US')}.${String(frac).padStart(2, '0')}`;
}

export function duration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '0';
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const basescan = (a) => `https://sepolia.basescan.org/address/${a}`;

/**
 * Count a value up to its final figure.
 *
 * Skipped entirely under reduced motion, and the final value is written
 * synchronously in that case so the number is never left mid-tween.
 */
export function tweenTo(node, text, { reduced = false } = {}) {
  node.classList.remove('loading');
  const target = Number.parseFloat(String(text).replace(/[^0-9.]/g, ''));
  if (reduced || !Number.isFinite(target) || target === 0) {
    node.textContent = text;
    return;
  }
  const suffix = String(text).replace(/^[\d,.]+/, '');
  const start = performance.now();
  const ms = 520;
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    const current = target * eased;
    node.textContent = current.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + suffix;
    if (t < 1) requestAnimationFrame(step);
    else node.textContent = text;
  };
  requestAnimationFrame(step);
}

export const prefersReducedMotion = () =>
  Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
