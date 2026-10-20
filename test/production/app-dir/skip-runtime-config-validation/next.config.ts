import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: {
    skipRuntimeConfigValidation: true,
    // @ts-expect-error -- an unknown key, so schema validation reports it
    notARealOption: true,
  },
}

export default nextConfig
