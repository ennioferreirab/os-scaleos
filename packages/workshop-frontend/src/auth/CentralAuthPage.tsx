import { useEffect, useState, type FormEvent } from 'react'
import { AuthCard } from './AuthCard'
import { beginOsLogin, getCentralSupabase, getPublicAuthConfig } from './supabase'

function consentReturnPath(): string | undefined {
  const candidate = new URLSearchParams(window.location.search).get('returnTo')
  if (!candidate) return undefined
  const parsed = new URL(candidate, window.location.origin)
  if (parsed.origin !== window.location.origin || parsed.pathname !== '/auth/consent' ||
      !parsed.searchParams.get('authorization_id')) return undefined
  return `${parsed.pathname}${parsed.search}`
}

/** Central Supabase email/password entry used by both registered public OAuth clients. */
export function CentralAuthPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const returnTo = consentReturnPath()

  useEffect(() => {
    void getCentralSupabase().auth.getUser().then(({ data }) => {
      if (!data.user) return
      if (returnTo) window.location.replace(returnTo)
      else void beginOsLogin()
    })
  }, [returnTo])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const { error: signInError } = await getCentralSupabase().auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (signInError) {
      setError(signInError.message)
      setBusy(false)
      return
    }
    if (returnTo) window.location.assign(returnTo)
    else await beginOsLogin()
  }

  const recover = async () => {
    if (!email.trim()) {
      setError('Informe seu e-mail para recuperar o acesso.')
      return
    }
    setBusy(true)
    setError(null)
    const { error: recoveryError } = await getCentralSupabase().auth.resetPasswordForEmail(
      email.trim(), { redirectTo: `${getPublicAuthConfig().osPublicUrl}/auth/recovery` })
    setBusy(false)
    setError(recoveryError?.message ?? 'Enviamos as instruções de recuperação para o seu e-mail.')
  }

  return (
    <AuthCard title="Entrar na organização" description="Use sua identidade central para acessar os sistemas autorizados.">
      <form className="space-y-4" onSubmit={submit}>
        <label className="block text-sm font-medium text-kumo-default">
          E-mail
          <input
            className="mt-1 h-10 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-kumo-default"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
          />
        </label>
        <label className="block text-sm font-medium text-kumo-default">
          Senha
          <input
            className="mt-1 h-10 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-kumo-default"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
        </label>
        {error && <p className="text-sm text-kumo-danger" role="status">{error}</p>}
        <button
          className="h-10 w-full rounded-lg bg-kumo-brand px-4 text-sm font-medium text-white disabled:opacity-60"
          type="submit"
          disabled={busy}
        >
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
        <button className="w-full text-sm text-kumo-subtle underline" type="button" onClick={recover} disabled={busy}>
          Esqueci minha senha
        </button>
      </form>
    </AuthCard>
  )
}
