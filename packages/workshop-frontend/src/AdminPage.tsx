import { useState, useEffect, useRef, type ChangeEvent } from 'react'
import { RpcStub } from 'capnweb'
import { Switch, Textarea, Input, Button, Tabs, useKumoToastManager } from '@cloudflare/kumo'
import { ClockCounterClockwise, Hexagon, ShieldWarning, UserPlus, Users } from '@phosphor-icons/react'
import { useAuthenticatedApi } from './AuthContext'
import { AdminApi, AdminAuditEvent, AdminFormat, AdminResourceVendor, AmbientGatekeeperMode, DirectoryUser, PendingUserLifecycle, MAX_INSTANCE_INSTRUCTIONS_LENGTH, MAX_ANNOUNCEMENT_LENGTH, MAX_SITE_NAME_LENGTH, DEFAULT_SITE_NAME, BannerColor, BANNER_COLORS, DEFAULT_BANNER_COLOR } from '@gadgets/workshop-shared/api'
import { cacheBustSiteLogoUrl, prepareSiteLogo } from './siteLogoUtils'
import SiteLogo from './components/SiteLogo'
import { useDocumentTitle } from './useDocumentTitle'
import AdminFormatsPanel from './components/format/AdminFormatsPanel'
import AdminGroupsPanel from './components/AdminGroupsPanel'
import { useLocale } from './i18n'
import { hasPublicAuthConfig } from './auth/supabase'

// Swatch background per banner color, matching AnnouncementBanner's accent styles.
const BANNER_SWATCH: Record<BannerColor, string> = {
  neutral: 'var(--color-kumo-tint)',
  info: 'var(--color-kumo-info)',
  success: 'var(--color-kumo-success)',
  warning: 'var(--color-kumo-warning)',
  danger: 'var(--color-kumo-danger)',
  brand: 'var(--color-accent-100)',
}

type PendingInviteMutation = {
  email: string
  displayName: string
  mutationId: string
}

const pendingInviteStorageKey = (actorId: string) => `scaleos-admin-pending-invite:${actorId}`

function readPendingInvite(actorId: string): PendingInviteMutation | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingInviteStorageKey(actorId)) ?? 'null')
    if (typeof value?.email !== 'string' || typeof value?.displayName !== 'string' ||
        typeof value?.mutationId !== 'string') return null
    return value
  } catch {
    return null
  }
}

function storePendingInvite(actorId: string, value: PendingInviteMutation | null) {
  const key = pendingInviteStorageKey(actorId)
  if (value) sessionStorage.setItem(key, JSON.stringify(value))
  else sessionStorage.removeItem(key)
}

export default function AdminPage() {
  const { authenticatedApi, isAdmin, currentUser } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const { t, formatNumber } = useLocale()
  const centralAuthEnabled = hasPublicAuthConfig()
  useDocumentTitle(t('adminArea.pageTitle'))

  // The admin capability (minted once via getAdminApi; null until loaded / for non-admins). Wrapped
  // in an object so useState doesn't treat the (callable) RPC stub as a state updater function.
  const [admin, setAdmin] = useState<{ api: RpcStub<AdminApi> } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  // System-prompt instructions: last-saved value + current editor draft.
  const [savedInstructions, setSavedInstructions] = useState('')
  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [savingInstructions, setSavingInstructions] = useState(false)

  // Top-bar notice: last-saved value + current editor draft.
  const [savedAnnouncement, setSavedAnnouncement] = useState('')
  const [announcementDraft, setAnnouncementDraft] = useState('')
  const [savingAnnouncement, setSavingAnnouncement] = useState(false)

  // Full-width banner: last-saved value + current editor draft (text + accent color).
  const [savedBanner, setSavedBanner] = useState<{ text: string; color: BannerColor }>({ text: '', color: DEFAULT_BANNER_COLOR })
  const [bannerTextDraft, setBannerTextDraft] = useState('')
  const [bannerColorDraft, setBannerColorDraft] = useState<BannerColor>(DEFAULT_BANNER_COLOR)
  const [savingBanner, setSavingBanner] = useState(false)

  // Site name (shown next to the top-bar logo): last-saved value + current editor draft.
  const [savedSiteName, setSavedSiteName] = useState('')
  const [siteNameDraft, setSiteNameDraft] = useState('')
  const [savingSiteName, setSavingSiteName] = useState(false)

  // Current custom logo URL. Uploads are normalized to PNG before crossing the RPC boundary.
  const [siteLogoUrl, setSiteLogoUrl] = useState<string | null>(null)
  const [savingSiteLogo, setSavingSiteLogo] = useState(false)
  const siteLogoInputRef = useRef<HTMLInputElement>(null)

  // Whether new account signups are allowed.
  const [signupsEnabled, setSignupsEnabled] = useState(true)
  const [savingSignups, setSavingSignups] = useState(false)
  // Preserve the operation key after an uncertain failure so an explicit retry cannot duplicate the
  // administrative change or its event.
  const pendingSignupMutation = useRef<{ enabled: boolean; idempotencyKey: string } | null>(null)

  // Local administrative audit history is fetched only when its tab is opened.
  const [auditEvents, setAuditEvents] = useState<AdminAuditEvent[]>([])
  const [loadingAudit, setLoadingAudit] = useState(false)
  const [auditLoadError, setAuditLoadError] = useState(false)

  const [directoryUsers, setDirectoryUsers] = useState<DirectoryUser[]>([])
  const [pendingUserLifecycle, setPendingUserLifecycle] = useState<PendingUserLifecycle[]>([])
  const [invitationEmail, setInvitationEmail] = useState('')
  const [invitationDisplayName, setInvitationDisplayName] = useState('')
  const [inviteRetryPending, setInviteRetryPending] = useState(false)
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [savingUser, setSavingUser] = useState<string | null>(null)
  const pendingInviteMutation = useRef<PendingInviteMutation | null>(null)
  const pendingStatusMutations = useRef(new Map<string, {
    status: 'active' | 'disabled'
    mutationId: string
  }>())

  // Gatekeeper resource config, and the set of resource keys ("vendorId\u0000urlPattern") busy toggling.
  const [resourceVendors, setResourceVendors] = useState<AdminResourceVendor[]>([])
  const [resourceBusy, setResourceBusy] = useState<Set<string>>(new Set())

  const [activeTab, setActiveTab] = useState('general')

  // Promoted output formats, in menu order (see AdminFormatsPanel).
  const [formats, setFormats] = useState<AdminFormat[]>([])

  const resourceKey = (vendorId: string, urlPattern: string) => `${vendorId}\u0000${urlPattern}`

  const auditActionLabel = (action: AdminAuditEvent['action']) => {
    switch (action) {
      case 'bootstrapAdmin': return t('adminArea.audit.actions.bootstrapAdmin')
      case 'inviteUser': return t('adminArea.audit.actions.inviteUser')
      case 'setUserRole': return t('adminArea.audit.actions.setUserRole')
      case 'setUserStatus': return t('adminArea.audit.actions.setUserStatus')
      case 'createGroup': return t('adminArea.audit.actions.createGroup')
      case 'renameGroup': return t('adminArea.audit.actions.renameGroup')
      case 'replaceGroupMembers': return t('adminArea.audit.actions.replaceGroupMembers')
      case 'deleteGroup': return t('adminArea.audit.actions.deleteGroup')
      case 'setAppPolicy': return t('adminArea.audit.actions.setAppPolicy')
      case 'setSignupsEnabled': return t('adminArea.audit.actions.setSignupsEnabled')
    }
  }

  const auditValue = (value: AdminAuditEvent['change']['before']) => {
    if (value === true) return t('adminArea.audit.enabled')
    if (value === false) return t('adminArea.audit.disabled')
    return value ?? '—'
  }

  // Populate all editor state from a freshly-fetched settings view.
  const applySettings = (view: Awaited<ReturnType<RpcStub<AdminApi>['getSettings']>>) => {
    setSignupsEnabled(view.signupsEnabled)
    setSavedSiteName(view.siteName)
    setSiteNameDraft(view.siteName)
    setSiteLogoUrl(view.siteLogo?.url ?? null)
    setResourceVendors(view.resourceVendors)
    setSavedInstructions(view.instanceInstructions)
    setInstructionsDraft(view.instanceInstructions)
    setSavedAnnouncement(view.announcement)
    setAnnouncementDraft(view.announcement)
    setSavedBanner(view.banner)
    setBannerTextDraft(view.banner.text)
    setBannerColorDraft(view.banner.color)
    setFormats(view.formats)
  }

  // Mint the admin capability once (the access check happens server-side) and load settings.
  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    let cancelled = false
    let stub: RpcStub<AdminApi> | null = null
    ;(async () => {
      try {
        const api = await authenticatedApi.getAdminApi()
        if (cancelled) {
          api?.[Symbol.dispose]?.()
          return
        }
        if (!api) {
          setLoadError(true)
          return
        }
        stub = api
        setAdmin({ api })
        applySettings(await api.getSettings())
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load admin settings:', err)
          setLoadError(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      stub?.[Symbol.dispose]?.()
    }
  }, [isAdmin, authenticatedApi])

  // Re-fetch just the gatekeeper/resource state (used to revert an optimistic toggle on error).
  // Leaves the General-tab drafts untouched.
  const reloadResources = async () => {
    if (!admin) return
    const view = await admin.api.getSettings()
    setResourceVendors(view.resourceVendors)
  }

  const handleResourceToggle = async (vendorId: string, urlPattern: string, enabled: boolean) => {
    if (!admin) return
    const key = resourceKey(vendorId, urlPattern)
    setResourceBusy((prev) => new Set(prev).add(key))
    // Optimistic update.
    setResourceVendors((prev) =>
      prev.map((v) =>
        v.vendorId !== vendorId || v.autoProvisions
          ? v
          : { ...v, resources: v.resources.map((r) => (r.urlPattern === urlPattern ? { ...r, enabled } : r)) }
      )
    )
    try {
      await admin.api.setResourceEnabled(vendorId, urlPattern, enabled)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.updateFailed')
      toasts.add({ title: message, variant: 'error' })
      await reloadResources().catch(() => {})
    } finally {
      setResourceBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleGatekeeperToggle = async (vendorId: string, enabled: boolean) => {
    if (!admin) return
    const key = `gk\u0000${vendorId}`
    setResourceBusy((prev) => new Set(prev).add(key))
    setResourceVendors((prev) =>
      prev.map((v) => (v.vendorId === vendorId && !v.autoProvisions ? { ...v, enabled } : v))
    )
    try {
      await admin.api.setGatekeeperMode(vendorId, enabled ? 'enabled' : 'disabled')
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.updateFailed')
      toasts.add({ title: message, variant: 'error' })
      await reloadResources().catch(() => {})
    } finally {
      setResourceBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleGatekeeperMode = async (vendorId: string, mode: AmbientGatekeeperMode) => {
    if (!admin) return
    const key = `gk\u0000${vendorId}`
    setResourceBusy((prev) => new Set(prev).add(key))
    setResourceVendors((prev) =>
      prev.map((v) => (v.vendorId === vendorId && v.autoProvisions ? { ...v, ambientMode: mode } : v))
    )
    try {
      await admin.api.setGatekeeperMode(vendorId, mode)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.updateFailed')
      toasts.add({ title: message, variant: 'error' })
      await reloadResources().catch(() => {})
    } finally {
      setResourceBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleSaveAnnouncement = async () => {
    if (!admin) return
    setSavingAnnouncement(true)
    try {
      await admin.api.setAnnouncement(announcementDraft)
      setSavedAnnouncement(announcementDraft)
      toasts.add({ title: t('adminArea.toasts.announcementSaved'), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.saveAnnouncementFailed')
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingAnnouncement(false)
    }
  }

  const bannerDirty =
    bannerTextDraft !== savedBanner.text || bannerColorDraft !== savedBanner.color

  const handleSaveBanner = async () => {
    if (!admin) return
    setSavingBanner(true)
    try {
      await admin.api.setBanner(bannerTextDraft, bannerColorDraft)
      setSavedBanner({ text: bannerTextDraft, color: bannerColorDraft })
      toasts.add({ title: t('adminArea.toasts.bannerSaved'), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.saveBannerFailed')
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingBanner(false)
    }
  }

  const handleSignupsToggle = async (enabled: boolean) => {
    if (!admin) return
    setSavingSignups(true)
    setSignupsEnabled(enabled) // optimistic
    const pending = pendingSignupMutation.current
    const mutation = pending?.enabled === enabled
      ? pending
      : { enabled, idempotencyKey: crypto.randomUUID() }
    pendingSignupMutation.current = mutation
    try {
      await admin.api.setSignupsEnabled(enabled, mutation.idempotencyKey)
      if (pendingSignupMutation.current === mutation) pendingSignupMutation.current = null
    } catch (err) {
      setSignupsEnabled(!enabled) // revert; retrying this target reuses the same operation key
      const message = err instanceof Error ? err.message : t('adminArea.errors.updateFailed')
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingSignups(false)
    }
  }

  const loadAuditEvents = async () => {
    if (!admin) return
    setLoadingAudit(true)
    setAuditLoadError(false)
    try {
      const events = await admin.api.listAuditEvents()
      setAuditEvents([...events])
      events[Symbol.dispose]?.()
    } catch (err) {
      console.error('Failed to load administrative audit history:', err)
      setAuditLoadError(true)
    } finally {
      setLoadingAudit(false)
    }
  }

  const loadDirectory = async () => {
    if (!admin) return
    setLoadingUsers(true)
    try {
      const [usersResult, pendingResult] = await Promise.all([
        admin.api.listDirectoryUsers(),
        admin.api.listPendingUserLifecycle(),
      ])
      setDirectoryUsers([...usersResult])
      setPendingUserLifecycle([...pendingResult])
      usersResult[Symbol.dispose]?.()
      pendingResult[Symbol.dispose]?.()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.loadUsersFailed')
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setLoadingUsers(false)
    }
  }

  useEffect(() => {
    if (currentUser?.type !== 'user') return
    const pending = readPendingInvite(currentUser.id)
    pendingInviteMutation.current = pending
    if (!pending) return
    setInvitationEmail(pending.email)
    setInvitationDisplayName(pending.displayName)
    setInviteRetryPending(true)
  }, [currentUser])

  const handleCreateInvitation = async () => {
    if (!admin || currentUser?.type !== 'user' ||
        !invitationEmail.trim() || !invitationDisplayName.trim()) return
    const email = invitationEmail.trim().toLowerCase()
    const displayName = invitationDisplayName.trim()
    const pending = pendingInviteMutation.current
    const mutation = pending?.email === email && pending.displayName === displayName
      ? pending
      : { email, displayName, mutationId: crypto.randomUUID() }
    pendingInviteMutation.current = mutation
    storePendingInvite(currentUser.id, mutation)
    setSavingUser('invite')
    try {
      await admin.api.inviteUser(mutation)
      if (pendingInviteMutation.current === mutation) pendingInviteMutation.current = null
      storePendingInvite(currentUser.id, null)
      setInviteRetryPending(false)
      setInvitationEmail('')
      setInvitationDisplayName('')
      toasts.add({ title: t('adminArea.toasts.invitationCreated'), variant: 'success' })
      await loadDirectory()
    } catch (err) {
      setInviteRetryPending(true)
      const message = err instanceof Error ? err.message : t('adminArea.errors.updateFailed')
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingUser(null)
    }
  }

  const handleUserStatus = async (user: DirectoryUser) => {
    if (!admin) return
    const status: DirectoryUser['status'] = user.status === 'active' ? 'disabled' : 'active'
    const pending = pendingStatusMutations.current.get(user.userId)
    const mutation = pending?.status === status
      ? pending
      : { status, mutationId: crypto.randomUUID() }
    pendingStatusMutations.current.set(user.userId, mutation)
    setSavingUser(user.userId)
    try {
      await admin.api.setUserStatus({userId: user.userId, ...mutation})
      if (pendingStatusMutations.current.get(user.userId) === mutation) {
        pendingStatusMutations.current.delete(user.userId)
      }
      toasts.add({ title: t('adminArea.toasts.userStatusSaved'), variant: 'success' })
      await loadDirectory()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.updateFailed')
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingUser(null)
    }
  }

  const handleResumeUserStatus = async (pending: PendingUserLifecycle) => {
    if (!admin) return
    setSavingUser(pending.userId)
    try {
      await admin.api.resumeUserStatus(pending)
      pendingStatusMutations.current.delete(pending.userId)
      toasts.add({ title: t('adminArea.toasts.userStatusSaved'), variant: 'success' })
      await loadDirectory()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.updateFailed')
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingUser(null)
    }
  }

  const handleUserRole = async (user: DirectoryUser) => {
    if (!admin) return
    setSavingUser(user.userId)
    try {
      await admin.api.setUserRole({
        userId: user.userId,
        role: user.role === 'admin' ? 'member' : 'admin',
        mutationId: crypto.randomUUID(),
      })
      toasts.add({ title: 'Papel atualizado.', variant: 'success' })
      await loadDirectory()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.updateFailed')
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingUser(null)
    }
  }

  useEffect(() => {
    if (activeTab === 'audit' && admin) void loadAuditEvents()
    if (activeTab === 'users' && admin) void loadDirectory()
  }, [activeTab, admin])

  const handleSaveSiteName = async () => {
    if (!admin) return
    setSavingSiteName(true)
    try {
      await admin.api.setSiteName(siteNameDraft)
      setSavedSiteName(siteNameDraft)
      toasts.add({ title: t('adminArea.toasts.siteNameSaved'), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.saveSiteNameFailed')
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingSiteName(false)
    }
  }

  const handleSiteLogoChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !admin) return

    setSavingSiteLogo(true)
    try {
      const data = await prepareSiteLogo(file)
      const logo = await admin.api.setSiteLogo(data)
      setSiteLogoUrl(logo ? cacheBustSiteLogoUrl(logo.url) : null)
      toasts.add({ title: t('adminArea.toasts.logoSaved'), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.saveLogoFailed')
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingSiteLogo(false)
    }
  }

  const handleRemoveSiteLogo = async () => {
    if (!admin) return
    setSavingSiteLogo(true)
    try {
      await admin.api.setSiteLogo(null)
      setSiteLogoUrl(null)
      toasts.add({ title: t('adminArea.toasts.defaultLogoRestored'), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.removeLogoFailed')
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingSiteLogo(false)
    }
  }

  const handleSaveInstructions = async () => {
    if (!admin) return
    setSavingInstructions(true)
    try {
      await admin.api.setInstanceInstructions(instructionsDraft)
      setSavedInstructions(instructionsDraft)
      toasts.add({ title: t('adminArea.toasts.instructionsSaved'), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('adminArea.errors.saveInstructionsFailed')
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingInstructions(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 text-center">
        <ShieldWarning size={32} className="mx-auto text-kumo-subtle mb-3" />
        <p className="text-sm text-kumo-default">{t('adminArea.accessDenied')}</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <p className="text-kumo-subtle">{t('adminArea.loading')}</p>
      </div>
    )
  }

  if (loadError || !admin) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-danger">{t('adminArea.loadError')}</p>
        <button onClick={() => window.location.reload()} className="text-kumo-brand mt-2 text-sm underline">
          {t('adminArea.tryAgain')}
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-kumo-default">{t('adminArea.pageTitle')}</h1>
        <p className="text-sm text-kumo-subtle mt-1">
          {t('adminArea.description')}
        </p>
      </div>

      <Tabs
        variant="underline"
        value={activeTab}
        onValueChange={setActiveTab}
        tabs={[
          { value: 'general', label: t('adminArea.tabs.general') },
          { value: 'gatekeepers', label: t('adminArea.tabs.gatekeepers') },
          { value: 'formats', label: t('adminArea.tabs.formats') },
          { value: 'users', label: t('adminArea.tabs.users') },
          { value: 'groups', label: t('adminArea.tabs.groups') },
          ...(!centralAuthEnabled
            ? [{ value: 'access', label: t('adminArea.tabs.access') }]
            : []),
          { value: 'audit', label: t('adminArea.tabs.audit') },
        ]}
      />

      {activeTab === 'users' && (
        <div className="space-y-6">
          <section className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <Users size={20} className="text-kumo-subtle" />
              <div>
                <h2 className="text-lg font-semibold text-kumo-strong">{t('adminArea.users.title')}</h2>
                <p className="text-sm text-kumo-subtle">{t('adminArea.users.description')}</p>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <Input
                className="flex-1"
                label="Nome"
                value={invitationDisplayName}
                onChange={(event) => setInvitationDisplayName(event.target.value)}
                disabled={savingUser !== null || inviteRetryPending}
              />
              <Input
                className="flex-1"
                label={t('adminArea.users.invitationEmail')}
                type="email"
                value={invitationEmail}
                onChange={(event) => setInvitationEmail(event.target.value)}
                disabled={savingUser !== null || inviteRetryPending}
              />
              <Button
                className="self-end"
                onClick={handleCreateInvitation}
                loading={savingUser === 'invite'}
                disabled={!invitationEmail.trim() || !invitationDisplayName.trim()}
              >
                {t('adminArea.users.invite')}
              </Button>
            </div>
          </section>

          <section className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-kumo-strong">{t('adminArea.users.members')}</h2>
              <Button size="sm" variant="secondary" onClick={loadDirectory} loading={loadingUsers}>
                {t('adminArea.audit.refresh')}
              </Button>
            </div>
            <div className="space-y-3">
              {directoryUsers.map((user) => (
                <article key={user.userId} className="flex items-center gap-4 rounded-lg border border-kumo-line bg-kumo-base p-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-kumo-strong truncate">{user.displayName}</p>
                    <p className="text-xs text-kumo-subtle truncate">{user.email}</p>
                    <p className="text-xs text-kumo-subtle break-all">{user.userId}</p>
                    <p className="text-xs text-kumo-subtle">{user.role} · {user.status}</p>
                    {pendingUserLifecycle.some(pending => pending.userId === user.userId) && (
                      <p className="text-xs font-medium text-kumo-warning">
                        Mudança de status pendente
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={savingUser === user.userId}
                      disabled={user.status !== 'active'}
                      onClick={() => handleUserRole(user)}
                    >
                      {user.role === 'admin' ? 'Tornar membro' : 'Tornar admin'}
                    </Button>
                    {(() => {
                      const pending = pendingUserLifecycle.find(item => item.userId === user.userId)
                      return pending ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={savingUser === user.userId}
                          disabled={pending.status === 'disabled' && currentUser?.id === user.userId}
                          onClick={() => handleResumeUserStatus(pending)}
                        >
                          Retomar mudança
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={savingUser === user.userId}
                          disabled={user.status === 'active' && currentUser?.id === user.userId}
                          onClick={() => handleUserStatus(user)}
                        >
                          {user.status === 'active'
                            ? t('adminArea.users.disable')
                            : t('adminArea.users.reactivate')}
                        </Button>
                      )
                    })()}
                  </div>
                </article>
              ))}
              {!loadingUsers && directoryUsers.length === 0 && (
                <p className="text-sm text-kumo-subtle">{t('adminArea.users.empty')}</p>
              )}
            </div>
          </section>

        </div>
      )}

      {activeTab === 'groups' && admin && <AdminGroupsPanel admin={admin.api} />}

      {/* Standard output formats */}
      {activeTab === 'formats' && admin && (
        <AdminFormatsPanel
          admin={admin.api}
          formats={formats}
          onChanged={async () => { setFormats((await admin.api.getSettings()).formats) }}
        />
      )}

      {/* Local administrative audit history */}
      {activeTab === 'audit' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t('adminArea.audit.title')}</h2>
              <p className="text-sm text-kumo-subtle">{t('adminArea.audit.description')}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={loadAuditEvents} loading={loadingAudit}>
              {t('adminArea.audit.refresh')}
            </Button>
          </div>

          {auditLoadError && (
            <p className="text-sm text-kumo-danger">{t('adminArea.audit.loadError')}</p>
          )}
          {!auditLoadError && loadingAudit && auditEvents.length === 0 && (
            <p className="text-sm text-kumo-subtle">{t('adminArea.audit.loading')}</p>
          )}
          {!auditLoadError && !loadingAudit && auditEvents.length === 0 && (
            <p className="text-sm text-kumo-subtle">{t('adminArea.audit.empty')}</p>
          )}
          <div className="space-y-3">
            {auditEvents.map((event) => (
              <article key={event.eventId} className="rounded-lg border border-kumo-line bg-kumo-base p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-kumo-strong">
                    <ClockCounterClockwise size={17} className="text-kumo-subtle" />
                    {auditActionLabel(event.action)}
                  </div>
                  <time className="text-xs text-kumo-subtle" dateTime={event.occurredAt}>
                    {event.occurredAt}
                  </time>
                </div>
                <p className="mt-2 text-sm text-kumo-default">
                  {t('adminArea.audit.change', {
                    before: auditValue(event.change.before),
                    after: auditValue(event.change.after),
                  })}
                </p>
                <dl className="mt-3 grid gap-2 text-xs text-kumo-subtle sm:grid-cols-2">
                  <div><dt className="font-medium">{t('adminArea.audit.actor')}</dt><dd className="break-all">{event.actorUserId}</dd></div>
                  <div><dt className="font-medium">{t('adminArea.audit.tenant')}</dt><dd className="break-all">{event.tenantId}</dd></div>
                  <div><dt className="font-medium">{t('adminArea.audit.result')}</dt><dd>{t('adminArea.audit.succeeded')}</dd></div>
                  <div><dt className="font-medium">{t('adminArea.audit.eventId')}</dt><dd className="break-all">{event.eventId}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        </div>
      )}

      {/* Sign-ups */}
      {activeTab === 'access' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <div className="flex items-center gap-4">
            <div className="w-9 h-9 rounded-lg flex-shrink-0 flex items-center justify-center bg-kumo-tint">
              <UserPlus size={18} className="text-kumo-subtle" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-kumo-strong">{t('adminArea.signups.title')}</h2>
              <p className="text-sm text-kumo-subtle mt-0.5">
                {t('adminArea.signups.description')}
              </p>
            </div>
            <Switch
              checked={signupsEnabled}
              disabled={savingSignups}
              onCheckedChange={handleSignupsToggle}
            />
          </div>
        </div>
      )}

      {/* Site name */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t('adminArea.siteName.title')}</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            {t('adminArea.siteName.description', { defaultName: DEFAULT_SITE_NAME })}
          </p>

          <Input
            value={siteNameDraft}
            onChange={(e) => setSiteNameDraft(e.target.value)}
            placeholder={DEFAULT_SITE_NAME}
            maxLength={MAX_SITE_NAME_LENGTH}
          />

          <div className="flex items-center justify-end mt-4 gap-2">
            {siteNameDraft !== savedSiteName && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSiteNameDraft(savedSiteName)}
                disabled={savingSiteName}
              >
                {t('adminArea.reset')}
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveSiteName}
              loading={savingSiteName}
              disabled={siteNameDraft === savedSiteName}
            >
              {t('adminArea.save')}
            </Button>
          </div>
        </div>
      )}

      {/* Site logo */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t('adminArea.logo.title')}</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            {t('adminArea.logo.description')}
          </p>

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-kumo-line bg-kumo-base p-2">
              <SiteLogo size={40} srcOverride={siteLogoUrl}>
                <Hexagon size={32} weight="bold" className="text-kumo-brand" />
              </SiteLogo>
            </div>
            <input
              ref={siteLogoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              disabled={savingSiteLogo}
              onChange={handleSiteLogoChange}
            />
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => siteLogoInputRef.current?.click()}
                loading={savingSiteLogo}
                disabled={savingSiteLogo}
              >
                {siteLogoUrl ? t('adminArea.logo.change') : t('adminArea.logo.upload')}
              </Button>
              {siteLogoUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRemoveSiteLogo}
                  disabled={savingSiteLogo}
                >
                  {t('adminArea.logo.restore')}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ScaleOS identity */}
      {activeTab === 'general' && (
        <div
          role="group"
          aria-label={t('adminArea.identity.locked')}
          aria-disabled="true"
          className="bg-kumo-elevated border border-kumo-line rounded-xl p-6"
        >
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t('adminArea.identity.title')}</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            {t('adminArea.identity.description')}
          </p>

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
                {t('adminArea.identity.brand')}
              </p>
              <p className="mt-1 text-sm font-medium text-kumo-default">
                {t('adminArea.identity.brandName')}
              </p>
            </div>
            <div className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
                {t('adminArea.identity.theme')}
              </p>
              <p className="mt-1 text-sm font-medium text-kumo-default">
                {t('adminArea.identity.themeValue')}
              </p>
            </div>
            <div className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
                {t('adminArea.identity.accent')}
              </p>
              <p className="mt-1 flex items-center gap-2 text-sm font-medium text-kumo-default">
                <span className="h-3 w-3 rounded-full border border-kumo-line bg-kumo-brand" />
                {t('adminArea.identity.accentValue')}
              </p>
            </div>
          </div>

          <p className="mt-3 text-xs text-kumo-inactive">{t('adminArea.identity.locked')}</p>
        </div>
      )}

      {/* Full-width banner */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t('adminArea.banner.title')}</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            {t('adminArea.banner.description')}
          </p>

          <Textarea
            className="w-full"
            value={bannerTextDraft}
            onValueChange={setBannerTextDraft}
            rows={1}
            placeholder={t('adminArea.banner.placeholder')}
            maxLength={MAX_ANNOUNCEMENT_LENGTH}
            error={
              bannerTextDraft.length > MAX_ANNOUNCEMENT_LENGTH
                ? t('adminArea.banner.tooLongBy', {
                    count: bannerTextDraft.length - MAX_ANNOUNCEMENT_LENGTH,
                  })
                : undefined
            }
          />

          <div className="mt-4 flex items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-kumo-subtle mb-2">{t('adminArea.banner.type')}</p>
              <div className="flex flex-wrap items-center gap-2">
                {BANNER_COLORS.map((c) => {
                  const selected = bannerColorDraft === c
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setBannerColorDraft(c)}
                      className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                        selected
                          ? 'border-kumo-default text-kumo-default bg-kumo-tint'
                          : 'border-kumo-line text-kumo-subtle hover:bg-kumo-tint'
                      }`}
                    >
                      <span
                        className="w-4 h-4 rounded-full border border-kumo-line"
                        style={{ background: BANNER_SWATCH[c] }}
                      />
                      {t(`adminArea.banner.colors.${c}`)}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {bannerDirty && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setBannerTextDraft(savedBanner.text)
                    setBannerColorDraft(savedBanner.color)
                  }}
                  disabled={savingBanner}
                >
                  {t('adminArea.reset')}
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveBanner}
                loading={savingBanner}
                disabled={!bannerDirty || bannerTextDraft.length > MAX_ANNOUNCEMENT_LENGTH}
              >
                {t('adminArea.save')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Top-bar notice */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t('adminArea.topBarNotice.title')}</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            {t('adminArea.topBarNotice.description')}
          </p>

          <Textarea
            className="w-full"
            value={announcementDraft}
            onValueChange={setAnnouncementDraft}
            rows={1}
            placeholder={t('adminArea.topBarNotice.placeholder')}
            maxLength={MAX_ANNOUNCEMENT_LENGTH}
            error={
              announcementDraft.length > MAX_ANNOUNCEMENT_LENGTH
                ? t('adminArea.banner.tooLongBy', {
                    count: announcementDraft.length - MAX_ANNOUNCEMENT_LENGTH,
                  })
                : undefined
            }
          />

          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-kumo-subtle">
              {t('adminArea.characters', {
                used: formatNumber(announcementDraft.length),
                maximum: formatNumber(MAX_ANNOUNCEMENT_LENGTH),
              })}
            </span>
            <div className="flex items-center gap-2">
              {announcementDraft !== savedAnnouncement && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAnnouncementDraft(savedAnnouncement)}
                  disabled={savingAnnouncement}
                >
                  {t('adminArea.reset')}
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveAnnouncement}
                loading={savingAnnouncement}
                disabled={
                  announcementDraft === savedAnnouncement ||
                  announcementDraft.length > MAX_ANNOUNCEMENT_LENGTH
                }
              >
                {t('adminArea.save')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Agent system prompt additions */}
      {activeTab === 'general' && (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t('adminArea.instructions.title')}</h2>
        <p className="text-sm text-kumo-subtle mb-5">
          {t('adminArea.instructions.description')}
        </p>

        <Textarea
          className="w-full"
          value={instructionsDraft}
          onValueChange={setInstructionsDraft}
          rows={6}
          placeholder={t('adminArea.instructions.placeholder')}
          maxLength={MAX_INSTANCE_INSTRUCTIONS_LENGTH}
          error={
            instructionsDraft.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH
              ? t('adminArea.banner.tooLongBy', {
                  count: instructionsDraft.length - MAX_INSTANCE_INSTRUCTIONS_LENGTH,
                })
              : undefined
          }
        />

        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-kumo-subtle">
            {t('adminArea.characters', {
              used: formatNumber(instructionsDraft.length),
              maximum: formatNumber(MAX_INSTANCE_INSTRUCTIONS_LENGTH),
            })}
          </span>
          <div className="flex items-center gap-2">
            {instructionsDraft !== savedInstructions && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setInstructionsDraft(savedInstructions)}
                disabled={savingInstructions}
              >
                {t('adminArea.reset')}
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveInstructions}
              loading={savingInstructions}
              disabled={
                instructionsDraft === savedInstructions ||
                instructionsDraft.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH
              }
            >
              {t('adminArea.save')}
            </Button>
          </div>
        </div>
      </div>
      )}

      {/* Gatekeeper resources */}
      {activeTab === 'gatekeepers' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t('adminArea.gatekeepers.title')}</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            {t('adminArea.gatekeepers.description')}
          </p>

          {resourceVendors.length === 0 && (
            <p className="text-sm text-kumo-subtle">
              {t('adminArea.gatekeepers.noneInstalled')}
            </p>
          )}

          <div className="space-y-6">
            {resourceVendors.map((vendor) => {
              const gkKey = `gk\u0000${vendor.vendorId}`

              // Auto-provisioned ("ambient") gatekeepers use a three-state mode and have no resources.
              if (vendor.autoProvisions) {
                const mode = vendor.ambientMode ?? 'optional'
                const options: { value: AmbientGatekeeperMode; label: string; hint: string }[] = [
                  {
                    value: 'disabled',
                    label: t('adminArea.gatekeepers.modes.disabled'),
                    hint: t('adminArea.gatekeepers.modes.offForEveryone'),
                  },
                  {
                    value: 'optional',
                    label: t('adminArea.gatekeepers.modes.optional'),
                    hint: t('adminArea.gatekeepers.modes.usersCanAdd'),
                  },
                  {
                    value: 'enabled',
                    label: t('adminArea.gatekeepers.modes.enabled'),
                    hint: t('adminArea.gatekeepers.modes.onForEveryone'),
                  },
                ]
                return (
                  <div key={vendor.vendorId}>
                    <div className="flex items-center gap-3 mb-2 px-3 py-2 rounded-lg bg-kumo-tint/50">
                      {vendor.logo && (
                        <img
                          src={vendor.logo.url}
                          alt=""
                          className={`w-5 h-5 object-contain transition-[filter,opacity] ${mode === 'disabled' ? 'grayscale opacity-40' : ''}`}
                        />
                      )}
                      <h3 className={`flex-1 text-sm font-semibold ${mode === 'disabled' ? 'text-kumo-subtle' : 'text-kumo-default'}`}>
                        {vendor.displayName}
                      </h3>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-kumo-tint text-kumo-subtle border border-kumo-line">
                        {t('adminArea.gatekeepers.autoProvisioned')}
                      </span>
                    </div>
                    <div className="flex gap-2 px-3 py-1">
                      {options.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={resourceBusy.has(gkKey)}
                          onClick={() => handleGatekeeperMode(vendor.vendorId, opt.value)}
                          className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                            mode === opt.value
                              ? 'border-kumo-brand bg-kumo-brand/10'
                              : 'border-kumo-line hover:bg-kumo-tint'
                          }`}
                        >
                          <span className="block text-sm font-medium text-kumo-default">{opt.label}</span>
                          <span className="block text-xs text-kumo-subtle mt-0.5">{opt.hint}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              }

              return (
              <div key={vendor.vendorId}>
                {/* The whole header row is a toggle target; the Switch stops propagation so it
                    doesn't double-fire. */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => !resourceBusy.has(gkKey) && handleGatekeeperToggle(vendor.vendorId, !vendor.enabled)}
                  onKeyDown={(e) => {
                    if (e.currentTarget !== e.target) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      if (!resourceBusy.has(gkKey)) handleGatekeeperToggle(vendor.vendorId, !vendor.enabled)
                    }
                  }}
                  className="flex cursor-pointer items-center gap-3 mb-2 px-3 py-2 rounded-lg bg-kumo-tint/50 hover:bg-kumo-tint transition-colors"
                >
                  {vendor.logo && (
                    <img
                      src={vendor.logo.url}
                      alt=""
                      className={`w-5 h-5 object-contain transition-[filter,opacity] ${vendor.enabled ? '' : 'grayscale opacity-40'}`}
                    />
                  )}
                  <h3 className={`flex-1 text-sm font-semibold ${vendor.enabled ? 'text-kumo-default' : 'text-kumo-subtle'}`}>
                    {vendor.displayName}
                    {!vendor.enabled && (
                      <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-kumo-tint text-kumo-subtle border border-kumo-line">
                        {t('adminArea.gatekeepers.disabledBadge')}
                      </span>
                    )}
                  </h3>
                      <span className="text-xs text-kumo-subtle">
                    {vendor.enabled
                      ? t('adminArea.gatekeepers.modes.enabled')
                      : t('adminArea.gatekeepers.off')}
                  </span>
                  <span onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={vendor.enabled}
                      disabled={resourceBusy.has(gkKey)}
                      onCheckedChange={(enabled) => handleGatekeeperToggle(vendor.vendorId, enabled)}
                    />
                  </span>
                </div>
                {/* Resources are hidden while the gatekeeper is disabled — they can't be used
                    until it's re-enabled. */}
                {vendor.enabled ? (
                  <div className="space-y-1">
                    {vendor.resources.map((resource) => {
                      const key = resourceKey(vendor.vendorId, resource.urlPattern)
                      return (
                        <div
                          key={resource.urlPattern}
                          role="button"
                          tabIndex={0}
                          onClick={() => !resourceBusy.has(key) && handleResourceToggle(vendor.vendorId, resource.urlPattern, !resource.enabled)}
                          onKeyDown={(e) => {
                            if (e.currentTarget !== e.target) return
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              if (!resourceBusy.has(key)) handleResourceToggle(vendor.vendorId, resource.urlPattern, !resource.enabled)
                            }
                          }}
                          className="flex cursor-pointer items-center gap-4 px-3 py-2.5 rounded-lg hover:bg-kumo-tint transition-colors"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-kumo-default truncate">
                              {resource.title}
                            </p>
                            <p className="text-xs text-kumo-subtle mt-0.5">{resource.description}</p>
                          </div>
                          <span onClick={(e) => e.stopPropagation()}>
                            <Switch
                              checked={resource.enabled}
                              disabled={resourceBusy.has(key)}
                              onCheckedChange={(enabled) =>
                                handleResourceToggle(vendor.vendorId, resource.urlPattern, enabled)
                              }
                            />
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-kumo-subtle px-3 py-1">
                    {t(
                      vendor.resources.length === 1
                        ? 'adminArea.gatekeepers.hiddenResourcesOne'
                        : 'adminArea.gatekeepers.hiddenResourcesMany',
                      { count: formatNumber(vendor.resources.length) },
                    )}
                  </p>
                )}
              </div>
            )})}
          </div>
        </div>
      )}
    </div>
  )
}
