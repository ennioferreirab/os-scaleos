import { useState, useEffect, useRef } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'
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

export function useAuth(publicApi: RpcStub<PublicApi>) {
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    authenticatedApi: null,
    isLoading: true,
    error: null,
  })
  const authenticatedApiRef = useRef<RpcStub<AuthenticatedApi> | null>(null)
  const generationRef = useRef(0)
  authenticatedApiRef.current = authState.authenticatedApi

  const installAuthenticatedApi = async (token: string | null, fromCfAccess = false) => {
    const generation = ++generationRef.current
    setAuthState((previous) => {
      previous.authenticatedApi?.[Symbol.dispose]()
      return { token, authenticatedApi: null, isLoading: true, error: null }
    })
    const api = fromCfAccess
      ? publicApi.authenticateFromCfAccess()
      : publicApi.authenticate(token!)
    try {
      const info = await api.whoami()
      if (generationRef.current !== generation) {
        api[Symbol.dispose]()
        return
      }
      setAuthState({ token, authenticatedApi: api, isLoading: false, error: null })
      if (info.type === 'user') setReportedUserId(info.id)
    } catch (caught) {
      api[Symbol.dispose]()
      if (generationRef.current === generation) {
        setAuthState({
          token: null,
          authenticatedApi: null,
          isLoading: false,
          error: caught instanceof Error ? caught.message : 'Authentication failed.',
        })
      }
      throw caught
    }
  }

  useEffect(() => {
    let cancelled = false

    if (hasPublicAuthConfig()) {
      const manager = getOsUserManager()
      let initialAuthenticationComplete = false
      const onUserLoaded = (user: { access_token: string }) => {
        if (!initialAuthenticationComplete || cancelled) return
        ++generationRef.current
        setAuthState((previous) => {
          previous.authenticatedApi?.[Symbol.dispose]()
          return { token: user.access_token, authenticatedApi: null, isLoading: true, error: null }
        })
        // A socket is bound to the first verified token that authenticated it. Disposing the
        // PublicApi makes the connection manager create a fresh socket; this effect then installs
        // the renewed token on that replacement instead of extending old derived capabilities.
        publicApi[Symbol.dispose]()
      }
      const onSilentRenewError = async () => {
        ++generationRef.current
        await manager.removeUser()
        if (!cancelled) {
          setAuthState((previous) => {
            previous.authenticatedApi?.[Symbol.dispose]()
            return { token: null, authenticatedApi: null, isLoading: false, error: null }
          })
          window.location.assign('/auth/central')
        }
      }
      const removeUserLoaded = manager.events.addUserLoaded(onUserLoaded)
      const removeSilentRenewError = manager.events.addSilentRenewError(onSilentRenewError)

      void (async () => {
        try {
          let user
          if (window.location.pathname === '/auth/callback') {
            user = await manager.signinRedirectCallback(window.location.href)
            const returnPath = callbackReturnPath(user.state)
            window.history.replaceState(null, '', returnPath)
          } else {
            user = await manager.getUser()
            if (user?.expired) {
              try {
                user = await manager.signinSilent()
              } catch {
                await manager.removeUser()
                window.location.assign('/auth/central')
                return
              }
            }
          }
          if (!user?.access_token) {
            if (!cancelled) setAuthState((previous) => ({ ...previous, isLoading: false }))
            return
          }
          await installAuthenticatedApi(user.access_token)
        } catch (caught) {
          await manager.removeUser()
          if (!cancelled) {
            const message = caught instanceof Error ? caught.message : 'Authentication failed.'
            setAuthState({ token: null, authenticatedApi: null, isLoading: false, error: message })
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
        authenticatedApiRef.current?.[Symbol.dispose]()
      }
    }

    // Compatibility path for upstream deployments which have not enabled the T03 Supabase mode.
    if (CF_ACCESS_MODE) {
      void installAuthenticatedApi(null, true).catch(() => {})
    } else {
      const storedToken = localStorage.getItem('authToken')
      if (storedToken) void installAuthenticatedApi(storedToken).catch(() => {})
      else setAuthState((previous) => ({ ...previous, isLoading: false }))
    }
    return () => {
      cancelled = true
      ++generationRef.current
      authenticatedApiRef.current?.[Symbol.dispose]()
    }
  }, [publicApi])

  const login = (token: string) => {
    localStorage.setItem('authToken', token)
    void installAuthenticatedApi(token).catch(() => {})
  }

  const logout = () => {
    ++generationRef.current
    setReportedUserId(undefined)
    setAuthState((previous) => {
      previous.authenticatedApi?.[Symbol.dispose]()
      return { token: null, authenticatedApi: null, isLoading: false, error: null }
    })
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
