import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  ArrowRight01Icon,
  PlayIcon,
  Rocket01Icon,
  Search01Icon,
  TaskDone01Icon,
} from '@hugeicons/core-free-icons'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toast'
import { workspaceRequestJson } from '@/lib/workspace-checkpoints'
import { cn } from '@/lib/utils'
import {
  extractDecomposeResponse,
  extractProject,
  type DecomposedTaskDraft,
} from '@/screens/projects/lib/workspace-types'

type QuickActionId = 'research' | 'build' | 'review'

type WorkspaceMissionInputProps = {
  connected: boolean
}

type MissionDraftTask = DecomposedTaskDraft & {
  enabled: boolean
}

const GOAL_STORAGE_KEY = 'workspace-v6-mission-goal'

const QUICK_ACTIONS: Array<{
  id: QuickActionId
  label: string
  icon: typeof Search01Icon
}> = [
  {
    id: 'research',
    label: 'Research',
    icon: Search01Icon,
  },
  {
    id: 'build',
    label: 'Build',
    icon: PlayIcon,
  },
  {
    id: 'review',
    label: 'Review',
    icon: TaskDone01Icon,
  },
]

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function extractEntityId(payload: unknown, key: string): string | null {
  const record = asRecord(payload)
  const entity = asRecord(record?.[key])

  return (
    asString(entity?.id) ??
    asString(record?.id) ??
    asString(record?.[`${key}_id`]) ??
    null
  )
}

function toProjectName(goal: string): string {
  const normalized = goal.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 60) return normalized || 'Workspace Mission'
  return `${normalized.slice(0, 57).trimEnd()}...`
}

function toProjectPath(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

  return `/tmp/workspace-mission-${slug || 'launch'}-${Date.now().toString(36)}`
}

function formatAgentRole(agentType: string | null): string {
  if (!agentType) return 'Unassigned'
  return agentType.charAt(0).toUpperCase() + agentType.slice(1)
}

export function WorkspaceMissionInput({
  connected,
}: WorkspaceMissionInputProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [selectedAction, setSelectedAction] = useState<QuickActionId>('build')
  const [goalDraft, setGoalDraft] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    return window.localStorage.getItem(GOAL_STORAGE_KEY) ?? ''
  })
  const [projectPathDraft, setProjectPathDraft] = useState<string>(() =>
    toProjectPath(
      typeof window === 'undefined'
        ? ''
        : (window.localStorage.getItem(GOAL_STORAGE_KEY) ?? ''),
    ),
  )
  const [projectPathEdited, setProjectPathEdited] = useState(false)
  const [reviewTasks, setReviewTasks] = useState<MissionDraftTask[] | null>(null)
  const [launchError, setLaunchError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (goalDraft.trim().length === 0) {
      window.localStorage.removeItem(GOAL_STORAGE_KEY)
      return
    }
    window.localStorage.setItem(GOAL_STORAGE_KEY, goalDraft)
  }, [goalDraft])

  useEffect(() => {
    if (projectPathEdited) return
    setProjectPathDraft(toProjectPath(goalDraft))
  }, [goalDraft, projectPathEdited])

  const enabledTasks = useMemo(
    () => (reviewTasks ?? []).filter((task) => task.enabled),
    [reviewTasks],
  )

  const decomposeMutation = useMutation({
    mutationFn: async (goal: string) =>
      extractDecomposeResponse(
        await workspaceRequestJson('/api/workspace/decompose', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ goal }),
        }),
      ),
    onSuccess: (result) => {
      const nextTasks = result.tasks.map((task) => ({ ...task, enabled: true }))
      setReviewTasks(nextTasks)
      setLaunchError(
        nextTasks.length === 0 ? 'No tasks returned. Try a more specific mission.' : null,
      )
    },
    onError: (error) => {
      toast(
        error instanceof Error ? error.message : 'Failed to decompose mission',
        { type: 'error' },
      )
    },
  })

  const startMissionMutation = useMutation({
    mutationFn: async (params: {
      goal: string
      tasks: MissionDraftTask[]
      projectPath: string
    }) => {
      const project = extractProject(
        await workspaceRequestJson('/api/workspace/projects', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: toProjectName(params.goal),
            path: params.projectPath,
            spec: params.goal,
          }),
        }),
      )

      if (!project) {
        throw new Error('Project creation returned an empty response')
      }

      const phasePayload = await workspaceRequestJson('/api/workspace/phases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          project_id: project.id,
          name: 'Phase 1',
          sort_order: project.phase_count,
        }),
      })
      const phaseId = extractEntityId(phasePayload, 'phase')
      if (!phaseId) throw new Error('Phase creation returned an empty response')

      const missionPayload = await workspaceRequestJson('/api/workspace/missions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phase_id: phaseId,
          name: toProjectName(params.goal),
        }),
      })
      const missionId = extractEntityId(missionPayload, 'mission')
      if (!missionId) throw new Error('Mission creation returned an empty response')

      const createdTaskIds = new Map<string, string>()

      for (const [index, task] of params.tasks.entries()) {
        const payload = await workspaceRequestJson('/api/workspace/tasks', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            mission_id: missionId,
            name: task.name,
            description: task.description,
            agent_type: task.suggested_agent_type,
            depends_on: task.depends_on
              .map((dependency) => createdTaskIds.get(dependency))
              .filter((dependency): dependency is string => typeof dependency === 'string'),
            sort_order: index,
          }),
        })

        const taskId = extractEntityId(payload, 'task')
        if (taskId) {
          createdTaskIds.set(task.name, taskId)
        }
      }

      await workspaceRequestJson(
        `/api/workspace/missions/${encodeURIComponent(missionId)}/start`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        },
      )

      return { missionId, projectId: project.id }
    },
    onSuccess: async ({ missionId, projectId }) => {
      setLaunchError(null)
      setReviewTasks(null)
      setGoalDraft('')
      setProjectPathDraft(toProjectPath(''))
      setProjectPathEdited(false)
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(GOAL_STORAGE_KEY)
      }
      await queryClient.invalidateQueries({ queryKey: ['workspace'] })
      toast('Mission started', { type: 'success' })
      void navigate({
        to: '/workspace',
        hash: 'projects',
        search: {
          goal: undefined,
          checkpointId: undefined,
          phaseId: undefined,
          phaseName: undefined,
          project: undefined,
          projectId,
          missionId,
          showWizard: undefined,
        },
      })
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'Failed to start mission'
      setLaunchError(message)
      toast(message, { type: 'error' })
    },
  })

  function handlePlanMission() {
    const goal = goalDraft.trim()
    if (!goal) {
      toast('Mission goal is required', { type: 'warning' })
      return
    }

    setLaunchError(null)
    setReviewTasks(null)
    decomposeMutation.mutate(goal)
  }

  function updateReviewTasks(
    updater: (current: MissionDraftTask[]) => MissionDraftTask[],
  ) {
    setReviewTasks((current) => (current ? updater(current) : current))
  }

  function handleTaskEnabledChange(taskId: string, enabled: boolean) {
    updateReviewTasks((current) =>
      current.map((task) => (task.id === taskId ? { ...task, enabled } : task)),
    )
  }

  function handleTaskNameChange(taskId: string, nextName: string) {
    updateReviewTasks((current) => {
      const currentTask = current.find((task) => task.id === taskId)
      if (!currentTask) return current

      const previousName = currentTask.name
      return current.map((task) => {
        if (task.id === taskId) {
          return { ...task, name: nextName }
        }

        if (!task.depends_on.includes(previousName)) {
          return task
        }

        return {
          ...task,
          depends_on: task.depends_on.map((dependency) =>
            dependency === previousName ? nextName : dependency,
          ),
        }
      })
    })
  }

  function handleTaskDescriptionChange(taskId: string, description: string) {
    updateReviewTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, description } : task,
      ),
    )
  }

  function handleStartMission() {
    const goal = goalDraft.trim()
    const projectPath = projectPathDraft.trim()
    const cleanedTasks = enabledTasks.map((task) => ({
      ...task,
      name: task.name.trim(),
      description: task.description.trim(),
      depends_on: task.depends_on.filter(Boolean),
    }))

    if (!goal) {
      setLaunchError('Mission goal is required.')
      return
    }

    if (!projectPath) {
      setLaunchError('Project path is required.')
      return
    }

    if (cleanedTasks.length === 0) {
      setLaunchError('Select at least one task before starting the mission.')
      return
    }

    if (cleanedTasks.some((task) => task.name.length === 0)) {
      setLaunchError('Every task needs a name.')
      return
    }

    if (new Set(cleanedTasks.map((task) => task.name)).size !== cleanedTasks.length) {
      setLaunchError('Task names must be unique so dependencies can be mapped.')
      return
    }

    setLaunchError(null)
    startMissionMutation.mutate({ goal, tasks: cleanedTasks, projectPath })
  }

  return (
    <section className="mx-auto max-w-2xl space-y-4">
      <header className="flex flex-col gap-4 rounded-xl border border-primary-200 bg-primary-50/80 px-5 py-4 shadow-sm md:flex-row md:items-center md:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-600">
            Workspace Home
            <span
              className={cn(
                'size-2 rounded-full',
                connected ? 'bg-accent-500' : 'bg-primary-300',
              )}
            />
          </div>
          <div>
            <h1 className="text-base font-semibold text-primary-900 md:text-lg">
              What should the team do next?
            </h1>
            <p className="text-sm text-primary-600">
              Plan the mission, review the editable task breakdown, then launch it into the existing workspace flow.
            </p>
          </div>
        </div>
      </header>

      {!reviewTasks ? (
        <div className="overflow-hidden rounded-xl border border-primary-200 bg-white shadow-sm">
          <div className="border-b border-primary-200 bg-primary-50/60 px-5 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-500">
              Plan → Review → Build
            </p>
          </div>
          <textarea
            value={goalDraft}
            onChange={(event) => setGoalDraft(event.target.value)}
            placeholder="Describe the mission goal, constraints, and desired outcome."
            className="min-h-[160px] w-full resize-none bg-white px-5 py-4 text-sm text-primary-900 outline-none placeholder:text-primary-500"
          />
          <div className="flex flex-col gap-3 border-t border-primary-200 bg-primary-50/60 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              {QUICK_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => setSelectedAction(action.id)}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    selectedAction === action.id
                      ? 'border-accent-500 bg-primary-100 text-primary-900'
                      : 'border-primary-200 bg-white text-primary-600 hover:border-primary-300 hover:text-primary-900',
                  )}
                >
                  <HugeiconsIcon icon={action.icon} size={14} strokeWidth={1.7} />
                  {action.label}
                </button>
              ))}
            </div>
            <Button
              onClick={handlePlanMission}
              disabled={!connected || !goalDraft.trim() || decomposeMutation.isPending}
              className="w-full bg-accent-500 text-white hover:bg-accent-500/90 sm:w-auto"
            >
              {decomposeMutation.isPending ? 'Planning...' : 'Plan It'}
              <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.7} />
            </Button>
          </div>
        </div>
      ) : null}

      {reviewTasks ? (
        <div className="rounded-xl border border-primary-200 bg-white shadow-sm">
          <div className="flex flex-col gap-2 border-b border-primary-200 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-primary-900">
                Mission Review
              </h2>
              <p className="text-sm text-primary-600">
                Review the plan, edit task details, and choose the workspace path before starting the mission.
              </p>
            </div>
            <div className="text-sm text-primary-600">
              {enabledTasks.length} selected
            </div>
          </div>

          <div className="space-y-4 px-5 py-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-primary-200 bg-primary-50 px-4 py-3 sm:col-span-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary-500">
                  Mission Goal
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-primary-900">
                  {goalDraft.trim()}
                </p>
              </div>

              <label className="block space-y-1.5">
                <span className="block text-[11px] font-medium uppercase tracking-[0.16em] text-primary-500">
                  Project Path
                </span>
                <Input
                  value={projectPathDraft}
                  onChange={(event) => {
                    setProjectPathEdited(true)
                    setProjectPathDraft(event.target.value)
                  }}
                  placeholder="/tmp/workspace-mission-..."
                  className="bg-white"
                />
              </label>

              <div className="rounded-xl border border-primary-200 bg-primary-50 px-4 py-3">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-primary-500">
                  Launch Config
                </p>
                <p className="mt-2 text-sm font-medium text-primary-900">
                  {enabledTasks.length} task{enabledTasks.length === 1 ? '' : 's'} selected
                </p>
                <p className="mt-1 text-sm text-primary-600">
                  Edit task details below before starting the mission.
                </p>
              </div>
            </div>

            {reviewTasks.map((task) => (
              <article
                key={task.id}
                className={cn(
                  'rounded-xl border px-4 py-3 transition-colors',
                  task.enabled
                    ? 'border-accent-500 bg-primary-50'
                    : 'border-primary-200 bg-white opacity-70',
                )}
              >
                <div className="flex items-start gap-3">
                  <label className="mt-1 flex items-center">
                    <input
                      type="checkbox"
                      checked={task.enabled}
                      onChange={(event) =>
                        handleTaskEnabledChange(task.id, event.target.checked)
                      }
                      className="size-4 rounded border-primary-300 text-accent-500 focus:ring-accent-500"
                    />
                  </label>
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <Input
                        value={task.name}
                        onChange={(event) =>
                          handleTaskNameChange(task.id, event.target.value)
                        }
                        className="bg-white text-sm font-medium text-primary-900"
                      />
                      <span className="inline-flex self-start rounded-full border border-primary-200 bg-white px-2.5 py-1 text-[11px] font-medium text-primary-600">
                        {formatAgentRole(task.suggested_agent_type)}
                      </span>
                    </div>
                    <textarea
                      value={task.description}
                      onChange={(event) =>
                        handleTaskDescriptionChange(task.id, event.target.value)
                      }
                      rows={3}
                      className="w-full rounded-xl border border-primary-200 bg-white px-3 py-2.5 text-sm text-primary-600 outline-none transition-colors focus:border-accent-500"
                    />
                    {task.depends_on.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {task.depends_on.map((dependency) => (
                          <span
                            key={`${task.id}:${dependency}`}
                            className="rounded-full border border-primary-200 bg-white px-2 py-0.5 text-[11px] text-primary-600"
                          >
                            Depends on {dependency}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>

          <div className="flex flex-col gap-3 border-t border-primary-200 bg-primary-50/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <Button
              variant="outline"
              onClick={() => {
                setLaunchError(null)
                setReviewTasks(null)
              }}
              className="w-full sm:w-auto"
            >
              Revise Plan
            </Button>
            <Button
              onClick={handleStartMission}
              disabled={
                !connected ||
                enabledTasks.length === 0 ||
                startMissionMutation.isPending
              }
              className="w-full bg-accent-500 text-white hover:bg-accent-500/90 sm:w-auto"
            >
              {startMissionMutation.isPending ? 'Starting...' : 'Start Mission'}
              <HugeiconsIcon icon={Rocket01Icon} size={16} strokeWidth={1.7} />
            </Button>
          </div>
        </div>
      ) : null}

      {launchError ? (
        <div className="rounded-xl border border-primary-300 bg-primary-50 px-4 py-3 text-sm text-primary-900">
          {launchError}
        </div>
      ) : null}
    </section>
  )
}
