import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { fetchSessions, type GatewaySession } from '@/lib/gateway-api'

type HistoryMessagePart = {
  type?: string
  text?: string
}

type HistoryMessage = {
  role?: string
  content?: string | HistoryMessagePart[]
}

type HistoryResponse = {
  messages?: HistoryMessage[]
  error?: string
}

type MissionPhase = 'idle' | 'decomposing' | 'running' | 'complete'

type StreamEvent =
  | { type: 'assistant'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name?: string; phase?: string; data?: Record<string, unknown> }
  | { type: 'done'; state?: string; message?: string }
  | { type: 'error'; message: string }
  | { type: 'started'; runId?: string; sessionKey?: string }

export type ConductorWorker = {
  key: string
  label: string
  model: string | null
  status: 'running' | 'complete' | 'stale' | 'idle'
  updatedAt: string | null
  displayName: string
  totalTokens: number
  contextTokens: number
  tokenUsageLabel: string
  raw: GatewaySession
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function toIso(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    const ms = new Date(value).getTime()
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  return null
}

function readContextTokens(session: GatewaySession): number {
  return (
    readNumber(session.contextTokens) ??
    readNumber(session.maxTokens) ??
    readNumber(session.contextWindow) ??
    readNumber(session.usage && typeof session.usage === 'object' ? (session.usage as Record<string, unknown>).contextTokens : null) ??
    0
  )
}

function deriveWorkerStatus(session: GatewaySession, updatedAt: string | null): ConductorWorker['status'] {
  const status = readString(session.status)?.toLowerCase()
  if (status && ['complete', 'completed', 'done', 'success', 'succeeded'].includes(status)) return 'complete'
  if (status && ['idle', 'waiting', 'sleeping'].includes(status)) return 'idle'
  if (status && ['error', 'errored', 'failed', 'cancelled', 'canceled', 'killed'].includes(status)) return 'stale'

  const updatedMs = updatedAt ? new Date(updatedAt).getTime() : 0
  const staleness = updatedMs > 0 ? Date.now() - updatedMs : 0
  const totalTokens = readNumber(session.totalTokens) ?? readNumber(session.tokenCount) ?? 0

  if (totalTokens > 0 && staleness > 10_000) return 'complete'
  if (staleness > 120_000) return 'stale'
  return 'running'
}

function workersLookComplete(workers: ConductorWorker[], staleAfterMs: number): boolean {
  if (workers.length === 0) return false

  return workers.every((worker) => {
    if (worker.totalTokens <= 0) return false
    if (!worker.updatedAt) return false
    const updatedMs = new Date(worker.updatedAt).getTime()
    if (!Number.isFinite(updatedMs)) return false
    return Date.now() - updatedMs >= staleAfterMs
  })
}

function formatDisplayName(session: GatewaySession): string {
  const label = readString(session.label)
  if (label) return label.replace(/^worker-/, '').replace(/[-_]+/g, ' ')
  const title = readString(session.title) ?? readString(session.derivedTitle)
  if (title) return title
  const key = readString(session.key) ?? 'worker'
  return key.split(':').pop()?.replace(/[-_]+/g, ' ') ?? key
}

function formatTokenUsage(totalTokens: number, contextTokens: number): string {
  if (contextTokens > 0) return `${totalTokens.toLocaleString()} / ${contextTokens.toLocaleString()} tok`
  return `${totalTokens.toLocaleString()} tok`
}

function toWorker(session: GatewaySession): ConductorWorker | null {
  const key = readString(session.key)
  if (!key) return null
  const label = readString(session.label) ?? 'worker'
  const updatedAt = toIso(session.updatedAt ?? session.startedAt ?? session.createdAt)
  const totalTokens = readNumber(session.totalTokens) ?? readNumber(session.tokenCount) ?? 0
  const contextTokens = readContextTokens(session)

  return {
    key,
    label,
    model: readString(session.model),
    status: deriveWorkerStatus(session, updatedAt),
    updatedAt,
    displayName: formatDisplayName(session),
    totalTokens,
    contextTokens,
    tokenUsageLabel: formatTokenUsage(totalTokens, contextTokens),
    raw: session,
  }
}

function extractWorkerLabels(text: string): string[] {
  const matches = text.match(/worker-[a-z0-9][a-z0-9_-]*/gi) ?? []
  return [...new Set(matches.map((match) => match.trim()))]
}

function extractHistoryMessageText(message: HistoryMessage | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function getLastAssistantMessage(messages: HistoryMessage[] | undefined): string {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = extractHistoryMessageText(message).trim()
    if (text) return text
  }
  return ''
}

async function fetchWorkerOutput(sessionKey: string, limit = 5): Promise<string> {
  const response = await fetch(`/api/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=${limit}`)
  const payload = (await response.json().catch(() => ({}))) as HistoryResponse
  if (!response.ok) {
    throw new Error(payload.error || `Failed to load history for ${sessionKey}`)
  }
  return getLastAssistantMessage(payload.messages)
}

async function readSseStream(response: Response, onEvent: (event: StreamEvent) => void): Promise<void> {
  if (!response.ok) {
    throw new Error((await response.text().catch(() => '')) || `Request failed (${response.status})`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('Streaming response unavailable')

  const decoder = new TextDecoder()
  let buffer = ''

  const flushChunk = (chunk: string) => {
    const blocks = chunk.split('\n\n')
    buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      const lines = block.split(/\r?\n/)
      let eventName = 'message'
      const dataLines: string[] = []

      for (const line of lines) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }

      if (dataLines.length === 0) continue

      const rawData = dataLines.join('\n')
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(rawData) as Record<string, unknown>
      } catch {
        payload = { text: rawData }
      }

      const stream = readString(payload.stream) ?? eventName
      const nestedData = readRecord(payload.data)
      const eventPayload = nestedData ?? payload

      if (stream === 'assistant') {
        onEvent({ type: 'assistant', text: readString(eventPayload.text) ?? '' })
      } else if (stream === 'thinking') {
        onEvent({ type: 'thinking', text: readString(eventPayload.text) ?? '' })
      } else if (stream === 'tool') {
        onEvent({
          type: 'tool',
          name: readString(eventPayload.name) ?? undefined,
          phase: readString(eventPayload.phase) ?? undefined,
          data: nestedData ?? readRecord(payload.data) ?? undefined,
        })
      } else if (stream === 'done') {
        onEvent({
          type: 'done',
          state: readString(eventPayload.state) ?? undefined,
          message: readString(eventPayload.message) ?? readString(eventPayload.errorMessage) ?? undefined,
        })
      } else if (stream === 'started') {
        onEvent({
          type: 'started',
          runId: readString(eventPayload.runId) ?? undefined,
          sessionKey: readString(eventPayload.sessionKey) ?? undefined,
        })
      } else if (stream === 'error') {
        onEvent({ type: 'error', message: readString(eventPayload.message) ?? 'Stream error' })
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    flushChunk(buffer)
  }

  if (buffer.trim()) {
    flushChunk(`${buffer}\n\n`)
  }
}

export function useConductorGateway() {
  const [phase, setPhase] = useState<MissionPhase>('idle')
  const [goal, setGoal] = useState('')
  const [streamText, setStreamText] = useState('')
  const [planText, setPlanText] = useState('')
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([])
  const [missionStartedAt, setMissionStartedAt] = useState<string | null>(null)
  const [completedAt, setCompletedAt] = useState<string | null>(null)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [missionWorkerKeys, setMissionWorkerKeys] = useState<Set<string>>(new Set())
  const [missionWorkerLabels, setMissionWorkerLabels] = useState<Set<string>>(new Set())
  const [workerOutputs, setWorkerOutputs] = useState<Record<string, string>>({})
  const fetchedWorkerOutputsRef = useRef<Set<string>>(new Set())
  const doneRef = useRef(false)
  const seenToolCallRef = useRef(false)

  const sessionsQuery = useQuery({
    queryKey: ['conductor', 'gateway', 'sessions'],
    queryFn: async () => {
      const payload = await fetchSessions()
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : []
      const missionStartMs = missionStartedAt ? new Date(missionStartedAt).getTime() : 0
      return sessions
        .filter((session) => {
          const label = readString(session.label) ?? ''
          const key = readString(session.key) ?? ''
          if (!label.startsWith('worker-') && !key.includes(':subagent:')) return false

          if (missionWorkerKeys.size > 0) {
            return missionWorkerKeys.has(key)
          }

          if (missionWorkerLabels.size > 0 && missionWorkerLabels.has(label)) {
            return true
          }

          const createdIso = toIso(session.createdAt ?? session.startedAt ?? session.updatedAt)
          if (!createdIso || !missionStartMs) return false
          return new Date(createdIso).getTime() >= missionStartMs
        })
        .map(toWorker)
        .filter((session): session is ConductorWorker => session !== null)
        .sort((a, b) => {
          const statusRank = { running: 0, idle: 1, complete: 2, stale: 3 }
          const rankDiff = statusRank[a.status] - statusRank[b.status]
          if (rankDiff !== 0) return rankDiff
          return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()
        })
    },
    enabled: phase !== 'idle',
    refetchInterval: phase === 'decomposing' || phase === 'running' ? 3_000 : false,
  })

  const recentSessionsQuery = useQuery({
    queryKey: ['conductor', 'recent-sessions'],
    queryFn: async () => {
      const payload = await fetchSessions()
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : []
      const cutoff = Date.now() - 24 * 60 * 60_000
      return sessions
        .filter((session) => {
          const label = readString(session.label) ?? ''
          const key = readString(session.key) ?? ''
          const updatedAt = toIso(session.updatedAt ?? session.startedAt ?? session.createdAt)
          if (!updatedAt) return false
          return (label.startsWith('worker-') || key.includes(':subagent:')) && new Date(updatedAt).getTime() >= cutoff
        })
        .sort((a, b) => {
          const updatedA = new Date(toIso(a.updatedAt ?? a.startedAt ?? a.createdAt) ?? 0).getTime()
          const updatedB = new Date(toIso(b.updatedAt ?? b.startedAt ?? b.createdAt) ?? 0).getTime()
          return updatedB - updatedA
        })
        .slice(0, 20)
    },
    enabled: phase === 'idle',
    refetchInterval: false,
  })

  const workers = sessionsQuery.data ?? []
  const activeWorkers = useMemo(
    () => workers.filter((worker) => worker.status === 'running' || worker.status === 'idle'),
    [workers],
  )

  useEffect(() => {
    if (missionWorkerLabels.size === 0 || workers.length === 0) return
    const matchedKeys = workers
      .filter((worker) => missionWorkerLabels.has(worker.label))
      .map((worker) => worker.key)

    if (matchedKeys.length === 0) return

    setMissionWorkerKeys((current) => {
      const next = new Set(current)
      let changed = false
      for (const key of matchedKeys) {
        if (!next.has(key)) {
          next.add(key)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [missionWorkerLabels, workers])

  useEffect(() => {
    if (phase === 'decomposing' && workers.length > 0) {
      setPhase('running')
    }
  }, [phase, workers.length])

  useEffect(() => {
    if (phase !== 'running') return

    const shouldCompleteImmediately = doneRef.current && workersLookComplete(workers, 8_000)
    if (shouldCompleteImmediately) {
      setPhase('complete')
      setCompletedAt((value) => value ?? new Date().toISOString())
      return
    }

    if (activeWorkers.length > 0) return
    if (workers.length === 0 && !doneRef.current) return
    setPhase('complete')
    setCompletedAt((value) => value ?? new Date().toISOString())
  }, [activeWorkers.length, phase, workers])

  useEffect(() => {
    const keysToFetch = workers
      .filter((worker) => {
        if (fetchedWorkerOutputsRef.current.has(worker.key)) return false
        return phase === 'complete' || worker.status === 'complete'
      })
      .map((worker) => worker.key)

    if (keysToFetch.length === 0) return

    let cancelled = false

    for (const key of keysToFetch) {
      fetchedWorkerOutputsRef.current.add(key)
    }

    void Promise.allSettled(
      keysToFetch.map(async (key) => {
        const output = await fetchWorkerOutput(key, 5)
        if (cancelled) return
        setWorkerOutputs((current) => {
          if (current[key] === output) return current
          return { ...current, [key]: output }
        })
      }),
    ).then((results) => {
      if (cancelled) return
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') return
        fetchedWorkerOutputsRef.current.delete(keysToFetch[index])
      })
    })

    return () => {
      cancelled = true
    }
  }, [phase, workers])

  const sendMission = useMutation({
    mutationFn: async (nextGoal: string) => {
      const trimmed = nextGoal.trim()
      if (!trimmed) throw new Error('Mission goal required')
      doneRef.current = false
      setGoal(trimmed)
      setStreamText('')
      setPlanText('')
      setStreamEvents([])
      setStreamError(null)
      setCompletedAt(null)
      setMissionWorkerKeys(new Set())
      setMissionWorkerLabels(new Set())
      setWorkerOutputs({})
      fetchedWorkerOutputsRef.current = new Set()
      seenToolCallRef.current = false
      setMissionStartedAt(new Date().toISOString())
      setPhase('decomposing')

      const response = await fetch('/api/send-stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionKey: 'agent:main:main',
          message: `[DISPATCH] ${trimmed}`,
        }),
      })

      await readSseStream(response, (event) => {
        setStreamEvents((current) => [...current, event])
        if (event.type === 'assistant' || event.type === 'thinking') {
          setStreamText((current) => current + event.text)

          if (event.type === 'assistant' && !seenToolCallRef.current) {
            setPlanText((current) => current + event.text)
          }

          const labels = extractWorkerLabels(event.text)
          if (labels.length > 0) {
            setMissionWorkerLabels((current) => {
              const next = new Set(current)
              let changed = false
              for (const label of labels) {
                if (!next.has(label)) {
                  next.add(label)
                  changed = true
                }
              }
              return changed ? next : current
            })
          }
        }
        if (event.type === 'tool') {
          seenToolCallRef.current = true
        }
        if (event.type === 'tool' && event.name === 'sessions_spawn' && event.phase === 'result') {
          const childSessionKey = readString(event.data?.childSessionKey)
          if (childSessionKey) {
            setMissionWorkerKeys((current) => {
              if (current.has(childSessionKey)) return current
              const next = new Set(current)
              next.add(childSessionKey)
              return next
            })
          }
        }
        if (event.type === 'error') {
          doneRef.current = true
          setStreamError(event.message)
          setPhase('complete')
          setCompletedAt(new Date().toISOString())
        }
        if (event.type === 'done') {
          doneRef.current = true
          setCompletedAt(new Date().toISOString())
        }
      })
    },
    onError: (error) => {
      doneRef.current = true
      setStreamError(error instanceof Error ? error.message : String(error))
      setPhase('complete')
      setCompletedAt(new Date().toISOString())
    },
  })

  const resetMission = () => {
    doneRef.current = false
    setPhase('idle')
    setGoal('')
    setStreamText('')
    setPlanText('')
    setStreamEvents([])
    setStreamError(null)
    setMissionStartedAt(null)
    setCompletedAt(null)
    setMissionWorkerKeys(new Set())
    setMissionWorkerLabels(new Set())
    setWorkerOutputs({})
    fetchedWorkerOutputsRef.current = new Set()
    seenToolCallRef.current = false
  }

  return {
    phase,
    goal,
    streamText,
    planText,
    streamEvents,
    streamError,
    missionStartedAt,
    completedAt,
    workers,
    activeWorkers,
    recentSessions: recentSessionsQuery.data ?? [],
    missionWorkerKeys,
    workerOutputs,
    sendMission: sendMission.mutateAsync,
    isSending: sendMission.isPending,
    resetMission,
    refreshWorkers: sessionsQuery.refetch,
    isRefreshingWorkers: sessionsQuery.isFetching,
  }
}
