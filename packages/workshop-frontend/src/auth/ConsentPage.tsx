import { useEffect, useState } from 'react'
import type { OAuthAuthorizationDetails } from '@supabase/supabase-js'
import { AuthCard } from './AuthCard'
import { getCentralSupabase, getPublicAuthConfig } from './supabase'

function authorizationId(): string | null {
  const value = new URLSearchParams(window.location.search).get('authorization_id')
  return value && value.length <= 512 ? value : null
}

function assertKnownClient(details: OAuthAuthorizationDetails): void {
  const config = getPublicAuthConfig()
  const allowed = new Map<string, string>([
    [config.osClientId, `${config.osPublicUrl}/auth/callback`],
  ])
  const vaultClientId = import.meta.env.VITE_AUTH_VAULT_CLIENT_ID?.trim()
  if (vaultClientId && config.vaultPublicUrl) {
    allowed.set(vaultClientId, `${config.vaultPublicUrl}/auth/callback`)
  }
  if (allowed.get(details.client.id) !== details.redirect_uri) {
    throw new Error('Cliente ou retorno OAuth não autorizado.')
  }
}

/** Consent UI hosted at the exact authorization path configured in Supabase. */
export function ConsentPage() {
  const [details, setDetails] = useState<OAuthAuthorizationDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = authorizationId()

  useEffect(() => {
    if (!id) {
      setError('Solicitação de autorização inválida.')
      return
    }
    const supabase = getCentralSupabase()
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) {
        const returnTo = `/auth/consent?authorization_id=${encodeURIComponent(id)}`
        window.location.replace(`/auth/central?returnTo=${encodeURIComponent(returnTo)}`)
        return
      }
      const result = await supabase.auth.oauth.getAuthorizationDetails(id)
      if (result.error || !result.data) throw result.error ?? new Error('Solicitação inválida.')
      if (!('authorization_id' in result.data)) {
        window.location.replace(result.data.redirect_url)
        return
      }
      assertKnownClient(result.data)
      setDetails(result.data)
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'Não foi possível carregar a autorização.')
    })
  }, [id])

  const decide = async (approved: boolean) => {
    if (!details) return
    setBusy(true)
    setError(null)
    const oauth = getCentralSupabase().auth.oauth
    const result = approved
      ? await oauth.approveAuthorization(details.authorization_id, { skipBrowserRedirect: true })
      : await oauth.denyAuthorization(details.authorization_id, { skipBrowserRedirect: true })
    if (result.error || !result.data) {
      setError(result.error?.message ?? 'Não foi possível registrar sua decisão.')
      setBusy(false)
      return
    }
    window.location.assign(result.data.redirect_url)
  }

  return (
    <AuthCard title="Autorizar acesso" description="Revise qual sistema receberá uma sessão própria.">
      {error && <p className="text-sm text-kumo-danger" role="alert">{error}</p>}
      {!error && !details && <p className="text-sm text-kumo-subtle">Carregando solicitação…</p>}
      {details && (
        <div className="space-y-5">
          <dl className="space-y-3 text-sm">
            <div><dt className="text-kumo-subtle">Aplicação</dt><dd className="font-medium text-kumo-strong">{details.client.name}</dd></div>
            <div><dt className="text-kumo-subtle">Permissões</dt><dd className="text-kumo-default">{details.scope.split(' ').join(', ')}</dd></div>
          </dl>
          <div className="flex gap-3">
            <button className="h-10 flex-1 rounded-lg border border-kumo-line text-sm text-kumo-default" disabled={busy} onClick={() => decide(false)}>Negar</button>
            <button className="h-10 flex-1 rounded-lg bg-kumo-brand text-sm font-medium text-white disabled:opacity-60" disabled={busy} onClick={() => decide(true)}>Autorizar</button>
          </div>
        </div>
      )}
    </AuthCard>
  )
}
