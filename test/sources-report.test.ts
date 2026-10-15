import { describe, expect, it, vi } from 'vitest';
import { isPublicAddress, validateSourceUrl } from '../src/http.js';
import { SourceCollector, extractText } from '../src/sources.js';
import { loadExample } from '../src/examples.js';
import { brandText, publicReport, renderReport } from '../src/report.js';
import { report } from './helpers.js';

describe('public evidence boundary', () => {
  it('uses the full product name in reports without rewriting identifiers or original evidence', () => {
    expect(brandText('Cortex. Katara Cortex. Katara\nCortex.')).toBe('Katara Cortex. Katara Cortex. Katara\nCortex.');
    const identifiers = 'katara/cortex@1 cortex:served CortexConfig cfg.Cortex https://example.com/Cortex Cortex.md';
    expect(brandText(identifiers)).toBe(identifiers);
    const r = report(loadExample('documentation'));
    r.title = 'Cortex report';
    r.sources = [{ id: 'source', title: 'Cortex guide', url: 'https://example.com/Cortex', status: 200, retrievedAt: r.startedAt, sha256: 'a'.repeat(64), text: 'Cortex source text.' }];
    const copy = publicReport(r);
    expect(copy.title).toBe('Katara Cortex report');
    expect(copy.sources[0]!.text).toBe('Katara Cortex source text.');
    expect(copy.sources[0]!.url).toBe(r.sources[0]!.url);
    expect(copy.sources[0]!.sha256).toBe(r.sources[0]!.sha256);
    expect(copy.payments).toEqual(r.payments);
    expect(copy.calls).toEqual(r.calls);
    expect(r.title).toBe('Cortex report');
    expect(r.sources[0]!.text).toBe('Cortex source text.');
    expect(copy.presentationNotes?.[0]).toContain('Katara Cortex');
  });
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', 'not-an-ip'])('refuses private or special DNS address %s', address => expect(isPublicAddress(address)).toBe(false));
  it('allows public addresses but rejects credentialed, cross-host, and insecure URLs', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    const hosts = new Set(['example.com']);
    for (const url of ['http://example.com', 'https://secret@example.com', 'https://example.com:8080', 'https://elsewhere.com']) expect(() => validateSourceUrl(url, hosts)).toThrow();
    expect(validateSourceUrl('https://example.com/page', hosts).pathname).toBe('/page');
    for (const host of ['127.0.0.1', '[::1]', '[::ffff:7f00:1]']) expect(() => validateSourceUrl(`https://${host}/`, new Set([host]))).toThrow('source_dns_refused');
  });
  it('pins repository sources once and deduplicates concurrent reads', async () => {
    const e = loadExample('repository'); const sha = 'a'.repeat(40);
    const fetcher = vi.fn(async (url: string) => ({ url, status: 200, text: url.includes('/commits/') ? JSON.stringify({ sha }) : 'first line\nsecond line', contentType: 'text/plain' }));
    const collector = new SourceCollector(e, false, fetcher);
    const [a, b] = await Promise.all([collector.get(e.sources[0]!.id), collector.get(e.sources[0]!.id)]);
    expect(a).toBe(b); expect(fetcher).toHaveBeenCalledTimes(2); expect(a.commit).toBe(sha); expect(a.url).toContain(`/blob/${sha}/`); expect(a.text).toBe('1: first line\n2: second line');
  });
  it('treats paid sources as unavailable without another payment mechanism', async () => {
    const e = loadExample('documentation');
    const collector = new SourceCollector(e, false, async url => ({ url, status: 402, text: 'pay me', contentType: 'text/plain' }));
    const s = await collector.get(e.sources[0]!.id);
    expect(s.error).toBe('paid_source_not_configured'); expect(s.text).toBe('');
  });
  it('removes executable page content and escapes findings, URLs, and report metadata', async () => {
    expect(extractText('<html><body><script>secret</script><main><p>Visible</p></main></body></html>', 'text/html')).toBe('Visible');
    const e = loadExample('documentation'); const r = report(e);
    r.command = '<script>alert(1)</script>'; r.sources = await new SourceCollector(e, true).all();
    r.sources[0]!.text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    r.sources[0]!.url = 'javascript:alert(1)';
    const copy = publicReport(r); const html = renderReport(copy);
    expect(copy.sources[0]!.text.split(/\s+/)).toHaveLength(25); expect(r.sources[0]!.text.split(/\s+/)).toHaveLength(100);
    expect(html).toContain('OFFLINE FIXTURE'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('href="javascript:');
  });
});

describe('payment links and simulated counts', () => {
  const tx = `0x${'cd'.repeat(32)}`;
  function paidReport(mode: 'test' | 'mainnet', network: string) {
    const r = report(loadExample('trip')); r.mode = mode; r.network = network;
    const base = { runId: 'run', agentId: 'trip/master', requestHash: 'h', from: `0x${'11'.repeat(20)}`, to: `0x${'22'.repeat(20)}`, asset: `0x${'33'.repeat(20)}`, network, value: '50000', validAfter: '0', validBefore: '1', startBlock: '1' };
    r.payments = [
      { ...base, id: 'a', callId: 'c1', nonce: `0x${'01'.repeat(32)}`, state: 'confirmed', actual: '50000', transaction: tx, block: '2' },
      { ...base, id: 'b', callId: 'c2', nonce: `0x${'02'.repeat(32)}`, state: 'confirmed', actual: '50000', transaction: tx, block: '2', network: 'eip155:1' },
    ];
    const call = (id: string, extra: object) => ({ id, agentId: 'trip/master', purpose: 'plan' as const, requestedModel: 'katara/cortex@1', startedAt: 'now', status: 'succeeded' as const, authorizationIds: [] as string[], ...extra });
    r.calls = [call('c1', { simulated: true, authorizationIds: ['a'] }), call('c2', { simulated: true, authorizationIds: ['b'] }), call('c3', { status: 'failed', error: 'gateway_http_429', gateway: { status: 429, code: 'quote_rate_limited', message: 'Too many unpaid quotes' } })];
    return r;
  }
  it('links Test settlements to the Fuji explorer and Live ones to the C-Chain explorer, never across', () => {
    const test = renderReport(paidReport('test', 'eip155:43113'));
    expect(test).toContain(`https://testnet.snowtrace.io/tx/${tx}`); expect(test).not.toContain(`https://snowtrace.io/tx/`);
    const live = renderReport(paidReport('mainnet', 'eip155:43114'));
    expect(live).toContain(`https://snowtrace.io/tx/${tx}`); expect(live).not.toContain('testnet.snowtrace.io');
  });
  it('counts only paid calls in the simulated banner and shows the gateway answer per call', () => {
    const html = renderReport(paidReport('test', 'eip155:43113'));
    expect(html).toContain('SIMULATED ANSWERS: 2 of 2 paid calls');
    expect(html).toContain('Katara answered 429 quote_rate_limited: Too many unpaid quotes');
  });
});
