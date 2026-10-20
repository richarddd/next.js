import module from 'module'

// Cache V8 bytecode for Next.js and the app's server chunks across process
// starts (Node.js >= 22.1). Node.js validates each entry against the source's
// content hash, stores the cache in the OS temp directory by default, and can
// be turned off with `NODE_DISABLE_COMPILE_CACHE=1`.
//
// This must run before any other module is loaded, so it is the first import
// of the CLI entry point.
// `enableCompileCache` isn't in the @types/node version this package builds
// against yet.
const { enableCompileCache } = module as typeof module & {
  enableCompileCache?: (cacheDir?: string) => unknown
}

try {
  enableCompileCache?.()
} catch {
  // The cache is an optimization; never fail to start because of it.
}
