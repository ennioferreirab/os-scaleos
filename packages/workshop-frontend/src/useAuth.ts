import { useState, useEffect, useRef } from 'react'
import { RpcStub } from 'capnweb'
import {
  AUTH_ERROR_CODES,
  AuthenticatedApi,
  getAuthErrorCode,
  PublicApi,
} from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { getOsUserManager, hasPublicAuthConfig, logoutOs } from './auth/supabase'

const CF_ACCESS_MODE = import.meta.env.VITE_CF_ACCESS_MODE === 'true' && !hasPublicAuthConfig()

interface AuthState {
  token: string | null
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  isLoading: boolean
  error: string | null
}

export { CF_ACCESS_MODE }

function callbackReturnPath(state: unknown): string {
  if (typeof state !== 'object' || state === null || !('returnPath' in state)) return '/'
  const candidate = state.returnPath
  return typeof candidate === 'string' && candidate.startsWith('/') && !candidate.startsWith('//')
    ? candidate
    : '/'
}

/** OIDC callback processing is global because the UserManager is global as well. */
const osCallbackPromises = new Map<
  string,
  Promise<Awaited<ReturnType<ReturnType<typeof getOsUserManager>['signinRedirectCallback']>>>
>()

function consumeOsCallback(manager: ReturnType<typeof getOsUserManager>, url: string) {
  let promise = osCallbackPromises.get(url)
  if (!promise) {
    promise = manager.signinRedirectCallback(url)
    osCallbackPromises.set(url, promise)
    void promise.then(
      () => { if (osCallbackPromises.get(url) === promise) osCallbackPromises.delete(url) },
      () => { if (osCallbackPromises.get(url) === promise) osCallbackPromises.delete(url) },
    )
  }
  return promise
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : 'Authentication failed.'
}

function shouldClearAuthUser(caught: unknown): boolean {
  const code = getAuthErrorCode(caught)
  return code === AUTH_ERROR_CODES.unauthenticated || code === AUTH_ERROR_CODES.invalidSessionToken
}

export function useAuth(publicApi: RpcStub<PublicApi>) {
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    authenticatedApi: null,
    isLoading: true,
    error: null,
  })
  const authenticatedApiRef = useRef<RpcStub<AuthenticatedApi> | null>(null)
  const generationRef = useRef(0)
  const initialAuthRef = useRef<{
    publicApi: RpcStub<PublicApi>
    promise: Promise<{
      user: { access_token?: string; expired?: boolean; state?: unknown } | null
      silentRenewFailed: boolean
    }>
  } | null>(null)

  authenticatedApiRef.current = authState.authenticatedApi

  const disposeAuthenticatedApi = () => {
    const api = authenticatedApiRef.current
    authenticatedApiRef.current = null
    try { api?.[Symbol.dispose]() } catch { /* already disposed */ }
  }

  const installAuthenticatedApi = async (
    token: string | null,
    generation: number,
    cancelled: () => boolean,
    fromCfAccess = false,
  ) => {
    if (cancelled() || generationRef.current !== generation) return
    const api = fromCfAccess
      ? publicApi.authenticateFromCfAccess()
      : publicApi.authenticate(token!)
    try {
      const info = await api.whoami()
      if (cancelled() || generationRef.current !== generation) {
        api[Symbol.dispose]()
        return
      }
      authenticatedApiRef.current = api
      setAuthState({ token, authenticatedApi: api, isLoading: false, error: null })
      if (info.type === 'user') setReportedUserId(info.id)
    } catch (caught) {
      api[Symbol.dispose]()
      if (!cancelled() && generationRef.current === generation) {
        setAuthState({ token: null, authenticatedApi: null, isLoading: false,
          error: errorMessage(caught) })
      }
      throw caught
    }
  }

  useEffect(() => {
    let cancelled = false
    const generation = ++generationRef.current
    // A replacement public socket invalidates the derived capability from the old socket. The
    // cleanup also performs this disposal, while the generation/cancel checks below keep an
    // in-flight old authenticate from installing itself after the new effect starts.
    disposeAuthenticatedApi()
    setAuthState((previous) => ({ ...previous, authenticatedApi: null, isLoading: true, error: null }))

    if (hasPublicAuthConfig()) {
      const manager = getOsUserManager()
      let initialAuthenticationComplete = false
      const onUserLoaded = (user: { access_token: string }) => {
        if (!initialAuthenticationComplete || cancelled) return
        ++generationRef.current
        disposeAuthenticatedApi()
        setAuthState({ token: user.access_token, authenticatedApi: null, isLoading: true, error: null })
        // A socket is bound to the first verified token that authenticated it. Disposing the
        // PublicApi makes the connection manager create a fresh socket for the renewed token.
        publicApi[Symbol.dispose]()
      }
      const onSilentRenewError = async () => {
        if (cancelled) return
        ++generationRef.current
        try { await manager.removeUser() } catch { /* redirect remains the safe recovery */ }
        if (cancelled) return
        disposeAuthenticatedApi()
        setAuthState({ token: null, authenticatedApi: null, isLoading: false, error: null })
        window.location.assign('/auth/central')
      }
      const removeUserLoaded = manager.events.addUserLoaded(onUserLoaded)
      const removeSilentRenewError = manager.events.addSilentRenewError(onSilentRenewError)

      void (async () => {
        // Errors while loading the OIDC user/callback indicate stale local OIDC state and may be
        // cleared. Once that state is loaded, an RPC dependency failure must not log the user out.
        let clearUserOnError = true
        try {
          let user: { access_token?: string; expired?: boolean; state?: unknown } | null
          let silentRenewFailed = false
          if (window.location.pathname === '/auth/callback') {
            user = await consumeOsCallback(manager, window.location.href)
            if (cancelled || generationRef.current !== generation) return
            const returnPath = callbackReturnPath(user.state)
            window.history.replaceState(null, '', returnPath)
          } else {
            const existing = initialAuthRef.current
            const promise = existing?.publicApi === publicApi
              ? existing.promise
              : manager.getUser().then(async (stored) => {
                if (stored?.expired) {
                  try { return { user: await manager.signinSilent(), silentRenewFailed: false } }
                  catch { return { user: null, silentRenewFailed: true } }
                }
                return { user: stored, silentRenewFailed: false }
              })
            if (!existing || existing.publicApi !== publicApi) {
              initialAuthRef.current = { publicApi, promise }
            }
            const initial = await promise
            user = initial.user
            silentRenewFailed = initial.silentRenewFailed
            if (cancelled || generationRef.current !== generation) return
          }
          if (cancelled || generationRef.current !== generation) return
          if (silentRenewFailed) {
            // Only the active effect may clear/redirect after a failed silent renewal. A canceled
            // StrictMode pass must never remove a session loaded by its replacement.
            try { await manager.removeUser() } catch { /* redirect remains the safe recovery */ }
            if (cancelled || generationRef.current !== generation) return
            setAuthState({ token: null, authenticatedApi: null, isLoading: false, error: null })
            window.location.assign('/auth/central')
            return
          }
          if (!user?.access_token) {
            if (!cancelled) setAuthState((previous) => ({ ...previous, isLoading: false }))
            return
          }
          clearUserOnError = false
          await installAuthenticatedApi(user.access_token, generation, () => cancelled)
        } catch (caught) {
          if (cancelled || generationRef.current !== generation) return
          // A stale StrictMode callback must never clear a current OIDC session. This catch is
          // reached only by the active effect, after every awaited operation checked cancellation.
          if (clearUserOnError || shouldClearAuthUser(caught)) {
            try { await manager.removeUser() } catch { /* preserve the original auth error */ }
          }
          if (cancelled || generationRef.current !== generation) return
          if (!cancelled && generationRef.current === generation) {
            setAuthState({ token: null, authenticatedApi: null, isLoading: false,
              error: errorMessage(caught) })
          }
        } finally {
          initialAuthenticationComplete = true
        }
      })()

      return () => {
        cancelled = true
        ++generationRef.current
        removeUserLoaded()
        removeSilentRenewError()
        disposeAuthenticatedApi()
      }
    }

    // Compatibility path for upstream deployments which have not enabled the T03 Supabase mode.
    void (async () => {
      try {
        if (cancelled || generationRef.current !== generation) return
        if (CF_ACCESS_MODE) {
          await installAuthenticatedApi(null, generation, () => cancelled, true)
        } else {
          const storedToken = localStorage.getItem('authToken')
          if (storedToken) await installAuthenticatedApi(storedToken, generation, () => cancelled)
          else if (!cancelled) setAuthState((previous) => ({ ...previous, isLoading: false }))
        }
      } catch (caught) {
        if (!cancelled && generationRef.current === generation) {
          setAuthState({ token: null, authenticatedApi: null, isLoading: false,
            error: errorMessage(caught) })
        }
      }
    })()
    return () => {
      cancelled = true
      ++generationRef.current
      disposeAuthenticatedApi()
    }
  }, [publicApi])

  const login = (token: string) => {
    localStorage.setItem('authToken', token)
    const generation = ++generationRef.current
    disposeAuthenticatedApi()
    setAuthState({ token: null, authenticatedApi: null, isLoading: true, error: null })
    void installAuthenticatedApi(token, generation, () => false).catch(() => {})
  }

  const logout = () => {
    ++generationRef.current
    setReportedUserId(undefined)
    disposeAuthenticatedApi()
    setAuthState({ token: null, authenticatedApi: null, isLoading: false, error: null })
    if (hasPublicAuthConfig()) {
      void logoutOs()
    } else if (CF_ACCESS_MODE) {
      window.location.assign('/cdn-cgi/access/logout')
    } else {
      localStorage.removeItem('authToken')
    }
  }

  return {
    ...authState,
    login,
    logout,
    isAuthenticated: !!authState.authenticatedApi,
  }
}
