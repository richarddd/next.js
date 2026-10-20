import crypto from 'node:crypto'
import path from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { getCacheDirectory } from '../../lib/helpers/get-cache-directory'

// Caches the SWC output for `next.config.ts` across process starts, so a
// production server start doesn't parse the tsconfig, load the SWC bindings and
// transpile the same config every time.
//
// Entries are keyed by everything the output depends on: the config source,
// the project's tsconfig.json/jsconfig.json, the Next.js and Node.js versions,
// and the config's absolute path. Stale entries are never read because their
// key no longer matches.

function getCacheFile(
  dir: string,
  nextConfigPath: string,
  nextConfigSource: string
): string {
  const hash = crypto.createHash('sha256')
  hash.update(
    `${process.env.__NEXT_VERSION}\0${process.version}\0${path.resolve(nextConfigPath)}\0`
  )
  hash.update(nextConfigSource)
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    try {
      hash.update(`\0${name}\0`)
      hash.update(readFileSync(path.join(dir, name)))
    } catch {
      // Missing config files are part of the key too.
    }
  }
  return path.join(
    getCacheDirectory('next-config-ts'),
    `${hash.digest('hex')}.js`
  )
}

export function readTranspiledConfig(
  dir: string,
  nextConfigPath: string
): string | undefined {
  try {
    const source = readFileSync(nextConfigPath, 'utf8')
    return readFileSync(getCacheFile(dir, nextConfigPath, source), 'utf8')
  } catch {
    return undefined
  }
}

export function writeTranspiledConfig(
  dir: string,
  nextConfigPath: string,
  nextConfigSource: string,
  code: string
): void {
  try {
    const file = getCacheFile(dir, nextConfigPath, nextConfigSource)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    // Write then rename so concurrent starts never read a partial file.
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, code, { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // The cache is an optimization; ignore write failures.
  }
}
