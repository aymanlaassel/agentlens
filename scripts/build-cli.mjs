import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: ['src/cli/index.ts'],
  outfile: 'dist-cli/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  metafile: process.argv.includes('--metafile'),
  logLevel: 'info',
});

if (result.metafile) await writeFile('dist-cli/metafile.json', JSON.stringify(result.metafile, null, 2));
