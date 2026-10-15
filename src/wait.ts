/** @module Cancellable waits and Retry-After parsing shared by the gateway and RPC clients. */

/**
 * Turn a Retry-After header (seconds or an HTTP date) into a wait between min and max milliseconds;
 * fallback when the header is missing or unreadable.
 */
export function retryAfterMs(header: string | null, now = Date.now(), fallback = 5_000, min = 1_000, max = 60_000): number {
  const value = header?.trim() ?? '';
  const ms = /^\d{1,6}$/.test(value) ? Number(value) * 1000 : Number.isNaN(Date.parse(value)) ? fallback : Date.parse(value) - now;
  return Math.min(max, Math.max(min, ms));
}
/**
 * Resolve after ms milliseconds, or reject as soon as the signal aborts.
 */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const done = () => { signal?.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(done, ms);
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}
