import { useState, useRef, useEffect } from 'react'
import { useLocale } from '../i18n'
import { ArrowUpRight, ArrowClockwise } from '@phosphor-icons/react'
import { openCommandPalette } from './AppShell/commandPaletteBus'
export default function VaultCanvas() {
  const { t } = useLocale()
  const [loading, setLoading] = useState(true)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const vaultBaseUrl = (import.meta.env.VITE_VAULT_PUBLIC_URL || 'http://127.0.0.1:18083').replace(/\/$/, '')
  const vaultUrl = `${vaultBaseUrl}/app?embedded=1`

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'scaleos:open-command-palette') {
        openCommandPalette()
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  const handleReload = () => {
    if (iframeRef.current) {
      setLoading(true)
      iframeRef.current.src = vaultUrl
    }
  }

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-kumo-base">
      {/* Top bar with breadcrumb and open in browser button */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-elevated px-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
            {t('navigation.vault')}
          </span>
          <span className="text-xs text-kumo-inactive">·</span>
          <span className="text-xs text-kumo-subtle">ScaleOS Memory Vault</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReload}
            title={t('common.retry')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
          >
            <ArrowClockwise size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <a
            href={vaultUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Abrir em nova aba do navegador"
            className="flex h-7 w-7 items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
          >
            <ArrowUpRight size={14} />
          </a>
        </div>
      </div>

      {/* Embedded canvas edge-to-edge */}
      <div className="relative min-h-0 flex-1">
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-kumo-base z-10">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
            <p className="text-xs text-kumo-subtle">Carregando o Cofre…</p>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={vaultUrl}
          title={t('navigation.vault')}
          className="h-full w-full border-0 bg-transparent"
          allow="clipboard-write; clipboard-read"
          onLoad={() => setLoading(false)}
        />
      </div>
    </div>
  )
}
