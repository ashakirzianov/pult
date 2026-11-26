// `node --test src/extensions/ui.test.ts`
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { ExtensionItems, replyMountKey, type Transport } from "./ui.ts";

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

function items(order: ReadonlyArray<string> = ["env", "other"]) {
  const warnings: string[] = [];
  const model = new ExtensionItems(
    (message) => warnings.push(message),
    () => order,
  );
  return { model, warnings };
}

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
    "holds an action pending until its answer, one at a time, and hands back a refusal's words; an instant's value is sent",
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
