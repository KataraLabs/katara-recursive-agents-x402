/** @module Rebuild versioned wire schemas; --check reports drift without rewriting files. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateSchemas } from './schema-contracts.js';

const check = process.argv.includes('--check');
for (const [name, schema] of Object.entries(generateSchemas())) {
  const file = resolve('schemas', 'v1', `${name}.schema.json`);
  const bytes = JSON.stringify(schema, null, 2) + '\n';
  if (check) {
    if (readFileSync(file, 'utf8') !== bytes) throw new Error(`Schema drift: ${name}; run npm run schemas`);
  } else { mkdirSync(resolve('schemas', 'v1'), { recursive: true }); writeFileSync(file, bytes); }
}
console.log(check ? 'Published schemas match their TypeScript contracts.' : 'Generated four versioned JSON Schemas.');
