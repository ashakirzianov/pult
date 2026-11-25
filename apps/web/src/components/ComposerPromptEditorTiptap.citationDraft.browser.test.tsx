import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { createRef, useState } from "react";
import { expect, it } from "vite-plus/test";

import { page, userEvent } from "vite-plus/test/browser";

import { findAssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { act, render } from "../../test/render";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};
const promptBefore = `See ${serializeAssistantCitation(citation)} `;

function Composer({
  question,
  editorRef,
  initialPrompt = promptBefore,
}: {
  question: boolean;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  initialPrompt?: string;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [answer, setAnswer] = useState("");
  return (
    <>
      <div data-assistant-citation-viewport="">
        <p
          data-assistant-citation-source={citation.messageId}
          data-assistant-citation-environment={citation.environmentId}
          data-assistant-citation-thread={citation.threadId}
        >
          hello world
        </p>
      </div>
      <output data-prompt={prompt} data-answer={answer} />
      <ComposerPromptEditor
        editorRef={editorRef}
        value={question ? answer : prompt}
        cursor={0}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={(next) => (question ? setAnswer(next) : setPrompt(next))}
        onCitationDraftSave={(replacedValue, savedValue) => {
          if (replacedValue === prompt) setPrompt(savedValue);
        }}
        onPaste={() => {}}
      />
    </>
  );
}

it("keeps a citation comment when a question takes the composer", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);
  const drafts = () => screen.container.querySelector("output")?.dataset;

  const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
  if (!sourceAnchor) throw new Error("Citation source did not resolve");
  await act(async () =>
    editorRef.current?.requestCitationComment({
      previousValue: "See ",
      value: promptBefore,
      citationStart: "See ".length,
      sourceAnchor,
      insertedSpaces: { before: false, after: true },
    }),
  );
  const comment = page.getByLabelText("Comment on the quoted text");
  await expect.element(comment).toHaveFocus();
  await userEvent.keyboard("check this");

  await screen.rerender(<Composer question editorRef={editorRef} />);
  await expect.element(comment).not.toBeInTheDocument();
  expect(drafts()?.answer).toBe("");
  await screen.rerender(<Composer question={false} editorRef={editorRef} />);

  expect(drafts()?.prompt).toBe(
    `See ${serializeAssistantCitation(withAssistantCitationComment(citation, "check this"))} `,
  );
  await expect.element(comment).toHaveValue("check this");
});

// Pult: the composer's reading-position probe lands on our citation block's comment, a textarea with no text node.
it("types into a citation's comment in a scrolled composer without a page error", async () => {
  const errors: unknown[] = [];
  const onError = (event: ErrorEvent) => errors.push(event.error);
  window.addEventListener("error", onError);
  try {
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const longPrompt = `${lines}\n${promptBefore}\n${lines}`;
    await using _screen = await render(
      <Composer question={false} editorRef={editorRef} initialPrompt={longPrompt} />,
    );

    const comment = page.getByLabelText("Comment on the quoted text");
    await expect.element(comment).toBeVisible();
    // Scrolled so the comment sits under the probe's first point, near the scroller's top.
    const scroller = page.getByTestId("composer-editor").element() as HTMLElement;
    // The app's stylesheet caps the composer's height; the tests load none.
    scroller.style.maxHeight = "120px";
    scroller.style.overflowY = "auto";
    const commentTop =
      comment.element().getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += commentTop - 16;
    expect(scroller.scrollTop).toBeGreaterThan(0);
    await comment.click();
    await userEvent.keyboard("check this");

    await expect.element(comment).toHaveValue("check this");
    expect(errors).toEqual([]);
  } finally {
    window.removeEventListener("error", onError);
  }
});

// Pult: Enter out of a citation's comment goes to the next line when one is there; when that line opens with a citation, to the bar between the two.
it("adds no line on Enter out of a comment when a citation follows", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const commented = (comment: string) =>
    serializeAssistantCitation(withAssistantCitationComment(citation, comment));
  const twoCitations = `${commented("one")}\n${commented("two")}`;
  await using screen = await render(
    <Composer question={false} editorRef={editorRef} initialPrompt={twoCitations} />,
  );
  const drafts = () => screen.container.querySelector("output")?.dataset;

  const first = page.getByLabelText("Comment on the quoted text").first();
  await first.click();
  await expect.element(first).toHaveFocus();
  await userEvent.keyboard("{Enter}");

  await expect.element(first).not.toHaveFocus();
  expect(drafts()?.prompt).toBe(twoCitations);
});
