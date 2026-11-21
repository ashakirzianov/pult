// Run with `node --test src/reader/render.test.ts`: the reader's frame in
// headless Chromium, on a page whose every request is recorded.
import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { chromium, type Browser, type Page } from "playwright";
import { build } from "vite";

const ORIGIN = "http://reader.test";
const LEAK = "http://leak.test";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Every way a page could run a script, load something or leave, each naming `leak.test` or pushing to the shell's `ran`. */
const HOSTILE = `<!doctype html>
<html onclick="top.ran.push('html')">
<head>
<base href="${LEAK}/base/">
<meta http-equiv="refresh" content="0; url=${LEAK}/refresh">
<link rel="stylesheet" href="${LEAK}/link.css">
<link rel="preload" as="image" href="${LEAK}/preload.png">
<link rel="icon" href="${LEAK}/icon.png">
<style>
@import url("${LEAK}/import.css");
@font-face { font-family: Leak; src: url("${LEAK}/font.woff2"); }
body { color: rgb(1, 2, 3); font-family: Leak; }
p { outline: 1px solid rgb(4, 5, 6); }
.remote { height: 10px; background-image: url("${LEAK}/background.png"); }
.inline { height: 10px; background-image: url("${PNG}"); }
</style>
<script>top.ran.push("script")</script>
<script src="${LEAK}/script.js"></script>
</head>
<body onload="top.ran.push('onload')">
<p id="styled">Styled</p>
<div class="remote"></div>
<div class="inline"></div>
<div style="height: 10px; background: url(${LEAK}/style-attribute.png)"></div>
<img id="inline" src="${PNG}">
<img src="${LEAK}/img.png" srcset="${LEAK}/srcset.png 2x">
<img src="x" onerror="top.ran.push('onerror')">
<img src=" &#10;ht&#9;tp://leak.test/spaced.png">
<picture><source srcset="${LEAK}/source.png"><img src="${PNG}"></picture>
<video poster="${LEAK}/poster.png" src="${LEAK}/video.mp4" autoplay></video>
<audio src="${LEAK}/audio.mp3" autoplay></audio>
<input type="image" src="${LEAK}/input.png">
<iframe src="${LEAK}/frame.html"></iframe>
<iframe srcdoc="<script>top.ran.push('srcdoc')</script>"></iframe>
<object data="${LEAK}/object"></object>
<embed src="${LEAK}/embed">
<svg width="100" height="40">
  <image href="${LEAK}/svg-image.png" width="10" height="10"/>
  <use href="${LEAK}/use.svg#x"/>
  <script>top.ran.push("svg")</script>
  <a xlink:href="${LEAK}/svg-link"><text id="svg-link" y="30">svg link</text></a>
</svg>
<svg width="100" height="40">
  <defs><a id="used-link" href="${LEAK}/used-link"><rect width="100" height="40"/></a></defs>
  <use id="use" href="#used-link"/>
</svg>
<a id="link" href="${LEAK}/link" ping="${LEAK}/ping">link</a>
<a id="javascript" href="javascript:top.ran.push('javascript')">javascript</a>
<form action="${LEAK}/form"><button id="submit">submit</button></form>
<template><img src="${LEAK}/template.png"></template>
</body>
</html>`;

/** What only the frame's policy stands between the page and a request for: CSS's own URLs. */
const REFUSED = ["import.css", "font.woff2", "background.png", "style-attribute.png"];

declare global {
  interface Window {
    ran: string[];
    reader: typeof import("./render.ts");
  }
}

async function bundle(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: import.meta.dirname,
    build: {
      write: false,
      minify: false,
      lib: {
        entry: NodePath.join(import.meta.dirname, "render.ts"),
        formats: ["iife"],
        name: "reader",
      },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("vite returned a watcher");
  return output.output[0].code;
}

NodeTest.describe("the reader's frame", () => {
  let browser: Browser;
  let page: Page;
  const requests: string[] = [];

  NodeTest.before(async () => {
    const script = await bundle();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/`)
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><p id="host">The shell</p><script>window.ran = [];</script><script src="/reader.js"></script>`,
        });
      if (url === `${ORIGIN}/reader.js`)
        return route.fulfill({ contentType: "text/javascript", body: script });
      requests.push(url);
      return route.abort();
    });
    await page.goto(`${ORIGIN}/`);
  });

  NodeTest.after(async () => {
    await browser?.close();
  });

  NodeTest.it(
    "shows the page's own CSS and inline images, and runs, loads and leaves nothing",
    async () => {
      const shown = await page.evaluate(async (source) => {
        const frame = window.reader.createReaderFrame();
        frame.element.id = "reader";
        document.body.append(frame.element);
        const result = (await frame.show(source))!;
        const doc = frame.element.contentDocument!;
        const refused: string[] = [];
        doc.addEventListener("securitypolicyviolation", (event) => refused.push(event.blockedURI));
        (window as unknown as { refused: string[] }).refused = refused;
        void doc.body.offsetHeight;
        const inline = doc.getElementById("inline") as HTMLImageElement;
        await inline.decode();
        return {
          scripts: result.scripts,
          inlineWidth: inline.naturalWidth,
          color: getComputedStyle(doc.getElementById("styled")!).color,
          hostColor: getComputedStyle(document.getElementById("host")!).color,
          hostOutline: getComputedStyle(document.getElementById("host")!).outlineColor,
        };
      }, HOSTILE);
      NodeAssert.equal(shown.scripts, true);
      NodeAssert.equal(shown.inlineWidth, 1);
      NodeAssert.equal(shown.color, "rgb(1, 2, 3)");
      NodeAssert.notEqual(shown.hostColor, "rgb(1, 2, 3)");
      NodeAssert.notEqual(shown.hostOutline, "rgb(4, 5, 6)");

      // CSS's own URLs reach the policy, which refuses them before any request.
      await page.waitForFunction(
        (names) =>
          names.every((name) =>
            (window as unknown as { refused: string[] }).refused.some((url) => url.endsWith(name)),
          ),
        REFUSED,
      );

      // The workbench takes a hidden pane out of the page; the frame the browser loads again is the same.
      await page.evaluate(async () => {
        const element = document.getElementById("reader")!;
        element.remove();
        const loaded = new Promise((resolve) =>
          element.addEventListener("load", resolve, { once: true }),
        );
        document.body.append(element);
        await loaded;
        await new Promise(requestAnimationFrame);
      });

      // The page's ways to leave, taken by a user.
      const frame = page.frameLocator("#reader");
      for (const selector of ["#link", "#javascript", "#svg-link", "#use", "#submit", "#styled"])
        await frame.locator(selector).click();

      // A request of the shell's own, seen last, shows every earlier one was seen.
      await page.evaluate(() => fetch("http://leak.test/control").catch(() => undefined));
      NodeAssert.deepEqual(requests, [`${LEAK}/control`]);
      NodeAssert.deepEqual(await page.evaluate(() => window.ran), []);
      NodeAssert.equal(
        await page.evaluate(
          () => (document.getElementById("reader") as HTMLIFrameElement).contentDocument?.URL,
        ),
        "about:srcdoc",
      );
    },
  );

  NodeTest.it("tells a page with scripts from one with data blocks", async () => {
    const scripts = await page.evaluate(
      async (sources) => {
        const frame = window.reader.createReaderFrame();
        document.body.append(frame.element);
        const results = [];
        for (const source of sources) results.push((await frame.show(source))!.scripts);
        frame.element.remove();
        return results;
      },
      [
        '<script type="text/livescript"></script>',
        '<script type="module"></script>',
        '<p onclick="x()">handler</p>',
        '<script type="application/ld+json">{}</script><script type="text/template"><b></b></script>',
      ],
    );
    NodeAssert.deepEqual(scripts, [true, true, true, false]);
  });

  NodeTest.it("cites a selection as it reads, under the source lines it came from", async () => {
    // Lines 2 and 6 say the same; line 9's text decodes an entity; line 11's is never rendered.
    const source = [
      "<!doctype html>",
      '<p id="a">Save the file</p>',
      '<p id="b">Then',
      "read it",
      "back</p>",
      '<p id="c">Save the file</p>',
      '<ul><li id="d">first</li>',
      '<li id="e">second</li></ul>',
      '<p><a id="f" href="#x">Save &amp;',
      "close</a></p>",
      "<style>p { margin: 0 }</style>",
      '<p id="g">after</p>',
    ].join("\n");
    const cited = await page.evaluate(async (source) => {
      const frame = window.reader.createReaderFrame();
      document.body.append(frame.element);
      await frame.show(source);
      const doc = frame.element.contentDocument!;
      const text = (id: string) => doc.getElementById(id)!.firstChild!;
      const select = (from: [string, number], to: [string, number]) => {
        const range = doc.createRange();
        range.setStart(text(from[0]), from[1]);
        range.setEnd(text(to[0]), to[1]);
        doc.getSelection()!.removeAllRanges();
        doc.getSelection()!.addRange(range);
        return frame.selection();
      };
      const passages = {
        repeated: select(["c", 0], ["c", 13]),
        withinParagraph: select(["b", 5], ["b", 9]),
        acrossBlocks: select(["b", 5], ["e", 3]),
        entity: select(["f", 0], ["f", 12]),
        afterEntity: select(["f", 7], ["f", 12]),
        untouchedEnd: select(["a", 0], ["b", 0]),
        unrendered: select(["f", 7], ["g", 0]),
        none: (doc.getSelection()!.removeAllRanges(), frame.selection()),
      };
      frame.element.remove();
      return passages;
    }, source);
    NodeAssert.deepEqual(cited, {
      repeated: { text: "Save the file", lines: { start: 6, end: 6 } },
      withinParagraph: { text: "read", lines: { start: 4, end: 4 } },
      acrossBlocks: {
        text: "read it back\n\nSave the file\n\nfirst\nsec",
        lines: { start: 4, end: 8 },
      },
      entity: { text: "Save & close", lines: { start: 9, end: 10 } },
      afterEntity: { text: "close", lines: { start: 9, end: 10 } },
      untouchedEnd: { text: "Save the file", lines: { start: 2, end: 2 } },
      unrendered: { text: "close", lines: { start: 9, end: 10 } },
      none: undefined,
    });
  });

  NodeTest.it("renders Markdown and cites it under the source lines it came from", async () => {
    // Lines 3 and 18 say the same; lines 13 to 16 are a fence; 19 and 20 raw HTML, 19 continuing 18; 22 to 26 math.
    const source = [
      "# Notes",
      "",
      "Save the file",
      "",
      "- first item",
      "  wraps here",
      "- a [**bold** link](https://leak.test/link) after",
      "",
      "| Key | Value |",
      "| --- | ----- |",
      "| `zq` | cell b |",
      "",
      "```mermaid",
      "graph TD",
      "  A --> B",
      "```",
      "",
      "Save the file",
      '<img src="https://leak.test/md.png"><script>top.ran.push("md")</script>',
      "<p>raw <b>html</b></p>",
      "",
      "Math $a_1 + b_1$ costs $5 or $10:",
      "",
      "$$",
      "x\\,dx",
      "$$",
    ].join("\n");
    const before = requests.length;
    const cited = await page.evaluate(async (source) => {
      const frame = window.reader.createReaderFrame();
      document.body.append(frame.element);
      const { scripts } = (await frame.show(source, { markdown: true }))!;
      const doc = frame.element.contentDocument!;
      /** The `nth` text node holding `text`, and where `text` starts in it. */
      const at = (text: string, nth = 0): [Text, number] => {
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const index = (node as Text).data.indexOf(text);
          if (index >= 0 && nth-- === 0) return [node as Text, index];
        }
        throw new Error(`no ${text}`);
      };
      const select = (from: string, to: string, nth: [number, number] = [0, 0]) => {
        const [start, startOffset] = at(from, nth[0]);
        const [end, endOffset] = at(to, nth[1]);
        const range = doc.createRange();
        range.setStart(start, startOffset);
        range.setEnd(end, endOffset + to.length);
        doc.getSelection()!.removeAllRanges();
        doc.getSelection()!.addRange(range);
        return frame.selection();
      };
      const passages = {
        heading: select("Notes", "Notes"),
        repeated: select("Save the file", "Save the file", [1, 1]),
        wrappedItem: select("wraps", "here"),
        formattedLink: select("bold", "link"),
        tableCell: select("cell b", "cell b"),
        inlineCode: select("zq", "zq"),
        fence: select("A --> B", "A --> B"),
        acrossBlocks: select("first", "Key"),
        rawHtml: select("html", "html"),
        inlineMath: select("a_1", "b_1"),
        displayMath: select("x\\,dx", "x\\,dx"),
      };
      frame.element.remove();
      return {
        scripts,
        tags: [...doc.body.children].map((element) => element.tagName.toLowerCase()),
        passages,
      };
    }, source);
    await page.evaluate(() => fetch("http://leak.test/control").catch(() => undefined));
    NodeAssert.deepEqual(requests.slice(before), [`${LEAK}/control`]);
    NodeAssert.deepEqual(await page.evaluate(() => window.ran), []);
    NodeAssert.equal(cited.scripts, true);
    NodeAssert.deepEqual(cited.tags, ["h1", "p", "ul", "table", "pre", "p", "p", "p", "pre"]);
    NodeAssert.deepEqual(cited.passages, {
      heading: { text: "Notes", lines: { start: 1, end: 1 } },
      repeated: { text: "Save the file", lines: { start: 18, end: 18 } },
      wrappedItem: { text: "wraps here", lines: { start: 6, end: 6 } },
      formattedLink: { text: "bold link", lines: { start: 7, end: 7 } },
      tableCell: { text: "cell b", lines: { start: 11, end: 11 } },
      inlineCode: { text: "zq", lines: { start: 11, end: 11 } },
      fence: { text: "A --> B", lines: { start: 15, end: 15 } },
      acrossBlocks: {
        text: "first item wraps here\na bold link after\nKey",
        lines: { start: 5, end: 9 },
      },
      rawHtml: { text: "html", lines: { start: 20, end: 20 } },
      inlineMath: { text: "a_1 + b_1", lines: { start: 22, end: 22 } },
      displayMath: { text: "x\\,dx", lines: { start: 25, end: 25 } },
    });
  });

  NodeTest.it(
    "follows edits, and a frame put back in the page, at the reader's scroll position",
    async () => {
      const page_ = (text: string) =>
        `<!doctype html><body style="margin: 0"><div style="height: 3000px">${text}</div></body>`;
      const after = await page.evaluate(
        async ([first, second]) => {
          const frame = window.reader.createReaderFrame();
          document.body.append(frame.element);
          const { scripts } = (await frame.show(first!))!;
          frame.element.contentDocument!.scrollingElement!.scrollTop = 500;
          await frame.show(second!);
          const edited = frame.element.contentDocument!;
          const inPlace = {
            text: edited.body.textContent,
            top: edited.scrollingElement!.scrollTop,
          };
          // The reader reads on, then the workbench takes the hidden pane out of the page, and the browser loads the frame anew when it is back.
          edited.scrollingElement!.scrollTop = 700;
          await new Promise(requestAnimationFrame);
          frame.element.remove();
          const reloaded = new Promise((resolve) =>
            frame.element.addEventListener("load", resolve, { once: true }),
          );
          document.body.append(frame.element);
          await reloaded;
          await new Promise(requestAnimationFrame);
          const back = frame.element.contentDocument!;
          return {
            scripts,
            inPlace,
            putBack: { text: back.body.textContent, top: back.scrollingElement!.scrollTop },
          };
        },
        [page_("before"), page_("after")],
      );
      NodeAssert.deepEqual(after, {
        scripts: false,
        inPlace: { text: "after", top: 500 },
        putBack: { text: "after", top: 700 },
      });
    },
  );
});
