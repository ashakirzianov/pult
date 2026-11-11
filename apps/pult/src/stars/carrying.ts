// The carry of unsent text into a sleeping Star's draft and out of it into
// the conversation someone else woke (`carry.ts`), on the page's Stars,
// threads and composers.
import type * as Drafts from "../../view/drafts.ts";
import { scopedKey, threadStore } from "../threads/store.ts";
import { carryInto, carryOutOf } from "./carry.ts";
import { starStore, type StarTarget, starTarget } from "./model.ts";
import { starEnabled, starSettingKnown } from "./settings.ts";
import { conversationsOf, type Star } from "./stars.ts";

/** The composer store's module, once loaded. */
let drafts: typeof Drafts | undefined;
let looking = false;
/** The conversations, by `scopedKey`, and the drafts, by `draftKey`, told stranded, each once per page session. */
const told = new Set<string>();
/**
 * The composers a move left holding something while the one moved into
 * still held nothing (a file the mover keeps back: one whose upload a reload
 * cut short), conversations by `scopedKey` and drafts by `draftKey`: carried
 * no more this page session, so the carry never moves the same nothing again
 * and again.
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
 * (`carryInto`); whenever the Star is awake in a conversation its draft did
 * not create and a draft of its holds text, moves the text into that
 * conversation's composer (`carryOutOf`), whether or not its tab is open.
 * A state looked at on every change, so text stranded while no page was
 * open is carried on the next look. Unsent text holds no Star awake, nor
 * asleep: its plugin puts it to sleep, and wakes it for a message,
 * regardless (`star-sleep`, `star-delivery`).
 */
function carry(drafts: typeof Drafts): void {
  if (!starSettingKnown() || !starEnabled.get()) return;
  const threads = threadStore.get().threads;
  for (const star of starStore.get()) {
    const target = starTarget(star);
    if (target?.kind === "thread") {
      carryOut(drafts, star, target);
      continue;
    }
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

/** Moves an awake Star's drafts' text into its current conversation's composer (`carryOutOf`). */
function carryOut(
  drafts: typeof Drafts,
  star: Star,
  target: Extract<StarTarget, { kind: "thread" }>,
): void {
  // Keyed by the draft and the conversation, so what stuck or was told in one wake holds no later one.
  const keyOf = (environmentId: string, projectId: string) =>
    `${drafts.draftKey(environmentId, projectId)}|${target.environmentId}:${target.threadId}`;
  const decision = carryOutOf(
    { holds: drafts.composerHoldsText(target) === true },
    star.homes.map(({ environmentId, projectId }) => ({
      environmentId,
      projectId,
      holds:
        !stuck.has(keyOf(environmentId, projectId)) &&
        drafts.composerHoldsText({ kind: "draft", environmentId, projectId }) === true,
      createsCurrent: drafts.isPromotion(
        { environmentId, projectId },
        target.environmentId,
        target.threadId,
      ),
    })),
  );
  if (decision === undefined) return;
  const { environmentId, projectId } = decision.draft;
  const from = { kind: "draft", environmentId, projectId } as const;
  const key = keyOf(from.environmentId, from.projectId);
  if (decision.kind === "move") {
    drafts.moveComposerText(from, target);
    if (drafts.composerHoldsText(target) !== true) {
      stuck.add(key);
      console.warn(
        `[pult-shell] the Star's draft in project ${from.projectId} holds what the composer cannot move into its conversation ${target.threadId}, left there.`,
      );
    }
    return;
  }
  if (told.has(key)) return;
  told.add(key);
  console.warn(
    `[pult-shell] the Star's draft in project ${from.projectId} holds unsent text, left there: its conversation ${target.threadId} holds some already.`,
  );
}

/** Starts carrying unsent text between the Stars' drafts and conversations, after the Stars' model, on the page's thread model. */
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
