// The carry of unsent text into a sleeping Star's draft (`carry.ts`), on the
// page's Stars, threads and composers.
import type * as Drafts from "../../view/drafts.ts";
import { scopedKey, threadStore } from "../threads/store.ts";
import { carryInto } from "./carry.ts";
import { starStore, starTarget } from "./model.ts";
import { starEnabled, starSettingKnown } from "./settings.ts";
import { conversationsOf } from "./stars.ts";

/** The composer store's module, once loaded. */
let drafts: typeof Drafts | undefined;
let looking = false;
/** The conversations told stranded, by `scopedKey`, each once per page session. */
const told = new Set<string>();
/**
 * The conversations whose composer a move left holding something while the
 * draft still held nothing (a file the mover keeps back: one whose upload a
 * reload cut short), by `scopedKey`: carried no more this page session, so
 * the carry never moves the same nothing again and again.
 */
const stuck = new Set<string>();

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
 * Whenever a Star's tab shows its draft and the composer of a conversation
 * of that home that has ended holds text, moves the text into the draft
 * (`carryInto`): a state looked at on every change, so text stranded while
 * no page was open is carried on the next look. Unsent text holds no Star
 * awake: its plugin puts it to sleep regardless (`star-sleep`).
 */
function carry(drafts: typeof Drafts): void {
  if (!starSettingKnown() || !starEnabled.get()) return;
  const threads = threadStore.get().threads;
  for (const star of starStore.get()) {
    const target = starTarget(star);
    if (target?.kind !== "draft") continue;
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
                !stuck.has(scopedKey(thread.environmentId, thread.id)) &&
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
      if (drafts.composerHoldsText(target) !== true) {
        stuck.add(scopedKey(target.environmentId, decision.threadId));
        console.warn(
          `[pult-shell] the Star's ended conversation ${decision.threadId} holds what the composer cannot move into the draft, left there.`,
        );
      }
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

/** Starts carrying unsent text into the Stars' drafts, after the Stars' model, on the page's thread model. */
export function startUnsentCarry(): void {
  threadStore.subscribe(look);
  starStore.subscribe(look);
  starEnabled.subscribe(look);
  // The composer store without the rest of the view, as the panel loads it.
  void import("../../view/drafts.ts").then((module) => {
    drafts = module;
    module.onDidChangeComposers(look);
    look();
  });
}
