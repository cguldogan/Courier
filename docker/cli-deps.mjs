// Assembles the command-line runner for the container image (see Dockerfile): copies
// out/cli/courier.cjs and exactly the installed packages it needs at runtime into <dest>.
//
// The bundle leaves the runtime dependencies external (cli.vite.config.mts), so the packages it
// require()s are read from the bundle itself. Their transitive closure is resolved through
// package-lock.json with Node's lookup rules (nested node_modules first, then the parent
// directories) and copied from the `npm ci` tree, so every version is the locked one and nothing
// is resolved again. Source maps and type declarations are left out; nothing loads them at run time.
//
// Usage (after `npm ci` and `npm run build:cli`): node docker/cli-deps.mjs /opt/courier
import { builtinModules } from 'node:module'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'

const dest = process.argv[2]
if (!dest) {
  console.error('usage: node docker/cli-deps.mjs <dest>')
  process.exit(2)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const bundle = readFileSync('out/cli/courier.cjs', 'utf8')

const packageName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
const external = [...new Set([...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))]
  .filter((s) => !s.startsWith('node:') && !builtinModules.includes(s))
  .map(packageName)
const roots = [...new Set(external)].sort()
for (const name of roots) {
  if (!pkg.dependencies?.[name]) throw new Error(`The CLI bundle requires "${name}", which is not a production dependency`)
}

// Node's lookup from a package directory: <dir>/node_modules/<name>, then each parent's.
function resolve(fromPath, name) {
  let dir = fromPath
  for (;;) {
    const candidate = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`
    if (lock.packages[candidate]) return candidate
    if (!dir) return null
    const i = dir.lastIndexOf('/node_modules/')
    dir = i === -1 ? '' : dir.slice(0, i)
  }
}

const needed = new Set()
const queue = roots.map((name) => {
  const p = resolve('', name)
  if (!p) throw new Error(`${name} is not in package-lock.json`)
  return p
})
while (queue.length) {
  const path = queue.pop()
  if (needed.has(path)) continue
  const entry = lock.packages[path]
  if (entry.dev) throw new Error(`${path} is marked dev-only in package-lock.json`)
  needed.add(path)
  const optionalPeers = new Set(Object.entries(entry.peerDependenciesMeta ?? {}).filter(([, m]) => m.optional).map(([n]) => n))
  const deps = [
    ...Object.keys(entry.dependencies ?? {}).map((n) => [n, false]),
    ...Object.keys(entry.optionalDependencies ?? {}).map((n) => [n, true]),
    ...Object.keys(entry.peerDependencies ?? {}).map((n) => [n, optionalPeers.has(n)])
  ]
  for (const [name, optional] of deps) {
    const target = resolve(path, name)
    // An optional dependency for another platform is in the lockfile but was not installed.
    if (!target || !existsSync(target)) {
      if (optional) continue
      throw new Error(`${path} needs ${name}, which is not installed`)
    }
    queue.push(target)
  }
}

const skip = /\.(map|d\.ts|d\.mts|d\.cts)$/
mkdirSync(join(dest, 'bin'), { recursive: true })
for (const path of [...needed].sort()) {
  const entry = lock.packages[path]
  const installed = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
  if (installed.version !== entry.version) throw new Error(`${path}: installed ${installed.version}, locked ${entry.version}`)
  // Nested node_modules are copied as packages of their own (only when needed).
  cpSync(path, join(dest, path), {
    recursive: true,
    filter: (src) => {
      const rel = posix.normalize(src.split('\\').join('/'))
      return !skip.test(rel) && !rel.slice(path.length).includes('/node_modules')
    }
  })
}

cpSync('out/cli/courier.cjs', join(dest, 'courier.cjs'))
chmodSync(join(dest, 'courier.cjs'), 0o755)
symlinkSync('../courier.cjs', join(dest, 'bin', 'courier'))
writeFileSync(
  join(dest, 'package.json'),
  JSON.stringify(
    {
      name: 'courier-cli',
      version: pkg.version,
      private: true,
      license: pkg.license,
      description: 'Courier command-line runner (container image)',
      bin: { courier: 'courier.cjs' },
      dependencies: Object.fromEntries(roots.map((n) => [n, lock.packages[`node_modules/${n}`].version]))
    },
    null,
    2
  ) + '\n'
)
console.log(`courier ${pkg.version}: ${roots.join(', ')} -> ${needed.size} packages in ${dest}`)
