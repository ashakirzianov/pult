// @effect-diagnostics nodeBuiltinImport:off - walks the checked-out source tree on disk.
//
// Pult's default home is ~/.pult; ~/.t3 is an installed T3 Code's live data
// (DECISIONS.md, `default-home`). This test fails if source under apps/,
// packages/ or scripts/ joins a home directory to a literal `.t3` again,
// outside the reasoned allow-list below. A `.t3` that is not a home default (a
// worktree-local `.t3`, a fixture path in a test) does not name a home
// directory next to it, so it never matches.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.join(import.meta.dirname, "..");
const scanRoots = ["apps", "packages", "scripts"];
const excludedDirNames = new Set(["node_modules", "dist", "build", "out", "coverage"]);
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".sh",
  ".ps1",
]);

const isTestFile = (fileName: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(fileName) || fileName.endsWith(".d.ts");

// A `.t3` segment with a home-directory accessor on its line or on one of the
// two before it, so a join split across lines is still caught. A quoted
// "~/.t3" is both at once.
const homeToken = /homedir\(\)|\bHOME\b|\bhomeDirectory\b|\bhomeDir\b|["']~[/\\]\.t3/;
const dotT3Token = /(^|[\s/\\'"`(])\.t3(?=$|[\s/\\'"`),}])/;
const precedingLines = 2;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function walk(dir: string, out: Array<string>) {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirNames.has(entry.name)) walk(full, out);
    } else if (
      entry.isFile() &&
      !isTestFile(entry.name) &&
      sourceExtensions.has(NodePath.extname(entry.name))
    ) {
      out.push(full);
    }
  }
}

function findMatches() {
  const files: Array<string> = [];
  for (const root of scanRoots) walk(NodePath.join(repoRoot, root), files);

  const findings: Array<Finding> = [];
  for (const file of files) {
    const lines = NodeFS.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      if (!dotT3Token.test(text)) return;
      const window = lines.slice(Math.max(0, index - precedingLines), index + 1).join("\n");
      if (homeToken.test(window)) {
        findings.push({
          file: NodePath.relative(repoRoot, file),
          line: index + 1,
          text: text.trim(),
        });
      }
    });
  }
  return findings;
}

// Each entry is a `.t3` next to a home directory that is not Pult's home
// default. `lineCount` pins how many matching lines the file has, so a new one
// cannot ride in on an entry that is already here.
const allowList: ReadonlyArray<{ file: string; lineCount: number; reason: string }> = [
  {
    file: "apps/server/src/device/sshDeviceScript.ts",
    lineCount: 1,
    reason: "a script run on a paired remote device; its home is that device's own.",
  },
  {
    file: "apps/desktop/src/wsl/DesktopWslEnvironment.ts",
    lineCount: 3,
    reason:
      "a runtime-binary cache inside the WSL guest; the WSL backend's state home is the server's default.",
  },
  {
    file: "scripts/install.sh",
    lineCount: 1,
    reason: "installs upstream's standalone T3 Code CLI, whose home is ~/.t3.",
  },
  {
    file: "scripts/install.ps1",
    lineCount: 1,
    reason: "the Windows counterpart of install.sh.",
  },
  {
    file: "apps/server/scripts/migrate-dev-db.ts",
    lineCount: 1,
    reason: "reads its source snapshot from ~/.t3 and refuses to write there.",
  },
  {
    file: "apps/server/scripts/t3-sqlite-state.ts",
    lineCount: 1,
    reason: "refuses to write into ~/.t3.",
  },
];

const describeFindings = (findings: ReadonlyArray<Finding>) =>
  findings.map((finding) => `  ${finding.file}:${finding.line}: ${finding.text}`).join("\n");

describe("no ~/.t3 home default", () => {
  const findings = findMatches();

  it("joins a home directory to .t3 only in allow-listed files", () => {
    const allowed = new Set(allowList.map((entry) => entry.file));
    const unexpected = findings.filter((finding) => !allowed.has(finding.file));
    expect(
      unexpected,
      `A home default of ~/.t3 is back; Pult's is ~/.pult. Fix it, or add a reasoned entry to scripts/noT3HomeDefault.test.ts:\n${describeFindings(unexpected)}`,
    ).toEqual([]);
  });

  it.each(allowList)("$file has exactly its allow-listed matches", (entry) => {
    const matches = findings.filter((finding) => finding.file === entry.file);
    expect(matches.length, describeFindings(matches)).toBe(entry.lineCount);
  });
});
