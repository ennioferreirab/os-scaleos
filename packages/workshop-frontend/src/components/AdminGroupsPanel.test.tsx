// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AdminApi, Group } from '@gadgets/workshop-shared/api'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => ({
  Button: ({children, loading: _loading, ...props}: ComponentProps<'button'> & {
    children: ReactNode
    loading?: boolean
  }) => <button type="button" {...props}>{children}</button>,
  Input: ({label, ...props}: ComponentProps<'input'> & {label: ReactNode}) => (
    <label>{label}<input aria-label={String(label)} {...props} /></label>
  ),
  // Kumo returns a new manager and wrapped methods on every render.
  useKumoToastManager: () => ({add: vi.fn()}),
}))

vi.mock('@phosphor-icons/react', () => ({Users: () => <span />}))
vi.mock('../i18n', () => {
  const t = (key: string) => key
  return {useLocale: () => ({t})}
})

import AdminGroupsPanel from './AdminGroupsPanel'

function disposableArray<T>(values: T[], dispose: () => void): T[] & Disposable {
  return Object.assign([...values], {[Symbol.dispose]: dispose})
}

function setInput(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setValue.call(input, value)
  input.dispatchEvent(new Event('input', {bubbles: true}))
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')]
      .find(candidate => candidate.textContent === label)
  if (!result) throw new Error(`Button ${label} was not rendered.`)
  return result
}

describe('AdminGroupsPanel', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  it('stabilizes the initial load when the toast manager changes on every render', async () => {
    const group: Group = {
      groupId: '50000000-0000-4000-8000-000000000004',
      name: 'Operations',
      createdAt: '2026-09-08T12:00:00.000Z',
      updatedAt: '2026-09-08T12:00:00.000Z',
    }
    const listGroups = vi.fn(async () => disposableArray([group], vi.fn()))
    const admin = {
      listGroups,
      listDirectoryUsers: vi.fn(async () => disposableArray([], vi.fn())),
      getGroupMembers: vi.fn(async () => disposableArray([], vi.fn())),
    } as unknown as RpcStub<AdminApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<AdminGroupsPanel admin={admin} />)
    })
    await act(async () => { await Promise.resolve() })

    expect(listGroups).toHaveBeenCalledOnce()
    expect(container.querySelector('select')?.value).toBe(group.groupId)
    expect(container.textContent).not.toContain('adminArea.loading')
  })

  it('reuses a create mutation id after an uncertain response and disposes every RPC result',
      async () => {
    const listGroupsDisposals: Array<ReturnType<typeof vi.fn>> = []
    const listUsersDisposals: Array<ReturnType<typeof vi.fn>> = []
    const memberDisposal = vi.fn()
    const createDisposal = vi.fn()
    const createdGroup: Group = {
      groupId: '50000000-0000-4000-8000-000000000005',
      name: 'Retry group',
      createdAt: '2026-09-08T12:00:00.000Z',
      updatedAt: '2026-09-08T12:00:00.000Z',
    }
    let groupLoad = 0
    const createGroup = vi.fn(async (input: {name: string; mutationId: string}) => {
      if (createGroup.mock.calls.length === 1) throw new Error('response lost')
      return Object.assign({
        group: createdGroup,
        receipt: {
          mutationId: input.mutationId,
          policyVersion: 1,
          confirmedAt: '2026-09-08T12:00:00.000Z',
        },
      }, {[Symbol.dispose]: createDisposal})
    })
    const admin = {
      listGroups: vi.fn(async () => {
        const dispose = vi.fn()
        listGroupsDisposals.push(dispose)
        return disposableArray(groupLoad++ === 0 ? [] : [createdGroup], dispose)
      }),
      listDirectoryUsers: vi.fn(async () => {
        const dispose = vi.fn()
        listUsersDisposals.push(dispose)
        return disposableArray([], dispose)
      }),
      getGroupMembers: vi.fn(async () => disposableArray([], memberDisposal)),
      createGroup,
      renameGroup: vi.fn(),
      replaceGroupMembers: vi.fn(),
      deleteGroup: vi.fn(),
    } as unknown as RpcStub<AdminApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<AdminGroupsPanel admin={admin} />)
    })

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="adminArea.groups.newName"]')!
    await act(async () => setInput(input, '  Retry group  '))
    await act(async () => {
      button(container!, 'adminArea.groups.create').click()
    })
    await act(async () => {
      button(container!, 'adminArea.groups.create').click()
    })

    expect(createGroup).toHaveBeenCalledTimes(2)
    expect(createGroup.mock.calls[0][0]).toEqual(createGroup.mock.calls[1][0])
    expect(createGroup.mock.calls[0][0].name).toBe('Retry group')
    expect(createDisposal).toHaveBeenCalledOnce()
    expect(memberDisposal).toHaveBeenCalledOnce()
    expect(listGroupsDisposals).toHaveLength(2)
    expect(listUsersDisposals).toHaveLength(2)
    for (const dispose of [...listGroupsDisposals, ...listUsersDisposals]) {
      expect(dispose).toHaveBeenCalledOnce()
    }
  })
})
