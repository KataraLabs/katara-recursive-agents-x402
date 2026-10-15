/** @module Cached, bounded public source views with retrieval hashes and explicit failure records. */
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { publicFetch, type SourceFetch } from './http.js';
import { DemoError, errorCode, type Example, type Source, type SourceSpec } from './types.js';

/** SHA-256 over UTF-8 text, used to bind source views, request bytes and review claims. */
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
/**
 * Remove non-content HTML and retain readable line breaks; plain text and JSON pass through unchanged.
 */
export function extractText(body: string, contentType: string): string {
  if (/html/.test(contentType) || /^\s*<!doctype html/i.test(body)) {
    const $ = load(body); $('script,style,noscript,svg,nav,footer,header').remove();
    $('br,p,li,h1,h2,h3,h4,tr,pre').each((_, el) => { $(el).append('\n'); });
    return ($('main').text() || $('article').text() || $('body').text()).replace(/[\t ]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
  }
  return body;
}
/**
 * Convert supported data endpoints into bounded observations with explicit window and coverage limits.
 */
function structuredText(spec: SourceSpec, raw: string, now: Date): string {
  const data = JSON.parse(raw);
  const since = Math.floor(now.getTime() / 1000) - 7 * 86400;
  if (spec.format === 'candles') {
    if (!Array.isArray(data)) throw new DemoError('source_schema_changed');
    return JSON.stringify({ venue: 'Coinbase Exchange', product: 'AVAX-USD', windowStart: new Date(since * 1000).toISOString(), windowEnd: now.toISOString(), columns: ['unixTime', 'lowUSD', 'highUSD', 'openUSD', 'closeUSD', 'volumeAVAX'], candles: data.filter(r => Array.isArray(r) && r[0] >= since && r[0] <= now.getTime() / 1000).sort((a, b) => a[0] - b[0]), note: 'Daily candles may be incomplete. Volume is for this venue only.' }, null, 2);
  }
  if (spec.format === 'tvl') {
    if (!Array.isArray(data)) throw new DemoError('source_schema_changed');
    return JSON.stringify({ metric: 'DeFi TVL in USD, a measure of capital rather than transaction count', samples: data.filter(r => typeof r.date === 'number' && r.date >= since) }, null, 2);
  }
  if (spec.format === 'releases') {
    if (!Array.isArray(data)) throw new DemoError('source_schema_changed');
    return JSON.stringify({ windowStart: new Date(since * 1000).toISOString(), releases: data.filter(r => Date.parse(r.published_at) >= since * 1000 && Date.parse(r.published_at) <= now.getTime()).map(r => ({ tag: r.tag_name, name: r.name, url: r.html_url, publishedAt: r.published_at, notes: String(r.body ?? '').slice(0, 6000) })), note: 'Only this endpoint page is inspected. An empty list means no release in the fetched page falls inside the window.' }, null, 2);
  }
  if (spec.format === 'rpc-block') {
    if (!data.result?.number || !Array.isArray(data.result.transactions)) throw new DemoError('source_schema_changed');
    const b = data.result;
    return JSON.stringify({ network: 'Avalanche C-Chain mainnet', block: parseInt(b.number, 16), hash: b.hash, timestamp: new Date(parseInt(b.timestamp, 16) * 1000).toISOString(), transactionsInThisBlock: b.transactions.length, gasUsed: parseInt(b.gasUsed, 16), gasLimit: parseInt(b.gasLimit, 16), explorer: `https://snowtrace.io/block/${parseInt(b.number, 16)}`, note: 'One observed block is a snapshot, not seven-day network throughput.' }, null, 2);
  }
  return raw;
}

/**
 * Cache each source request and pin repository files to one resolved commit before collection.
 */
export class SourceCollector {
  private cache = new Map<string, Promise<Source>>();
  private commit?: string;
  private prepared?: Promise<void>;
  private readonly now = new Date();
  readonly records: Source[] = [];
  readonly hosts: Set<string>;
  /**
   * Resolve source permissions and an optional owner/name override. Fixtures use synthetic URLs and no transport.
   */
  constructor(readonly example: Example, private fixture = false, private fetcher: SourceFetch = publicFetch, private signal?: AbortSignal, repoOverride?: string) {
    if (repoOverride) {
      if (example.id !== 'repository' || !/^[\w.-]+\/[\w.-]+$/.test(repoOverride)) throw new DemoError('invalid_repository');
      this.example = { ...example, repository: repoOverride };
    }
    this.hosts = new Set(example.sources.map(s => new URL(this.url(s)).hostname));
    if (example.repository) { this.hosts.add('api.github.com'); this.hosts.add('raw.githubusercontent.com'); }
  }
  /**
   * Expand only supported repository and observation-window placeholders from the scenario.
   */
  private url(s: SourceSpec): string {
    return s.url.replaceAll('{repo}', this.example.repository ?? '').replaceAll('{commit}', this.commit ?? 'HEAD').replaceAll('{now}', encodeURIComponent(this.now.toISOString())).replaceAll('{weekAgo}', encodeURIComponent(new Date(this.now.getTime() - 7 * 86400000).toISOString()));
  }
  /**
   * Resolve the repository commit once per collector; fixture mode skips the network.
   */
  prepare(): Promise<void> {
    this.prepared ??= (async () => {
      if (!this.example.repository || this.fixture) return;
      const res = await this.fetcher(`https://api.github.com/repos/${this.example.repository}/commits/HEAD`, this.hosts, this.signal);
      if (res.status !== 200) throw new DemoError('repository_lookup_failed');
      const sha = JSON.parse(res.text).sha;
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new DemoError('invalid_repository_commit');
      this.commit = sha;
    })();
    return this.prepared;
  }
  /**
   * Share a single in-flight collection for a source ID so sibling agents observe the same source snapshot.
   */
  async get(id: string): Promise<Source> {
    if (!this.cache.has(id)) this.cache.set(id, this.collect(id));
    return this.cache.get(id)!;
  }
  /**
   * Collect sources sequentially to bound public API pressure independently of model concurrency.
   */
  async all(): Promise<Source[]> {
    // Keep public API pressure bounded independently of model concurrency.
    for (const s of this.example.sources) await this.get(s.id);
    return this.records;
  }
  /**
   * Record a bounded view or explicit retrieval error, preserving response and view hashes without treating failure metadata as evidence.
   */
  private async collect(id: string): Promise<Source> {
    const spec = this.example.sources.find(s => s.id === id);
    if (!spec) throw new DemoError('unknown_source');
    const source: Source = { id, title: spec.title, url: this.url(spec), retrievedAt: new Date().toISOString(), status: 0, sha256: '', text: '' };
    try {
      if (this.fixture) {
        source.fixture = true; source.url = `fixture:${id}`; source.status = 200;
        source.text = `Offline fixture for ${spec.title}. This is synthetic test data, not a retrieved fact.\nA researcher must cite ${id} and label the fixture.`;
        source.sha256 = digest(source.text);
      } else {
        await this.prepare(); source.url = this.url(spec); source.commit = this.commit;
        const body = spec.format === 'rpc-block' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }) : undefined;
        const res = await this.fetcher(source.url, this.hosts, this.signal, body);
        source.status = res.status; source.url = res.url; source.sha256 = digest(res.text);
        if (res.status < 200 || res.status >= 300) throw new DemoError(res.status === 402 ? 'paid_source_not_configured' : `source_http_${res.status}`);
        const text = spec.format ? structuredText(spec, res.text, this.now) : extractText(res.text, res.contentType);
        source.text = text.split('\n').slice(0, 500).map((line, n) => `${n + 1}: ${line}`).join('\n').slice(0, 12_000);
        if (!text.trim()) throw new DemoError('source_empty');
        if (source.commit) source.url = `https://github.com/${this.example.repository}/blob/${source.commit}/${new URL(this.url(spec)).pathname.split('/').slice(4).join('/')}`;
        if (spec.links) {
          const $ = load(res.text);
          const urls = new Set<string>();
          $('a[href]').each((_, el) => {
            try {
              const target = new URL($(el).attr('href')!, res.url);
              if (target.protocol === 'https:' && target.hostname === new URL(res.url).hostname && !target.hash && target.href !== res.url) urls.add(target.href);
            } catch { /* An invalid href is not fetched. */ }
          });
          source.links = [];
          for (const url of [...urls].slice(0, 2)) {
            try { const r = await this.fetcher(url, this.hosts, this.signal); source.links.push({ url, status: r.status }); }
            catch (e) { source.links.push({ url, status: 0, error: errorCode(e) }); }
          }
          const count = source.text.split('\n').length;
          source.text += `\n${count + 1}: Observed link checks (bounded sample, not an exhaustive crawl):\n${count + 2}: ${JSON.stringify(source.links)}`;
        }
      }
    } catch (e) { source.error = errorCode(e); source.text = ''; }
    source.textSha256 = digest(source.text);
    this.records.push(source);
    return source;
  }
}
