// What a thread's shelves read that only the view's providers reach (`DetailsViewRows` in
// `host.ts`): its project's scripts, its local servers, its scheduled tasks and which of its
// subagents can be stopped, read and called as upstream's rows do (`ProjectScriptsControl.tsx`,
// `ThreadServersPanel.tsx`, `ThreadAutomationsPanel.tsx`, `ThreadRelationshipsControl.tsx`), and
// handed to the shell, which draws them (`src/details/ThreadDetails.tsx`). No upstream control is
// mounted: an action's editor, a scheduled task's, port forwarding and the rest stay the fork's
// web app's.
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  type AuthEnvironmentScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ProjectScript,
  type ThreadId,
} from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";

import { openDiscoveredPort } from "~/components/preview/openDiscoveredPort";
import type {
  NewProjectScriptInput,
  ProjectScriptActionResult,
} from "~/components/ProjectScriptsControl";
import { scheduleLabel } from "~/components/settings/scheduledTasksSettings.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useClientSettings } from "~/hooks/useSettings";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { m } from "~/i18n/messages";
import { useThreadDiscoveredPorts } from "~/portDiscoveryState";
import { useQuietThreadProjection } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { type DetailsViewRows, threadViewHost } from "./host.ts";

const ACTIVE = new Set(["pending", "running", "waiting"]);

/** Whether upstream's lineage panel offers Stop on the subagent's row, by its rule for an agent. */
function canStop(agent: OrchestrationV2Subagent): boolean {
  const stoppable =
    agent.origin === "app_owned" ||
    (agent.driver === "claudeAgent" &&
      agent.runId !== null &&
      agent.nativeTaskRef?.strength === "strong" &&
      agent.nativeTaskRef.nativeId !== null);
  return stoppable && agent.startedAt !== null && ACTIVE.has(agent.status);
}

/**
 * Whether the session grants every scope a command needs, as its permission
 * atom reads it; read as the rows render, which their next change reads again.
 */
function granted(
  environmentId: EnvironmentId,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): boolean {
  return scopes.every((scope) => readEnvironmentScope(environmentId, scope));
}

function reportFailure(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? String(error),
    }),
  );
}

/**
 * The rows handed over, each action calling its row's as the latest render
 * has it, found by its key, since a change to what an action does (a
 * script's command) need not change what the rows say.
 */
function delegated(
  rows: DetailsViewRows,
  latest: { readonly current: DetailsViewRows },
): DetailsViewRows {
  const action = (key: string) => latest.current.actions.find((each) => each.key === key);
  const server = (key: string) => latest.current.servers.find((each) => each.key === key);
  const schedule = (key: string) => latest.current.schedules.find((each) => each.key === key);
  return {
    ...rows,
    actions: rows.actions.map((row) => ({
      ...row,
      ...(row.run === undefined ? {} : { run: () => action(row.key)?.run?.() }),
      ...(row.add === undefined ? {} : { add: () => action(row.key)?.add?.() }),
    })),
    servers: rows.servers.map((row) => ({
      ...row,
      ...(row.open === undefined ? {} : { open: () => server(row.key)?.open?.() }),
      ...(row.stop === undefined ? {} : { stop: () => server(row.key)?.stop?.() }),
    })),
    schedules: rows.schedules.map((row) => ({
      ...row,
      ...(row.runNow === undefined ? {} : { runNow: () => schedule(row.key)?.runNow?.() }),
      ...(row.setEnabled === undefined
        ? {}
        : {
            setEnabled: (enabled: boolean) => schedule(row.key)?.setEnabled?.(enabled),
          }),
    })),
    stops: rows.stops.map(({ threadId }) => ({
      threadId,
      stop: () => latest.current.stops.find((each) => each.threadId === threadId)?.stop(),
    })),
  };
}

/** A command's failure, told as upstream's rows tell it; an interrupted one is none. */
function reported(title: string) {
  return (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      reportFailure(title, squashAtomCommandFailure(result));
  };
}

/**
 * Hands the shell the thread's rows its view reads while the shelves show it
 * (`ThreadDetailsPanel.tsx`; on a thread's side chat's tab the shelves are
 * its parent's, and so is this thread), again whenever what they say
 * changes; each
 * action calls through the latest props, so a new render alone hands over
 * nothing.
 */
export function DetailsViewRowsPublisher(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly gitCwd: string | null;
  readonly scripts: ReadonlyArray<ProjectScript> | undefined;
  readonly onRunProjectScript: (script: ProjectScript) => void;
  readonly onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
}) {
  const { environmentId, threadId } = props;
  const { detailsCards } = threadViewHost();
  const fileScripts = useT3ProjectFileScripts(
    environmentId,
    props.scripts === undefined ? null : props.gitCwd,
  );
  const servers = useThreadDiscoveredPorts({ environmentId, threadId });
  const canOpen = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const mayStop = granted(environmentId, previewEnvironment.stopLocalServer.requiredScopes());
  const supportsStop =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities.localServerStop === true;
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const stopServer = useAtomCommand(previewEnvironment.stopLocalServer, {
    label: "thread server stop",
  });
  const mayRunTasks = granted(
    environmentId,
    serverEnvironment.runScheduledTaskNow.requiredScopes(),
  );
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  ).data?.tasks;
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "thread automation toggle",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread automation run now",
  });
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // Its own subagents, and on a subagent's tab its siblings, which its parent's projection holds.
  const projection = useQuietThreadProjection(scopeThreadRef(environmentId, threadId))?.projection;
  const parentId = projection?.thread?.lineage.parentThreadId ?? null;
  const parentProjection = useQuietThreadProjection(
    parentId === null ? null : scopeThreadRef(environmentId, parentId),
  )?.projection;
  const subagents = [...(projection?.subagents ?? []), ...(parentProjection?.subagents ?? [])];
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);

  const latest = useRef(props);
  // oxlint-disable-next-line react/refs -- the actions call through the latest props without handing the rows over again.
  latest.current = props;
  const threadRef = scopeThreadRef(environmentId, threadId);
  const scripts = props.scripts ?? [];
  const importable = fileScripts.filter(
    (fileScript) =>
      !scripts.some(
        (script) =>
          script.command === fileScript.command ||
          script.name.toLowerCase() === fileScript.name.toLowerCase(),
      ),
  );
  const rows: DetailsViewRows = {
    environmentId,
    threadId,
    actions: [
      ...scripts.map((script) => ({
        key: `script:${script.id}`,
        name: script.name,
        icon: script.icon,
        run: () => latest.current.onRunProjectScript(script),
      })),
      ...importable.map((fileScript) => ({
        key: `file:${fileScript.name}\n${fileScript.command}`,
        name: fileScript.name,
        icon: fileScript.icon ?? "play",
        // Upstream's import payload (`ProjectScriptsControl.tsx`, `importFileScript`), with no dialog.
        add: () =>
          void latest.current
            .onAddProjectScript({
              name: fileScript.name,
              command: fileScript.command,
              icon: fileScript.icon ?? "play",
              runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
              waitForSetup: fileScript.runOnWorktreeCreate === true && fileScript.async === false,
              runOnSettle: fileScript.runOnSettle ?? false,
              stopOnSettle: fileScript.stopOnSettle ?? false,
              ...(readEnvironmentScope(environmentId, AuthSettingsWriteScope)
                ? { keybinding: null }
                : {}),
              previewUrl: fileScript.previewUrl ?? null,
              autoOpenPreview: fileScript.previewUrl
                ? (fileScript.autoOpenPreview ?? false)
                : false,
            })
            .then(reported(`Failed to import ${fileScript.name}.`)),
      })),
    ],
    servers: servers.map((server) => {
      const { pid } = server;
      return {
        key: `${server.pid}:${server.port}`,
        address: `localhost:${server.port}`,
        startedBy: server.terminal === null ? "Agent" : "Terminal",
        ...(canOpen
          ? {
              open: () =>
                void openDiscoveredPort({ threadRef, port: server, openPreview }).then(
                  reported("Unable to open preview"),
                ),
            }
          : {}),
        ...(mayStop && supportsStop && pid !== null
          ? {
              stop: () =>
                void stopServer({ environmentId, input: { pid, port: server.port } }).then(
                  reported("Could not stop server"),
                ),
            }
          : {}),
      };
    }),
    schedules: (tasks ?? [])
      .filter((task) => task.threadId === threadId)
      .map((task) => ({
        key: task.id,
        title: task.title,
        rule: scheduleLabel(task.schedule, timestampFormat, undefined, task.nextRunAt, m),
        nextRunAt: task.nextRunAt,
        once: task.schedule.type === "once",
        enabled: task.enabled,
        running: task.lastRunStatus === "running",
        blocked: task.blockedByPolicy ?? null,
        ...(mayRunTasks && readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
          ? {
              // A webhook's task runs when its hook is called, as upstream's row has it.
              ...(task.schedule.type === "webhook"
                ? {}
                : {
                    runNow: () =>
                      void runTaskNow({ environmentId, input: { id: task.id } }).then(
                        reported("Could not run automation"),
                      ),
                  }),
              setEnabled: (enabled: boolean) =>
                void setTaskEnabled({ environmentId, input: { id: task.id, enabled } }).then(
                  reported("Could not update automation"),
                ),
            }
          : {}),
      })),
    stops: subagents.flatMap((agent) =>
      agent.childThreadId === null || !canStop(agent)
        ? []
        : [
            {
              threadId: agent.childThreadId,
              stop: () =>
                void interruptTurn({
                  environmentId,
                  input: { threadId: agent.threadId, subagentId: agent.id },
                }).then(reported("Could not stop subagent")),
            },
          ],
    ),
  };
  // What the rows say, their actions aside: a change hands them over again.
  const said = JSON.stringify(rows);
  const current = useRef(rows);
  // oxlint-disable-next-line react/refs -- the rows handed over are the latest that say this.
  current.current = rows;
  useLayoutEffect(() => {
    detailsCards.setViewRows(delegated(current.current, current));
    return () => {
      // Still ours: the next publisher's effect runs after this cleanup.
      detailsCards.setViewRows(null);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- what the rows say, not their identity, which every render changes.
  }, [said, detailsCards]);
  return null;
}
