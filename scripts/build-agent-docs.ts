/** @module Generate standalone onboarding, mirrored instructions and a JSDoc-derived API reference. */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { load } from 'cheerio';
import { document, escapeHtml as h } from '../src/report.js';
import { generatedFile } from './generated-files.js';

const check = process.argv.includes('--check');
const write = (path: string, content: string) => generatedFile(resolve(path), content, check);
const files = ['src', 'scripts'].flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.ts')).sort().map(f => `${dir}/${f}`));
const program = ts.createProgram(files, { strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
const checker = program.getTypeChecker();

/** Keep JSDoc descriptions and contract tags readable without copying implementation bodies. */
function jsdoc(node: ts.Node): string {
  const blocks = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  return blocks.map(block => {
    const description = typeof block.comment === 'string' ? block.comment : block.comment?.map(c => c.getText()).join('') ?? '';
    const tags = block.tags?.filter(t => t.tagName.text !== 'module').map(t => t.getText().trim()).join('\n') ?? '';
    return [description, tags].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n');
}

/** Render source-level parameter types so wallet implementation details do not expand into generated docs. */
function signature(node: ts.Node, file: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
    const name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText(file) ?? 'anonymous';
    return `${name}(${node.parameters.map(p => `${p.name.getText(file)}${p.questionToken || p.initializer ? '?' : ''}: ${p.type?.getText(file) ?? 'inferred'}`).join(', ')}): ${node.type?.getText(file) ?? 'inferred'}`;
  }
  if (ts.isClassDeclaration(node)) return `class ${node.name!.text}`;
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.map(d => `${d.name.getText(file)}: ${d.type?.getText(file) ?? checker.typeToString(checker.getTypeAtLocation(d.name))}`).join('\n');
  return node.getText(file);
}

/** Extract exports and public class methods, refusing undocumented exports during regeneration. */
function reference(file: string): { html: string; text: string; count: number } {
  const source = program.getSourceFile(file)!;
  const sections: string[] = []; const plain: string[] = []; let count = 0;
  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) && !ts.isClassDeclaration(node) && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node) && !ts.isVariableStatement(node)) continue;
    if (!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const text = jsdoc(node);
    if (!text) throw new Error(`Missing export JSDoc in ${file}: ${node.getText(source).slice(0, 70)}`);
    const code = signature(node, source);
    sections.push(`<h3>${h(ts.isVariableStatement(node) ? node.declarationList.declarations[0]!.name.getText(source) : node.name?.getText(source))}</h3><pre>${h(text)}</pre><pre>${h(code)}</pre>`);
    plain.push(`${code}\n${text}`); count++;
    if (ts.isClassDeclaration(node)) for (const member of node.members) {
      if ((!ts.isConstructorDeclaration(member) && !ts.isMethodDeclaration(member)) || (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Private)) continue;
      const docs = jsdoc(member);
      if (!docs) throw new Error(`Missing method JSDoc in ${file}: ${member.name?.getText(source) ?? 'constructor'}`);
      const method = signature(member, source);
      sections.push(`<h4>${h(method)}</h4><pre>${h(docs)}</pre>`); plain.push(`${method}\n${docs}`); count++;
    }
  }
  const module = source.statements.length ? ts.getJSDocTags(source.statements[0]!).find(t => t.tagName.text === 'module')?.comment : '';
  return { html: `<section><h2 id="${h(file.replace(/[/.]/g, '-'))}">${h(file)}</h2>${module ? `<p>${h(module)}</p>` : ''}<p><a href="../${h(file)}">Read source</a></p>${sections.join('') || '<p>Executable script; see its module JSDoc and source.</p>'}</section>`, text: `${file}\n${module ?? ''}\n${plain.join('\n\n')}`, count };
}

const references = files.map(reference);
const contributorBody = `<p><a href="index.html">Demo guide</a> · <a href="api.html">API reference</a> · <a href="../AGENTS.md">Agent instructions</a></p><h1>Extend the recursive-agent demos</h1><div class="banner">Routine checks use offline fixtures. Live inference spends native USDC through x402 and requires the current user's authorized cap, a verified settlement contract and a funded wallet.</div>
<h2>Follow a request</h2><pre>cli.ts: parse arguments and resolve configuration
examples.ts: load and validate a fixed scenario
runtime.ts: master plans specialists; specialists plan researchers
sources.ts + http.ts: collect permitted public sources
inference.ts + ledger.ts: reserve and sign x402 inference payments
review.ts: assess cited findings against source spans
synopsis.ts: write the master answer from supported findings
review.ts: check and replace unsupported master sections
chain.ts: reconcile finalized USDC charges
report.ts + evidence.ts: preserve evidence and render the answer</pre>
<p>Katara Cortex supplies ordinary model completions. The TypeScript runtime creates the recursive tasks, constrains source access and waits for child results. No local service stack or model tool-calling interface is needed.</p>
<h2>Change an existing example</h2><ol><li>Edit its <code>examples/&lt;id&gt;/scenario.json</code>. Use unique IDs and explicitly assigned source IDs. Maintain at most four specialists, one to three researchers each, and sixteen total agents.</li><li>For a new endpoint format, change <code>src/sources.ts</code> and test its window and missing-data behavior. Preserve HTTPS host checks and connection-time public-IP validation in <code>src/http.ts</code>.</li><li>For a different final answer structure, update <code>synopsisHeadings</code> and scenario guidance in <code>src/synopsis.ts</code>. Keep source reviews and missing-evidence handling intact.</li><li>Regenerate documentation and run the offline checks. Inspect the master synopsis and JSON evidence, not just the process exit code.</li></ol>
<h2>Add another example</h2><p>Create <code>examples/&lt;new-id&gt;/scenario.json</code>, add its identity to <code>ExampleId</code> in <code>src/types.ts</code>, register it in <code>src/examples.ts</code>, and add its headings and guidance in <code>src/synopsis.ts</code>. Update scenario-specific walkthrough guidance in <code>scripts/build-docs.ts</code>, the README table and any labels that assume five examples. The runtime, fixtures and indexes enumerate the registry, but identity unions and scenario prose must also agree. Run <code>npm run docs</code> and exercise the new example plus all registered examples.</p>
<h2>Use the JSON CLI</h2><pre>npm run --silent demo -- list --json
npm run --silent demo -- plan all --json
npm run --silent demo -- run all --offline --json
npm run --silent demo -- inspect &lt;run-id&gt; --json</pre><p>All CLI commands accept <code>--json</code>. The process emits exactly one JSON envelope to stdout, with <code>schemaVersion: 1</code> and <code>ok</code>. Success includes <code>result</code>; failure includes a stable error code and may include partial results. Exit status is zero for success and one for failure or partial execution. JSON mode suppresses human progress lines. Use <code>npm run --silent</code> to suppress npm's own banner, or <code>node dist/cli.js</code> after building.</p>
<p><code>doctor --json</code> performs read-only checks. <code>configurationVerified</code> is separate from <code>paidCapacityVerified</code>, which stays false. <code>sources --json</code> retrieves public data without paying. <code>run</code> spends money unless <code>--offline</code> is supplied, even when its output is JSON. <code>reconcile</code> reads chain evidence and updates local accounting.</p>
<h2>Data contracts</h2><ul><li><a href="../schemas/v1/scenario.schema.json">Scenario v1</a>: tasks and source scopes.</li><li><a href="../schemas/v1/run-report.schema.json">Run report v1</a>: progress, findings, source reviews and payments.</li><li><a href="../schemas/v1/synopsis-revision.schema.json">Synopsis revision v1</a>: corrections tied to immutable input hashes.</li><li><a href="../schemas/v1/cli-response.schema.json">CLI response v1</a>: structured success and failure envelopes.</li></ul><p>The schemas use <a href="https://ajv.js.org/json-schema.html">JSON Schema draft-07</a> and are self-contained. TypeScript contracts and their JSDoc constraints generate them. <code>npm run schemas</code> writes them; <code>npm run schemas:check</code> refuses drift. Unknown object fields are rejected, optional fields are omitted rather than null, and USDC accounting uses decimal integer strings in six-decimal base units. Schema validation checks structure; runtime checks also enforce matching source IDs, line bounds, nonce uniqueness, budgets and finalized settlement.</p>
<h2>JSDoc and generated files</h2><p>The <a href="api.html">API reference</a> is derived from exported declarations and public methods in <code>src/</code> and <code>scripts/</code>. Document behavior, side effects, cancellation, monetary units and error boundaries. Use <code>@param</code>, <code>@returns</code>, <code>@throws</code> or <code>@remarks</code> where they explain the contract. Schema properties also support <code>@minimum</code>, <code>@maximum</code>, <code>@minLength</code>, <code>@maxLength</code>, <code>@minItems</code>, <code>@maxItems</code>, <code>@pattern</code> and <code>@integer</code>. Breaking wire changes require a deliberate schema-version decision.</p>
<pre>npm run docs
npm run generated:check
npm run check
npm run build
npm run audit</pre><p><code>npm run docs</code> regenerates schemas, walkthroughs, this guide, the JSDoc reference, LLM indexes and the identical <code>CLAUDE.md</code> mirror. Edit <code>AGENTS.md</code> for both instruction files. <code>generated:check</code> compares bytes without rewriting files. The offline tests validate every shipped scenario, report and revision against its schema and exercise the JSON CLI.</p>
<h2>Review and release</h2><p>Run the documented workflow from a fresh checkout with no wallet or parent workspace. Review dependency updates before merging. Preserve MIT and source attribution. Keep raw local source snapshots and revision drafts private; exported findings still require review before sharing. The first public release uses one root commit, and publishing requires the current user's explicit authorization.</p>`;
write('docs/contributing.html', document('Contributor and agent guide', contributorBody));
const apiIntro = `<p><a href="contributing.html">Contributor guide</a> · <a href="index.html">Demo guide</a></p><h1>JSDoc API reference</h1><p>Generated from source contracts. All amounts described as USDC base units use six decimals. Read <code>src/types.ts</code> and the versioned schemas for wire formats. Private source snapshots, keys and payment signatures are not public API data.</p>`;
write('docs/api.html', document('Recursive-agent API reference', apiIntro + references.map(r => r.html).join('')));
const instructions = readFileSync('AGENTS.md', 'utf8');
write('CLAUDE.md', instructions);
write('llms.txt', `# Recursive agents with Katara Cortex and x402\n\n> Bounded research agents using Katara Cortex and native USDC through x402 on Avalanche C-Chain. Begin with offline verification.\n\n## Start\n\n- [README](README.md): setup, five examples and evidence.\n- [Agent instructions](AGENTS.md): standalone operating rules; CLAUDE.md is an identical mirror.\n- [Contributor guide](docs/contributing.html): module map, extension recipes and JSON CLI.\n- [API reference](docs/api.html): generated JSDoc contracts.\n- [Full text](llms-full.txt): generated guidance and API text.\n\n## Data and behavior\n\n- [Scenario schema](schemas/v1/scenario.schema.json): source scopes and task trees.\n- [Run report schema](schemas/v1/run-report.schema.json): results, reviews and payments.\n- [Synopsis revision schema](schemas/v1/synopsis-revision.schema.json): input and revision provenance.\n- [CLI response schema](schemas/v1/cli-response.schema.json): structured output and errors.\n- [Payments and evidence](docs/payments.html): signing, caps and finalized settlement.\n- [Sample answers](evidence/results.html): explicitly labeled offline fixtures.\n\n## Maintenance\n\n- [Package commands](package.json): build, test, audit and regeneration.\n- [MIT license](LICENSE): project reuse terms.\n`);
/** Strip generated presentation markup while retaining guide text for LLM consumption. */
function plainHtml(text: string): string {
  const $ = load(text); $('script,style').remove();
  $('th,td').append(' | ');
  $('p,li,h1,h2,h3,h4,pre,tr').append('\n');
  return $.root().text().replace(/\n\s*\n/g, '\n\n').trim();
}
write('llms-full.txt', [instructions, readFileSync('README.md', 'utf8'), plainHtml(contributorBody), plainHtml(readFileSync('docs/payments.html', 'utf8')), ...references.map(r => r.text)].join('\n\n') + '\n');
console.log(`${check ? 'Verified' : 'Generated'} agent guidance, mirrored instructions and ${references.reduce((n, r) => n + r.count, 0)} JSDoc API entries.`);
