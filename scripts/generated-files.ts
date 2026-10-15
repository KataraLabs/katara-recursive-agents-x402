/** @module Shared write-or-check behavior for deterministic documentation artifacts. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Write generated content or check exact bytes without touching the checkout.
 * @param file Destination URL or path inside the public artifact tree.
 * @param text Deterministic output; do not include current timestamps or machine paths.
 * @param check True for verification, false for intentional regeneration.
 * @throws When a required artifact is absent or stale in check mode.
 */
export function generatedFile(file: string | URL, text: string, check: boolean): void {
  if (check) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) throw new Error(`Generated artifact is stale: ${file instanceof URL ? file.pathname.split('/').slice(-2).join('/') : file}; run npm run docs`);
  } else {
    mkdirSync(dirname(file instanceof URL ? fileURLToPath(file) : file), { recursive: true });
    writeFileSync(file, text);
  }
}
