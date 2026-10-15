import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { exampleIds, loadExample } from '../src/examples.js';
import { generatedFile } from '../scripts/generated-files.js';
import { report } from './helpers.js';
import { contracts, validateContract } from './contracts.js';

describe('published contracts and generated files', () => {
  it.each(exampleIds)('validates the shipped %s scenario', id => validateContract('scenario', loadExample(id)));

  it('validates all shipped reports and synopsis revisions', () => {
    let runs = 0; let revisions = 0;
    for (const entry of readdirSync('evidence', { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'synopses') continue;
      for (const file of readdirSync(join('evidence', entry.name)).filter(f => f.endsWith('.json'))) {
        validateContract('run-report', JSON.parse(readFileSync(join('evidence', entry.name, file), 'utf8'))); runs++;
      }
    }
    for (const entry of readdirSync('evidence/synopses')) for (const file of readdirSync(join('evidence/synopses', entry)).filter(f => f.endsWith('.json'))) {
      validateContract('synopsis-revision', JSON.parse(readFileSync(join('evidence/synopses', entry, file), 'utf8'))); revisions++;
    }
    expect(runs).toBeGreaterThanOrEqual(5); expect(revisions).toBeGreaterThanOrEqual(5);
  });

  it('rejects unknown fields, invalid amounts, unsupported versions and non-integer citations', () => {
    const scenario = loadExample('documentation');
    expect(contracts.scenario!({ ...scenario, privateField: 'not in contract' })).toBe(false);
    expect(contracts.scenario!({ ...scenario, specialists: [] })).toBe(false);
    const validReport = report(scenario); validateContract('run-report', validReport);
    expect(contracts['run-report']!({ ...validReport, budgetUnits: '-1' })).toBe(false);
    expect(contracts['run-report']!({ ...validReport, mode: 'unknown' })).toBe(false);
    for (const startLine of [0, 1.5]) expect(contracts['run-report']!({ ...validReport, result: { summary: 'Example', findings: [{ claim: 'Example', citations: [{ sourceId: 'example', startLine, endLine: 1 }] }], limitations: [] } })).toBe(false);
    expect(contracts['cli-response']!({ schemaVersion: 2, ok: true, result: { command: 'list', examples: [] } })).toBe(false);
    expect(contracts['cli-response']!({ schemaVersion: 1, ok: true, result: { command: 'run' } })).toBe(false);
    expect(contracts['cli-response']!({ schemaVersion: 1, ok: false, error: { message: 'Missing code and command' } })).toBe(false);
  });

  it('writes URL paths with spaces and detects drift without replacing the changed file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'katara generated ')); const file = pathToFileURL(join(dir, 'new folder', 'guide.txt'));
    try {
      generatedFile(file, 'first', false); generatedFile(file, 'first', true);
      expect(() => generatedFile(file, 'second', true)).toThrow('stale');
      expect(readFileSync(file, 'utf8')).toBe('first');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
