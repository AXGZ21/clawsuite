import { useNavigate } from '@tanstack/react-router'
import { ArrowRight01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { workspaceRequestJson } from '@/lib/workspace-checkpoints'
import { cn } from '@/lib/utils'
import {
  extractTaskRuns,
  normalizeMission,
  type WorkspaceStatus,
} from '@/screens/projects/lib/workspace-types'
import {
  formatRelativeTime,
  formatStatus,
} from '@/screens/projects/lib/workspace-utils'

type MissionFilter = 'all' | 'running' | 'completed' | 'failed'

type RecentMissionEntry = {
  id: string
  name: string
  status: WorkspaceStatus
  projectId: string
  projectName: string
  phaseName: string | null
  timestamp: string | null
}

const PAGE_SIZE = 6

const RUNNING_STATUSES = new Set([
  'pending',
  'decomposing',
  'ready',
  'running',
  'reviewing',
  'revising',
  'paused',
  'active',
])

const FAILED_STATUSES = new Set(['failed', 'stopped'])

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function getMissionStatusBadgeClass(status: WorkspaceStatus): string {
  if (status === 'running' || status === 'reviewing' || status === 'revising') {
    return 'border-accent-500 bg-primary-100 text-primary-900'
  }
  if (status === 'decomposing' || status === 'ready') {
    return 'border-primary-300 bg-primary-50 text-primary-900'
  }
  if (status === 'completed' || status === 'done') {
    return 'border-primary-200 bg-white text-primary-900'
  }
  if (status === 'failed' || status === 'stopped') {
    return 'border-primary-300 bg-primary-50 text-primary-600'
  }
  if (status === 'paused') {
    return 'border-primary-300 bg-primary-50 text-primary-900'
  }
  return 'border-primary-200 bg-white text-primary-600'
}

function getMissionTimestamp(
  missionRecord: Record<string, unknown>,
  taskRunTimestamps: Map<string, string>,
): string | null {
  return (
    asString(missionRecord.updated_at) ??
    asString(missionRecord.created_at) ??
    taskRunTimestamps.get(asString(missionRecord.id) ?? '') ??
    null
  )
}

function matchesFilter(status: WorkspaceStatus, filter: MissionFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'running') return RUNNING_STATUSES.has(status)
  if (filter === 'completed') return status === 'completed' || status === 'done'
  return FAILED_STATUSES.has(status)
}

export function WorkspaceRecentMissions() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<MissionFilter>('all')
  const [page, setPage] = useState(0)

  const missionsQuery = useQuery({
    queryKey: ['workspace', 'home', 'missions'],
    queryFn: async () => workspaceRequestJson('/api/workspace/missions'),
    refetchInterval: 10_000,
  })

  const taskRunsQuery = useQuery({
    queryKey: ['workspace', 'home', 'task-runs'],
    queryFn: async () => workspaceRequestJson('/api/workspace/task-runs'),
    refetchInterval: 10_000,
  })

  const missions = useMemo(() => {
    const taskRuns = extractTaskRuns(taskRunsQuery.data)
    const taskRunTimestamps = new Map<string, string>()

    for (const run of taskRuns) {
      if (!run.mission_id) continue
      const timestamp = run.completed_at ?? run.started_at
      if (!timestamp) continue

      const current = taskRunTimestamps.get(run.mission_id)
      if (!current || new Date(timestamp).getTime() > new Date(current).getTime()) {
        taskRunTimestamps.set(run.mission_id, timestamp)
      }
    }

    const payload = missionsQuery.data
    const record = asRecord(payload)
    const source = Array.isArray(payload)
      ? payload
      : Array.isArray(record?.missions)
        ? record.missions
        : Array.isArray(record?.items)
          ? record.items
          : Array.isArray(record?.data)
            ? record.data
            : []

    return source.flatMap((value) => {
      const missionRecord = asRecord(value)
      if (!missionRecord) return []

      const mission = normalizeMission(missionRecord)
      const projectRecord = asRecord(missionRecord.project)
      const projectId =
        asString(missionRecord.project_id) ?? asString(projectRecord?.id)

      if (!projectId) return []

      return [
        {
          id: mission.id,
          name: mission.name,
          status: mission.status,
          projectId,
          projectName:
            asString(missionRecord.project_name) ??
            asString(projectRecord?.name) ??
            'Unassigned project',
          phaseName: asString(missionRecord.phase_name),
          timestamp: getMissionTimestamp(missionRecord, taskRunTimestamps),
        } satisfies RecentMissionEntry,
      ]
    })
  }, [missionsQuery.data, taskRunsQuery.data])

  const filteredMissions = useMemo(
    () =>
      missions
        .filter((mission) => matchesFilter(mission.status, filter))
        .sort((left, right) => {
          const leftTime = left.timestamp ? new Date(left.timestamp).getTime() : 0
          const rightTime = right.timestamp ? new Date(right.timestamp).getTime() : 0
          return rightTime - leftTime || left.name.localeCompare(right.name)
        }),
    [filter, missions],
  )

  useEffect(() => {
    setPage(0)
  }, [filter])

  const totalPages = Math.max(1, Math.ceil(filteredMissions.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pageStart = safePage * PAGE_SIZE
  const pageItems = filteredMissions.slice(pageStart, pageStart + PAGE_SIZE)

  useEffect(() => {
    if (page !== safePage) {
      setPage(safePage)
    }
  }, [page, safePage])

  return (
    <section className="rounded-xl border border-primary-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-primary-200 px-5 py-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-primary-900">
            Recent Missions
          </h2>
          <p className="text-sm text-primary-600">
            Resume context from recently launched workspace missions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(['all', 'running', 'completed', 'failed'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors',
                filter === value
                  ? 'border-accent-500 bg-primary-100 text-primary-900'
                  : 'border-primary-200 bg-white text-primary-600 hover:border-primary-300 hover:text-primary-900',
              )}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3 px-5 py-4">
        {missionsQuery.isPending && !missionsQuery.data ? (
          <div className="rounded-xl border border-primary-200 bg-primary-50 px-4 py-6 text-sm text-primary-600">
            Loading recent missions...
          </div>
        ) : pageItems.length === 0 ? (
          <div className="rounded-xl border border-dashed border-primary-200 bg-primary-50 px-4 py-6 text-sm text-primary-600">
            No {filter === 'all' ? '' : `${filter} `}missions yet.
          </div>
        ) : (
          pageItems.map((mission) => (
            <button
              key={mission.id}
              type="button"
              onClick={() => {
                void navigate({
                  to: '/workspace',
                  hash: 'projects',
                  search: {
                    goal: undefined,
                    checkpointId: undefined,
                    phaseId: undefined,
                    phaseName: mission.phaseName ?? undefined,
                    project: undefined,
                    projectId: mission.projectId,
                    missionId: undefined,
                    showWizard: undefined,
                  },
                })
              }}
              className="flex w-full flex-col gap-3 rounded-xl border border-primary-200 bg-white px-4 py-3 text-left transition-colors hover:border-primary-300 hover:bg-primary-50/60 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium text-primary-900">
                    {mission.name}
                  </p>
                  <span
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                      getMissionStatusBadgeClass(mission.status),
                    )}
                  >
                    {formatStatus(mission.status)}
                  </span>
                </div>
                <p className="text-sm text-primary-600">
                  {mission.projectName}
                  {mission.phaseName ? ` / ${mission.phaseName}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-3 text-xs text-primary-500">
                <span>
                  {mission.timestamp ? formatRelativeTime(mission.timestamp) : 'No activity yet'}
                </span>
                <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.7} />
              </div>
            </button>
          ))
        )}
      </div>

      <div className="flex items-center justify-between border-t border-primary-200 bg-primary-50/60 px-5 py-4">
        <span className="text-xs text-primary-600">
          Page {safePage + 1} of {totalPages}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={safePage === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={safePage >= totalPages - 1}
            onClick={() =>
              setPage((current) => Math.min(totalPages - 1, current + 1))
            }
          >
            Next
          </Button>
        </div>
      </div>
    </section>
  )
}
