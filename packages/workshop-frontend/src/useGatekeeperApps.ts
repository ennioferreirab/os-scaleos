import { useEffect, useState } from 'react'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { useOptionalAuthenticatedApi } from './AuthContext'
import { useLocale } from './i18n'

// Shared per-API-stub in-flight request, so multiple callers in one render cycle share a single
// RPC. Resolved data is never retained: an app-policy change must be observed on the next call.
const appsRequestByApi = new WeakMap<object, Promise<GatekeeperAppInfo[]>>()
// Mounted useGatekeeperApps() hooks register here so an explicit refresh can prompt them to refetch.
const refreshListeners = new Set<() => void>()

/**
 * Drop the cached apps request and prompt mounted hooks to refetch. Unlike connected accounts, the
 * apps list has no live subscription, so callers must invoke this after an action that changes which
 * gatekeepers provide a UI (opting into or disconnecting an optional ambient gatekeeper).
 */
export function refreshGatekeeperApps(api: object): void {
  appsRequestByApi.delete(api)
  for (const listener of refreshListeners) listener()
}

/**
 * The gatekeeper-served management apps available to the current user (one per gatekeeper that sets
 * `providesUi`, e.g. the Context Library). The Workshop hosts each at `/gatekeepers/$appId` and lists
 * them in the nav — no gatekeeper is hardcoded here; the set comes from the backend's discovery of
 * bound gatekeepers. Returns [] until authenticated/loaded. `GatekeeperAppInfo` is plain data
 * (id/title/icon), so it's safe to hold in state.
 */
export function useGatekeeperApps(): GatekeeperAppInfo[] {
  const auth = useOptionalAuthenticatedApi()
  const { t } = useLocale()
  const [apps, setApps] = useState<GatekeeperAppInfo[]>([])
  // Bumped by refreshGatekeeperApps() to re-run the fetch effect after the cache is invalidated.
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    const listener = () => setRefreshTick((tick) => tick + 1)
    refreshListeners.add(listener)
    return () => { refreshListeners.delete(listener) }
  }, [])

  useEffect(() => {
    if (!auth) {
      setApps([])
      return
    }
    const api: object = auth.authenticatedApi
    let request = appsRequestByApi.get(api)
    if (!request) {
      request = auth.authenticatedApi.listGatekeeperApps()
      appsRequestByApi.set(api, request)
      // Keep only the in-flight request. A later mount/navigation must issue a fresh policy read.
      void request.then(
        () => {
          if (appsRequestByApi.get(api) === request) appsRequestByApi.delete(api)
        },
        () => {
          if (appsRequestByApi.get(api) === request) appsRequestByApi.delete(api)
        },
      )
    }
    let cancelled = false
    request
      .then((list) => {
        if (!cancelled) setApps(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [auth, refreshTick])

  return apps.map(app => app.id === 'scheduler'
    ? { ...app, title: t('connections.vendors.scheduler.displayName') }
    : app)
}
