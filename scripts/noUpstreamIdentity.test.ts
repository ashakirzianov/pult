// @effect-diagnostics nodeBuiltinImport:off - walks the checked-out source tree on disk.
//
// Pult names its identity in one module, `packages/shared/src/identity.ts`, so
// a Pult app runs beside an installed T3 Code without either disturbing the
// other (DECISIONS.md, `identity-seam`). This test fails if source under apps/,
// packages/ or scripts/ spells one of upstream's identity values again, outside
// the reasoned allow-list below. Mobile is out of scope and not scanned, and
// apps/web is upstream's client kept byte for byte; Pult's is apps/pult.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import { APP_DISPLAY_NAME, CLI_NAME } from "@t3tools/shared/identity";

const repoRoot = NodePath.join(import.meta.dirname, "..");
const scanRoots = ["apps", "packages", "scripts"];
const excludedPaths = new Set(["apps/mobile", "apps/marketing", "apps/web"]);
const excludedDirNames = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "build",
  "out",
  "coverage",
]);
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".html",
  ".sh",
  ".ps1",
]);

const isTestFile = (fileName: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(fileName) || fileName.endsWith(".d.ts");
const isMobileScript = (relativePath: string) => relativePath.startsWith("scripts/mobile-");

// Upstream's values, each as it is spelled at a site. Comment lines are
// skipped: prose about upstream's names is not a site.
const upstreamValues: ReadonlyArray<{ name: string; pattern: RegExp; paths?: RegExp }> = [
  { name: "bundle id or launchd label", pattern: /com\.t3tools\.t3code/ },
  { name: "Linux desktop entry", pattern: /com\.t3tools\.T3Code(\.Development)?\.desktop/ },
  { name: "Electron userData", pattern: /\bt3code-v2\b/ },
  // A bare "t3code" is also a branch prefix and a namespace, so only the
  // spellings that can only be the scheme are pinned.
  {
    name: "URL scheme",
    pattern: /\bt3code(-dev)?:\/\/|["'`]t3code(-dev)?:["'`]|["'`]t3code-dev["'`]/,
  },
  { name: "systemd unit", pattern: /\bt3code\.service\b/ },
  { name: "observability service", pattern: /["'`]t3code-desktop["'`]/ },
  { name: "display name", pattern: /T3 Code \((Alpha|Dev|Nightly)\)/ },
  { name: "desktop backend port", pattern: /\b3773\b/, paths: /^apps\/desktop\// },
];
const commentLine = /^\s*(\/\/|\/\*|\*|#|<!--)/;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly value: string;
  readonly text: string;
}

function walk(dir: string, out: Array<string>) {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = NodePath.join(dir, entry.name);
    const relative = NodePath.relative(repoRoot, full);
    if (entry.isDirectory()) {
      if (!excludedDirNames.has(entry.name) && !excludedPaths.has(relative)) walk(full, out);
    } else if (
      entry.isFile() &&
      !isTestFile(entry.name) &&
      !isMobileScript(relative) &&
      sourceExtensions.has(NodePath.extname(entry.name))
    ) {
      out.push(relative);
    }
  }
}

function findMatches() {
  const files: Array<string> = [];
  for (const root of scanRoots) walk(NodePath.join(repoRoot, root), files);

  const findings: Array<Finding> = [];
  for (const file of files) {
    if (file === "packages/shared/src/identity.ts") continue;
    const lines = NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      if (commentLine.test(text)) return;
      for (const value of upstreamValues) {
        if (value.paths && !value.paths.test(file)) continue;
        if (value.pattern.test(text)) {
          findings.push({ file, line: index + 1, value: value.name, text: text.trim() });
        }
      }
    });
  }
  return findings;
}

// Each entry is a site that names upstream's value on purpose. `lineCount` pins
// how many matching lines the file has, so a new one cannot ride in on it.
const allowList: ReadonlyArray<{ file: string; lineCount: number; reason: string }> = [
  {
    file: "apps/pult/src/components/NightlyMobileBeta.tsx",
    lineCount: 1,
    reason: "links to upstream's mobile app in the Play Store; mobile is out of scope.",
  },
];

const describeFindings = (findings: ReadonlyArray<Finding>) =>
  findings
    .map((finding) => `  ${finding.file}:${finding.line} (${finding.value}): ${finding.text}`)
    .join("\n");

describe("no upstream identity outside the identity module", () => {
  const findings = findMatches();

  it("spells upstream's identity values only in allow-listed files", () => {
    const allowed = new Set(allowList.map((entry) => entry.file));
    const unexpected = findings.filter((finding) => !allowed.has(finding.file));
    expect(
      unexpected,
      `Read the value from packages/shared/src/identity.ts, or add a reasoned entry to scripts/noUpstreamIdentity.test.ts:\n${describeFindings(unexpected)}`,
    ).toEqual([]);
  });

  it.each(allowList)("$file has exactly its allow-listed matches", (entry) => {
    const matches = findings.filter((finding) => finding.file === entry.file);
    expect(matches.length, describeFindings(matches)).toBe(entry.lineCount);
  });

  it("names the packaged app and the CLI binary after the identity module", () => {
    expect(desktopPackageJson.productName).toBe(APP_DISPLAY_NAME);
    expect(Object.keys(serverPackageJson.bin)).toEqual([CLI_NAME]);
  });
});
