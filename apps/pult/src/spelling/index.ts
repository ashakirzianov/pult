import {
  getService,
  ILanguageFeaturesService,
  IMarkerService,
  IModelService,
} from "@codingame/monaco-vscode-api";
import { DisposableStore } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { Range } from "@codingame/monaco-vscode-api/vscode/vs/editor/common/core/range";
import { StandardTokenType } from "@codingame/monaco-vscode-api/vscode/vs/editor/common/encodedTokenAttributes";
import type { TextModel } from "@codingame/monaco-vscode-api/vscode/vs/editor/common/model/textModel";
import {
  Action2,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import {
  type IMarkerData,
  MarkerSeverity,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/markers/common/markers";

import type { PultDesktop } from "../desktop/api.ts";
import { type SpellingWord, spellingWords } from "./words.ts";

const OWNER = "pult-spelling";
const LEARN_COMMAND = "pult-shell.learnSpelling";
/** The languages checked whole, a Markdown file's fenced blocks aside; every other language's comments alone. */
const PROSE = new Set(["markdown", "plaintext"]);
const FENCE = /^\s*(```|~~~)/;
/** How long an edit, or a model's tokens, settle before a file is checked again. */
const SETTLE_MS = 400;
/** Each new word's check is a synchronous call to the OS's checker (about 0.6ms), so a file's run yields this often. */
const SLICE_MS = 8;
const SUGGESTIONS = 5;

/**
 * Spell checking in the workbench's editors, in Pult.app alone: the OS's
 * checker, through Electron (`window.pultDesktop.spelling`), the one the
 * composer and every text field use, so a word learnt in either is known in
 * both. Each file open in an editor is checked a moment after it settles, a
 * misspelled word marked with an information squiggle whose quick fixes are
 * the checker's suggestions and Learn Spelling. Prose files are checked
 * whole, code files their comments only (`spellingWords` for the words).
 */
export async function startSpelling(spelling: PultDesktop["spelling"]): Promise<void> {
  const [models, markers, features] = await Promise.all([
    getService(IModelService),
    getService(IMarkerService),
    getService(ILanguageFeaturesService),
  ]);
  // Each word's answer, kept for the page's life: most words recur, and each first ask is the costly part.
  const known = new Map<string, boolean>();
  const misspelled = (word: string) => {
    let answer = known.get(word);
    if (answer === undefined) {
      answer = spelling.misspelled(word);
      known.set(word, answer);
    }
    return answer;
  };
  const schedules = new Map<TextModel, () => void>();
  // A file's latest run; an older one still yielding stops, so only the latest writes its markers.
  const runs = new Map<TextModel, number>();

  const check = async (model: TextModel) => {
    const run = (runs.get(model) ?? 0) + 1;
    runs.set(model, run);
    if (!model.isAttachedToEditor()) return markers.changeOne(OWNER, model.uri, []);
    const found: IMarkerData[] = [];
    let slice = performance.now();
    for (const { line, word } of candidates(model)) {
      if (!known.has(word.word) && performance.now() - slice > SLICE_MS) {
        await new Promise((resolve) => setTimeout(resolve));
        if (model.isDisposed() || runs.get(model) !== run) return;
        slice = performance.now();
      }
      if (!misspelled(word.word)) continue;
      found.push({
        severity: MarkerSeverity.Info,
        source: "Spelling",
        message: `Unknown word "${word.word}".`,
        startLineNumber: line,
        startColumn: word.start + 1,
        endLineNumber: line,
        endColumn: word.end + 1,
      });
    }
    markers.changeOne(OWNER, model.uri, found);
  };

  const watch = (model: TextModel) => {
    const store = new DisposableStore();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void check(model), SETTLE_MS);
    };
    store.add(model.onDidChangeContent(schedule));
    // Code files' comments are read from their tokens, which come in the background as a file opens.
    store.add(model.onDidChangeTokens(schedule));
    store.add(model.onDidChangeLanguage(schedule));
    store.add(model.onDidChangeAttached(schedule));
    store.add(
      model.onWillDispose(() => {
        clearTimeout(timer);
        store.dispose();
        schedules.delete(model);
        runs.delete(model);
        markers.changeOne(OWNER, model.uri, []);
      }),
    );
    schedules.set(model, schedule);
    schedule();
  };
  // The service's models are the editor's own `TextModel`s; its public type leaves out their tokens.
  for (const model of models.getModels()) watch(model as unknown as TextModel);
  models.onModelAdded((model) => watch(model as unknown as TextModel));

  features.codeActionProvider.register("*", {
    providedCodeActionKinds: ["quickfix"],
    provideCodeActions(model, range) {
      const actions = markers
        .read({ owner: OWNER, resource: model.uri })
        .filter((marker) => Range.areIntersectingOrTouching(marker, range))
        .flatMap((marker) => {
          const word = model.getValueInRange(marker);
          const replacements = spelling.suggestions(word).slice(0, SUGGESTIONS);
          return [
            ...replacements.map((suggestion, index) => ({
              title: suggestion,
              kind: "quickfix",
              diagnostics: [marker],
              isPreferred: index === 0,
              edit: {
                edits: [
                  {
                    resource: model.uri,
                    versionId: model.getVersionId(),
                    textEdit: { range: Range.lift(marker), text: suggestion },
                  },
                ],
              },
            })),
            {
              title: `Learn Spelling of "${word}"`,
              kind: "quickfix",
              diagnostics: [marker],
              command: { id: LEARN_COMMAND, title: "Learn Spelling", arguments: [word] },
            },
          ];
        });
      return { actions, dispose() {} };
    },
  });

  registerAction2(
    class extends Action2 {
      constructor() {
        super({ id: LEARN_COMMAND, title: "Learn Spelling", f1: false });
      }
      async run(_accessor: unknown, word: unknown) {
        if (typeof word !== "string") return;
        await spelling.learn(word);
        const learnt = word.toLowerCase();
        for (const each of known.keys()) if (each.toLowerCase() === learnt) known.delete(each);
        for (const schedule of schedules.values()) schedule();
      }
    },
  );
}

/** The words of `model` to check, line by line: none of a file too large to tokenize. */
function* candidates(model: TextModel): Generator<{ line: number; word: SpellingWord }> {
  if (model.isTooLargeForTokenization()) return;
  const language = model.getLanguageId();
  const prose = PROSE.has(language);
  let fenced = false;
  for (let line = 1; line <= model.getLineCount(); line++) {
    const text = model.getLineContent(line);
    let checkable: (readonly [number, number])[];
    if (prose) {
      if (language === "markdown" && FENCE.test(text)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      checkable = [[0, text.length]];
    } else {
      // A line not yet tokenized is read once its tokens come (`onDidChangeTokens`).
      if (!model.tokenization.hasAccurateTokensForLine(line)) continue;
      const tokens = model.tokenization.getLineTokens(line);
      checkable = [];
      for (let index = 0; index < tokens.getCount(); index++) {
        if (tokens.getStandardTokenType(index) === StandardTokenType.Comment)
          checkable.push([tokens.getStartOffset(index), tokens.getEndOffset(index)]);
      }
    }
    for (const word of spellingWords(text, checkable)) yield { line, word };
  }
}
