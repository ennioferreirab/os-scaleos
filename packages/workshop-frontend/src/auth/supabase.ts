import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { UserManager, WebStorageStateStore } from 'oidc-client-ts'

export type PublicAuthConfig = {
  issuer: string
  publicUrl: string
  osClientId: string
  publishableKey: string
  osPublicUrl: string
  vaultPublicUrl?: string
}

function required(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name]?.trim()
  if (!value) throw new Error(`Missing public authentication setting ${name}.`)
  return value
}

function requiredUrl(name: keyof ImportMetaEnv): string {
  const url = new URL(required(name))
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error(`Invalid public authentication URL ${name}.`)
  }
  return url.toString().replace(/\/$/, '')
}

/** Read the public OAuth configuration compiled into this first-party frontend. */
export function getPublicAuthConfig(): PublicAuthConfig {
  const vaultPublicUrl = import.meta.env.VITE_VAULT_PUBLIC_URL?.trim()
    ? requiredUrl('VITE_VAULT_PUBLIC_URL')
    : undefined
  return {
    issuer: requiredUrl('VITE_AUTH_ISSUER'),
    publicUrl: requiredUrl('VITE_AUTH_PUBLIC_URL'),
    osClientId: required('VITE_AUTH_OS_CLIENT_ID'),
    publishableKey: required('VITE_SUPABASE_PUBLISHABLE_KEY'),
    osPublicUrl: requiredUrl('VITE_OS_PUBLIC_URL'),
    ...(vaultPublicUrl ? { vaultPublicUrl } : {}),
  }
}

let centralClient: SupabaseClient | undefined
let osManager: UserManager | undefined

/** Whether this build contains the complete public Supabase/OIDC configuration. */
export function hasPublicAuthConfig(): boolean {
  const values = [
    import.meta.env.VITE_AUTH_ISSUER,
    import.meta.env.VITE_AUTH_PUBLIC_URL,
    import.meta.env.VITE_AUTH_OS_CLIENT_ID,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    import.meta.env.VITE_OS_PUBLIC_URL,
  ].map(value => value?.trim() ?? '')
  if (values.some(Boolean) && !values.every(Boolean)) {
    throw new Error('Public Supabase authentication configuration is incomplete.')
  }
  return values.every(Boolean)
}

/** Supabase browser client for the central login, consent, recovery, and logout surfaces. */
export function getCentralSupabase(): SupabaseClient {
  if (!centralClient) {
    const config = getPublicAuthConfig()
    centralClient = createClient(config.publicUrl, config.publishableKey, {
      auth: {
        storageKey: 'scaleos-central-auth',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })
  }
  return centralClient
}

/** OIDC Authorization Code + PKCE client for the OS application session. */
export function getOsUserManager(): UserManager {
  if (!osManager) {
    const config = getPublicAuthConfig()
    osManager = new UserManager({
      authority: config.issuer,
      client_id: config.osClientId,
      redirect_uri: `${config.osPublicUrl}/auth/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      automaticSilentRenew: true,
      monitorSession: false,
      loadUserInfo: false,
      userStore: new WebStorageStateStore({
        store: window.sessionStorage,
        prefix: 'scaleos-os-auth:user:',
      }),
      stateStore: new WebStorageStateStore({
        store: window.sessionStorage,
        prefix: 'scaleos-os-auth:state:',
      }),
    })
  }
  return osManager
}

/** Begin an OS authorization request through the central Supabase consent surface. */
export async function beginOsLogin(returnPath = '/'): Promise<void> {
  const safeReturnPath = returnPath.startsWith('/') && !returnPath.startsWith('//')
    ? returnPath
    : '/'
  await getOsUserManager().signinRedirect({ state: { returnPath: safeReturnPath } })
}

/** Clear only the OS client session before handing global logout to the central surface. */
export async function logoutOs(): Promise<void> {
  await getOsUserManager().removeUser()
  sessionStorage.removeItem('authToken')
  window.location.assign('/auth/logout?returnApp=os')
}
