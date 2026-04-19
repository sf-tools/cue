import { build } from 'esbuild';

await build({
  entryPoints: ['src/cue.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  minify: true,
  packages: 'external',
  outfile: 'dist/cue.js',
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
});

await import('./prepare-package-bin.mjs');
