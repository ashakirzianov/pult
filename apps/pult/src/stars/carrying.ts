// The carry of unsent text into a sleeping Star's draft (`carry.ts`), on the
// page's Stars, threads and composers.
import type * as Drafts from "../../view/drafts.ts";
import { scopedKey, threadStore } from "../threads/store.ts";
import { onDidChangePluginFeatures, pluginFeatures } from "./about.ts";
import { carryInto } from "./carry.ts";
import { starStore, starTarget } from "./model.ts";
import { STARS_FEATURE } from "./plugin.ts";
import { starEnabled, starSettingKnown } from "./settings.ts";
import { conversationsOf } from "./stars.ts";

/** The composer store's module, once loaded. */
let drafts: typeof Drafts | undefined;
let looking = false;
/** The conversations told stranded, by `scopedKey`, each once per page session. */
const told = new Set<string>();

/** Looks once the current change is through: a move changes the composers again, and is looked at after. */
function look(): void {
  if (looking) return;
  looking = true;
  queueMicrotask(() => {
    looking = false;
    if (drafts !== undefined) carry(drafts);
  });
}

/**
 * Whenever a Star's tab shows its draft on an environment whose Pult plugin
 * keeps its Stars, and the composer of a conversation of that home that has
 * ended holds text, moves the text into the draft (`carryInto`): a state
 * looked at on every change, so text stranded while no page was open is
 * carried on the next look. The page holds a Star awake over unsent text
 * where it keeps the Star itself (`conversations.ts`).
 */
function carry(drafts: typeof Drafts): void {
  if (!starSettingKnown() || !starEnabled.get()) return;
  const threads = threadStore.get().threads;
  for (const star of starStore.get()) {
    const target = starTarget(star);
    if (
      target?.kind !== "draft" ||
      pluginFeatures(target.environmentId)?.has(STARS_FEATURE) !== true
    )
      continue;
    const homes = star.homes.filter(
      (home) => home.environmentId === target.environmentId && home.projectId === target.projectId,
    );
    const ended = conversationsOf(homes, threads).flatMap((thread) =>
      thread.settled && thread.settledAt !== null
        ? [
            {
              threadId: thread.id,
              settledAt: thread.settledAt,
              holds:
                drafts.composerHoldsText({
                  kind: "thread",
                  environmentId: thread.environmentId,
                  threadId: thread.id,
                }) === true,
            },
          ]
        : [],
    );
    const holds = drafts.composerHoldsText(target);
    const decision = carryInto(holds === null ? null : { holds }, ended);
    if (decision === undefined) continue;
    const from = {
      kind: "thread",
      environmentId: target.environmentId,
      threadId: decision.threadId,
    } as const;
    if (decision.kind === "move") {
      drafts.moveComposerText(from, target);
      continue;
    }
    const key = scopedKey(target.environmentId, decision.threadId);
    if (told.has(key)) continue;
    told.add(key);
    console.warn(
      `[pult-shell] the Star's ended conversation ${decision.threadId} holds unsent text, left there: its draft holds some already.`,
    );
  }
}

/** Starts carrying unsent text into the Stars' drafts, after the Stars' model, on the page's thread model and its plugins' `about`. */
export function startUnsentCarry(): void {
  threadStore.subscribe(look);
  starStore.subscribe(look);
  starEnabled.subscribe(look);
  onDidChangePluginFeatures(look);
  // The composer store without the rest of the view, as the panel loads it.
  void import("../../view/drafts.ts").then((module) => {
    drafts = module;
    module.onDidChangeComposers(look);
    look();
  });
}
