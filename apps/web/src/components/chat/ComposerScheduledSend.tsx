// Pult's, not upstream's: the send button's context menu saves the message as a one-time
// scheduled task on this thread (upstream's; listed under the thread's Automations) and clears
// the composer. A bound task sends text alone on the thread's model and mode, so a draft
// carrying more is refused in the menu rather than sent without it.
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  pickSnoozePreset,
  resolveSnoozePresets,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  AuthOrchestrationOperateScope,
  type ContextMenuItem,
  type EnvironmentId,
  type RuntimeMode,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import {
  use,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { useClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatShortTimestamp } from "../../timestampFormat";
import { threadHasStarted } from "../../lib/chatThreadActions";
import { DEFAULT_INTERACTION_MODE, type Thread } from "../../types";
import { toDateTimeLocalValue } from "../settings/scheduledTasksSettings.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ChatComposerHandle } from "./ChatComposer";
import { getComposerPromptLengthValidationMessage } from "./composerSubmission";
import { readFreshSessionArm } from "./freshSessionArms";
import { ShellComposerOptions } from "./ShellComposerOptions";

const HOUR_MS = 3_600_000;

type ModelOptions = Thread["modelSelection"]["options"];

/** An option both selections set to different values, such as an effort changed in the composer. */
function optionsConflict(composer: ModelOptions, thread: ModelOptions): boolean {
  const threadValues = new Map((thread ?? []).map((option) => [option.id, option.value]));
  return (composer ?? []).some(
    (option) => threadValues.has(option.id) && threadValues.get(option.id) !== option.value,
  );
}

export function useComposerScheduledSend(input: {
  readonly environmentId: EnvironmentId;
  /** The server thread the composer sends to; undefined for a draft, which has none yet. */
  readonly thread: Thread | undefined;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly composerRef: React.RefObject<ChatComposerHandle | null>;
  readonly promptRef: React.RefObject<string>;
  readonly runtimeMode: RuntimeMode;
}): {
  readonly onSendContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly dialog: ReactNode;
} {
  const { environmentId, thread, composerDraftTarget, composerRef, promptRef, runtimeMode } = input;
  const gt = useGT();
  const messages = useMessages();
  const { reply } = use(ShellComposerOptions);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const offersOnce =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities.oneTimeSchedules === true;
  const canSchedule = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "composer scheduled send",
  });
  const [customOpen, setCustomOpen] = useState(false);
  const saving = useRef(false);
  // The composer stays mounted across threads, and its prompt ref is the shown thread's.
  const shownTargetKey = useRef("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the shown draft target to a ref an awaited save reads
  useLayoutEffect(() => {
    shownTargetKey.current = composerTargetKey(composerDraftTarget);
  });

  /** The message to schedule, or why this draft cannot be. */
  const readMessage = (): { text: string; thread: Thread } | { refused: string } => {
    const sendCtx = composerRef.current?.getSendContext();
    const draft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
    const text = (sendCtx?.prompt ?? promptRef.current).trim();
    if (saving.current) return { refused: gt("Still scheduling the previous message") };
    if (thread === undefined || !threadHasStarted(thread))
      return { refused: gt("A new thread's first message sends now") };
    if (!offersOnce) return { refused: gt("This environment can't schedule one-time messages") };
    if (!canSchedule) return { refused: gt("You can't schedule tasks on this environment") };
    if (reply !== null) return { refused: gt("A reply sends now") };
    if (sendCtx === undefined || sendCtx.answeringPendingUserInput)
      return { refused: gt("Answer the open question first") };
    if (
      sendCtx.images.length > 0 ||
      sendCtx.files.length > 0 ||
      (draft?.persistedAttachments.length ?? 0) > 0 ||
      sendCtx.terminalContexts.length > 0 ||
      sendCtx.previewAnnotations.length > 0 ||
      sendCtx.reviewComments.length > 0 ||
      sendCtx.threadContexts.length > 0 ||
      sendCtx.environmentContexts.length > 0 ||
      (draft?.replyTo ?? null) !== null
    )
      return { refused: gt("Only plain text can be scheduled") };
    if (text.length === 0) return { refused: gt("Type a message to schedule") };
    if (text.startsWith("/")) return { refused: gt("Commands send now") };
    const tooLong = getComposerPromptLengthValidationMessage(text, messages);
    if (tooLong !== null) return { refused: tooLong };
    if (
      sendCtx.multipleModelSelections !== null ||
      sendCtx.selectedModelSelection.instanceId !== thread.modelSelection.instanceId ||
      sendCtx.selectedModelSelection.model !== thread.modelSelection.model ||
      optionsConflict(sendCtx.selectedModelSelection.options, thread.modelSelection.options) ||
      runtimeMode !== thread.runtimeMode ||
      // A composer send always runs in the default mode.
      thread.interactionMode !== DEFAULT_INTERACTION_MODE
    )
      return { refused: gt("A scheduled message uses the thread's model and mode") };
    if (
      readFreshSessionArm(scopedThreadKey(scopeThreadRef(environmentId, thread.id))) !== undefined
    )
      return { refused: gt("A fresh session is armed; send now to start it") };
    return { text, thread };
  };

  const schedule = async (runAt: Date) => {
    const message = readMessage();
    if ("refused" in message) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: gt("Message not scheduled"),
          description: message.refused,
        }),
      );
      return;
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const { text, thread: target } = message;
    // As the server titles a task an agent schedules: the first line.
    const firstLine = (text.split("\n")[0] ?? "")
      .trim()
      .slice(0, 80)
      .replace(/[\uD800-\uDBFF]$/, "");
    const taskInput: ScheduledTaskUpsertInput = {
      title: firstLine.length > 0 ? firstLine : gt("Scheduled message"),
      prompt: text,
      enabled: true,
      schedule: { type: "once", runAt: runAt.toISOString() },
      projectId: target.projectId,
      threadId: target.id,
      workspaceStrategy: { type: "root" },
      modelSelection: target.modelSelection,
      runtimeMode: target.runtimeMode,
      interactionMode: target.interactionMode,
      creationSource: "web",
    };
    // Cleared at schedule time as a send clears it, so nothing typed during the save is lost.
    const targetKey = composerTargetKey(composerDraftTarget);
    const store = useComposerDraftStore.getState();
    store.clearComposerContent(composerDraftTarget);
    promptRef.current = "";
    composerRef.current?.resetCursorState();
    saving.current = true;
    const result = await upsertTask({ environmentId, input: taskInput });
    saving.current = false;
    if (result._tag === "Failure") {
      // Put back above anything typed meanwhile, as a failed send does.
      const current = store.getComposerDraft(composerDraftTarget)?.prompt ?? "";
      const restored = current.trim() ? `${current}\n\n${text}` : text;
      store.setPrompt(composerDraftTarget, restored);
      if (shownTargetKey.current === targetKey) {
        promptRef.current = restored;
        composerRef.current?.resetCursorState({ prompt: restored, cursor: restored.length });
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not schedule message"),
            description: thrownErrorMessage(error, messages) ?? String(error),
          }),
        );
      }
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: gt("Message scheduled"),
        description: gt("Sends {time}. The thread's Automations list it.", {
          time: formatShortTimestamp(runAt.toISOString(), timestampFormat),
        }),
      }),
    );
  };

  const onSendContextMenu = useStableCallback(async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const message = readMessage();
    const formatTime = (date: Date) => formatShortTimestamp(date.toISOString(), timestampFormat);
    const presetOptions = () => {
      const presets = appAtomRegistry.get(
        serverEnvironment.settingsValueAtom(environmentId),
      )?.snoozePresets;
      return { ...(presets ? { presets } : {}), formatTime };
    };
    // The snooze presets are the app's "later" times, so they are reused rather than duplicated.
    const presets =
      "refused" in message ? [] : resolveSnoozePresets(new Date(), presetOptions(), messages);
    const items: ContextMenuItem[] = [
      { id: "header", label: gt("Send later"), header: true },
      ...("refused" in message
        ? [{ id: "refused", label: message.refused, disabled: true }]
        : [
            ...presets.map((preset) => ({
              id: `preset:${preset.id}`,
              label: preset.label,
              detail: preset.whenLabel,
            })),
            { id: "custom", label: gt("Custom time…"), separatorBefore: presets.length > 0 },
          ]),
    ];
    const clicked = await settlePromise(() =>
      api.contextMenu.show(items, { x: event.clientX, y: event.clientY }),
    );
    if (clicked._tag === "Failure" || clicked.value === null) return;
    if (clicked.value === "custom") {
      setCustomOpen(true);
      return;
    }
    if (!clicked.value.startsWith("preset:")) return;
    const picked = pickSnoozePreset({
      shown: presets,
      id: clicked.value.slice("preset:".length),
      now: new Date(),
      ...presetOptions(),
      resolve: messages,
    });
    if (picked === undefined) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: gt("Message not scheduled"),
          description: gt("That time has passed. Choose another time."),
        }),
      );
      return;
    }
    await schedule(new Date(picked.snoozedUntil));
  });

  const dialog = customOpen ? (
    <ScheduledSendDialog
      onClose={() => setCustomOpen(false)}
      onSchedule={(runAt) => {
        setCustomOpen(false);
        void schedule(runAt);
      }}
    />
  ) : null;

  return { onSendContextMenu, dialog };
}

/** Settings' picker for a one-time task: a local date and time. */
function ScheduledSendDialog(props: {
  readonly onClose: () => void;
  readonly onSchedule: (runAt: Date) => void;
}) {
  const gt = useGT();
  const id = useId();
  const [value, setValue] = useState(() => toDateTimeLocalValue(new Date(Date.now() + HOUR_MS)));
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            // React bubbles a portal's submit to the composer's own form, which would send now.
            event.stopPropagation();
            const runAt = new Date(value);
            // A time skipped by a daylight saving change parses to a different clock time.
            if (
              Number.isNaN(runAt.getTime()) ||
              toDateTimeLocalValue(runAt) !== value ||
              runAt.getTime() <= Date.now()
            ) {
              setError(gt("Choose a valid date and time in the future."));
              return;
            }
            props.onSchedule(runAt);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>Send later</T>
            </DialogTitle>
            <DialogDescription>
              <T>Choose when this message is sent to the thread.</T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex items-center gap-2">
              <Label htmlFor={`${id}-run-at`}>
                <T>Send at</T>
              </Label>
              <Input
                type="datetime-local"
                id={`${id}-run-at`}
                nativeInput
                className="w-56"
                required
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(null);
                }}
              />
            </div>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit">
              <T context="verb">Schedule</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
