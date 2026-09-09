import { useState, FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import { Hexagon } from '@phosphor-icons/react'
import { Input, Button, Banner, Loader } from '@cloudflare/kumo'
import { hashPassword } from './passwordHash'
import { useServerConfig, useServerConfigError, useSiteName } from './ServerConfigContext'
import { useDocumentTitle } from './useDocumentTitle'
import { useConnectionLost } from './RpcContext'
import OAuthButtons from './components/auth/OAuthButtons'
import SiteLogo from './components/SiteLogo'
import LanguageSelector from './components/LanguageSelector'
import { useLocale } from './i18n'
import { beginOsLogin, hasPublicAuthConfig } from './auth/supabase'


interface LoginPageProps {
  rpcStub: RpcStub<PublicApi>
  onLoginSuccess?: () => void
}

type LoginError =
  | { key: 'auth.signIn.invalidCredentials' | 'auth.signIn.failed' }
  | { message: string }

export default function LoginPage({ rpcStub, onLoginSuccess }: LoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<LoginError | null>(null)
  const [centralBusy, setCentralBusy] = useState(false)
  const serverConfig = useServerConfig()
  const serverConfigError = useServerConfigError()
  const siteName = useSiteName()
  const connectionLost = useConnectionLost()
  const { t } = useLocale()
  useDocumentTitle(t('auth.signIn.title'))

  const errorMessage = error
    ? 'key' in error ? t(error.key) : error.message
    : null

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!username || !password || loading) return
    setLoading(true)
    setError(null)

    try {
      const passwordHash = await hashPassword(username, password)
      const token = await rpcStub.login(username, passwordHash)
      if (token) {
        localStorage.setItem('authToken', token)
        if (onLoginSuccess) {
          onLoginSuccess()
        } else {
          window.location.reload()
        }
      } else {
        setError({ key: 'auth.signIn.invalidCredentials' })
      }
    } catch (err) {
      setError(err instanceof Error ? { message: err.message } : { key: 'auth.signIn.failed' })
    } finally {
      setLoading(false)
    }
  }

  if (hasPublicAuthConfig()) {
    const handleCentralLogin = async () => {
      setCentralBusy(true)
      setError(null)
      try {
        await beginOsLogin(`${window.location.pathname}${window.location.search}`)
      } catch (err) {
        setError(err instanceof Error ? { message: err.message } : { key: 'auth.signIn.failed' })
        setCentralBusy(false)
      }
    }
    return (
      <div className="relative flex h-full min-h-0 flex-col items-center justify-center bg-kumo-base px-4 py-8">
        <LanguageSelector className="absolute right-4 top-4 z-10 w-[170px]" />
        <div className="w-full max-w-sm rounded-2xl border border-kumo-line bg-kumo-elevated p-7">
          <div className="mb-7 flex flex-col items-center">
            <SiteLogo size={40} className="mb-3">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-brand">
                <Hexagon size={20} className="text-white" weight="bold" />
              </div>
            </SiteLogo>
            <h1 className="text-xl font-semibold text-kumo-default">{siteName}</h1>
            <p className="mt-1 text-center text-sm text-kumo-subtle">
              Entre com a identidade central da organização.
            </p>
          </div>
          {errorMessage && <Banner variant="error" title={errorMessage} className="mb-4" />}
          <Button
            variant="primary"
            className="w-full justify-center"
            loading={centralBusy}
            onClick={handleCentralLogin}
          >
            Continuar para entrar
          </Button>
        </div>
      </div>
    )
  }

  // Until the deployment config loads we don't know which auth methods are enabled, so don't guess:
  // defaulting to the password form would show it even where it's disabled (and hide configured
  // OAuth providers). This is especially important when the server is unreachable — serverConfig
  // stays null — so render a loading / connection state instead of a misconfigured form.
  if (!serverConfig) {
    if (serverConfigError && !connectionLost) {
      return (
        <div
          role="alert"
          className="relative flex h-full min-h-0 flex-col items-center justify-center gap-4 overflow-y-auto bg-kumo-base px-4 py-8"
        >
          <LanguageSelector className="absolute right-4 top-4 w-[170px]" />
          <p className="text-sm text-kumo-danger text-center">
            {t('auth.deploymentSettingsFailed')}
          </p>
          <Button variant="secondary" onClick={() => window.location.reload()}>{t('common.reload')}</Button>
        </div>
      )
    }
    return (
      <div className="relative flex h-full min-h-0 flex-col items-center justify-center gap-4 overflow-y-auto bg-kumo-base px-4 py-8">
        <LanguageSelector className="absolute right-4 top-4 w-[170px]" />
        <Loader size="lg" />
        <p className="text-sm text-kumo-subtle text-center">
          {connectionLost ? t('auth.serverUnavailable') : t('common.loading')}
        </p>
      </div>
    )
  }

  const authVendors = serverConfig.authVendors ?? []
  const passwordAuthEnabled = serverConfig.passwordAuthEnabled

  return (
    <div className="relative flex h-full min-h-0 flex-col items-center justify-start overflow-y-auto bg-kumo-base px-4 py-8">
      <LanguageSelector className="absolute right-4 top-4 z-10 w-[170px]" />
      {/* Dot grid — fades from top to bottom */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--color-kumo-line) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          maskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 70%)',
          WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 70%)',
        }}
      />

      <div className="relative my-auto w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <SiteLogo size={40} className="mb-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-kumo-brand mb-3">
              <Hexagon size={20} className="text-white" weight="bold" />
            </div>
          </SiteLogo>
          <h1 className="text-xl font-semibold text-kumo-default">{siteName}</h1>
          <p className="text-sm text-kumo-subtle mt-1">{t('auth.signIn.subtitle')}</p>
        </div>

        {passwordAuthEnabled && (
          <>
            {/* Username / password form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                className="w-full"
                label={t('auth.username')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                disabled={loading}
                placeholder={t('auth.usernamePlaceholder')}
              />

              <Input
                className="w-full"
                type="password"
                label={t('auth.password')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={loading}
                placeholder="••••••••"
              />

              {errorMessage && (
                <Banner variant="error" title={errorMessage} />
              )}

              <Button
                type="submit"
                variant="primary"
                disabled={!username || !password}
                loading={loading}
                className="w-full justify-center"
              >
                {t('auth.signIn.submit')}
              </Button>
            </form>

            <p className="text-center text-sm text-kumo-subtle mt-6">
              {t('auth.signIn.noAccount')}{' '}
              <Link to="/signup" className="text-kumo-brand hover:underline font-medium">
                {t('auth.signIn.createAccount')}
              </Link>
            </p>
          </>
        )}

        {/* Gatekeeper sign-in options, shown whenever any auth vendor is configured. */}
        {authVendors.length > 0 && (
          <div className={passwordAuthEnabled ? 'mt-6' : ''}>
            {passwordAuthEnabled && (
              <div className="flex items-center gap-3 mb-4">
                <div className="h-px flex-1 bg-kumo-line" />
                <span className="text-xs text-kumo-subtle">{t('common.or')}</span>
                <div className="h-px flex-1 bg-kumo-line" />
              </div>
            )}
            {!passwordAuthEnabled && errorMessage && (
              <Banner variant="error" title={errorMessage} className="mb-4" />
            )}
            <OAuthButtons rpcStub={rpcStub} vendors={authVendors} onSuccess={onLoginSuccess} />
          </div>
        )}
      </div>
    </div>
  )
}
