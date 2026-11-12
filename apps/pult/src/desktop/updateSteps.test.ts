// Run with `node --test src/desktop/updateSteps.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { DesktopUpdateState } from "@t3tools/contracts";

import { busyRestartDetail, installableVersion, nextUpdateStep, trayOffer } from "./updateSteps.ts";

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

/** A step while the server installs at rest, as it does by default. */
const step = (current: DesktopUpdateState, downloadTried: boolean, installsAtRest = true) =>
  nextUpdateStep(current, downloadTried, installsAtRest);

const answer = (severity: "info" | "error", message: string) => ({
  kind: "answer",
  severity,
  message,
});

NodeTest.test("an update found is downloaded once, then answered", () => {
  const available = state({ status: "available", availableVersion: "0.0.2" });
  NodeAssert.deepEqual(step(available, false), { kind: "download" });
  NodeAssert.deepEqual(
    step({ ...available, message: "Network down", errorContext: "download" }, true),
    answer("error", "Network down"),
  );
  NodeAssert.deepEqual(
    step(
      state({ status: "downloaded", availableVersion: "0.0.2", downloadedVersion: "0.0.2" }),
      true,
    ),
    answer("info", "Pult 0.0.2 downloaded; it installs when Pult rests."),
  );
});

NodeTest.test("a download that failed to install here is left to Restart to Update", () => {
  const download = {
    status: "downloaded" as const,
    availableVersion: "0.0.2",
    downloadedVersion: "0.0.2",
  };
  for (const failed of [{ notAppliedVersion: "0.0.2" }, { installFailedVersion: "0.0.2" }]) {
    NodeAssert.deepEqual(
      step(state({ ...download, ...failed }), false),
      answer("info", "Pult 0.0.2 downloaded. Restart to Update installs it."),
    );
  }
  NodeAssert.deepEqual(
    step(
      state({
        status: "downloaded",
        availableVersion: "0.0.3",
        downloadedVersion: "0.0.3",
        installFailedVersion: "0.0.2",
      }),
      false,
    ),
    answer("info", "Pult 0.0.3 downloaded; it installs when Pult rests."),
  );
});

NodeTest.test("with automatic updates off, a download is left to Restart to Update", () => {
  NodeAssert.deepEqual(
    step(state({ status: "downloaded", downloadedVersion: "0.0.2" }), false, false),
    answer("info", "Pult 0.0.2 downloaded. Restart to Update installs it."),
  );
});

NodeTest.test("a check or a download running, whoever started it, is waited for", () => {
  NodeAssert.deepEqual(step(state({ status: "checking" }), false), { kind: "wait" });
  NodeAssert.deepEqual(step(state({ status: "downloading", availableVersion: "0.0.2" }), false), {
    kind: "wait",
  });
});

NodeTest.test("a download already waiting is answered without another", () => {
  NodeAssert.deepEqual(
    step(state({ status: "downloaded", downloadedVersion: "0.0.2" }), false),
    answer("info", "Pult 0.0.2 downloaded; it installs when Pult rests."),
  );
});

NodeTest.test("up to date, disabled and failed checks are answered", () => {
  NodeAssert.deepEqual(
    step(state({ status: "up-to-date" }), false),
    answer("info", "You're up to date."),
  );
  const dev = "Automatic updates are only available in packaged production builds.";
  NodeAssert.deepEqual(
    step(state({ enabled: false, status: "disabled", message: dev }), false),
    answer("error", dev),
  );
  NodeAssert.deepEqual(
    step(state({ status: "error", errorContext: "check", message: "HttpError: 404" }), false),
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

NodeTest.test("the tray offers a download, then its progress, then a restart", () => {
  NodeAssert.equal(trayOffer(state({ status: "up-to-date" })), null);
  NodeAssert.equal(trayOffer(state({ status: "checking" })), null);
  NodeAssert.deepEqual(trayOffer(state({ status: "available", availableVersion: "0.0.2" })), {
    kind: "download",
    version: "0.0.2",
  });
  NodeAssert.deepEqual(
    trayOffer(state({ status: "error", errorContext: "download", availableVersion: "0.0.2" })),
    { kind: "download", version: "0.0.2" },
  );
  NodeAssert.deepEqual(trayOffer(state({ status: "downloading", availableVersion: "0.0.2" })), {
    kind: "downloading",
    version: "0.0.2",
  });
  NodeAssert.deepEqual(
    trayOffer(
      state({ status: "downloaded", availableVersion: "0.0.2", downloadedVersion: "0.0.2" }),
    ),
    { kind: "restart", version: "0.0.2" },
  );
});

NodeTest.test("the busy restart's warning names a few of the threads at work", () => {
  NodeAssert.equal(
    busyRestartDetail([]),
    "Agent work is running on this computer. Restarting now interrupts it.",
  );
  NodeAssert.equal(
    busyRestartDetail(["Fix tray"]),
    "An agent is working on “Fix tray”. Restarting now interrupts it.",
  );
  NodeAssert.equal(
    busyRestartDetail(["a", "b", "c", "d", "e"]),
    "Agents are working on “a”, “b”, “c” and 2 more. Restarting now interrupts it.",
  );
});
