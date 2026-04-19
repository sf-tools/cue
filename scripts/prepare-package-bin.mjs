import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputPath = path.join(__dirname, '../dist/cue.js');
const shebang = '#!/usr/bin/env node\n';

const content = await readFile(outputPath, 'utf8');

if (!content.startsWith(shebang)) {
  await writeFile(outputPath, `${shebang}${content}`);
}

await chmod(outputPath, 0o755);
