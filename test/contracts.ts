import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';

const ajv = new Ajv({ strict: true, allErrors: true });
export const contracts = Object.fromEntries(['scenario', 'run-report', 'synopsis-revision', 'cli-response'].map(name => [name, ajv.compile(JSON.parse(readFileSync(new URL(`../schemas/v1/${name}.schema.json`, import.meta.url), 'utf8')))]));

export function validateContract(name: keyof typeof contracts, value: unknown): void {
  const validate = contracts[name]!;
  if (!validate(value)) throw new Error(`${name}: ${ajv.errorsText(validate.errors)}`);
}
