import type { ReactNode } from 'react'
import SiteLogo from '../components/SiteLogo'
import { useSiteName } from '../ServerConfigContext'

/** Shared shell for central and application authentication pages. */
export function AuthCard({ title, description, children }: {
  title: string
  description?: string
  children: ReactNode
}) {
  const siteName = useSiteName()
  return (
    <main className="flex min-h-full items-center justify-center bg-kumo-base p-6">
      <section className="w-full max-w-md rounded-2xl border border-kumo-line bg-kumo-elevated p-7 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <SiteLogo size={36} className="h-9 w-9">
            <span className="h-9 w-9 rounded-lg bg-kumo-brand" />
          </SiteLogo>
          <span className="text-sm font-semibold text-kumo-strong">{siteName}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-strong">{title}</h1>
        {description && <p className="mt-2 text-sm leading-5 text-kumo-subtle">{description}</p>}
        <div className="mt-6">{children}</div>
      </section>
    </main>
  )
}
