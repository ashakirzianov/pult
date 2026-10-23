// Drives the shell in headless Chromium, as a list of steps:
//   node scripts/drive.ts [--url http://localhost:5190/] [--profile dir] step...
// Steps: `eval:<js>` prints the value; `fire:<js>` runs it without waiting (for
// commands that open a prompt); `type:<text>` types into the focused element;
// `fill:<selector>=<text>`; `press:<key>`; `click:<selector>`; `wait:<ms>`;
// `shot:<path>` saves a screenshot. The browser profile persists in
// `.playwright/`, so user data (IndexedDB) and the connection survive runs.
import * as path from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args.splice(index, 2)[1]!;
};
const url = option("--url", "http://localhost:5190/");
const width = Number(option("--width", "1440"));
const height = Number(option("--height", "900"));
const profile = option("--profile", path.join(import.meta.dirname, "../.playwright"));

const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  viewport: { width, height },
  deviceScaleFactor: 2,
});
const page = context.pages()[0] ?? (await context.newPage());
page.on("console", (message) => {
  const text = message.text();
  if (message.type() === "error" || text.startsWith("[pult")) console.error(`[page] ${text.slice(0, 400)}`);
});
page.on("pageerror", (error) => console.error(`[page error] ${error.message}`));
await page.goto(url);
await page.waitForFunction(() => "pult" in window, undefined, { timeout: 60_000 });
await page.waitForTimeout(1500);

for (const step of args) {
  const colon = step.indexOf(":");
  const kind = step.slice(0, colon);
  const rest = step.slice(colon + 1);
  switch (kind) {
    case "eval":
      console.log(JSON.stringify(await page.evaluate(rest), null, 2));
      break;
    case "fire":
      await page.evaluate(`void (async () => { try { await (${rest}); } catch (e) { console.error('[pult-drive] ' + e); } })()`);
      break;
    case "type":
      await page.keyboard.type(rest);
      break;
    case "fill": {
      const eq = rest.indexOf("=");
      await page.fill(rest.slice(0, eq), rest.slice(eq + 1));
      break;
    }
    case "press":
      await page.keyboard.press(rest);
      break;
    case "click":
      await page.click(rest);
      break;
    case "wait":
      await page.waitForTimeout(Number(rest));
      break;
    case "shot":
      await page.screenshot({ path: rest });
      console.error(`screenshot: ${rest}`);
      break;
    default:
      throw new Error(`Unknown step ${step}`);
  }
}
await context.close();
