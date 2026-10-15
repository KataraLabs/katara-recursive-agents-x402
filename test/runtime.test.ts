import { describe, expect, it, vi } from 'vitest';
import { Runtime, TRUNCATION_RETRY_TOKENS, parseOutput, parsePlan } from '../src/runtime.js';
import { FixtureInference, type CompletionRequest, type Inference } from '../src/inference.js';
import { SourceCollector } from '../src/sources.js';
import { exampleIds, loadExample, agentCount } from '../src/examples.js';
import { DemoError } from '../src/types.js';
import { report } from './helpers.js';

describe('bounded recursive research', () => {
  it.each(exampleIds)('%s executes real grandchildren and completes even with one inference slot', async id => {
    const example = loadExample(id); const r = report(example);
    const noNetwork = vi.fn(async () => { throw new Error('unexpected network'); });
    const collector = new SourceCollector(example, true, noNetwork);
    await new Runtime(new FixtureInference(e => r.calls.push(e)), collector, r, 1, new AbortController().signal, () => {}).run(example);
    expect(r.status).toBe('succeeded'); expect(r.agents).toHaveLength(agentCount(example));
    expect(r.calls).toHaveLength(agentCount(example) + example.specialists.length + 3);
    expect(r.agents.filter(a => a.depth === 2)).toHaveLength(example.specialists.flatMap(s => s.researchers).length);
    for (const a of r.agents.filter(a => a.depth === 2)) expect(r.agents.find(p => p.id === a.parentId)?.depth).toBe(1);
    expect(r.result!.findings.length).toBeGreaterThan(0); expect(r.payments).toEqual([]); expect(noNetwork).not.toHaveBeenCalled();
  });
  it('keeps sibling findings when a child fails and bounds malformed-output repairs', async () => {
    const example = loadExample('documentation'); const r = report(example); let failedCalls = 0;
    const badId = example.specialists[0]!.researchers[0]!.id;
    const inference: Inference = { complete: async q => { if (q.agentId.endsWith(`/${badId}`)) { failedCalls++; return 'bad JSON'; } return JSON.stringify(q.fixtureOutput); } };
    await new Runtime(inference, new SourceCollector(example, true), r, 2, new AbortController().signal, () => {}).run(example);
    expect(failedCalls).toBe(2); expect(r.status).toBe('partial'); expect(r.result!.findings.length).toBeGreaterThan(0);
    expect(r.agents.filter(a => a.status === 'failed')).toHaveLength(1);
  });
  it('does not spawn children after cancellation or an invalid delegation', async () => {
    const example = loadExample('documentation'); const r = report(example);
    const control = new AbortController(); control.abort(new DemoError('cancelled'));
    const complete = vi.fn(async () => '{}');
    await new Runtime({ complete }, new SourceCollector(example, true), r, 1, control.signal, () => {}).run(example);
    expect(r.status).toBe('failed'); expect(complete).not.toHaveBeenCalled();
    const r2 = report(example);
    await new Runtime({ complete }, new SourceCollector(example, true), r2, 1, new AbortController().signal, () => {}).run(example);
    expect(r2.agents).toHaveLength(1); expect(complete).toHaveBeenCalledTimes(2);
  });
  it('rejects extra or duplicate children and fabricated or out-of-bounds citations', async () => {
    expect(() => parsePlan('{"delegations":[{"id":"a","task":"task"},{"id":"a","task":"task"}]}', ['a', 'b'])).toThrow('delegation_invalid');
    const sources = await new SourceCollector(loadExample('documentation'), true).all();
    const output = (sourceId: string, startLine: number, endLine: number) => JSON.stringify({ summary: 'test', findings: [{ claim: 'test', citations: [{ sourceId, startLine, endLine }] }], limitations: [] });
    expect(() => parseOutput(output('invented', 1, 1), sources)).toThrow('Every sourceId');
    expect(() => parseOutput(output(sources[0]!.id, 1, 1000), sources)).toThrow('positive integer line numbers');
    expect(() => parseOutput(output(sources[0]!.id, 0, 1), sources)).toThrow('positive integer line numbers');
  });
  it('normalizes the observed singular limitation key without relaxing citation validation', async () => {
    const sources = await new SourceCollector(loadExample('documentation'), true).all();
    const output = { summary: 'Example', findings: [{ claim: 'Fixture', citations: [{ sourceId: sources[0]!.id, startLine: 1, endLine: 1 }] }], limitation: ['Synthetic data'] };
    expect(parseOutput(JSON.stringify(output), sources).limitations).toEqual(['Synthetic data']);
    expect(parseOutput(JSON.stringify({ ...output, limitation: 'Synthetic data' }), sources).limitations).toEqual(['Synthetic data']);
    expect(parseOutput(JSON.stringify({ ...output, limitation: undefined }), sources).limitations).toEqual([]);
    output.findings[0]!.citations[0]!.endLine = 1000;
    expect(() => parseOutput(JSON.stringify(output), sources)).toThrow('positive integer line numbers');
  });
  describe('truncated research', () => {
    const example = loadExample('comparison');
    const target = example.specialists[0]!.researchers[0]!.id;
    function run(answer: (q: CompletionRequest, n: number) => string) {
      const r = report(example); const seen: CompletionRequest[] = [];
      const inference: Inference = { complete: async q => {
        if (!q.agentId.endsWith(`/${target}`)) return JSON.stringify(q.fixtureOutput);
        seen.push(q); return answer(q, seen.length);
      } };
      return { r, seen, done: new Runtime(inference, new SourceCollector(example, true), r, 2, new AbortController().signal, () => {}).run(example) };
    }
    it('asks once more for a shorter answer at the largest output limit', async () => {
      const { r, seen, done } = run((q, n) => { if (n === 1) throw new DemoError('completion_truncated'); return JSON.stringify(q.fixtureOutput); });
      await done;
      expect(seen.map(q => [q.purpose, q.maxTokens])).toEqual([['research', undefined], ['repair', TRUNCATION_RETRY_TOKENS]]);
      expect(seen[1]!.prompt).toContain('cut off at the output limit');
      expect(r.status).toBe('succeeded');
      expect(r.agents.find(a => a.id.endsWith(`/${target}`))!.validationIssues).toEqual([expect.objectContaining({ code: 'completion_truncated', attempt: 1 })]);
    });
    it('fails the agent explicitly when the retry is also cut off, and keeps its siblings', async () => {
      const { r, seen, done } = run(() => { throw new DemoError('completion_truncated'); });
      await done;
      expect(seen).toHaveLength(2);
      const agent = r.agents.find(a => a.id.endsWith(`/${target}`))!;
      expect(agent).toMatchObject({ status: 'failed', error: 'completion_truncated' });
      expect(r.status).toBe('partial'); expect(r.result!.findings.length).toBeGreaterThan(0);
    });
    it('does not retry past an exhausted budget', async () => {
      const { r, seen, done } = run((_q, n) => { throw new DemoError(n === 1 ? 'completion_truncated' : 'budget_exhausted'); });
      await done;
      expect(seen).toHaveLength(2);
      expect(r.agents.find(a => a.id.endsWith(`/${target}`))).toMatchObject({ status: 'failed', error: 'budget_exhausted' });
    });
  });
});
