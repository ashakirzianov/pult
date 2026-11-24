// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a one-shot run with plain node.
// The cut of Pult's tree from xaxis to monore, unit A of
// `pult/tasks/pult-release-calls-monore.task/design.md` (section 6), run once at the rename's
// sitting at the root of a clean checkout of Pult, git's or xaxis's:
//
//   node scripts/monore-cut.ts
//
// It replaces `xaxis`, `Xaxis` and `XAXIS` by `monore`, `Monore` and `MONORE` in the files a
// commit would hold, renames the paths that hold them, deletes itself, and prints the residue:
// every `xaxis` left outside the exclusions below, one per line with its path. An empty residue
// is the pass; any other exits 1.
//
// The files are listed by git's ignore rules over the disk, against a throwaway git directory,
// so the listing is the same in a git checkout and in an xaxis one (whose CLI reads `.gitignore`
// then `.xaxisignore`, in git's syntax). Renames are the file system's.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const SELF = "scripts/monore-cut.ts";
/** knip's entry for this script, which goes with it. */
const KNIP = "knip.jsonc";
const KNIP_ENTRY =
  '        // Run once by hand at the rename\'s sitting; it deletes itself and this entry.\n        "monore-cut.ts",\n';
const MARKER = ".xaxis-checkout";
/** Read by the old CLI until the fence; the tree landing moves them, never this cut. */
const IGNORE_FILE = ".xaxisignore";
const GIT_FILE = ".xaxisgit";
/** What formats the rewritten files: a longer word moves where lines wrap. */
const VP = "node_modules/.bin/vp";

/**
 * The agent-context budget the server's test pins, which counts the bytes of the tool text the
 * cut rewrites: measured by a copy of that test whose check writes the budget instead.
 */
const SERVER = "apps/server";
const BUDGET_TEST = "src/provider/AgentContextBudget.test.ts";
const BUDGET_MEASURE = "src/provider/AgentContextBudget.measure.test.ts";
const BUDGET_CHECK = ").toEqual(budget);";
const BUDGET_WRITE =
  ').toBeDefined();\n    MeasureFS.writeFileSync(new URL("./agentContextBudget.json", import.meta.url), `${JSON.stringify(measured, null, 2)}\\n`);';

/** Upstream's: `chart.bar.xaxis` is an SF Symbol, and `docs/upstream/` its own text. */
const UNTOUCHED_FOLDERS = ["apps/mobile/", "docs/upstream/"];

/**
 * What keeps its spelling wherever it sits: the track's folder and the task ids in it, which
 * move with the reorganisation and not with the rename; upstream's SF Symbol; and the Star
 * record's legacy line, which the record test names on purpose, since the four live records
 * carry it until a runbook line removes it.
 */
const KEPT = [
  String.raw`/ashakirzianov/xaxis/`,
  String.raw`xaxis/(?:tasks/|decisions)`,
  String.raw`tasks/[\w.-]*xaxis[\w.-]*\.task`,
  String.raw`chart\.bar\.xaxis`,
  String.raw`xaxis-kind`,
].join("|");
const WORD = new RegExp(`(${KEPT})|xaxis|Xaxis|XAXIS`, "g");
const ANY = new RegExp(`(${KEPT})|xaxis`, "gi");
const NEW = { xaxis: "monore", Xaxis: "Monore", XAXIS: "MONORE" } as const;

const fail = (message: string): never => {
  console.error(`monore-cut: ${message}`);
  process.exit(2);
};

const spawn = (command: string, args: ReadonlyArray<string>, cwd = ".") => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return NodeChildProcess.spawnSync(command, args, { cwd, encoding: "utf8", env });
};

const refuseFailed = (
  command: string,
  args: ReadonlyArray<string>,
  result: ReturnType<typeof spawn>,
) => {
  if (result.status !== 0)
    fail(
      `${command} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout || String(result.error)).slice(-4000)}`,
    );
  return result.stdout;
};

const run = (command: string, args: ReadonlyArray<string>, cwd = ".") =>
  refuseFailed(command, args, spawn(command, args, cwd));

/** "an xaxis checkout", "an `.xaxis-checkout`": the new word takes "a". */
const ARTICLE = new RegExp(String.raw`\b([Aa])n(\s+[^\sA-Za-z0-9]{0,2})(?=xaxis)(?!${KEPT})`, "gi");

const rewrite = (text: string) =>
  text
    .replace(ARTICLE, "$1$2")
    .replace(WORD, (word, kept: string | undefined) => kept ?? NEW[word as keyof typeof NEW]);

const newPath = (path: string) =>
  path
    .split("/")
    .map((segment) => rewrite(segment))
    .join("/");

const untouched = (path: string) =>
  UNTOUCHED_FOLDERS.some((folder) => path.startsWith(folder)) ||
  path === MARKER ||
  NodePath.posix.basename(path) === GIT_FILE;

const isIgnoreFile = (path: string) => NodePath.posix.basename(path) === IGNORE_FILE;

/** The files a commit would hold, this script apart: what no ignore file ignores. */
function listFiles(): string[] {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "monore-cut-"));
  try {
    run("git", ["init", "-q", "--bare", scratch]);
    const listed = run("git", [
      `--git-dir=${scratch}`,
      "--work-tree=.",
      "-c",
      "core.bare=false",
      "-c",
      "core.excludesFile=/dev/null",
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      ...(NodeFS.existsSync(IGNORE_FILE) ? [`--exclude-from=${IGNORE_FILE}`] : []),
    ]);
    return listed
      .split("\0")
      .filter((path) => path !== "" && path !== SELF)
      .toSorted();
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

/** A file's text, or undefined for bytes that are no UTF-8 text. */
function textOf(path: string): string | undefined {
  const bytes = NodeFS.readFileSync(path);
  if (bytes.includes(0)) return undefined;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

function refuseDirtyCheckout() {
  const git = NodeFS.existsSync(".git");
  const xaxis = NodeFS.existsSync(MARKER);
  if (git === xaxis)
    fail(
      git
        ? `the current folder holds both .git and ${MARKER}.`
        : `run it at the root of a checkout of Pult: the current folder holds neither .git nor ${MARKER}.`,
    );
  if (!NodeFS.existsSync(SELF)) fail(`run it at the root of Pult's checkout: ${SELF} is not here.`);
  if (!NodeFS.existsSync(VP)) fail(`${VP} is not here: run \`vp i\` first.`);
  const budgetTest = NodeFS.readFileSync(NodePath.join(SERVER, BUDGET_TEST), "utf8");
  if (budgetTest.split(BUDGET_CHECK).length !== 2)
    fail(`${SERVER}/${BUDGET_TEST} does not hold \`${BUDGET_CHECK}\` exactly once.`);
  if (git) {
    const status = run("git", ["status", "--porcelain", "--untracked-files=all"]);
    if (status !== "") fail(`the checkout is not clean; commit or remove first:\n${status}`);
  } else {
    const status = JSON.parse(run("xaxis", ["status", "--json"])) as {
      readonly changes: ReadonlyArray<{ readonly path: string; readonly kind: string }>;
      readonly conflict: unknown;
    };
    if (status.conflict !== null) fail("the checkout holds a conflict; resolve it first.");
    if (status.changes.length > 0)
      fail(
        `the checkout is not clean; commit or remove first:\n${status.changes.map((change) => `${change.kind} ${change.path}`).join("\n")}`,
      );
  }
}

function cut() {
  const files = listFiles();
  const writes = new Map<string, string>();
  const moves = new Map<string, string>();
  for (const path of files) {
    if (untouched(path)) continue;
    const read = textOf(path);
    if (path === KNIP && read?.split(KNIP_ENTRY).length !== 2)
      fail(`${KNIP} does not hold this script's entry exactly once; nothing was changed.`);
    const text = path === KNIP ? read?.replace(KNIP_ENTRY, "") : read;
    if (text !== undefined) {
      const written = isIgnoreFile(path)
        ? text.replace(/^#.*$/gm, (line) => rewrite(line))
        : rewrite(text);
      if (written !== read) writes.set(path, written);
    }
    const target = isIgnoreFile(path) ? path : newPath(path);
    if (target !== path) moves.set(path, target);
  }
  const targets = new Set<string>();
  for (const [path, target] of moves) {
    if (targets.has(target) || NodeFS.existsSync(target))
      fail(`renaming ${path} would overwrite ${target}; nothing was changed.`);
    targets.add(target);
  }
  for (const [path, text] of writes) NodeFS.writeFileSync(path, text);
  for (const [path, target] of moves) {
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.renameSync(path, target);
    for (
      let folder = NodePath.dirname(path);
      folder !== "." && NodeFS.readdirSync(folder).length === 0;
      folder = NodePath.dirname(folder)
    )
      NodeFS.rmdirSync(folder);
  }
  const written = [...writes.keys()].map((path) => moves.get(path) ?? path);
  run(VP, ["fmt", "--no-error-on-unmatched-pattern", ...written]);
  console.error(`monore-cut: ${writes.size} files rewritten, ${moves.size} renamed.`);
}

/** Every `xaxis` left outside the exclusions, `path` or `path:line: text`. */
function residue(): string[] {
  const lines: string[] = [];
  for (const path of listFiles()) {
    if (untouched(path)) continue;
    if (!isIgnoreFile(path) && path.replace(ANY, (word, kept) => kept ?? "") !== path)
      lines.push(path);
    const text = textOf(path);
    if (text === undefined) {
      if (/xaxis/i.test(NodeFS.readFileSync(path).toString("latin1")))
        lines.push(`${path}: binary, holds xaxis`);
      continue;
    }
    text.split(/\r?\n/).forEach((line, index) => {
      if (isIgnoreFile(path) && !line.startsWith("#")) return;
      if (line.replace(ANY, (word, kept) => kept ?? "") !== line)
        lines.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  return lines;
}

/** The budget measured on the cut tree and written, then the budget test run as it is. */
function measureBudget() {
  const test = NodeFS.readFileSync(NodePath.join(SERVER, BUDGET_TEST), "utf8");
  const measure = NodePath.join(SERVER, BUDGET_MEASURE);
  NodeFS.writeFileSync(
    measure,
    `import * as MeasureFS from "node:fs";\n${test.replace(BUDGET_CHECK, () => BUDGET_WRITE)}`,
  );
  const vp = NodePath.resolve(VP);
  const args = ["test", "run", BUDGET_MEASURE];
  const measured = spawn(vp, args, SERVER);
  NodeFS.rmSync(measure);
  refuseFailed(vp, args, measured);
  run(vp, ["test", "run", BUDGET_TEST], SERVER);
}

refuseDirtyCheckout();
cut();
measureBudget();
NodeFS.rmSync(SELF);
const left = residue();
for (const line of left) console.log(line);
console.error(
  left.length === 0 ? "monore-cut: no residue." : `monore-cut: ${left.length} lines of residue.`,
);
process.exit(left.length === 0 ? 0 : 1);
