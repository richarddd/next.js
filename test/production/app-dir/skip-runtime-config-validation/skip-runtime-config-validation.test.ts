import stripAnsi from 'strip-ansi'
import { nextTestSetup } from 'e2e-utils'

describe('experimental.skipRuntimeConfigValidation', () => {
  const { next } = nextTestSetup({
    files: __dirname,
    skipStart: true,
  })

  it('still validates during build but not when the production server starts', async () => {
    const build = await next.build()
    expect(build.exitCode).toBe(0)
    const buildOutput = stripAnsi(build.cliOutput)
    expect(buildOutput).toContain('Invalid next.config.ts options detected')
    expect(buildOutput).toContain('notARealOption')

    await next.start({ skipBuild: true })
    const res = await next.fetch('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('hello world')

    const startOutput = stripAnsi(next.cliOutput)
    expect(startOutput).not.toContain('Invalid next.config.ts options detected')
    expect(startOutput).not.toContain('notARealOption')
  })
})
