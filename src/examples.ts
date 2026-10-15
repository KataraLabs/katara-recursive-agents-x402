/** @module Registered scenarios and fixed tree limits shared by execution and documentation. */
import { readFileSync } from 'node:fs';
import { DemoError, type Example, type ExampleId } from './types.js';

/** Ordered scenario registry used by all, listing, documentation and evidence navigation. */
export const exampleIds: ExampleId[] = ['repository', 'documentation', 'comparison', 'trip', 'cryptocurrency'];
/**
 * Read a registered scenario from the checkout and apply runtime tree and source-permission checks.
 * @throws DemoError for unknown examples or invalid scenario structure.
 */
export function loadExample(id: string): Example {
  if (!exampleIds.includes(id as ExampleId)) throw new DemoError('unknown_example');
  const example = JSON.parse(readFileSync(new URL(`../examples/${id}/scenario.json`, import.meta.url), 'utf8')) as Example;
  validateExample(example);
  return example;
}
/**
 * Check unique task/source IDs, referenced source scopes, HTTPS endpoints and the sixteen-agent limit.
 * @throws DemoError rather than silently dropping tasks or broadening source access.
 */
export function validateExample(e: Example): void {
  if (!exampleIds.includes(e.id) || !e.title || !e.command || !Array.isArray(e.sources) || !Array.isArray(e.specialists)) throw new DemoError('invalid_example');
  const ids = new Set<string>();
  const add = (id: string) => {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(id) || ids.has(id)) throw new DemoError('invalid_example_ids');
    ids.add(id);
  };
  for (const s of e.sources) { add(s.id); if (new URL(s.url.replace('{repo}', 'a/b').replace('{commit}', 'main')).protocol !== 'https:') throw new DemoError('invalid_source'); }
  const sources = new Set(ids); ids.clear();
  if (e.specialists.length < 1 || e.specialists.length > 4 || e.sources.length > 30) throw new DemoError('example_too_large');
  for (const lead of e.specialists) {
    add(lead.id);
    if (lead.researchers.length < 1 || lead.researchers.length > 3) throw new DemoError('example_too_large');
    for (const worker of lead.researchers) {
      add(worker.id);
      if (!worker.question || !worker.sourceIds.length || worker.sourceIds.some(s => !sources.has(s))) throw new DemoError('unknown_source');
    }
  }
  if (agentCount(e) > 16) throw new DemoError('example_too_large');
}
/**
 * Count the master, specialists and researchers. This is a task count, not an inference-call estimate.
 */
export function agentCount(e: Example): number { return 1 + e.specialists.length + e.specialists.reduce((n, s) => n + s.researchers.length, 0); }
