// Run with `node --test view/previewRoutes.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { previewRoutes } from "./previewRoutes.ts";

const thread = { environmentId: "env", threadId: "thread" };

type Source =
  | { readonly kind: "browser"; readonly tabId: string }
  | { readonly kind: "device"; readonly deviceId: string };

interface Session {
  reveal?: boolean;
  revealRequest?: { readonly id: string; readonly force: boolean };
}

/** The reroutes over a recording host and upstream, with the thread's sessions as the test sets them. */
function setup() {
  const sessions = new Map<string, Session>();
  const calls: Array<unknown[]> = [];
  const routes = previewRoutes<typeof thread, Source>({
    host: () => ({
      openPreview: (...args) => void calls.push(["openPreview", ...args]),
      closeStalePreviews: (...args) => void calls.push(["closeStalePreviews", ...args]),
    }),
    session: (_ref, tabId) => sessions.get(tabId),
    upstream: {
      float: (_ref, source) => void calls.push(["upstream.float", source]),
      revealSurface: (_ref, surfaceId) => void calls.push(["upstream.revealSurface", surfaceId]),
    },
  });
  /** Upstream's reveal of a session with no panel tab, which in Pult is every reveal. */
  const reveal = (tabId: string, session: Session) => {
    sessions.set(tabId, session);
    routes.float(thread, { kind: "browser", tabId });
  };
  const take = () => calls.splice(0);
  return { routes, sessions, reveal, take };
}

const opened = (tabId: string | null, options: object) => [
  "openPreview",
  "env",
  "thread",
  tabId,
  options,
];

NodeTest.test("an agent's reveal opens the session's tab in the background", () => {
  const { reveal, take } = setup();
  reveal("a", { reveal: true, revealRequest: { id: "r1", force: false } });
  NodeAssert.deepEqual(take(), [opened("a", { activate: false })]);
});

NodeTest.test("a forced reveal, the agent's explicit open, activates the tab", () => {
  const { reveal, take } = setup();
  reveal("a", { reveal: true, revealRequest: { id: "r1", force: true } });
  NodeAssert.deepEqual(take(), [opened("a", { activate: true })]);
});

NodeTest.test("each new reveal of a session asks again, active only when forced", () => {
  const { reveal, take } = setup();
  reveal("a", { reveal: true, revealRequest: { id: "r1", force: false } });
  reveal("a", { reveal: true, revealRequest: { id: "r2", force: true } });
  reveal("a", { reveal: true, revealRequest: { id: "r3", force: false } });
  // An unforced ask for a tab already open is the shell's no-op (`ThreadViewHost.openPreview`).
  NodeAssert.deepEqual(take(), [
    opened("a", { activate: false }),
    opened("a", { activate: true }),
    opened("a", { activate: false }),
  ]);
});

NodeTest.test("a session announced revealed without a request opens in the background", () => {
  const { reveal, take } = setup();
  reveal("a", { reveal: true });
  NodeAssert.deepEqual(take(), [opened("a", { activate: false })]);
});

NodeTest.test("a float with no new reveal is the user's, and activates the tab", () => {
  const { routes, reveal, sessions, take } = setup();
  reveal("a", { reveal: true, revealRequest: { id: "r1", force: false } });
  routes.float(thread, { kind: "browser", tabId: "a" });
  sessions.set("b", {});
  routes.float(thread, { kind: "browser", tabId: "b" });
  NodeAssert.deepEqual(take(), [
    opened("a", { activate: false }),
    opened("a", { activate: true }),
    opened("b", { activate: true }),
  ]);
});

NodeTest.test("a device floats as upstream's, and the shell hears nothing of it", () => {
  const { routes, take } = setup();
  routes.float(thread, { kind: "device", deviceId: "phone" });
  NodeAssert.deepEqual(take(), [["upstream.float", { kind: "device", deviceId: "phone" }]]);
});

NodeTest.test(
  "the user's ways in open the session's tab active, in the placeholder's place",
  () => {
    const { routes, take } = setup();
    routes.openBrowser(thread, "a");
    routes.openBrowser(thread, null);
    NodeAssert.deepEqual(take(), [
      opened("a", { activate: true, replacePlaceholder: true }),
      opened(null, { activate: true, replacePlaceholder: false }),
    ]);
  },
);

NodeTest.test(
  "revealing a browser surface activates its tab; other surfaces stay upstream's",
  () => {
    const { routes, take } = setup();
    routes.revealSurface(thread, "browser:a");
    routes.revealSurface(thread, "browser:new");
    routes.revealSurface(thread, "terminal:1");
    NodeAssert.deepEqual(take(), [
      opened("a", { activate: true }),
      ["upstream.revealSurface", "terminal:1"],
    ]);
  },
);

NodeTest.test("the reconcile only closes stale tabs: no session gets a tab by existing", () => {
  const { routes, take } = setup();
  routes.reconcileBrowserSurfaces(thread, ["a", "b"]);
  NodeAssert.deepEqual(take(), [["closeStalePreviews", "env", "thread", ["a", "b"]]]);
});
