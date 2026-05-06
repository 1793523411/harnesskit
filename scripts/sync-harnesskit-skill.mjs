import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const docsDir = join(root, 'docs');
const referencesDir = join(root, 'skills', 'harnesskit', 'references');

await mkdir(referencesDir, { recursive: true });
await copyFile(join(root, 'README.md'), join(referencesDir, 'project-overview.md'));

const entries = await readdir(docsDir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isFile() && entry.name.endsWith('.md')) {
    await copyFile(join(docsDir, entry.name), join(referencesDir, entry.name));
  }
}

console.log('Synced HarnessKit docs into skills/harnesskit/references');
