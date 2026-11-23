// Bundles the `courier` command line (src/cli) into out/cli/courier.cjs: plain Node, CommonJS, one
// file. Runtime dependencies stay external (resolved from node_modules, like the Electron main build).
// Kept separate from electron.vite.config.ts so the app's out/main bundle is unaffected.
import { chmodSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import pkg from './package.json' with { type: 'json' }

const root = fileURLToPath(new URL('.', import.meta.url))
const deps = Object.keys(pkg.dependencies)

export default defineConfig({
  root,
  logLevel: 'warn',
  // The bundle is the package's `bin`: make it directly executable (`./out/cli/courier.cjs`).
  plugins: [{ name: 'courier-cli-executable', writeBundle: () => chmodSync(`${root}out/cli/courier.cjs`, 0o755) }],
  build: {
    ssr: `${root}src/cli/bin.ts`,
    outDir: `${root}out/cli`,
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      // `electron` is listed so that an accidental import fails the CLI loudly instead of being bundled.
      external: (id) => id === 'electron' || id.startsWith('node:') || builtinModules.includes(id) || deps.some((d) => id === d || id.startsWith(`${d}/`)),
      output: { format: 'cjs', entryFileNames: 'courier.cjs', banner: '#!/usr/bin/env node' }
    }
  }
})
