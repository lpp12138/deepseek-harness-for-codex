import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const dependencies = ['@modelcontextprotocol/sdk', 'zod', 'ws', 'zod-to-json-schema', 'ajv', 'fast-deep-equal', 'json-schema-traverse', 'fast-uri', 'ajv-formats'];
const parts = ['Third-party dependencies included in the self-contained MCP bundle.\nThe fork retains its upstream MIT license in LICENSE.\n'];
for (const name of dependencies) {
  let root = dirname(require.resolve(name === '@modelcontextprotocol/sdk' ? name + '/server/mcp.js' : name));
  for (;;) {
    try { const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); if (manifest.name === name) break; } catch {}
    const parent = dirname(root); if (parent === root) throw new Error('Could not locate dependency manifest: ' + name); root = parent;
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  let license;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'license', 'license.md']) {
    try { license = await readFile(join(root, filename), 'utf8'); break; } catch {}
  }
  if (!license) throw new Error('Missing bundled dependency license: ' + name);
  parts.push(`\n===== ${name}@${manifest.version} (${manifest.license}) =====\n\n${license}\n`);
}
await writeFile(new URL('../plugins/deepseek-harness/THIRD_PARTY_LICENSES.txt', import.meta.url), parts.join(''));
console.log('Bundled dependency license notices generated.');
