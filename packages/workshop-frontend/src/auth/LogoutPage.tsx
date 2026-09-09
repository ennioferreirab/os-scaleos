import { useEffect } from 'react'
import { AuthProgressPage } from './AuthProgressPage'
import { getCentralSupabase, getPublicAuthConfig } from './supabase'

/** Global central logout with a closed enum for the post-logout application. */
export function LogoutPage() {
  useEffect(() => {
    const selected = new URLSearchParams(window.location.search).get('returnApp')
    const config = getPublicAuthConfig()
    const target = selected === 'vault' && config.vaultPublicUrl ? config.vaultPublicUrl : config.osPublicUrl
    void getCentralSupabase().auth.signOut({ scope: 'global' }).finally(() => {
      window.location.replace(target)
    })
  }, [])
  return <AuthProgressPage message="Saindo…" />
}
