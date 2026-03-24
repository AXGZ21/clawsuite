import { Router } from "express";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { Tracker } from "../tracker";

/** Read hooks.token from openclaw.json so the daemon auto-discovers it. */
function resolveHooksToken(): string {
  try {
    const configPath = join(process.env.HOME || "", ".openclaw/openclaw.json");
    if (!existsSync(configPath)) return "";
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    return typeof cfg?.hooks?.token === "string" ? cfg.hooks.token : "";
  } catch {
    return "";
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "mission";
}

const STATE_PATH = join(
  process.env.HOME || "/Users/aurora",
  ".openclaw/workspace/data/dispatch-state.json"
);

function buildOrchestratorPrompt(missionId: string, mission: string, tasks: any[], projectPath: string): string {
  const taskList = tasks.map((t: any, i: number) => {
    const id = t.id || `task-${String(i + 1).padStart(3, "0")}`;
    return `- [${id}] ${t.title || t.name || "Task"} (type: ${t.type || "coding"})${t.description ? `\n  ${t.description}` : ""}`;
  }).join("\n");

  return `You are a mission orchestrator. Execute this mission end-to-end autonomously.

## Mission
ID: ${missionId}
Goal: ${mission}
Project Path: ${projectPath}

## Tasks
${taskList}

## How to Execute

For EACH task in order:

1. **Update daemon**: Run \`exec\` to call:
   curl -X PATCH http://localhost:3099/api/workspace/tasks/<TASK_ID> -H 'Content-Type: application/json' -d '{"status":"running"}'

2. **Spawn a worker agent** using sessions_spawn:
   - task: detailed instructions for building/researching
   - model: "openai-codex/gpt-5.4" for coding, or appropriate model
   - mode: "run"
   - label: "worker-<task-id>"
   - cwd: "${projectPath}"
   - runTimeoutSeconds: 600

3. **Call sessions_yield** and wait for the worker to complete.

4. **Verify the output** — check files exist, run any validation.

5. **Update daemon**: 
   curl -X PATCH http://localhost:3099/api/workspace/tasks/<TASK_ID> -H 'Content-Type: application/json' -d '{"status":"completed"}'

6. **Move to next task**.

After ALL tasks complete:
- Summarize what was built
- The Conductor UI updates automatically via daemon SSE

## Rules
- Do NOT ask for user input. Execute everything autonomously.
- Do NOT skip tasks. Execute each one.
- If a worker fails, retry ONCE with error feedback, then mark failed.
- Use exec + curl to update the daemon. The UI watches via SSE.
- Work ONLY in the project path directory.`;
}

function fireDispatchTrigger(missionId: string, mission: string, tasks: any[] = [], projectPath: string = ""): void {
  const orchestratorMessage = buildOrchestratorPrompt(missionId, mission, tasks, projectPath);

  // Use gateway hooks/agent endpoint to spawn an isolated agent session.
  // This creates an independent session that can use sessions_spawn — no chat session dependency.
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";
  const hooksToken = process.env.OPENCLAW_HOOKS_TOKEN ?? resolveHooksToken();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (hooksToken) {
    headers["Authorization"] = `Bearer ${hooksToken}`;
  }

  fetch(`${gatewayUrl}/hooks/agent`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: orchestratorMessage,
      name: `mission-${missionId}`,
      deliver: false,
      wakeMode: "now",
      timeoutSeconds: 600,
    }),
  })
    .then((res) => {
      if (res.ok) {
        return res.json().then((data: any) => {
          console.log("[dispatch] Orchestrator spawned for", missionId, "runId:", data?.runId);
        });
      } else {
        throw new Error(`Hooks returned ${res.status}`);
      }
    })
    .catch((err: Error) => {
      console.error("[dispatch] Failed to spawn orchestrator:", err.message);
      // Fallback: wake event (goes to agent:main:main)
      const fallbackText = `[dispatch] Mission started: ${missionId}. Goal: "${mission.slice(0, 100)}". Read data/dispatch-state.json and run the workspace-dispatch skill loop now.`;
      fetch(`${gatewayUrl}/api/cron/wake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: fallbackText, mode: "now" }),
      }).catch(() => {
        console.error("[dispatch] Wake fallback also failed for", missionId);
      });
    });
}

export function createDispatchRouter(tracker?: Tracker): Router {
  const router = Router();

  router.get("/state", (_req, res) => {
    if (!existsSync(STATE_PATH)) {
      return res.json({ status: "idle", tasks: [] });
    }
    try {
      const raw = readFileSync(STATE_PATH, "utf-8");
      res.json(JSON.parse(raw));
    } catch {
      res.status(500).json({ error: "Failed to read dispatch state" });
    }
  });

  router.post("/start", (req, res) => {
    const { mission, mode, tasks, projectPath } = req.body;
    if (!mission) return res.status(400).json({ error: "mission is required" });

    const missionId = "mission-" + Date.now();
    const now = new Date().toISOString();
    const resolvedProjectPath =
      typeof projectPath === "string" && projectPath.trim().length > 0
        ? projectPath.trim()
        : `/tmp/dispatch-${slugify(mission)}-${Date.now()}`;

    const state = {
      mission_id: missionId,
      mission,
      status: "pending_dispatch",
      created_at: now,
      updated_at: now,
      current_task_id: null,
      tasks: tasks || [],
      options: { mode: mode || "autonomous", max_parallel: 1, project_path: resolvedProjectPath },
    };

    // Write dispatch state file
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

    // Sync to daemon SQLite so Recent Missions shows it
    let projectId: string | null = null;
    if (tracker) {
      try {
        const project = tracker.createProject({
          name: mission.slice(0, 80),
          path: resolvedProjectPath,
          spec: mission,
        });
        projectId = project.id;
        const phase = tracker.createPhase({ project_id: project.id, name: "Phase 1" });
        const dbMission = tracker.createMission({ phase_id: phase.id, name: mission.slice(0, 100) });
        if (dbMission) {
          for (const task of (tasks || [])) {
            tracker.createTask({
              mission_id: dbMission.id,
              name: task.title || task.name || "Task",
              description: task.description || "",
              agent_type: task.type || null,
            });
          }
          // Start the mission so the mission loop picks it up
          tracker.startMission(dbMission.id);
        }
      } catch {
        // SQLite sync is best-effort
      }
    }

    // Spawn orchestrator agent via gateway hooks
    fireDispatchTrigger(missionId, mission, tasks || [], resolvedProjectPath);

    res.json({ ok: true, mission_id: missionId, project_id: projectId });
  });

  return router;
}
