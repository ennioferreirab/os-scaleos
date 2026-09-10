import { useEffect, useMemo, useState } from 'react'
import { BookOpenText, CaretRight, MagnifyingGlass, Trash } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AuthorizedReturn,
  Overseer,
  ToolReturnSummary,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopInput } from './components/WorkshopControls'
import { reportIssue } from './errorReporting'
import { formatDate, useLocale } from './i18n'

type SourcesPanelProps = {
  overseer: RpcStub<Overseer>
  chatId: number | null
  gadgetId?: number
  isVisible: boolean
}

type SourcesView = 'conversation' | 'document'

function returnStatus(entry: ToolReturnSummary): string {
  if (entry.captureState === 'deleted') return 'deleted'
  if (entry.captureState === 'partial') return 'partial'
  if (entry.captureState === 'failed') return 'failed'
  if (entry.executionState === 'failed' || entry.executionState === 'unknown') {
    return entry.executionState
  }
  return entry.normalizationState
}

function ReturnDetail({ value }: { value: AuthorizedReturn }) {
  const { t } = useLocale()
  if (value.status === 'unavailable') {
    return (
      <div className="rounded-lg border border-kumo-line bg-kumo-tint p-4 text-[13px] leading-[19px] text-kumo-subtle">
        {value.reason}
      </div>
    )
  }

  const byType = new Map<string, typeof value.sources>()
  for (const source of value.sources) {
    const group = byType.get(source.type)
    if (group) group.push(source)
    else byType.set(source.type, [source])
  }

  return (
    <div className="space-y-5">
      {value.normalization.state !== 'normalized' && (
        <div className="rounded-lg border border-kumo-line bg-kumo-tint p-3 text-[12px] leading-[18px] text-kumo-subtle">
          {value.normalization.reason ?? t('workspace.sources.unstructured')}
        </div>
      )}

      {value.sources.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-kumo-inactive">
            {t('workspace.sources.sourcesCount', { count: value.sources.length })}
          </h3>
          <div className="space-y-3">
            {[...byType.entries()].map(([type, sources]) => (
              <div key={type}>
                <p className="mb-1 text-[12px] font-medium text-kumo-subtle">{type}</p>
                <div className="space-y-1.5">
                  {sources.map(source => (
                    <div key={source.id} className="rounded-lg border border-kumo-line px-3 py-2">
                      <p className="m-0 text-[13px] font-medium text-kumo-default">
                        {source.title || source.ref}
                      </p>
                      {source.title && (
                        <p className="mt-0.5 break-all text-[11px] text-kumo-inactive">{source.ref}</p>
                      )}
                      <p className="mt-1 text-[11px] text-kumo-inactive">
                        {source.occurredAt ?? t('workspace.sources.dateUnavailable')}
                        {source.sensitivity ? ` · ${source.sensitivity}` : ''}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {value.evidence.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-kumo-inactive">
            {t('workspace.sources.evidenceCount', { count: value.evidence.length })}
          </h3>
          <div className="space-y-2">
            {value.evidence.map(item => (
              <article key={item.id} className="rounded-lg border border-kumo-line p-3">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-kumo-inactive">
                  <span>{item.kind}</span>
                  {item.locator && <span>{item.locator}</span>}
                </div>
                <p className="m-0 whitespace-pre-wrap text-[13px] leading-[19px] text-kumo-default">
                  {item.text}
                </p>
              </article>
            ))}
          </div>
        </section>
      )}

      <details className="rounded-lg border border-kumo-line">
        <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-kumo-subtle">
          {t('workspace.sources.returnedContent')}
        </summary>
        <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-kumo-line p-3 text-[11px] leading-[17px] text-kumo-subtle">
          {value.text || JSON.stringify(value.structuredContent, null, 2)}
        </pre>
      </details>
    </div>
  )
}

export default function SourcesPanel({ overseer, chatId, gadgetId, isVisible }: SourcesPanelProps) {
  const { t } = useLocale()
  const [view, setView] = useState<SourcesView>('conversation')
  const [entries, setEntries] = useState<ToolReturnSummary[]>([])
  const [nextBeforeId, setNextBeforeId] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [detail, setDetail] = useState<AuthorizedReturn>()
  const [query, setQuery] = useState('')
  const [sourceType, setSourceType] = useState('')
  const [connectorId, setConnectorId] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)

  useEffect(() => {
    setSelectedId(undefined)
    setDetail(undefined)
  }, [chatId])

  useEffect(() => {
    if (!isVisible || view !== 'conversation' || chatId === null) return
    let cancelled = false
    const timeout = window.setTimeout(() => {
      setLoading(true)
      setError(undefined)
      overseer.listReturns({
        chatId,
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(sourceType ? { sourceType } : {}),
        ...(connectorId ? { connectorId: Number(connectorId) } : {}),
      }).then(page => {
        if (cancelled) return
        setEntries(page.entries)
        setNextBeforeId(page.nextBeforeId)
      }).catch(cause => {
        if (cancelled) return
        reportIssue('sources.list', cause)
        setError(cause instanceof Error ? cause.message : String(cause))
        setEntries([])
        setNextBeforeId(undefined)
      }).finally(() => {
        if (!cancelled) setLoading(false)
      })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [chatId, connectorId, isVisible, overseer, query, reload, sourceType, view])

  useEffect(() => {
    if (!isVisible || !selectedId) return
    let cancelled = false
    setDetail(undefined)
    overseer.getReturn(selectedId).then(value => {
      if (!cancelled) setDetail(value)
    }).catch(cause => {
      if (cancelled) return
      reportIssue('sources.detail', cause)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { cancelled = true }
  }, [isVisible, overseer, selectedId, reload])

  const connectorOptions = useMemo(() => {
    const options = new Map<number, string>()
    for (const entry of entries) {
      options.set(entry.gatekeeperId, entry.connectorTitle || `#${entry.gatekeeperId}`)
    }
    return [...options.entries()]
  }, [entries])
  const sourceTypeOptions = useMemo(() =>
    [...new Set(entries.flatMap(entry => entry.sourceTypes))].sort(), [entries])

  const loadMore = async () => {
    if (chatId === null || !nextBeforeId || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await overseer.listReturns({
        chatId,
        beforeId: nextBeforeId,
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(sourceType ? { sourceType } : {}),
        ...(connectorId ? { connectorId: Number(connectorId) } : {}),
      })
      setEntries(current => [...current, ...page.entries])
      setNextBeforeId(page.nextBeforeId)
    } catch (cause) {
      reportIssue('sources.list-more', cause)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingMore(false)
    }
  }

  const deleteSelected = async () => {
    if (!selectedId || !window.confirm(t('workspace.sources.deleteConfirm'))) return
    try {
      await overseer.deleteReturn(selectedId)
      setSelectedId(undefined)
      setDetail(undefined)
      setReload(value => value + 1)
    } catch (cause) {
      reportIssue('sources.delete', cause)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-kumo-base">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-kumo-line px-3">
        <button type="button" onClick={() => setView('conversation')}
          className={`rounded-md px-3 py-1.5 text-[13px] ${view === 'conversation' ? 'bg-kumo-tint font-medium text-kumo-default' : 'text-kumo-subtle'}`}>
          {t('workspace.sources.fromConversation')}
        </button>
        <button type="button" onClick={() => setView('document')}
          className={`rounded-md px-3 py-1.5 text-[13px] ${view === 'document' ? 'bg-kumo-tint font-medium text-kumo-default' : 'text-kumo-subtle'}`}>
          {t('workspace.sources.fromDocument')}
        </button>
      </div>

      {view === 'document' ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <BookOpenText size={24} className="mb-3 text-kumo-inactive" />
          <p className="m-0 text-[13px] font-medium text-kumo-default">
            {gadgetId === undefined
              ? t('workspace.sources.noDocument')
              : t('workspace.sources.noDocumentLinks')}
          </p>
          <p className="mt-1 max-w-xs text-[12px] leading-[18px] text-kumo-subtle">
            {t('workspace.sources.documentLinksExplanation')}
          </p>
        </div>
      ) : chatId === null ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-kumo-subtle">
          {t('workspace.sources.selectConversation')}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full min-w-0 flex-col border-r border-kumo-line md:w-[42%]`}>
            <div className="space-y-2 border-b border-kumo-line p-3">
              <div className="relative">
                <MagnifyingGlass size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
                <WorkshopInput value={query} onChange={event => setQuery(event.target.value)}
                  maxLength={200} placeholder={t('workspace.sources.search')} className="w-full !pl-9" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select value={connectorId} onChange={event => setConnectorId(event.target.value)}
                  className="h-8 min-w-0 rounded-md border border-kumo-line bg-kumo-base px-2 text-[12px] text-kumo-default">
                  <option value="">{t('workspace.sources.allConnectors')}</option>
                  {connectorOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
                <select value={sourceType} onChange={event => setSourceType(event.target.value)}
                  className="h-8 min-w-0 rounded-md border border-kumo-line bg-kumo-base px-2 text-[12px] text-kumo-default">
                  <option value="">{t('workspace.sources.allTypes')}</option>
                  {sourceTypeOptions.map(type => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {loading ? (
                <p className="p-4 text-[13px] text-kumo-subtle">{t('workspace.sources.loading')}</p>
              ) : error ? (
                <p className="p-4 text-[13px] text-kumo-danger">{error}</p>
              ) : entries.length === 0 ? (
                <p className="p-4 text-[13px] leading-[19px] text-kumo-subtle">{t('workspace.sources.empty')}</p>
              ) : entries.map(entry => (
                <button key={entry.id} type="button" onClick={() => setSelectedId(entry.id)}
                  className={`flex w-full items-center gap-3 border-b border-kumo-line px-3 py-3 text-left hover:bg-kumo-tint ${selectedId === entry.id ? 'bg-kumo-tint' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 truncate text-[13px] font-medium text-kumo-default">{entry.tool}</p>
                    <p className="mt-0.5 truncate text-[11px] text-kumo-inactive">
                      {entry.connectorTitle || `#${entry.gatekeeperId}`} · {formatDate(new Date(entry.calledAt), { dateStyle: 'medium', timeStyle: 'short' })}
                    </p>
                    <p className="mt-1 text-[11px] text-kumo-subtle">
                      {returnStatus(entry)} · {t('workspace.sources.sourceEvidenceCounts', {
                        sources: entry.sourceCount,
                        evidence: entry.evidenceCount,
                      })}
                    </p>
                  </div>
                  <CaretRight size={14} className="shrink-0 text-kumo-inactive" />
                </button>
              ))}
              {nextBeforeId && (
                <div className="p-3">
                  <WorkshopButton onClick={loadMore} disabled={loadingMore} className="w-full">
                    {loadingMore ? t('workspace.sources.loading') : t('workspace.sources.loadOlder')}
                  </WorkshopButton>
                </div>
              )}
            </div>
          </aside>

          <main className={`${selectedId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
            {selectedId && (
              <div className="flex h-11 shrink-0 items-center justify-between border-b border-kumo-line px-3">
                <button type="button" onClick={() => setSelectedId(undefined)}
                  className="text-[12px] text-kumo-subtle md:hidden">
                  {t('workspace.sources.back')}
                </button>
                <span className="truncate text-[12px] font-medium text-kumo-default">{selectedId}</span>
                <button type="button" onClick={deleteSelected}
                  title={t('workspace.sources.deleteReturn')} aria-label={t('workspace.sources.deleteReturn')}
                  className="grid h-8 w-8 place-items-center rounded-md text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-danger">
                  <Trash size={15} />
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {selectedId
                ? detail ? <ReturnDetail value={detail} /> : <p className="text-[13px] text-kumo-subtle">{t('workspace.sources.loading')}</p>
                : <div className="flex h-full items-center justify-center text-[13px] text-kumo-subtle">{t('workspace.sources.selectReturn')}</div>}
            </div>
          </main>
        </div>
      )}
    </div>
  )
}
