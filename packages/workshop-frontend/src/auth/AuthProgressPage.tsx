import { AuthCard } from './AuthCard'

/** Neutral progress surface used while an OAuth callback or logout is being completed. */
export function AuthProgressPage({ message = 'Concluindo autenticação…' }: { message?: string }) {
  return <AuthCard title={message}><div className="h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" /></AuthCard>
}
