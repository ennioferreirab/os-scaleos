import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Switch, useKumoToastManager } from '@cloudflare/kumo'
import { RpcStub } from 'capnweb'
import type {
  AdminApi,
  AdminResourceVendor,
  AppPolicy,
  AppPolicyMode,
  Audience,
  DirectoryUser,
  Group,
  AppPolicyAudiencePreview,
} from '@gadgets/workshop-shared/api'
import { useLocale } from '../i18n'

type Props = {
  api: RpcStub<AdminApi>
  vendors: AdminResourceVendor[]
}

type Draft = AppPolicy & { dirty?: boolean }

const modes: AppPolicyMode[] = ['disabled', 'optional', 'enabled']

export default function AdminAppPoliciesPanel({ api, vendors }: Props) {
  const { t } = useLocale()
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const [policies, setPolicies] = useState<Draft[]>([])
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [previews, setPreviews] = useState<Record<string, AppPolicyAudiencePreview>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const savingRef = useRef(new Set<string>())
  const pendingMutations = useRef(new Map<string, { payload: string; id: string }>())

  useEffect(() => {
    let cancelled = false
    const loadPolicies = async () => {
      const result = await api.listAppPolicies()
      try {
        return result.map((policy) => ({
          ...policy,
          audience: {
            everyone: policy.audience.everyone,
            userIds: [...policy.audience.userIds],
            groupIds: [...policy.audience.groupIds],
          },
          dirty: false,
        }))
      } finally {
        result[Symbol.dispose]?.()
      }
    }
    const loadUsers = async () => {
      const result = await api.listDirectoryUsers()
      try {
        return result.map((user) => ({ ...user }))
      } finally {
        result[Symbol.dispose]?.()
      }
    }
    const loadGroups = async () => {
      const result = await api.listGroups()
      try {
        return result.map((group) => ({ ...group }))
      } finally {
        result[Symbol.dispose]?.()
      }
    }
    void Promise.all([loadPolicies(), loadUsers(), loadGroups()])
      .then(([nextPolicies, nextUsers, nextGroups]) => {
        if (cancelled) return
        setPolicies(nextPolicies)
        setUsers(nextUsers)
        setGroups(nextGroups)
      })
      .catch((error) => {
        if (!cancelled) {
          toastsRef.current.add({
            title: error instanceof Error ? error.message : t('adminArea.errors.loadPoliciesFailed'),
            variant: 'error',
          })
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [api, t])

  useEffect(() => {
    if (policies.length === 0) return
    let cancelled = false
    void Promise.all(policies.map(async (policy) => {
      try {
        const result = await api.previewAppPolicy({
          vendorId: policy.vendorId,
          mode: policy.mode,
          audience: policy.audience,
        })
        try {
          const preview: AppPolicyAudiencePreview = {
            users: result.users.map((user) => ({
              userId: user.userId,
              displayName: user.displayName,
              sources: [...user.sources],
            })),
          }
          return [policy.vendorId, preview] as const
        } finally {
          result[Symbol.dispose]?.()
        }
      } catch {
        return null
      }
    })).then((entries) => {
      if (cancelled) return
      const present = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      setPreviews(Object.fromEntries(present))
    })
    return () => { cancelled = true }
  }, [api, policies])

  const vendorById = useMemo(() => new Map(vendors.map((vendor) => [vendor.vendorId, vendor])), [vendors])

  const update = (vendorId: string, updater: (policy: Draft) => Draft) => {
    if (savingRef.current.has(vendorId)) return
    setPolicies((previous) => previous.map((policy) => policy.vendorId === vendorId ? { ...updater(policy), dirty: true } : policy))
  }

  const updateAudience = (vendorId: string, updater: (audience: Audience) => Audience) => {
    update(vendorId, (policy) => ({ ...policy, audience: updater(policy.audience) }))
  }

  const save = async (policy: Draft) => {
    if (savingRef.current.has(policy.vendorId)) return
    const payload = JSON.stringify({ vendorId: policy.vendorId, mode: policy.mode, audience: policy.audience })
    const pending = pendingMutations.current.get(policy.vendorId)
    const mutationId = pending?.payload === payload ? pending.id : crypto.randomUUID()
    pendingMutations.current.set(policy.vendorId, { payload, id: mutationId })
    savingRef.current.add(policy.vendorId)
    setSaving((previous) => new Set(previous).add(policy.vendorId))
    try {
      const result = await api.setAppPolicy({ vendorId: policy.vendorId, mode: policy.mode, audience: policy.audience, mutationId })
      let savedPolicy: Draft
      try {
        savedPolicy = {
          ...result.policy,
          audience: {
            everyone: result.policy.audience.everyone,
            userIds: [...result.policy.audience.userIds],
            groupIds: [...result.policy.audience.groupIds],
          },
          dirty: false,
        }
      } finally {
        result[Symbol.dispose]?.()
      }
      setPolicies((previous) => previous.map((entry) => entry.vendorId === policy.vendorId ? savedPolicy : entry))
      if (pendingMutations.current.get(policy.vendorId)?.id === mutationId) {
        pendingMutations.current.delete(policy.vendorId)
      }
      toastsRef.current.add({ title: t('adminArea.appPolicies.saved'), variant: 'success' })
    } catch (error) {
      toastsRef.current.add({ title: error instanceof Error ? error.message : t('adminArea.errors.updateFailed'), variant: 'error' })
    } finally {
      savingRef.current.delete(policy.vendorId)
      setSaving((previous) => { const next = new Set(previous); next.delete(policy.vendorId); return next })
    }
  }

  if (loading) return <p className="text-sm text-kumo-subtle">{t('adminArea.appPolicies.loading')}</p>

  return (
    <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t('adminArea.appPolicies.title')}</h2>
        <p className="text-sm text-kumo-subtle">{t('adminArea.appPolicies.description')}</p>
      </div>
      {policies.map((policy) => {
        const vendor = vendorById.get(policy.vendorId)
        const preview = previews[policy.vendorId]
        const isSaving = saving.has(policy.vendorId)
        const activeUsers = users.filter((user) => user.status === 'active')
        const activeUserIds = new Set(activeUsers.map((user) => user.userId))
        const knownGroupIds = new Set(groups.map((group) => group.groupId))
        const unavailableUserIds = policy.audience.userIds.filter((id) => !activeUserIds.has(id))
        const unavailableGroupIds = policy.audience.groupIds.filter((id) => !knownGroupIds.has(id))
        return (
          <section key={policy.vendorId} className="border border-kumo-line rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-3">
              {vendor?.logo && <img src={vendor.logo.url} alt="" className="w-5 h-5 object-contain" />}
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-kumo-default">{vendor?.displayName ?? policy.vendorId}</h3>
                <p className="text-xs text-kumo-subtle">{policy.vendorId}</p>
              </div>
              <select
                aria-label={t('adminArea.appPolicies.mode')}
                value={policy.mode}
                disabled={isSaving}
                onChange={(event) => update(policy.vendorId, (current) => ({ ...current, mode: event.target.value as AppPolicyMode }))}
                className="rounded-md border border-kumo-line bg-kumo-elevated px-2 py-1 text-sm"
              >
                {modes.filter((mode) => mode !== 'enabled' || policy.mode === 'enabled' || vendor?.autoProvisions).map((mode) => (
                  <option key={mode} value={mode}>{t(`adminArea.appPolicies.modes.${mode}`)}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-kumo-default">
              <Switch disabled={isSaving} checked={policy.audience.everyone} onCheckedChange={(checked) => updateAudience(policy.vendorId, (audience) => ({ ...audience, everyone: checked }))} />
              {t('adminArea.appPolicies.everyone')}
            </label>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <p className="text-xs font-medium text-kumo-subtle mb-1">{t('adminArea.appPolicies.users')}</p>
                <div className="max-h-32 overflow-auto space-y-1">
                  {activeUsers.map((user) => (
                    <label key={user.userId} className="flex items-center gap-2 text-sm text-kumo-default">
                      <input type="checkbox" disabled={isSaving} checked={policy.audience.userIds.includes(user.userId)} onChange={(event) => updateAudience(policy.vendorId, (audience) => ({ ...audience, userIds: event.target.checked ? [...audience.userIds, user.userId] : audience.userIds.filter((id) => id !== user.userId) }))} />
                      {user.displayName}
                    </label>
                  ))}
                  {unavailableUserIds.map((userId) => (
                    <label key={userId} className="flex items-center gap-2 text-sm text-kumo-subtle">
                      <input type="checkbox" disabled={isSaving} checked onChange={() => updateAudience(policy.vendorId, (audience) => ({ ...audience, userIds: audience.userIds.filter((id) => id !== userId) }))} />
                      {t('adminArea.appPolicies.targetUnavailable', { id: userId })}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-kumo-subtle mb-1">{t('adminArea.appPolicies.groups')}</p>
                <div className="max-h-32 overflow-auto space-y-1">
                  {groups.map((group) => (
                    <label key={group.groupId} className="flex items-center gap-2 text-sm text-kumo-default">
                      <input type="checkbox" disabled={isSaving} checked={policy.audience.groupIds.includes(group.groupId)} onChange={(event) => updateAudience(policy.vendorId, (audience) => ({ ...audience, groupIds: event.target.checked ? [...audience.groupIds, group.groupId] : audience.groupIds.filter((id) => id !== group.groupId) }))} />
                      {group.name}
                    </label>
                  ))}
                  {unavailableGroupIds.map((groupId) => (
                    <label key={groupId} className="flex items-center gap-2 text-sm text-kumo-subtle">
                      <input type="checkbox" disabled={isSaving} checked onChange={() => updateAudience(policy.vendorId, (audience) => ({ ...audience, groupIds: audience.groupIds.filter((id) => id !== groupId) }))} />
                      {t('adminArea.appPolicies.targetUnavailable', { id: groupId })}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="rounded-md bg-kumo-tint/50 p-3">
              <p className="text-xs font-medium text-kumo-subtle">{t('adminArea.appPolicies.preview')}</p>
              <p className="text-sm text-kumo-default">{preview ? t('adminArea.appPolicies.recipientCount', { count: preview.users.length }) : t('adminArea.appPolicies.previewUnavailable')}</p>
              {preview && <p className="mt-1 text-xs text-kumo-subtle">{preview.users.map((user) => `${user.displayName} (${user.sources.join(', ')})`).join(', ')}</p>}
            </div>
            <div className="flex justify-end">
              <Button variant="primary" size="sm" loading={isSaving} disabled={!policy.dirty || isSaving} onClick={() => void save(policy)}>
                {t('adminArea.save')}
              </Button>
            </div>
          </section>
        )
      })}
    </div>
  )
}
