import { workAsyncStorage } from '../app-render/work-async-storage.external'
import {
  workUnitAsyncStorage,
  type WorkUnitStore,
} from '../app-render/work-unit-async-storage.external'
import type { SyncIOApiType } from '../app-render/sync-io-messages'

// These are only needed once a prerender or staged render actually hits sync
// IO. Loading them lazily keeps them (and dynamic-rendering's dependencies) off
// the startup path of every server process, including proxy-only ones.
function loadSyncIODependencies() {
  return {
    ...(require('../app-render/dynamic-rendering') as typeof import('../app-render/dynamic-rendering')),
    ...(require('../app-render/staged-rendering') as typeof import('../app-render/staged-rendering')),
    ...(require('../dynamic-rendering-utils') as typeof import('../dynamic-rendering-utils')),
    ...(require('../app-render/sync-io-messages') as typeof import('../app-render/sync-io-messages')),
    ...(require('../../shared/lib/invariant-error') as typeof import('../../shared/lib/invariant-error')),
  }
}

// Whether the switch below can do anything for this store. Kept as a separate
// function so it doesn't narrow `workUnitStore` for that switch.
function mayTrackSyncIO(workUnitStore: WorkUnitStore): boolean {
  switch (workUnitStore.type) {
    case 'prerender':
    case 'prerender-runtime':
    case 'prerender-client':
      return true
    case 'request':
      return workUnitStore.stagedRendering != null
    default:
      return false
  }
}

export function io(expression: string, type: SyncIOApiType) {
  const workUnitStore = workUnitAsyncStorage.getStore()
  const workStore = workAsyncStorage.getStore()

  if (!workUnitStore || !workStore) {
    return
  }

  if (!mayTrackSyncIO(workUnitStore)) {
    return
  }

  const {
    abortOnSynchronousPlatformIOAccess,
    RenderStage,
    applyOwnerStack,
    createSyncIOClientError,
    createSyncIOError,
    createSyncIORuntimeError,
    InvariantError,
  } = loadSyncIODependencies()

  switch (workUnitStore.type) {
    case 'prerender':
    case 'prerender-runtime': {
      const prerenderSignal = workUnitStore.controller.signal

      if (prerenderSignal.aborted === false) {
        // If the prerender signal is already aborted we don't need to construct
        // any stacks because something else actually terminated the prerender.
        // TODO: synchronize this with `stageController`
        abortOnSynchronousPlatformIOAccess(
          workStore.route,
          expression,
          applyOwnerStack(createSyncIOError(workStore.route, expression, type)),
          workUnitStore
        )
      }
      break
    }
    case 'prerender-client': {
      const prerenderSignal = workUnitStore.controller.signal

      if (prerenderSignal.aborted === false) {
        // If the prerender signal is already aborted we don't need to construct
        // any stacks because something else actually terminated the prerender.
        abortOnSynchronousPlatformIOAccess(
          workStore.route,
          expression,
          applyOwnerStack(
            createSyncIOClientError(workStore.route, expression, type)
          ),
          workUnitStore
        )
      }
      break
    }
    case 'request': {
      const stageController = workUnitStore.stagedRendering
      if (stageController && stageController.shouldTrackSyncInterrupt()) {
        let syncIOError: Error
        // NOTE: keep stages where we can interrupt in sync with
        // `shouldTrackSyncInterrupt`/`syncInterruptCurrentStageWithReason`
        switch (stageController.currentStage) {
          case RenderStage.ShellStatic:
          case RenderStage.PrefetchStatic_prefetchApi:
          case RenderStage.PrefetchStatic:
          case RenderStage.NavigationStatic: {
            syncIOError = createSyncIOError(workStore.route, expression, type)
            break
          }
          case RenderStage.ShellRuntime:
          case RenderStage.PrefetchRuntime_prefetchApi:
          case RenderStage.PrefetchRuntime:
          case RenderStage.NavigationRuntime: {
            // We're in a runtime stage.
            // We only error for Sync IO in runtime stages if the route has partialPrefetching enabled.
            syncIOError = createSyncIORuntimeError(
              workStore.route,
              expression,
              type
            )
            break
          }
          case RenderStage.Before:
          case RenderStage.Dynamic:
          case RenderStage.Abandoned: {
            throw new InvariantError(
              `shouldTrackSyncInterrupt allowed a sync IO interrupt in an unexpected stage: ${RenderStage[stageController.currentStage]}`
            )
          }
        }

        syncIOError = applyOwnerStack(syncIOError)
        stageController.syncInterruptCurrentStageWithReason(syncIOError)

        // A validation render uses a 'request' store type, but may be abortable.
        // If we're rendering with filled caches, Sync IO is an error and should trigger an abort.
        if (
          workUnitStore.controller &&
          !workUnitStore.controller.signal.aborted
        ) {
          workUnitStore.controller.abort(syncIOError)
        }
      }
      break
    }
    case 'validation-client':
    case 'prerender-legacy':
    case 'cache':
    case 'private-cache':
    case 'unstable-cache':
    case 'build-time-generator':
      break
    default:
      workUnitStore satisfies never
  }
}
