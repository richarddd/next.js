import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readTranspiledConfig,
  writeTranspiledConfig,
} from '../../../packages/next/src/build/next-config-ts/transpile-cache'
import { getCacheDirectory } from '../../../packages/next/src/lib/helpers/get-cache-directory'

jest.mock('../../../packages/next/src/lib/helpers/get-cache-directory', () => ({
  getCacheDirectory: jest.fn(),
}))

describe('transpiled next.config.ts cache', () => {
  let temporaryDirectory: string
  let projectDirectory: string
  let configPath: string
  const source = 'export default { poweredByHeader: false }'
  const code = 'module.exports = { poweredByHeader: false }'

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'next-config-ts-cache-test-')
    )
    projectDirectory = path.join(temporaryDirectory, 'app')
    fs.mkdirSync(projectDirectory)
    configPath = path.join(projectDirectory, 'next.config.ts')
    fs.writeFileSync(configPath, source)
    jest
      .mocked(getCacheDirectory)
      .mockReturnValue(path.join(temporaryDirectory, 'cache'))
  })

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  it('reuses output only while the config source matches', () => {
    expect(readTranspiledConfig(projectDirectory, configPath)).toBeUndefined()
    writeTranspiledConfig(projectDirectory, configPath, source, code)
    expect(readTranspiledConfig(projectDirectory, configPath)).toBe(code)

    fs.writeFileSync(configPath, 'export default { poweredByHeader: true }')
    expect(readTranspiledConfig(projectDirectory, configPath)).toBeUndefined()
  })

  it.each(['tsconfig.json', 'jsconfig.json'])(
    'invalidates output when %s is added or changed',
    (filename) => {
      writeTranspiledConfig(projectDirectory, configPath, source, code)
      const compilerConfig = path.join(projectDirectory, filename)
      fs.writeFileSync(compilerConfig, '{}')
      expect(readTranspiledConfig(projectDirectory, configPath)).toBeUndefined()

      writeTranspiledConfig(projectDirectory, configPath, source, code)
      expect(readTranspiledConfig(projectDirectory, configPath)).toBe(code)
      fs.writeFileSync(compilerConfig, '{"compilerOptions": {}}')
      expect(readTranspiledConfig(projectDirectory, configPath)).toBeUndefined()
    }
  )

  it('ignores cache write failures', () => {
    const blockedDirectory = path.join(temporaryDirectory, 'not-a-directory')
    fs.writeFileSync(blockedDirectory, '')
    jest.mocked(getCacheDirectory).mockReturnValue(blockedDirectory)
    expect(() =>
      writeTranspiledConfig(projectDirectory, configPath, source, code)
    ).not.toThrow()
    expect(readTranspiledConfig(projectDirectory, configPath)).toBeUndefined()
  })
})
