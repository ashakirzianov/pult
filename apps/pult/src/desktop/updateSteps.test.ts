// Run with `node --test src/desktop/updateSteps.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { DesktopUpdateState } from "@t3tools/contracts";

import { installableVersion, nextUpdateStep } from "./updateSteps.ts";

const state = (overrides: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.0.1",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  ...overrides,
});

const answer = (severity: "info" | "error", message: string) => ({
  kind: "answer",
  severity,
  message,
});

NodeTest.test("an update found is downloaded once, then answered", () => {
  const available = state({ status: "available", availableVersion: "0.0.2" });
  NodeAssert.deepEqual(nextUpdateStep(available, false), { kind: "download" });
  NodeAssert.deepEqual(
    nextUpdateStep({ ...available, message: "Network down", errorContext: "download" }, true),
    answer("error", "Network down"),
  );
  NodeAssert.deepEqual(
    nextUpdateStep(
      state({ status: "downloaded", availableVersion: "0.0.2", downloadedVersion: "0.0.2" }),
      true,
    ),
    answer("info", "Pult 0.0.2 downloaded; it installs when Pult rests."),
  );
});

NodeTest.test("a check or a download running, whoever started it, is waited for", () => {
  NodeAssert.deepEqual(nextUpdateStep(state({ status: "checking" }), false), { kind: "wait" });
  NodeAssert.deepEqual(
    nextUpdateStep(state({ status: "downloading", availableVersion: "0.0.2" }), false),
    { kind: "wait" },
  );
});

NodeTest.test("a download already waiting is answered without another", () => {
  NodeAssert.deepEqual(
    nextUpdateStep(state({ status: "downloaded", downloadedVersion: "0.0.2" }), false),
    answer("info", "Pult 0.0.2 downloaded; it installs when Pult rests."),
  );
});

NodeTest.test("up to date, disabled and failed checks are answered", () => {
  NodeAssert.deepEqual(
    nextUpdateStep(state({ status: "up-to-date" }), false),
    answer("info", "You're up to date."),
  );
  const dev = "Automatic updates are only available in packaged production builds.";
  NodeAssert.deepEqual(
    nextUpdateStep(state({ enabled: false, status: "disabled", message: dev }), false),
    answer("error", dev),
  );
  NodeAssert.deepEqual(
    nextUpdateStep(
      state({ status: "error", errorContext: "check", message: "HttpError: 404" }),
      false,
    ),
    answer("error", "HttpError: 404"),
  );
});

NodeTest.test("Restart to Update installs a download waiting, even after a failed install", () => {
  NodeAssert.equal(
    installableVersion(state({ status: "downloaded", downloadedVersion: "0.0.2" })),
    "0.0.2",
  );
  NodeAssert.equal(
    installableVersion(
      state({ status: "error", errorContext: "install", downloadedVersion: "0.0.2" }),
    ),
    "0.0.2",
  );
  NodeAssert.equal(
    installableVersion(state({ status: "checking", downloadedVersion: "0.0.2" })),
    null,
  );
  NodeAssert.equal(
    installableVersion(state({ status: "available", availableVersion: "0.0.2" })),
    null,
  );
});
