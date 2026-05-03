// build.mjs — esbuild script for the phantom CLI
import { build }     from 'esbuild'
import { chmod }     from 'node:fs/promises'
import { mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })

await build({
  entryPoints: ['src/index.ts'],
  bundle:      true,
  platform:    'node',
  format:      'esm',
  target:      'node20',
  outfile:     'dist/phantom.mjs',
  // Keep CJS modules external so require() resolution works at runtime
  packages:    'external',
  banner:      { js: '#!/usr/bin/env node' },
  logLevel:    'info',
})

await chmod('dist/phantom.mjs', 0o755)

console.log('\n  ✓  dist/phantom.mjs ready')
console.log('     npm install -g .   → phantom command globally available\n')
