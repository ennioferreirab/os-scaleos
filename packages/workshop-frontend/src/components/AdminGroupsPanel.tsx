import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, useKumoToastManager } from '@cloudflare/kumo'
import { Users } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import type { AdminApi, DirectoryUser, Group } from '@gadgets/workshop-shared/api'
import { useLocale } from '../i18n'

type AdminGroupsPanelProps = {
  admin: RpcStub<AdminApi>
}

type MembersByGroup = Record<string, string[]>
type CreateMutation = { name: string; mutationId: string }
type RenameMutation = { groupId: string; name: string; mutationId: string }
type MembersMutation = { groupId: string; userIds: string[]; mutationId: string }
type DeleteMutation = { groupId: string; mutationId: string }

/** Admin-only group management UI backed by the authoritative directory RPCs. */
export default function AdminGroupsPanel({ admin }: AdminGroupsPanelProps) {
  const { t } = useLocale()
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const [groups, setGroups] = useState<Group[]>([])
  const [directoryUsers, setDirectoryUsers] = useState<DirectoryUser[]>([])
  const [membersByGroup, setMembersByGroup] = useState<MembersByGroup>({})
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [newGroupName, setNewGroupName] = useState('')
  const [draftMembers, setDraftMembers] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const mutationInFlight = useRef(false)
  const pendingCreateMutation = useRef<CreateMutation | null>(null)
  const pendingRenameMutation = useRef<RenameMutation | null>(null)
  const pendingMembersMutation = useRef<MembersMutation | null>(null)
  const pendingDeleteMutation = useRef<DeleteMutation | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [nextGroups, nextUsers] = await Promise.all([
        (async () => {
          const result = await admin.listGroups()
          try {
            return result.map(group => ({...group}))
          } finally {
            result[Symbol.dispose]?.()
          }
        })(),
        (async () => {
          const result = await admin.listDirectoryUsers()
          try {
            return result.map(user => ({...user}))
          } finally {
            result[Symbol.dispose]?.()
          }
        })(),
      ])
      const memberResults = await Promise.all(nextGroups.map(async group => {
        const result = await admin.getGroupMembers(group.groupId)
        try {
          return [group.groupId, [...result]] as const
        } finally {
          result[Symbol.dispose]?.()
        }
      }))
      const nextMembers: MembersByGroup = {}
      for (const [groupId, members] of memberResults) nextMembers[groupId] = [...members]
      setGroups(nextGroups)
      setDirectoryUsers(nextUsers)
      setMembersByGroup(nextMembers)
      setSelectedGroupId(current =>
        current && nextGroups.some(group => group.groupId === current)
          ? current
          : nextGroups[0]?.groupId ?? null)
    } catch (error) {
      toastsRef.current.add({
        title: error instanceof Error ? error.message : t('adminArea.groups.loadFailed'),
        variant: 'error',
      })
    } finally {
      setLoading(false)
    }
  }, [admin, t])

  useEffect(() => { void reload() }, [reload])

  const selectedGroup = useMemo(
    () => groups.find(group => group.groupId === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  )

  useEffect(() => {
    setDraftName(selectedGroup?.name ?? '')
    setDraftMembers(new Set(selectedGroupId ? membersByGroup[selectedGroupId] ?? [] : []))
  }, [membersByGroup, selectedGroup, selectedGroupId])

  const handleCreate = async () => {
    const name = newGroupName.trim()
    if (!name || mutationInFlight.current) return
    const pending = pendingCreateMutation.current
    const mutation = pending?.name === name
      ? pending
      : {name, mutationId: crypto.randomUUID()}
    pendingCreateMutation.current = mutation
    mutationInFlight.current = true
    setSaving('create')
    try {
      const result = await admin.createGroup(mutation)
      let group: Group
      try {
        group = {...result.group}
      } finally {
        result[Symbol.dispose]?.()
      }
      if (pendingCreateMutation.current === mutation) pendingCreateMutation.current = null
      setNewGroupName('')
      await reload()
      setSelectedGroupId(group.groupId)
      toasts.add({ title: t('adminArea.groups.created'), variant: 'success' })
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : t('adminArea.groups.saveFailed'),
        variant: 'error',
      })
    } finally {
      mutationInFlight.current = false
      setSaving(null)
    }
  }

  const handleRename = async () => {
    const name = draftName.trim()
    if (!selectedGroup || !name || mutationInFlight.current) return
    const pending = pendingRenameMutation.current
    const mutation = pending?.groupId === selectedGroup.groupId && pending.name === name
      ? pending
      : {groupId: selectedGroup.groupId, name, mutationId: crypto.randomUUID()}
    pendingRenameMutation.current = mutation
    mutationInFlight.current = true
    setSaving(selectedGroup.groupId)
    try {
      const result = await admin.renameGroup(mutation)
      try {
        if (pendingRenameMutation.current === mutation) pendingRenameMutation.current = null
      } finally {
        result[Symbol.dispose]?.()
      }
      await reload()
      toasts.add({ title: t('adminArea.groups.renamed'), variant: 'success' })
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : t('adminArea.groups.saveFailed'),
        variant: 'error',
      })
    } finally {
      mutationInFlight.current = false
      setSaving(null)
    }
  }

  const handleSaveMembers = async () => {
    if (!selectedGroup || mutationInFlight.current) return
    const userIds = [...draftMembers].toSorted()
    const pending = pendingMembersMutation.current
    const mutation = pending?.groupId === selectedGroup.groupId &&
        pending.userIds.length === userIds.length &&
        pending.userIds.every((userId, index) => userId === userIds[index])
      ? pending
      : {groupId: selectedGroup.groupId, userIds, mutationId: crypto.randomUUID()}
    pendingMembersMutation.current = mutation
    mutationInFlight.current = true
    setSaving(selectedGroup.groupId)
    try {
      const result = await admin.replaceGroupMembers(mutation)
      try {
        if (pendingMembersMutation.current === mutation) pendingMembersMutation.current = null
      } finally {
        result[Symbol.dispose]?.()
      }
      await reload()
      toasts.add({ title: t('adminArea.groups.membersSaved'), variant: 'success' })
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : t('adminArea.groups.saveFailed'),
        variant: 'error',
      })
    } finally {
      mutationInFlight.current = false
      setSaving(null)
    }
  }

  const handleDelete = async () => {
    if (!selectedGroup || mutationInFlight.current ||
        !window.confirm(t('adminArea.groups.confirmDelete', {name: selectedGroup.name}))) return
    const pending = pendingDeleteMutation.current
    const mutation = pending?.groupId === selectedGroup.groupId
      ? pending
      : {groupId: selectedGroup.groupId, mutationId: crypto.randomUUID()}
    pendingDeleteMutation.current = mutation
    mutationInFlight.current = true
    setSaving(selectedGroup.groupId)
    try {
      const result = await admin.deleteGroup(mutation)
      try {
        if (pendingDeleteMutation.current === mutation) pendingDeleteMutation.current = null
      } finally {
        result[Symbol.dispose]?.()
      }
      await reload()
      toasts.add({ title: t('adminArea.groups.deleted'), variant: 'success' })
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : t('adminArea.groups.saveFailed'),
        variant: 'error',
      })
    } finally {
      mutationInFlight.current = false
      setSaving(null)
    }
  }

  const currentMemberIds = selectedGroupId ? membersByGroup[selectedGroupId] ?? [] : []
  const visibleUsers = directoryUsers.filter(user =>
    user.status === 'active' || currentMemberIds.includes(user.userId))

  return (
    <div className="space-y-6">
      <section className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <div className="flex items-center gap-3 mb-4">
          <Users size={20} className="text-kumo-subtle" />
          <div>
            <h2 className="text-lg font-semibold text-kumo-strong">{t('adminArea.groups.title')}</h2>
            <p className="text-sm text-kumo-subtle">{t('adminArea.groups.description')}</p>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 items-end">
          <Input
            className="flex-1"
            label={t('adminArea.groups.newName')}
            value={newGroupName}
            onChange={event => setNewGroupName(event.target.value)}
            maxLength={80}
            disabled={saving !== null}
          />
          <Button
            onClick={handleCreate}
            loading={saving === 'create'}
            disabled={saving !== null || !newGroupName.trim()}
          >
            {t('adminArea.groups.create')}
          </Button>
        </div>
      </section>

      <section className="bg-kumo-elevated border border-kumo-line rounded-xl p-6 space-y-5">
        {loading && <p className="text-sm text-kumo-subtle">{t('adminArea.loading')}</p>}
        {!loading && groups.length === 0 && (
          <p className="text-sm text-kumo-subtle">{t('adminArea.groups.empty')}</p>
        )}
        {!loading && groups.length > 0 && (
          <>
            <label className="block text-sm font-medium text-kumo-strong">
              {t('adminArea.groups.select')}
              <select
                className="mt-2 block w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
                value={selectedGroupId ?? ''}
                onChange={event => setSelectedGroupId(event.target.value)}
                disabled={saving !== null}
              >
                {groups.map(group => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}
              </select>
            </label>

            {selectedGroup && (
              <>
                <div className="flex flex-col sm:flex-row gap-3 items-end">
                  <Input
                    className="flex-1"
                    label={t('adminArea.groups.name')}
                    value={draftName}
                    onChange={event => setDraftName(event.target.value)}
                    maxLength={80}
                    disabled={saving !== null}
                  />
                  <Button
                    variant="secondary"
                    onClick={handleRename}
                    loading={saving === selectedGroup.groupId}
                    disabled={saving !== null || !draftName.trim() || draftName === selectedGroup.name}
                  >
                    {t('adminArea.groups.rename')}
                  </Button>
                </div>

                <div>
                  <h3 className="text-sm font-semibold text-kumo-strong mb-2">{t('adminArea.groups.members')}</h3>
                  <div className="space-y-2 rounded-lg border border-kumo-line bg-kumo-base p-3">
                    {visibleUsers.map(user => (
                      <label key={user.userId} className="flex items-start gap-3 text-sm text-kumo-default">
                        <input
                          type="checkbox"
                          checked={draftMembers.has(user.userId)}
                          disabled={saving !== null}
                          onChange={event => setDraftMembers(previous => {
                            const next = new Set(previous)
                            if (event.target.checked) next.add(user.userId)
                            else next.delete(user.userId)
                            return next
                          })}
                        />
                        <span className="min-w-0">
                          <span className="block truncate">{user.displayName}</span>
                          <span className="block text-xs text-kumo-subtle truncate">
                            {user.email}{user.status !== 'active' ? ` · ${user.status}` : ''}
                          </span>
                        </span>
                      </label>
                    ))}
                    {visibleUsers.length === 0 && <p className="text-sm text-kumo-subtle">{t('adminArea.groups.noUsers')}</p>}
                  </div>
                  <div className="flex flex-wrap justify-end gap-2 mt-4">
                    <Button
                      variant="secondary"
                      onClick={handleSaveMembers}
                      loading={saving === selectedGroup.groupId}
                      disabled={saving !== null}
                    >
                      {t('adminArea.groups.saveMembers')}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={handleDelete}
                      loading={saving === selectedGroup.groupId}
                      disabled={saving !== null}
                    >
                      {t('adminArea.groups.delete')}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  )
}
