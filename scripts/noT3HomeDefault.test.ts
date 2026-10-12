// @effect-diagnostics nodeBuiltinImport:off - walks the checked-out source tree on disk.
//
// The desktop's own state defaults to ~/.pult and the dev modes to the
// checkout's own .t3; ~/.t3 is the running T3 Code Extensible server's live
// data, which a dev run must never touch. This test fails if Pult's own source under apps/, packages/
// or scripts/ joins a home directory to a literal `.t3` again, outside the
// reasoned allow-list below. The server, which legitimately defaults to ~/.t3,
// lives outside this repo (DECISIONS.md, `server-side-home`), and the protocol
// packages under vendor/, the fork's bytes, lie outside the scanned roots. A
// `.t3` that is not a home default (a worktree-local `.t3`, a fixture path in a
// test) does not name a home directory next to it, so it never matches.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.join(import.meta.dirname, "..");
const scanRoots = ["apps", "packages", "scripts"];
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
  ".sh",
  ".ps1",
]);

const isTestFile = (fileName: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(fileName) || fileName.endsWith(".d.ts");

// A `.t3` segment with something naming a home directory on its line or on one
// of the two lines before it, so a join split across lines is still
// caught. A quoted "~/.t3" is both at once; a bare `home` counts as an argument.
// Comment lines are skipped: prose about `~/.t3` is not a default.
const homeToken =
  /homedir\(\)|[(,]\s*home\s*[,)]|\bHOME|\bhomeDirectory\b|\bhomeDir\b|\buserHome\b|USERPROFILE|getPath\(["'`]home|["'`]~[/\\]\.t3/;
const dotT3Token = /(^|[\s/\\'"`(])\.t3(?=$|[\s/\\'"`),}])/;
const precedingLines = 2;
const commentLine = /^\s*(\/\/|\/\*|\*|#)/;

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
    const lines = NodeFS.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => (commentLine.test(line) ? "" : line));
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
    file: "apps/pult-desktop/src/wsl/DesktopWslEnvironment.ts",
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
    file: "scripts/pult/stage.ts",
    lineCount: 2,
    reason: "refuses to stage into ~/.t3, and says so in its error.",
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
