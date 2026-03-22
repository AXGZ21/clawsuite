import { execSync } from "node:child_process";
import { CodexAdapter } from "./adapters/codex";
import { ClaudeAdapter } from "./adapters/claude";
import { OpenClawAdapter } from "./adapters/openclaw";
import type { AgentAdapter } from "./adapters/types";
import { buildCheckpoint } from "./checkpoint-builder";
import { getWorkflowConfig, loadWorkflowDefinition, renderTaskPrompt } from "./config";
import { WorkspaceManager } from "./workspace";
import { Tracker } from "./tracker";
import type { AgentRecord, Project, Task, TaskRun, TaskRunOutcome } from "./types";

export class AgentRunner {
  private readonly adapters: Map<string, AgentAdapter>;
  private readonly workspaceManager: WorkspaceManager;
  private readonly tracker: Tracker;

  constructor(tracker: Tracker, workspaceManager = new WorkspaceManager()) {
    this.tracker = tracker;
    this.workspaceManager = workspaceManager;
    this.adapters = new Map<string, AgentAdapter>([
      ["codex", new CodexAdapter()],
      ["claude", new ClaudeAdapter()],
      ["openclaw", new OpenClawAdapter()],
    ]);
  }

  getAdapter(type: string): AgentAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`Unsupported adapter type: ${type}`);
    }
    return adapter;
  }

  async runTask(input: {
    project: Project;
    task: Task;
    taskRun: TaskRun;
    agent: AgentRecord;
    attempt: number;
    config?: {
      autoApprove?: boolean;
    };
    signal?: AbortSignal;
  }): Promise<TaskRunOutcome> {
    const workflow = loadWorkflowDefinition(input.project.path);
    const workflowConfig = getWorkflowConfig(input.project.path);
    const autoApprove = input.config?.autoApprove ?? workflowConfig.autoApprove;
    const workspace = await this.workspaceManager.ensureWorkspace(input.project, input.task, input.taskRun.id);
    this.tracker.updateTaskRunWorkspacePath(input.taskRun.id, workspace.path);
    input.taskRun.workspace_path = workspace.path;

    await this.workspaceManager.runBeforeRunHooks(workspace.path, workspace.hooks);

    const basePrompt = renderTaskPrompt(workflow.promptTemplate, {
      projectName: input.project.name,
      taskName: input.task.name,
      taskDescription: input.task.description,
      workspacePath: workspace.path,
    });
    const agentSystemPrompt = input.agent.system_prompt?.trim();
    const projectPath = input.project.path;
    const isEphemeralProject = projectPath?.startsWith("/tmp/conductor") ?? false;
    let finalPrompt: string;

    if (isEphemeralProject) {
      const genericPrompt = [
        "# Autonomous Builder Agent",
        "",
        "You are an autonomous coding agent. Build exactly what is requested.",
        "",
        "## Rules",
        "- Create all files from scratch in the current working directory",
        "- Use modern web technologies (HTML, CSS, JavaScript/TypeScript, React if appropriate)",
        "- For simple projects, prefer standalone HTML+CSS+JS (no build step needed)",
        "- For complex projects, scaffold with Vite + React + Tailwind",
        "- Always create a working, self-contained project",
        "- Commit your changes with a descriptive message",
        "- If the project has package.json, run npm install",
        "- Verify your work compiles/runs without errors",
        "",
        "## Important",
        "- This is a FRESH empty directory — create everything from scratch",
        "- Do NOT look for existing source code — there is none",
        "- Build the complete project as described in the task",
      ].join("\n");
      finalPrompt = `${genericPrompt}\n\n---\n\n${basePrompt}`;
    } else {
      finalPrompt = agentSystemPrompt
        ? `${agentSystemPrompt}\n\n---\n\n${basePrompt}`
        : basePrompt;
    }

    if (projectPath) {
      try {
        const recentLog = execSync("git log --oneline -5", {
          cwd: projectPath,
          encoding: "utf8",
        }).trim();

        if (recentLog) {
          finalPrompt += `\n\n## Recent project commits\n${recentLog}`;
        }
      } catch {
        // Skip git context when the project is not a git repo or has no readable history.
      }
    }

    const adapter = this.getAdapter(input.agent.adapter_type || workflowConfig.defaultAdapter);

    this.tracker.appendRunEvent(input.taskRun.id, "started", {
      taskId: input.task.id,
      agentId: input.agent.id,
      workspacePath: workspace.path,
      attempt: input.attempt,
    });

    const result = await adapter.execute(
      {
        task: input.task,
        taskRun: input.taskRun,
        agent: input.agent,
        workspacePath: workspace.path,
        projectName: input.project.name,
        prompt: finalPrompt,
      },
      {
        signal: input.signal,
        tracker: this.tracker,
        onEvent: (event) => {
          this.tracker.appendRunEvent(input.taskRun.id, event.type === "agent_message" ? "output" : (event.type as any), {
            message: event.message ?? null,
            ...event.data,
          });
        },
      },
    );

    await this.workspaceManager.runAfterRunHooks(workspace.path, workspace.hooks);

    const checkpoint = result.status === "completed"
      ? await buildCheckpoint(
          workspace.path,
          input.project.path,
          input.project.name,
          input.task.name,
          input.taskRun.id,
          this.tracker,
          autoApprove,
        )
      : null;
    const autoApproved =
      result.status === "completed" && checkpoint?.status === "approved";

    if (autoApproved && workspace.git_worktree) {
      await this.workspaceManager.cleanup(input.project, input.task, input.taskRun.id);
    }

    return {
      result,
      workspacePath: workspace.path,
      checkpoint,
      autoApproved,
    };
  }
}
