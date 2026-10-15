/** @module Bounded HTTPS source retrieval with host restrictions and connection-time DNS checks. */
import { request } from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { DemoError } from './types.js';

/**
 * Accept public unicast IP addresses only, including normalization of IPv4-mapped addresses.
 */
export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
/**
 * Require an allowed HTTPS host without credentials, alternate ports or literal private addresses.
 * @throws DemoError before a refused source URL reaches the transport.
 */
export function validateSourceUrl(input: string, allowedHosts: Set<string>): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new DemoError('invalid_source_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowedHosts.has(url.hostname)) throw new DemoError('source_url_refused');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw new DemoError('source_dns_refused');
  return url;
}
/**
 * Bounded source response retained for extraction; text is untrusted external content.
 */
export interface HttpResult { status: number; text: string; url: string; contentType: string; location?: string }
/**
 * Transport seam for free source collection. A supplied body is a read-only structured-data request.
 */
export type SourceFetch = (url: string, hosts: Set<string>, signal?: AbortSignal, body?: string) => Promise<HttpResult>;

/** Free source transport with three redirects, a response byte cap and connection-time DNS validation. */
export const publicFetch: SourceFetch = async (input, hosts, signal, body) => {
  let url = validateSourceUrl(input, hosts);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const result = await new Promise<HttpResult>((resolve, reject) => {
      const req = request(url, {
        method: body ? 'POST' : 'GET', signal, timeout: 20_000,
        headers: { 'user-agent': 'KataraDemo/0.1 (public research)', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.1', ...(body ? { 'content-type': 'application/json' } : {}) },
        /**
         * Check every DNS answer at connection time to prevent a hostname from resolving into a private network.
         */
        lookup(host, _options, callback) {
          lookup(host, { all: true, verbatim: true }, (error, addresses) => {
            if (error || !addresses.length || addresses.some(a => !isPublicAddress(a.address))) { callback(new DemoError('source_dns_refused'), []); return; }
            // Node may ask for all addresses when automatic family selection is enabled.
            if (typeof _options === 'object' && _options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          });
        },
      }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2_000_000) { res.destroy(); req.destroy(new DemoError('source_too_large')); }
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), url: url.href, contentType: String(res.headers['content-type'] ?? ''), location: res.headers.location }));
      });
      req.on('timeout', () => req.destroy(new DemoError('source_timeout')));
      req.on('error', reject); req.end(body);
    });
    if (result.status >= 300 && result.status < 400 && result.location) {
      url = validateSourceUrl(new URL(result.location, url).href, hosts);
      continue;
    }
    return result;
  }
  throw new DemoError('source_redirect_limit');
};
