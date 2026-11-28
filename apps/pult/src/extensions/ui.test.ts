// `node --test src/extensions/ui.test.ts`
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { ExtensionItems, replyLanding, replyMountKey, type Transport } from "./ui.ts";

const row = (key: string, shelf = "inbox", extra: Record<string, unknown> = {}) => ({
  key,
  shelf,
  title: `Ask ${key}`,
  poster: { thread: "t1" },
  status: { icon: "comment-unresolved", label: "Asked" },
  actions: [
    {
      id: "snooze",
      label: "Snooze",
      icon: "clock",
      input: { kind: "instant", label: "Snooze until" },
    },
    { id: "settle", label: "Settle", icon: "check", text: true },
  ],
  open: {
    file: "/q.md",
    reply: { target: { handled: { project: "p1" } }, chips: [{ label: "Yes", text: "Yes" }] },
  },
  ...extra,
});

/** A row whose snooze, settle and reply declare what they do to it. */
const declaring = (key: string, extra: Record<string, unknown> = {}) => {
  const base = row(key);
  const [snooze, settle] = base.actions;
  return row(key, "inbox", {
    actions: [
      {
        ...snooze,
        then: {
          shelf: "snoozed",
          status: { icon: "bell-slash", label: "Snoozed", time: { of: "input", as: "clock" } },
        },
      },
      {
        ...settle,
        then: {
          shelf: "settled",
          status: { icon: "check", label: "Settled", time: { of: "click", as: "age" } },
        },
      },
    ],
    open: {
      ...base.open,
      reply: {
        ...base.open.reply,
        then: {
          shelf: "working",
          status: { icon: "comment", label: "Replied", time: { of: "click", as: "age" } },
        },
      },
    },
    ...extra,
  });
};

const CLICK = Date.parse("2026-11-28T12:00:00.000Z");

function items(order: ReadonlyArray<string> = ["env", "other"]) {
  const warnings: string[] = [];
  const model = new ExtensionItems(
    (message) => warnings.push(message),
    () => order,
    () => CLICK,
  );
  return { model, warnings };
}

/** A transport whose every call waits for the test to answer or refuse it. */
function held() {
  const sent: unknown[] = [];
  let answer = () => {};
  let refuse = (_error: Error) => {};
  const wait = <A>(value: A) =>
    new Promise<A>((resolve, reject) => {
      answer = () => resolve(value);
      refuse = reject;
    });
  const transport: Transport = {
    act: (environmentId, input) => {
      sent.push({ environmentId, ...input });
      return wait(undefined);
    },
    send: (environmentId, input) => {
      sent.push({ environmentId, ...input });
      return wait({ thread: "t2" });
    },
  };
  return { transport, sent, answer: () => answer(), refuse: (error: Error) => refuse(error) };
}

const message = {
  text: "Yes",
  attachments: [],
  model: null,
  runtimeMode: null,
  interactionMode: null,
};

const keys = (model: ExtensionItems) =>
  model.rows().map((page) => `${page.environmentId}/${page.extension}/${page.row.key}`);

NodeTest.describe("ExtensionItems", () => {
  NodeTest.test(
    "holds each list as published, in the environments' order and by extension, and lets an emptied or forgotten one go",
    () => {
      const { model } = items();
      model.apply("other", { extension: "a", slot: "shelf-row", items: [row("x")] });
      model.apply("env", { extension: "b", slot: "shelf-row", items: [row("y"), row("z")] });
      model.apply("env", { extension: "a", slot: "shelf-row", items: [row("w")] });
      NodeAssert.deepEqual(keys(model), ["env/a/w", "env/b/y", "env/b/z", "other/a/x"]);
      // A change replaces the extension's whole list.
      model.apply("env", { extension: "b", slot: "shelf-row", items: [row("z", "snoozed")] });
      NodeAssert.deepEqual(keys(model), ["env/a/w", "env/b/z", "other/a/x"]);
      NodeAssert.equal(model.row("env", "b", "z")?.row.shelf, "snoozed");
      model.apply("env", { extension: "a", slot: "shelf-row", items: [] });
      model.forget("other");
      NodeAssert.deepEqual(keys(model), ["env/b/z"]);
    },
  );

  NodeTest.test(
    "skips an unknown slot and drops the list of an undecodable item, each logged once",
    () => {
      const { model, warnings } = items();
      model.apply("env", { extension: "a", slot: "shelf-row", items: [row("x")] });
      model.apply("env", { extension: "a", slot: "tab", items: [{ key: "t" }] });
      model.apply("env", { extension: "a", slot: "tab", items: [{ key: "t" }] });
      NodeAssert.deepEqual(keys(model), ["env/a/x"]);
      model.apply("env", { extension: "a", slot: "shelf-row", items: [row("x"), { key: "y" }] });
      model.apply("env", { extension: "a", slot: "shelf-row", items: [{ key: "y" }] });
      NodeAssert.deepEqual(keys(model), []);
      NodeAssert.equal(warnings.length, 2);
      NodeAssert.match(warnings[0]!, /slot "tab"/);
      NodeAssert.match(warnings[1]!, /does not decode/);
    },
  );

  NodeTest.test(
    "holds an action that declares nothing pending until its answer, one at a time, and hands back a refusal's words; an instant's value is sent",
    async () => {
      const { model } = items();
      model.apply("env", { extension: "a", slot: "shelf-row", items: [row("x")] });
      const page = model.row("env", "a", "x")!;
      const sent: unknown[] = [];
      let answer = () => {};
      let refuse = (_error: Error) => {};
      const transport: Transport = {
        act: (environmentId, input) => {
          sent.push({ environmentId, ...input });
          return new Promise((resolve, reject) => {
            answer = resolve;
            refuse = reject;
          });
        },
        send: () => Promise.reject(new Error("unused")),
      };
      const until = "2026-11-27T09:00:00.000Z";
      const snoozing = model.act(transport, page, "snooze", until);
      NodeAssert.equal(model.pendingOf(page), "snooze");
      // Another action waits for the first to answer.
      NodeAssert.equal(await model.act(transport, page, "settle"), null);
      NodeAssert.deepEqual(sent, [
        {
          environmentId: "env",
          extension: "a",
          slot: "shelf-row",
          key: "x",
          action: "snooze",
          value: until,
        },
      ]);
      answer();
      NodeAssert.equal(await snoozing, null);
      NodeAssert.equal(model.pendingOf(page), undefined);
      const settling = model.act(transport, page, "settle");
      NodeAssert.equal(model.pendingOf(page), "settle");
      NodeAssert.equal("value" in (sent[1] as object), false);
      refuse(new Error("not now"));
      NodeAssert.equal(await settling, "not now");
      NodeAssert.equal(model.pendingOf(page), undefined);
    },
  );

  NodeTest.test(
    "draws a declared action at the click and holds it, over publishes leaving the row and an answer arriving first, until the row's own publish",
    async () => {
      const { model, warnings } = items();
      model.apply("env", { extension: "a", slot: "shelf-row", items: [declaring("x")] });
      const call = held();
      const until = "2026-11-29T09:00:00.000Z";
      const snoozing = model.act(call.transport, model.row("env", "a", "x")!, "snooze", until);
      // Its new shelf and status, the input's value its time, and no actions to offer.
      const drawn = model.row("env", "a", "x")!;
      NodeAssert.deepEqual(
        [drawn.row.shelf, drawn.row.status, drawn.row.actions],
        ["snoozed", { icon: "bell-slash", label: "Snoozed", time: { at: until, as: "clock" } }, []],
      );
      NodeAssert.equal(model.pendingOf(drawn), undefined);
      NodeAssert.equal(call.sent.length, 1);
      // Another row's publish leaves it drawn, and so does the answer.
      const other = { extension: "a", slot: "shelf-row", items: [declaring("x"), row("y")] };
      model.apply("env", other);
      call.answer();
      NodeAssert.equal(await snoozing, null);
      NodeAssert.equal(model.row("env", "a", "x")?.row.shelf, "snoozed");
      NodeAssert.deepEqual(model.row("env", "a", "x")?.row.actions, []);
      // The row's own publish ends it, whatever it says.
      model.apply("env", {
        extension: "a",
        slot: "shelf-row",
        items: [declaring("x", { shelf: "working" }), row("y")],
      });
      NodeAssert.equal(model.row("env", "a", "x")?.row.shelf, "working");
      NodeAssert.equal(model.row("env", "a", "x")?.row.actions.length, 2);
      NodeAssert.deepEqual(warnings, []);
      // A publish ahead of the answer ends it too, and the row's new actions are offered at once.
      const settling = model.act(call.transport, model.row("env", "a", "x")!, "settle");
      model.apply("env", {
        extension: "a",
        slot: "shelf-row",
        items: [declaring("x", { shelf: "settled" }), row("y")],
      });
      const settled = model.row("env", "a", "x")!;
      NodeAssert.equal(settled.row.actions.length, 2);
      NodeAssert.equal(model.pendingOf(settled), undefined);
      call.answer();
      NodeAssert.equal(await settling, null);
      NodeAssert.equal(model.row("env", "a", "x")?.row.shelf, "settled");
      NodeAssert.deepEqual(warnings, []);
    },
  );

  NodeTest.test(
    "redraws a refused one as published, with the refusal's words, and a send's the same; the click's instant is its time",
    async () => {
      const { model } = items();
      model.apply("env", { extension: "a", slot: "shelf-row", items: [declaring("x")] });
      const call = held();
      const settling = model.act(call.transport, model.row("env", "a", "x")!, "settle");
      NodeAssert.deepEqual(model.row("env", "a", "x")?.row.status, {
        icon: "check",
        label: "Settled",
        time: { at: "2026-11-28T12:00:00.000Z", as: "age" },
      });
      call.refuse(new Error("asked again meanwhile"));
      NodeAssert.equal(await settling, "asked again meanwhile");
      NodeAssert.equal(model.row("env", "a", "x")?.row.shelf, "inbox");
      // A handled send draws its reply's `then`, and a refused one throws its words.
      const name = { environmentId: "env", extension: "a", key: "x" };
      const sending = model.send(call.transport, name, message);
      NodeAssert.equal(model.row("env", "a", "x")?.row.shelf, "working");
      call.refuse(new Error("not here"));
      await NodeAssert.rejects(sending, /not here/);
      NodeAssert.equal(model.row("env", "a", "x")?.row.shelf, "inbox");
      const sent = model.send(call.transport, name, message);
      call.answer();
      NodeAssert.deepEqual(await sent, { thread: "t2" });
      NodeAssert.equal(model.row("env", "a", "x")?.row.shelf, "working");
    },
  );

  NodeTest.test(
    "draws as published a row answered and never published, warning once per extension, and forgets one drawn with its environment",
    async () => {
      const { model, warnings } = items();
      const list = { extension: "a", slot: "shelf-row", items: [declaring("x"), declaring("y")] };
      model.apply("env", list);
      const call = held();
      for (const key of ["x", "y"]) {
        const settling = model.act(call.transport, model.row("env", "a", key)!, "settle");
        call.answer();
        await settling;
        NodeAssert.equal(model.row("env", "a", key)?.row.shelf, "settled");
        model.apply("env", list);
        NodeAssert.equal(model.row("env", "a", key)?.row.shelf, "inbox");
      }
      NodeAssert.equal(warnings.length, 1);
      NodeAssert.match(warnings[0]!, /declared what an action or a send does to its row "x"/);
      // An environment forgotten takes the row drawn and its pending mark: its next snapshot is the state.
      void model.act(call.transport, model.row("env", "a", "x")!, "settle");
      model.forget("env");
      model.apply("env", list);
      const page = model.row("env", "a", "x")!;
      NodeAssert.equal(page.row.shelf, "inbox");
      NodeAssert.equal(model.pendingOf(page), undefined);
    },
  );

  NodeTest.test("keeps a handled reply's mount across a republish with the same target", () => {
    const { model } = items();
    const publish = (extra: Record<string, unknown>) => {
      model.apply("env", { extension: "a", slot: "shelf-row", items: [row("x", "inbox", extra)] });
      return replyMountKey(1, model.row("env", "a", "x")!);
    };
    const first = publish({});
    NodeAssert.equal(
      publish({ title: "Renamed", status: { icon: "comment", label: "Replied" } }),
      first,
    );
    NodeAssert.notEqual(
      publish({
        open: { file: "/q.md", reply: { target: { handled: { project: "p2" } }, chips: [] } },
      }),
      first,
    );
    NodeAssert.notEqual(replyMountKey(2, model.row("env", "a", "x")!), first);
  });
});

NodeTest.describe("replyLanding", () => {
  // The decision takes no conversation, so a reply that wakes a fresh one, which the page's Stars
  // do not know yet, lands where a reply into an open one does.
  const star = { id: "s1", defaultChannel: "desk" };

  NodeTest.test("lands a default channel's reply on the Star's tab, open or fresh", () => {
    NodeAssert.deepEqual(replyLanding({ star: "s1", channel: "desk" }, star), {
      kind: "star",
      star: "s1",
    });
  });

  NodeTest.test("lands another channel's reply on that channel's tab, open or fresh", () => {
    NodeAssert.deepEqual(replyLanding({ star: "s1", channel: "main" }, star), {
      kind: "channel",
      star: "s1",
      slug: "main",
    });
  });

  NodeTest.test(
    "lands a thread poster's reply, and a Star's the page does not hold, on the thread",
    () => {
      NodeAssert.deepEqual(replyLanding({ thread: "t1" }, undefined), { kind: "thread" });
      NodeAssert.deepEqual(replyLanding({ star: "gone", channel: "desk" }, undefined), {
        kind: "thread",
      });
    },
  );
});
