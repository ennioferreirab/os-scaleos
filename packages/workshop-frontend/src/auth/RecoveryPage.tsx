import { useState, type FormEvent } from 'react'
import { AuthCard } from './AuthCard'
import { beginOsLogin, getCentralSupabase } from './supabase'

/** Invite/recovery landing page: updates the central credential, then starts OS OAuth. */
export function RecoveryPage() {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password.length < 8 || password !== confirmation) {
      setError('Use ao menos 8 caracteres e confirme a mesma senha.')
      return
    }
    setBusy(true)
    setError(null)
    const { error: updateError } = await getCentralSupabase().auth.updateUser({ password })
    if (updateError) {
      setError(updateError.message)
      setBusy(false)
      return
    }
    await beginOsLogin()
  }

  return (
    <AuthCard title="Definir senha" description="Conclua seu convite ou recuperação na identidade central.">
      <form className="space-y-4" onSubmit={submit}>
        <input className="h-10 w-full rounded-lg border border-kumo-line bg-kumo-base px-3" type="password" autoComplete="new-password" placeholder="Nova senha" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} required />
        <input className="h-10 w-full rounded-lg border border-kumo-line bg-kumo-base px-3" type="password" autoComplete="new-password" placeholder="Confirmar senha" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} required />
        {error && <p className="text-sm text-kumo-danger" role="alert">{error}</p>}
        <button className="h-10 w-full rounded-lg bg-kumo-brand text-sm font-medium text-white disabled:opacity-60" type="submit" disabled={busy}>Continuar</button>
      </form>
    </AuthCard>
  )
}
