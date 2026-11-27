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
    // The chat's highlighter, which colours a Markdown file's code, is `apps/web`'s.
    resolve: { alias: { "~": NodePath.join(import.meta.dirname, "../../../web/src") } },
    // A library build leaves this to its user; the modules the highlighter brings read it.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
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
    // A `-time` frontmatter value reads in the machine's zone.
    page = await browser.newPage({ timezoneId: "America/Argentina/Buenos_Aires" });
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/`)
        return route.fulfill({
          contentType: "text/html",
          // The thread view's stylesheet, as far as a Markdown file reads it.
          body: `<!doctype html><style>.chat-markdown p { word-spacing: 3px; } .chat-content-lane { max-width: 300px; }</style><p id="host">The shell</p><script>window.ran = [];</script><script src="/reader.js"></script>`,
        });
      if (url === `${ORIGIN}/reader.js`)
        return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
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

  NodeTest.it(
    "shows an image a file path names as the shell reads it, and says why it does not another",
    async () => {
      const before = requests.length;
      const shown = await page.evaluate(
        async ({ png, leak }) => {
          const frame = window.reader.createReaderFrame();
          document.body.append(frame.element);
          const read: string[] = [];
          const readImage = async (path: string) => {
            read.push(path);
            return path === "mocks/mock.png" ? { url: png } : { refused: "outside the projects" };
          };
          const unshown = (doc: Document) =>
            [...doc.querySelectorAll(".pult-reader-unshown-image")].map((node) => node.textContent);
          await frame.show(
            [
              `<img id="file" src=" mocks/mock.png" alt="the mock">`,
              `<img src="${leak}/web.png" alt="from far">`,
              `<img src="/elsewhere/far.png" alt="far">`,
              `<img src="ftp://host/y.png">`,
            ].join(""),
            { readImage },
          );
          const page = frame.element.contentDocument!;
          const file = page.getElementById("file") as HTMLImageElement;
          await file.decode();
          const html = { width: file.naturalWidth, alt: file.alt, unshown: unshown(page) };
          await frame.show(`![md mock](mocks/mock.png) and ![](${leak}/md.png)`, {
            markdown: true,
            readImage,
          });
          const markdown = frame.element.contentDocument!;
          const image = markdown.querySelector("img")!;
          await image.decode();
          const result = {
            html,
            markdown: { width: image.naturalWidth, unshown: unshown(markdown) },
            read,
          };
          frame.element.remove();
          return result;
        },
        { png: PNG, leak: LEAK },
      );
      await page.evaluate(() => fetch("http://leak.test/control").catch(() => undefined));
      NodeAssert.deepEqual(requests.slice(before), [`${LEAK}/control`]);
      NodeAssert.deepEqual(shown, {
        html: {
          width: 1,
          alt: "the mock",
          unshown: [
            "from far not shown · from the web",
            "far not shown · outside the projects",
            "ftp://host/y.png not shown · not a file",
          ],
        },
        markdown: { width: 1, unshown: [`${LEAK}/md.png not shown · from the web`] },
        read: ["mocks/mock.png", "/elsewhere/far.png", "mocks/mock.png"],
      });
    },
  );

  NodeTest.it(
    "draws a Markdown file's inline code as a file chip where the shell says, and cites it as the code",
    async () => {
      const before = requests.length;
      const shown = await page.evaluate(async () => {
        const frame = window.reader.createReaderFrame();
        document.body.append(frame.element);
        const asked: string[][] = [];
        const chips = (codes: ReadonlyArray<string>) => {
          asked.push([...codes]);
          const markup = `<a href="#" class="chip" onclick="top.ran.push('chip')"><svg viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg><span data-slot="context-chip-label">a.ts · L3</span></a>`;
          return {
            codes: new Map([["src/a.ts:3", { markup, file: "src/a.ts:3" }]]),
            refs: new Map(),
          };
        };
        const source = [
          "# Paths",
          "",
          "See `src/a.ts:3`, `src/b.ts` and <code>src/a.ts:3</code>.",
        ].join("\n");
        await frame.show(source, { markdown: true, chips });
        const doc = frame.element.contentDocument!;
        const chip = doc.querySelector<HTMLElement>("[data-pult-file]")!;
        const range = doc.createRange();
        range.selectNodeContents(chip.querySelector('[data-slot="context-chip-label"]')!);
        doc.getSelection()!.removeAllRanges();
        doc.getSelection()!.addRange(range);
        const markdown = {
          asked,
          file: chip.getAttribute("data-pult-file"),
          label: chip.textContent,
          icon: chip.querySelector("svg path") !== null,
          code: [...doc.querySelectorAll("code")].map((code) => code.textContent),
          cited: frame.selection(),
        };
        // An HTML page's code is never asked, and a page names no file for the pane to open.
        await frame.show(
          '<p><code>src/a.ts:3</code> <a href="#top" data-pult-file="src/a.ts">a</a></p>',
          { chips },
        );
        const result = {
          ...markdown,
          htmlCode: doc.querySelector("code")?.textContent,
          htmlChips: doc.querySelectorAll("[data-pult-file]").length,
        };
        frame.element.remove();
        return result;
      });
      await page.evaluate(() => fetch("http://leak.test/control").catch(() => undefined));
      NodeAssert.deepEqual(requests.slice(before), [`${LEAK}/control`]);
      NodeAssert.deepEqual(await page.evaluate(() => window.ran), []);
      NodeAssert.deepEqual(shown, {
        asked: [["src/a.ts:3", "src/b.ts"]],
        file: "src/a.ts:3",
        label: "a.ts · L3",
        icon: true,
        code: ["src/b.ts", "src/a.ts:3"],
        cited: { text: "a.ts · L3", lines: { start: 3, end: 3 } },
        htmlCode: "src/a.ts:3",
        htmlChips: 0,
      });
    },
  );

  NodeTest.it(
    "opens a shown image on a plain click, with the page's others, but not a linked or refused one, nor over a selection",
    async () => {
      const before = requests.length;
      await page.evaluate(
        async ({ png, leak }) => {
          const opened: unknown[] = [];
          (window as unknown as { opened: unknown[] }).opened = opened;
          const frame = window.reader.createReaderFrame({
            onDocument: (doc) =>
              window.reader.followImageClicks(doc, (images, index) =>
                opened.push({
                  images: images.map(({ src, name }) => [name, src === png]),
                  index,
                }),
              ),
          });
          frame.element.id = "images";
          frame.element.style.cssText = "width: 600px; height: 400px";
          document.body.append(frame.element);
          await frame.show(
            [
              `Some text before ![first](${png}) and after.`,
              "",
              `[![linked](${png})](#top)`,
              "",
              `![second](${png}) ![](${leak}/refused.png) <img alt="written" src=" DATA:${png.slice(5)}">`,
            ].join("\n"),
            { markdown: true },
          );
          // A 1-pixel image is too small to take a click.
          for (const image of frame.element.contentDocument!.images)
            image.style.cssText = "width: 40px; height: 40px";
        },
        { png: PNG, leak: LEAK },
      );
      const frame = page.frameLocator("#images");
      const opened = () => page.evaluate(() => (window as unknown as { opened: unknown[] }).opened);
      const collapsed = () =>
        frame
          .locator("p")
          .first()
          .evaluate((p) => p.ownerDocument.getSelection()!.isCollapsed);
      const cursor = (selector: string) =>
        frame.locator(selector).evaluate((node) => getComputedStyle(node).cursor);
      NodeAssert.deepEqual(
        [await cursor('img[alt="first"]'), await cursor('img[alt="linked"]')],
        ["zoom-in", "pointer"],
      );

      await frame.locator('img[alt="second"]').click();
      await frame.locator('img[alt="linked"]').click();
      await frame.locator(".pult-reader-unshown-image").click();
      NodeAssert.deepEqual(await opened(), [
        {
          images: [
            ["first", true],
            ["second", true],
            ["written", true],
          ],
          index: 1,
        },
      ]);

      // A `src` written in another case or spaced, which the page shows, opens too.
      await frame.locator('img[alt="written"]').click();
      NodeAssert.equal(((await opened()) as Array<{ index: number }>)[1]?.index, 2);

      // A click with a selection standing is the selection's, which it leaves standing; once it is gone, a click opens.
      await frame
        .locator("p")
        .first()
        .evaluate((paragraph) => {
          const range = paragraph.ownerDocument.createRange();
          range.selectNodeContents(paragraph.firstChild!);
          paragraph.ownerDocument.getSelection()!.removeAllRanges();
          paragraph.ownerDocument.getSelection()!.addRange(range);
        });
      await frame.locator('img[alt="first"]').click();
      NodeAssert.equal((await opened()).length, 2);
      NodeAssert.equal(await collapsed(), false);
      await frame
        .locator("p")
        .first()
        .click({ position: { x: 2, y: 5 } });
      NodeAssert.equal(await collapsed(), true);
      await frame.locator('img[alt="first"]').click();
      NodeAssert.equal((await opened()).length, 3);

      // A drag selecting text that ends on an image.
      const text = await page.evaluate(() => {
        const element = document.getElementById("images") as HTMLIFrameElement;
        const range = element.contentDocument!.createRange();
        range.selectNodeContents(element.contentDocument!.querySelector("p")!.firstChild!);
        const [frameBox, textBox] = [
          element.getBoundingClientRect(),
          range.getBoundingClientRect(),
        ];
        return {
          x: frameBox.left + textBox.left,
          y: frameBox.top + textBox.top,
          height: textBox.height,
        };
      });
      const image = (await frame.locator('img[alt="first"]').boundingBox())!;
      // Playwright's own drag waits on a script in every frame, which this one runs none of.
      const input = await page.context().newCDPSession(page);
      const mouse = (
        type: "mousePressed" | "mouseMoved" | "mouseReleased",
        x: number,
        y: number,
        buttons: number,
      ) =>
        input.send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          buttons,
          clickCount: 1,
        });
      await mouse("mousePressed", text.x + 2, text.y + text.height / 2, 1);
      for (const step of [0.25, 0.5, 0.75, 1])
        await mouse(
          "mouseMoved",
          text.x + 2 + (image.x + image.width / 2 - text.x - 2) * step,
          text.y + text.height / 2 + (image.y + image.height / 2 - text.y - text.height / 2) * step,
          1,
        );
      await mouse("mouseReleased", image.x + image.width / 2, image.y + image.height / 2, 0);
      await input.detach();
      NodeAssert.equal((await opened()).length, 3);
      NodeAssert.equal(await collapsed(), false);

      await page.evaluate(() => document.getElementById("images")!.remove());
      await page.evaluate(() => fetch("http://leak.test/control").catch(() => undefined));
      NodeAssert.deepEqual(requests.slice(before), [`${LEAK}/control`]);
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
    // Lines 3 and 18 say the same; lines 13 to 16 are a fence; 19 and 20 raw HTML, 19 continuing 18; 22 to 26 math; 28 on a nested list, raw HTML in quotes, indented code, then
    // code coloured by its language, code in one the highlighter lacks and math KaTeX refuses.
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
      "",
      "- parent",
      "  - child",
      "",
      "> > <div>",
      "> > one",
      "> > two",
      "> > three",
      "> > </div>",
      "",
      "    first",
      "    second",
      "",
      "```ts",
      "const total = 1;",
      "export { total };",
      "```",
      "",
      "```nolang",
      "plain words",
      "```",
      "",
      "$$",
      "\\frac{",
      "$$",
    ].join("\n");
    const before = requests.length;
    const cited = await page.evaluate(async (source) => {
      const frame = window.reader.createReaderFrame();
      // As the shell's stylesheet has it, for a page's sake.
      frame.element.style.colorScheme = "normal";
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
      /** The contents of the first element matching `selector`, as a reader selects all of it. */
      const selectAll = (selector: string) => {
        const range = doc.createRange();
        range.selectNodeContents(doc.querySelector(selector)!);
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
        fence: select("A", "B"),
        acrossBlocks: select("first", "Key"),
        rawHtml: select("html", "html"),
        // Typeset math reads as KaTeX's glyphs, cited under its TeX's lines.
        inlineMath: selectAll(".katex")?.lines,
        displayMath: selectAll(".math-display")?.lines,
        nestedParent: select("parent", "parent"),
        nestedBoth: select("parent", "child"),
        quotedRawHtml: select("three", "three"),
        indentedCode: select("second", "second"),
        colouredLine: select("export", "total", [0, 1]),
        acrossColouredLines: select("total", "export", [0, 0]),
        uncolouredCode: select("plain words", "plain words"),
        refusedMath: select("\\frac{", "\\frac{"),
      };
      /** A code block's coloured runs, and its child nodes. */
      const runs = (selector: string) => {
        const code = doc.querySelector(selector)!;
        return {
          coloured: code.querySelectorAll("span[style]").length,
          nodes: code.childNodes.length,
        };
      };
      // The code's colours follow the shell's colour scheme.
      const keyword = () =>
        frame.element
          .contentDocument!.querySelector("code.language-ts span")!
          .getAttribute("style");
      const light = keyword();
      document.documentElement.style.colorScheme = "dark";
      await frame.show(source, { markdown: true });
      const dark = keyword();
      document.documentElement.style.colorScheme = "";
      const thread = {
        wordSpacing: getComputedStyle(doc.querySelector(".chat-markdown p")!).wordSpacing,
        laneWidth: getComputedStyle(doc.querySelector(".chat-content-lane")!).maxWidth,
      };
      frame.element.remove();
      // The thread's markup for an ordered list's gutter and for code, which a formula's block is not.
      const blocks = window.reader.createReaderFrame();
      document.body.append(blocks.element);
      await blocks.show("100. hundred\n\n```ts\nconst x = 1;\n```\n\n$$\nx\n$$\n", {
        markdown: true,
        wrapCode: true,
      });
      const blocksDoc = blocks.element.contentDocument!;
      const marked = {
        gutter: blocksDoc.querySelector<HTMLElement>("ol")!.style.getPropertyValue("--list-gutter"),
        codeWrap: blocksDoc.querySelector(".chat-markdown-codeblock")!.getAttribute("data-wrap"),
        boxes: blocksDoc.querySelectorAll(".chat-markdown-codeblock").length,
        formulaInBox:
          blocksDoc.querySelector(".math-display")!.closest(".chat-markdown-codeblock") !== null,
      };
      blocks.element.remove();
      return {
        scripts,
        marked,
        thread,
        schemes: light === dark ? [light] : [],
        coloured: runs("code.language-ts"),
        uncoloured: runs("code.language-nolang"),
        // A table and a code block each in the thread's box for one.
        tags: [...doc.querySelector(".chat-markdown")!.children].map((element) =>
          (element.querySelector(":scope > table, :scope > pre") ?? element).tagName.toLowerCase(),
        ),
        passages,
      };
    }, source);
    await page.evaluate(() => fetch("http://leak.test/control").catch(() => undefined));
    NodeAssert.deepEqual(requests.slice(before), [`${LEAK}/control`]);
    NodeAssert.deepEqual(await page.evaluate(() => window.ran), []);
    NodeAssert.equal(cited.scripts, true);
    NodeAssert.deepEqual(cited.thread, { wordSpacing: "3px", laneWidth: "300px" });
    NodeAssert.deepEqual(cited.marked, {
      gutter: "5ch",
      codeWrap: "true",
      boxes: 1,
      formulaInBox: false,
    });
    NodeAssert.deepEqual(cited.tags, [
      "h1",
      "p",
      "ul",
      "table",
      "pre",
      "p",
      "p",
      "p",
      "div",
      "ul",
      "blockquote",
      "pre",
      "pre",
      "pre",
      "pre",
    ]);
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
      inlineMath: { start: 22, end: 22 },
      displayMath: { start: 25, end: 25 },
      nestedParent: { text: "parent", lines: { start: 28, end: 28 } },
      nestedBoth: { text: "parent\nchild", lines: { start: 28, end: 29 } },
      quotedRawHtml: { text: "three", lines: { start: 34, end: 34 } },
      indentedCode: { text: "second", lines: { start: 38, end: 38 } },
      colouredLine: { text: "export { total", lines: { start: 42, end: 42 } },
      acrossColouredLines: { text: "total = 1;\nexport", lines: { start: 41, end: 42 } },
      uncolouredCode: { text: "plain words", lines: { start: 46, end: 46 } },
      refusedMath: { text: "\\frac{", lines: { start: 50, end: 50 } },
    });
    NodeAssert.ok(cited.coloured.coloured > 4);
    NodeAssert.deepEqual(cited.schemes, []);
    NodeAssert.deepEqual(cited.uncoloured, { coloured: 0, nodes: 1 });
  });

  NodeTest.it(
    "lays out YAML frontmatter as the monore front draws properties, cites each row's lines, and keeps the body on its own",
    async () => {
      const result = await page.evaluate(async () => {
        const frame = window.reader.createReaderFrame();
        document.body.append(frame.element);
        const source = [
          "---",
          'title: "<script>Safe text</script>"',
          "settings:",
          "  tags: [one, two]",
          "id: 9007199254740993",
          'summary: "a\\nb',
          '  c"',
          `long: ${"a value too long for the line ".repeat(12)}`,
          "opened-date: 2026-11-25",
          "closed-date: someday",
          "updated-time: 2026-11-25T13:04:05.000Z",
          "done-flag: true",
          "count-number: 3",
          "extra-json: {a: 1, b: [2]}",
          "blocked-by-ref-list: [../a.task, design.md]",
          "design-ref: ./design.md",
          "tag-list: [small, in-the-loop]",
          "monore-title: Hello",
          "date: 2026-01-02",
          "empty:",
          "none-ref-list: []",
          "---",
          "# Document",
          "",
          // Raw HTML in the body names no frontmatter ref.
          '<span data-pult-ref="">../b.task</span>',
        ].join("\n");
        const asked: string[][] = [];
        // The shell draws `../a.task` alone; `design.md` resolves to nothing, or is not yet decided.
        const chips = (codes: ReadonlyArray<string>, refs: ReadonlyArray<string>) => {
          asked.push([...codes], [...refs]);
          const markup = `<a href="#"><span data-slot="context-chip-label">a.task</span></a>`;
          return {
            codes: new Map(),
            refs: new Map([["../a.task", { markup, file: "/x/a.task/bundle.md" }]]),
          };
        };
        const { scripts } = (await frame.show(source, { markdown: true, chips }))!;
        const doc = frame.element.contentDocument!;
        const meta = doc.querySelector(".pult-reader-frontmatter")!;
        const rows = [...meta.querySelectorAll(":scope > dl > div")];
        const select = (from: [Node, number], to: [Node, number]) => {
          const range = doc.createRange();
          range.setStart(...from);
          range.setEnd(...to);
          doc.getSelection()!.removeAllRanges();
          doc.getSelection()!.addRange(range);
          return frame.selection();
        };
        const whole = (node: Node) => select([node, 0], [node, node.childNodes.length]);
        const textOf = (node: Element) => node.lastChild as Text;
        const box = (node: Element) => node.getBoundingClientRect();
        const [titleEntry, , , , longEntry] = rows;
        const label = (row: number) => textOf(rows[row]!.querySelector("dt")!);
        const date = rows[5]!.querySelector(".pult-reader-date")!;
        const chip = rows[11]!.querySelector("[data-pult-file]")!;
        const chipLabel = chip.querySelector('[data-slot="context-chip-label"]')!.firstChild!;
        const json = rows[10]!.querySelector("details")!;
        const rendered = {
          scripts,
          asked,
          // Each entry one line, its label and then its value; a long value wraps beside its label.
          titleOnOneLine: box(titleEntry!.children[0]!).top === box(titleEntry!.children[1]!).top,
          longBesideKey:
            box(longEntry!.children[1]!).left > box(longEntry!.children[0]!).right &&
            box(longEntry!.children[1]!).height > 2 * box(longEntry!.children[0]!).height,
          labels: rows.map((row) => row.querySelector(":scope > dt")!.textContent),
          keys: rows.map((row) => row.getAttribute("title")),
          // Each row's glyph, and a list's badge, by the start of their strokes.
          icons: rows.map((row) => {
            const [glyph, badge] = row.querySelectorAll(":scope > dt > svg path");
            return [glyph?.getAttribute("d")?.slice(0, 8), badge?.getAttribute("d")?.slice(0, 8)];
          }),
          masked:
            rows[11]!.querySelector("svg path")!.getAttribute("mask") ===
            `url(#${rows[11]!.querySelector("svg mask")!.id})`,
          values: rows.map((row) => row.querySelector(":scope > dd")!.textContent),
          nested: [...meta.querySelectorAll("dd > dl dd > ul > li")].map(
            (item) => item.textContent,
          ),
          dayOnHover: date.getAttribute("title"),
          pills: [...rows[13]!.querySelectorAll(".pult-reader-pill")].map(
            (pill) => pill.textContent,
          ),
          chipFile: chip.getAttribute("data-pult-file"),
          unresolved: [...meta.querySelectorAll("[data-pult-ref]")].map((ref) => ref.textContent),
          json: {
            open: json.open,
            summary: json.querySelector("summary")!.textContent,
            text: json.querySelector("pre")!.textContent,
          },
          title: whole(meta.querySelector("dd")!),
          summary: select(
            [meta.querySelectorAll(":scope > dl > div > dd")[3]!.firstChild!, 2],
            [meta.querySelectorAll(":scope > dl > div > dd")[3]!.firstChild!, 3],
          ),
          // A row whole; from inside a label into its date; from a date into a chip; a chip, a label and a time alone.
          row: whole(rows[5]!)?.lines,
          labelToDate: select([label(5), 2], [date.firstChild!, 4])?.lines,
          dateToChip: select([date.firstChild!, 3], [chipLabel, 2])?.lines,
          chip: whole(chipLabel.parentNode!),
          label: select([label(11), 0], [label(11), 7]),
          time: select(
            [rows[7]!.querySelector(".pult-reader-time")!.firstChild!, 11],
            [rows[7]!.querySelector(".pult-reader-time")!.firstChild!, 16],
          ),
          heading: whole(doc.querySelector("h1")!),
        };
        frame.element.remove();
        return rendered;
      });
      const [string, json, day, time, flag, number, ref, list] = [
        "M3 3h10 ",
        "M6 2.5H5",
        "M2.5 4h1",
        "M8 2.5a5",
        "M3 3h10v",
        "M6 2v12 ",
        "M9 3h4v4",
        "M5.5 4h8",
      ] as const;
      NodeAssert.deepEqual(result, {
        scripts: false,
        asked: [[], ["../a.task", "design.md", "./design.md"]],
        titleOnOneLine: true,
        longBesideKey: true,
        labels: [
          "Title",
          "Settings",
          "Id",
          "Summary",
          "Long",
          "Opened",
          "Closed",
          "Updated",
          "Done",
          "Count",
          "Extra",
          "Blocked By",
          "Design",
          "Tag",
          "Title",
          "Date",
          "Empty",
          "None",
        ],
        keys: [
          "title",
          "settings",
          "id",
          "summary",
          "long",
          "opened-date",
          "closed-date",
          "updated-time",
          "done-flag",
          "count-number",
          "extra-json",
          "blocked-by-ref-list",
          "design-ref",
          "tag-list",
          "monore-title",
          "date",
          "empty",
          "none-ref-list",
        ],
        icons: [
          [string, undefined],
          // A mapping and an integer under an untyped key read as JSON, as the front draws them; a date that is no day as a string.
          [json, undefined],
          [json, undefined],
          [string, undefined],
          [string, undefined],
          [day, undefined],
          [string, undefined],
          [time, undefined],
          [flag, undefined],
          [number, undefined],
          [json, undefined],
          [list, "M1.5 7.5"],
          [ref, undefined],
          [list, "M1.5 1.5"],
          [string, undefined],
          [day, undefined],
          [string, undefined],
          [list, "M1.5 7.5"],
        ],
        masked: true,
        values: [
          "<script>Safe text</script>",
          "tagsonetwo",
          "9007199254740993",
          "a\nb c",
          "a value too long for the line ".repeat(12).trim(),
          "25 Nov 2026",
          "someday",
          "2026-11-25 10:04:05",
          "true",
          "3",
          'json{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
          "a.taskdesign.md",
          "./design.md",
          "smallin-the-loop",
          "Hello",
          "2 Jan 2026",
          "null",
          "",
        ],
        nested: ["one", "two"],
        dayOnHover: "2026-11-25",
        pills: ["small", "in-the-loop"],
        chipFile: "/x/a.task/bundle.md",
        unresolved: ["design.md", "./design.md"],
        json: { open: false, summary: "json", text: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}' },
        title: { text: "<script>Safe text</script>", lines: { start: 2, end: 2 } },
        summary: { text: "b", lines: { start: 6, end: 7 } },
        row: { start: 9, end: 9 },
        labelToDate: { start: 9, end: 9 },
        dateToChip: { start: 9, end: 15 },
        chip: { text: "a.task", lines: { start: 15, end: 15 } },
        label: { text: "Blocked", lines: { start: 15, end: 15 } },
        time: { text: "10:04", lines: { start: 11, end: 11 } },
        heading: { text: "Document", lines: { start: 23, end: 23 } },
      });
    },
  );

  NodeTest.it(
    "joins a frontmatter ref to its document's folder, from the monore root in the kept checkout",
    async () => {
      const { frontmatterRefPath } = await import("./frontmatter.ts");
      const task = "/Users/a/.pult/monore/ann/pult/tasks/x.task/bundle.md";
      const ref = (path: string, document = task) =>
        frontmatterRefPath(path, document, "/Users/a/.pult/monore");
      const design = {
        named: "/ann/pult/tasks/x.task/design.md",
        file: "/ann/pult/tasks/x.task/design.md",
      };
      NodeAssert.deepEqual(
        {
          bare: ref("design.md"),
          dot: ref("./design.md"),
          up: ref("../y.task"),
          root: ref("/ann/pult/decisions/a.md"),
          outside: ref("../b.md", "/repo/docs/a.md"),
          invalid: ["", "a:3", "a/", "a//b.md", "~/a.md", "/a/../b.md", "../../../../../b.md"].map(
            (path) => ref(path),
          ),
        },
        {
          bare: design,
          dot: design,
          up: { named: "/ann/pult/tasks/y.task", file: "/ann/pult/tasks/y.task/bundle.md" },
          root: { named: "/ann/pult/decisions/a.md", file: "/ann/pult/decisions/a.md" },
          outside: { named: "/repo/b.md", file: "/repo/b.md" },
          invalid: [undefined, undefined, undefined, undefined, undefined, undefined, undefined],
        },
      );
    },
  );

  NodeTest.it(
    "follows edits, and a frame put back in the page, at the reader's scroll position, its scrollbar shown while it scrolls",
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
          const scrolling = () => edited.body.hasAttribute("data-pult-scrolling");
          const scrollbar = { scrolling: scrolling(), still: false };
          await new Promise((resolve) =>
            new MutationObserver(resolve).observe(edited.body, {
              attributeFilter: ["data-pult-scrolling"],
            }),
          );
          scrollbar.still = !scrolling();
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
            scrollbar,
            putBack: { text: back.body.textContent, top: back.scrollingElement!.scrollTop },
          };
        },
        [page_("before"), page_("after")],
      );
      NodeAssert.deepEqual(after, {
        scripts: false,
        inPlace: { text: "after", top: 500 },
        scrollbar: { scrolling: true, still: true },
        putBack: { text: "after", top: 700 },
      });
    },
  );
  NodeTest.it("finds the page's text, highlights it and steps through it, wrapping", async () => {
    const page_ = (extra: string) =>
      `<!doctype html><body style="margin: 0"><p>Alpha <b>be</b>ta gamma</p><p style="display: none">alpha beta hidden</p><p style="visibility: hidden">alpha beta unseen</p><p>end</p><p>start</p><p style="margin-top: 3000px">ALPHA&nbsp; beta</p>${extra}</body>`;
    const found = await page.evaluate(
      async ([first, second]) => {
        const frame = window.reader.createReaderFrame();
        document.body.append(frame.element);
        await frame.show(first!);
        const doc = frame.element.contentDocument!;
        const view = doc.defaultView!;
        const markup = doc.body.innerHTML;
        const colors = { match: "rgb(1, 2, 3)", current: "rgb(4, 5, 6)" };
        const find = (query: string, reveal = true) => frame.find(query, { colors, reveal });
        const highlighted = () => ({
          all: [...(view.CSS.highlights.get("pult-find") ?? [])].map(String),
          current: [...(view.CSS.highlights.get("pult-find-current") ?? [])].map(String),
        });
        const top = () => doc.scrollingElement!.scrollTop;
        const result = {
          first: find("alpha  BETA"),
          highlighted: highlighted(),
          sheet: doc.adoptedStyleSheets
            .flatMap((sheet) => [...sheet.cssRules])
            .map((rule) => rule.cssText),
          acrossBlocks: [find("end start").count, find("endstart").count],
          next: (find("alpha beta"), frame.findStep(1)),
          scrolled: top() > 0,
          wrapped: frame.findStep(1),
          back: [frame.findStep(-1), top() > 0],
          // The highlights leave the page's DOM, which the citations read, as it was.
          untouched: doc.body.innerHTML === markup,
          // The file changes while the bar is open: the pane finds again, staying where the reader is.
          rendered: await frame.show(second!).then(() => find("alpha beta", false)),
          selection: (() => {
            frame.clearFind();
            doc.scrollingElement!.scrollTop = 0;
            const range = doc.createRange();
            range.selectNodeContents(doc.body.lastElementChild!);
            doc.getSelection()!.removeAllRanges();
            doc.getSelection()!.addRange(range);
            return find("alpha");
          })(),
          empty: find(""),
          // A match in a box of its own that scrolls is brought into it; Greek's final sigma matches its capital.
          clipped: await frame
            .show(
              `<!doctype html><pre id="wide" style="width: 100px; overflow: auto">${"x ".repeat(200)}far end</pre><p>ΟΔΟΣ</p>`,
            )
            .then(() => [
              find("far end").count,
              doc.getElementById("wide")!.scrollLeft > 0,
              find("οδος").count,
            ]),
          cleared: (frame.clearFind(), highlighted()),
        };
        frame.element.remove();
        return result;
      },
      [page_(""), page_("<p>alpha beta again</p><p>alpha last</p>")],
    );
    NodeAssert.deepEqual(found, {
      first: { count: 2, current: 0 },
      highlighted: { all: ["Alpha beta", "ALPHA\u00a0 beta"], current: ["Alpha beta"] },
      sheet: [
        "::highlight(pult-find) { background-color: rgb(1, 2, 3); }",
        "::highlight(pult-find-current) { background-color: rgb(4, 5, 6); }",
      ],
      acrossBlocks: [1, 0],
      next: { count: 2, current: 1 },
      scrolled: true,
      wrapped: { count: 2, current: 0 },
      back: [{ count: 2, current: 1 }, true],
      rendered: { count: 3, current: 1 },
      selection: { count: 4, current: 3 },
      empty: { count: 0, current: -1 },
      clipped: [1, true, 1],
      untouched: true,
      cleared: { all: [], current: [] },
    });
  });
  NodeTest.it("opens at a source line, and tells the line at the top of the view", async () => {
    // Paragraph k on line 2k - 1, to line 79; lines 81 to 102 a fence of one text node, its code on 82 to 101.
    const source = [
      ...Array.from({ length: 40 }, (_, index) => [`Paragraph ${index + 1}`, ""]).flat(),
      "```nolang",
      ...Array.from({ length: 20 }, (_, index) => `code ${index + 82}`),
      "```",
    ].join("\n");
    const lines = await page.evaluate(async (source) => {
      const frame = window.reader.createReaderFrame();
      document.body.append(frame.element);
      await frame.show(source, { markdown: true });
      const at = (line: number) => (frame.reveal(line), frame.topLine());
      const result = {
        top: frame.topLine(),
        paragraph: at(41),
        blank: at(42),
        fence: at(81),
        code: at(90),
      };
      frame.element.remove();
      return result;
    }, source);
    NodeAssert.deepEqual(lines, { top: 1, paragraph: 41, blank: 41, fence: 82, code: 90 });
  });
});
