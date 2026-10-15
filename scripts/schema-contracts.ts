/** @module Generate portable JSON Schemas from the public TypeScript wire contracts. */
import ts from 'typescript';
import { resolve } from 'node:path';

/** Schema versions describe wire compatibility independently of package releases. */
export const contractRoots = { scenario: 'Example', 'run-report': 'RunReport', 'synopsis-revision': 'SynopsisRevision', 'cli-response': 'CliResponse' } as const;
/**
 * Published contract filename key; each artifact contains its own schema dependencies.
 */
export type ContractName = keyof typeof contractRoots;
/**
 * Generator representation of JSON Schema vocabulary, not a type accepted from model input.
 */
export type JsonSchema = Record<string, any>;

/**
 * Derive draft-07 schemas using the installed TypeScript compiler, without loading application modules.
 * Optional fields are omitted rather than encoded as null. Unknown object properties are refused.
 * @param root Checkout root containing src/types.ts and src/cli-types.ts.
 * @returns Self-contained schemas with local definitions and stable URN identifiers.
 * @throws If a contract introduces an unsupported or non-JSON type; generation never widens it to any.
 */
export function generateSchemas(root = process.cwd()): Record<ContractName, JsonSchema> {
  const files = ['src/types.ts', 'src/cli-types.ts'].map(file => resolve(root, file));
  const program = ts.createProgram(files, { strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const checker = program.getTypeChecker();
  const types = new Map<string, ts.Type>();
  for (const file of files) for (const node of program.getSourceFile(file)!.statements) {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) types.set(node.name.text, checker.getTypeAtLocation(node));
  }
  const metadata = (symbol: ts.Symbol | undefined): JsonSchema => {
    if (!symbol) return {};
    const description = ts.displayPartsToString(symbol.getDocumentationComment(checker));
    const result: JsonSchema = description ? { description } : {};
    for (const tag of symbol.getJsDocTags(checker)) {
      const value = ts.displayPartsToString(tag.text);
      if (['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'].includes(tag.name)) {
        if (!value.trim() || !Number.isFinite(Number(value))) throw new Error(`Invalid @${tag.name} on ${symbol.name}`);
        result[tag.name] = Number(value);
      } else if (tag.name === 'pattern') result.pattern = value;
      else if (tag.name === 'integer') result.type = 'integer';
    }
    return result;
  };
  const schemas = {} as Record<ContractName, JsonSchema>;
  for (const [name, typeName] of Object.entries(contractRoots) as [ContractName, string][]) {
    const definitions: Record<string, JsonSchema> = {};
    const named = new Map<ts.Type, string>();
    for (const [id, type] of types) if (!type.isUnion() && (type.flags & ts.TypeFlags.Object)) named.set(type, id);
    const convert = (type: ts.Type, inline = false): JsonSchema => {
      const id = named.get(type);
      if (id && !inline) {
        if (!definitions[id]) { definitions[id] = {}; definitions[id] = { ...convert(type, true), ...metadata(type.getSymbol()) }; }
        return { $ref: `#/definitions/${id}` };
      }
      if (type.isUnion()) {
        const variants = type.types.filter(t => !(t.flags & ts.TypeFlags.Undefined));
        if (variants.length === 1) return convert(variants[0]!);
        if (variants.length && variants.every(t => t.isStringLiteral())) return { type: 'string', enum: variants.map(t => (t as ts.StringLiteralType).value).sort() };
        if (variants.length === 2 && variants.every(t => t.flags & ts.TypeFlags.BooleanLiteral)) return { type: 'boolean' };
        return { anyOf: variants.map(t => convert(t)) };
      }
      if (type.isStringLiteral()) return { type: 'string', const: type.value };
      if (type.isNumberLiteral()) return { type: 'number', const: type.value };
      if (type.flags & ts.TypeFlags.String) return { type: 'string' };
      if (type.flags & ts.TypeFlags.Number) return { type: 'number' };
      if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
      if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', const: checker.typeToString(type) === 'true' };
      if (type.flags & ts.TypeFlags.Null) return { type: 'null' };
      if (checker.isArrayType(type)) return { type: 'array', items: convert(checker.getTypeArguments(type as ts.TypeReference)[0]!) };
      if (type.flags & ts.TypeFlags.Object) {
        const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
        if (index) return { type: 'object', additionalProperties: convert(index) };
        if (type.getCallSignatures().length) throw new Error('Functions are not JSON contracts');
        const properties: Record<string, JsonSchema> = {};
        const required: string[] = [];
        for (const prop of type.getProperties()) {
          const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
          if (!declaration) throw new Error(`Missing declaration: ${prop.name}`);
          properties[prop.name] = { ...convert(checker.getTypeOfSymbolAtLocation(prop, declaration)), ...metadata(prop) };
          if (!(prop.flags & ts.SymbolFlags.Optional)) required.push(prop.name);
        }
        return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
      }
      throw new Error(`Unsupported JSON contract type: ${checker.typeToString(type)}`);
    };
    const type = types.get(typeName);
    if (!type) throw new Error(`Contract missing: ${typeName}`);
    const body = convert(type);
    schemas[name] = { $schema: 'http://json-schema.org/draft-07/schema#', $id: `urn:katara:recursive-agents:${name}:v1`, title: typeName, ...body, ...(Object.keys(definitions).length ? { definitions } : {}) };
  }
  return schemas;
}
