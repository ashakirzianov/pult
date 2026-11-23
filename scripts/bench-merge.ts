// @effect-diagnostics nodeBuiltinImport:off globalConsole:off extendsNativeError:off - runs on the bench, which may have no `vp i`.
// An upstream merge from the bench, once Pult's code lives in xaxis: the mechanical steps
// of `pult/tasks/upstream-merges-from-the-bench.task` (pick 5, steps 1 to 5); `AGENTS.md`,
// "Upstream merges from the bench", is how to run it. Run it in the bench, a git clone
// whose `origin` is the mirror, with `upstream` and Pult's `rr-cache`:
//
//   node scripts/bench-merge.ts start [upstream-ref]   pin, merge, transfer, check
//   node scripts/bench-merge.ts continue               after resolving or fixing, where it stopped
//   node scripts/bench-merge.ts land                   commit with `Git-Parent:`, land, mirror, retire
//   node scripts/bench-merge.ts abort                  retire without landing
//
// The merge is `-X no-renames` (`pult/decisions`, `bench-merge-form`). One merge at a time:
// its state is `<git common dir>/bench-merge.json`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

type Step = "merge" | "check" | "land" | "finish";

interface State {
  readonly upstream: string;
  /** The mirror's `main` when pinned: the git commit `changeset` maps to. */
  readonly pinned: string;
  readonly changeset: string;
  readonly prefix: string;
  readonly server: string;
  /** The temporary git worktree, at `pinned`, where the merge is made. */
  readonly git: string;
  /** The xaxis checkout of `prefix` at `changeset`, where the merge is checked and landed. */
  readonly xaxis: string;
  readonly step: Step;
}

const STRIPPED = [
  ".repos",
  ".claude/skills",
  "apps/mobile/modules/t3-voice-transcription/ios/AppleSpeechEngine.swift",
];
const TYPECHECKED = ["apps/pult", "apps/web", "apps/server", "plugins/pult"];

class Stop extends Error {}

const stop = (lines: ReadonlyArray<string>): never => {
  throw new Stop(lines.join("\n"));
};

function run(
  cmd: string,
  args: ReadonlyArray<string>,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; allowFail?: boolean; inherit?: boolean },
): { status: number; stdout: string } {
  const result = NodeChildProcess.spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0 && !opts.allowFail) {
    stop([`bench-merge: \`${cmd} ${args.join(" ")}\` failed (exit ${status}) in ${opts.cwd}.`]);
  }
  return { status, stdout: result.stdout ?? "" };
}

const git = (cwd: string, ...args: string[]) => run("git", args, { cwd }).stdout.trim();
const xaxis = (cwd: string, ...args: string[]) =>
  run("xaxis", ["-C", cwd, ...args], { cwd }).stdout;

/**
 * Writes into `dir` what changed between git trees `from` and `to` of `repo`: each added or
 * changed file's committed bytes and executable bit, and each deletion. Nothing else in `dir`
 * is touched, so an xaxis checkout's marker and ignored files stay. A symlink or a gitlink in
 * the change is refused, since xaxis holds neither.
 */
export function transfer(repo: string, from: string, to: string, dir: string): number {
  const raw = run("git", ["diff-tree", "-r", "-z", "--no-renames", from, to], { cwd: repo }).stdout;
  const fields = raw.split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, newMode, , , status] = fields[i]!.slice(1).split(" ");
    if (status !== "D" && newMode !== "100644" && newMode !== "100755") {
      stop([
        `bench-merge: ${fields[i + 1]} has git mode ${newMode}; xaxis holds regular and executable files only.`,
      ]);
    }
  }
  let count = 0;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, newMode, , blob, status] = fields[i]!.slice(1).split(" ");
    const file = NodePath.join(dir, fields[i + 1]!);
    count += 1;
    if (status === "D") {
      NodeFS.rmSync(file);
      for (let parent = NodePath.dirname(file); parent !== dir; parent = NodePath.dirname(parent)) {
        if (NodeFS.readdirSync(parent).length > 0) break;
        NodeFS.rmdirSync(parent);
      }
      continue;
    }
    const bytes = NodeChildProcess.execFileSync("git", ["cat-file", "blob", blob!], {
      cwd: repo,
      maxBuffer: 1 << 30,
    });
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.rmSync(file, { force: true });
    NodeFS.writeFileSync(file, bytes);
    NodeFS.chmodSync(file, newMode === "100755" ? 0o755 : 0o644);
  }
  return count;
}

/** The merge's commit message, kept beside the worktrees for a land conflict's fix commit. */
const messagePath = (state: State) => NodePath.join(NodePath.dirname(state.git), "message.txt");

function statePath(bench: string): string {
  return NodePath.join(
    NodePath.resolve(bench, git(bench, "rev-parse", "--git-common-dir")),
    "bench-merge.json",
  );
}

function readState(bench: string): State {
  const file = statePath(bench);
  if (!NodeFS.existsSync(file)) stop(["bench-merge: no merge in progress; `start` begins one."]);
  return JSON.parse(NodeFS.readFileSync(file, "utf8")) as State;
}

function writeState(bench: string, state: State): State {
  NodeFS.writeFileSync(statePath(bench), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

/** Runs `xaxis mirror` and reads the mapping on `origin`'s `main`. */
function mirror(bench: string): {
  commit: string;
  changeset: string;
  prefix: string;
  server: string;
} {
  process.stdout.write(xaxis(bench, "mirror"));
  const commit = git(bench, "rev-parse", "refs/remotes/origin/main");
  const note = git(bench, "notes", "--ref=xaxis-mirror", "show", commit);
  const field = (name: string) => {
    const value = note.match(new RegExp(`^${name} (.+)$`, "m"))?.[1];
    if (!value)
      stop([`bench-merge: the mirror's note on ${commit} has no \`${name}\` line:`, note]);
    return value!;
  };
  return {
    commit,
    changeset: field("changeset"),
    prefix: `/${field("prefix")}`,
    server: field("server"),
  };
}

function start(bench: string, ref: string): void {
  if (NodeFS.existsSync(statePath(bench))) {
    stop([
      `bench-merge: a merge is in progress (${statePath(bench)}); \`continue\`, \`land\` or \`abort\` it first.`,
    ]);
  }
  // Step 1: export through a pinned tip; the mirror's `main` is the git commit it maps to.
  const pinned = mirror(bench);
  // Step 2: pin upstream's full hash.
  run("git", ["fetch", "upstream"], { cwd: bench, inherit: true });
  const upstream = git(bench, "rev-parse", "--verify", `${ref}^{commit}`);
  if (
    run("git", ["merge-base", "--is-ancestor", upstream, pinned.commit], {
      cwd: bench,
      allowFail: true,
    }).status === 0
  ) {
    stop([
      `bench-merge: ${upstream} is already merged into the mirror's ${pinned.commit}; nothing to do.`,
    ]);
  }
  const work = NodePath.join(
    NodePath.dirname(bench),
    `${NodePath.basename(bench)}-merge-${upstream.slice(0, 12)}`,
  );
  const state = writeState(bench, {
    upstream,
    pinned: pinned.commit,
    changeset: pinned.changeset,
    prefix: pinned.prefix,
    server: pinned.server,
    git: NodePath.join(work, "git"),
    xaxis: NodePath.join(work, "xaxis"),
    step: "merge",
  });
  console.log(
    `bench-merge: upstream ${upstream} onto ${pinned.commit} (${pinned.changeset}), in ${work}.`,
  );
  run("git", ["worktree", "add", "--detach", state.git, state.pinned], {
    cwd: bench,
    inherit: true,
  });
  run(
    "xaxis",
    ["checkout", state.prefix, state.xaxis, "--at", state.changeset, "--server", state.server],
    {
      cwd: bench,
      inherit: true,
    },
  );
  const merged = run(
    "git",
    [
      "-c",
      "rerere.enabled=true",
      "-c",
      "rerere.autoupdate=true",
      "merge",
      "--no-commit",
      "--no-ff",
      "-X",
      "no-renames",
      upstream,
    ],
    { cwd: state.git, allowFail: true, inherit: true },
  );
  const mergeHead = run("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
    cwd: state.git,
    allowFail: true,
  }).stdout.trim();
  if (merged.status > 1 || mergeHead !== upstream) {
    stop([
      `bench-merge: \`git merge\` exited ${merged.status} with no merge of ${upstream} in progress; \`abort\`.`,
    ]);
  }
  // Upstream keeps changing `.repos/`, which our tree no longer holds: its edits come back
  // as modify/delete conflicts, removed here with the rest.
  run("git", ["rm", "-r", "-q", "--cached", "--ignore-unmatch", ...STRIPPED], { cwd: state.git });
  for (const path of STRIPPED)
    NodeFS.rmSync(NodePath.join(state.git, path), { recursive: true, force: true });
  NodeFS.writeFileSync(
    NodePath.join(state.git, "docs/upstream/AGENTS.md"),
    NodeChildProcess.execFileSync("git", ["show", `${upstream}:AGENTS.md`], { cwd: state.git }),
  );
  run("git", ["add", "docs/upstream/AGENTS.md"], { cwd: state.git });
  console.log(
    `bench-merge: git merge exited ${merged.status}; ${STRIPPED.join(" and ")} removed, docs/upstream/AGENTS.md refreshed.`,
  );
  proceed(bench, state);
}

function proceed(bench: string, initial: State): void {
  // After the page run's fixes, `continue` checks again.
  let state: State = initial.step === "land" ? { ...initial, step: "check" } : initial;
  if (state.step === "finish") stop(["bench-merge: committed already; `land` finishes it."]);
  if (state.step === "merge") {
    const unmerged = git(state.git, "diff", "--name-only", "--diff-filter=U");
    if (unmerged) {
      stop([
        "bench-merge: STOPPED. Conflicts rerere did not resolve:",
        ...unmerged.split("\n").map((path) => `  ${path}`),
        `Resolve them in ${state.git} (the server's and the view's hook points), \`git add\` each, then \`continue\`.`,
      ]);
    }
    run("git", ["add", "-u"], { cwd: state.git });
    // The merge is never committed, so record the hand resolutions in `rr-cache` here.
    run("git", ["-c", "rerere.enabled=true", "rerere"], { cwd: state.git });
    const tree = git(state.git, "write-tree");
    if (tree === git(state.git, "rev-parse", `${state.pinned}^{tree}`)) {
      retire(bench, state);
      console.log(
        `bench-merge: upstream ${state.upstream} changes nothing in our tree; skipped, nothing landed. Remove ${state.xaxis}.`,
      );
      return;
    }
    // Step 3: never overlay the merge onto a checkout that moved from the pinned changeset.
    const status = JSON.parse(xaxis(state.xaxis, "status", "--json")) as {
      head: string;
      changes: unknown[];
      stack: unknown[];
    };
    if (status.head !== state.changeset || status.changes.length > 0 || status.stack.length > 0) {
      stop([
        `bench-merge: ${state.xaxis} is not a clean checkout of ${state.changeset}; transfer refused.`,
      ]);
    }
    const count = transfer(state.git, state.pinned, tree, state.xaxis);
    console.log(`bench-merge: ${count} paths transferred into ${state.xaxis}.`);
    state = writeState(bench, { ...state, step: "check" });
  }
  if (state.step === "check") {
    const setup = run("node", ["scripts/setup-worktree.ts"], {
      cwd: state.xaxis,
      env: { ...process.env, T3CODE_PROJECT_ROOT: bench },
      allowFail: true,
      inherit: true,
    });
    if (setup.status !== 0) {
      stop([
        "bench-merge: STOPPED. Setup failed; a stale lockfile is fixed by `vp i` there, and lands with the merge.",
        `Fix it in ${state.xaxis}, then \`continue\`.`,
      ]);
    }
    const missing = TYPECHECKED.filter(
      (dir) => !NodeFS.existsSync(NodePath.join(state.xaxis, dir)),
    );
    if (missing.length > 0)
      stop([`bench-merge: the merged tree has no ${missing.join(", ")} to typecheck.`]);
    const failed = TYPECHECKED.filter(
      (dir) =>
        run(NodePath.join(state.xaxis, "node_modules/.bin/vp"), ["run", "typecheck"], {
          cwd: NodePath.join(state.xaxis, dir),
          allowFail: true,
          inherit: true,
        }).status !== 0,
    );
    if (failed.length > 0) {
      stop([
        `bench-merge: STOPPED. Typecheck failed in ${failed.join(", ")}.`,
        `Fix it in ${state.xaxis} (fixes inside the merge are expected), then \`continue\`.`,
      ]);
    }
    state = writeState(bench, { ...state, step: "land" });
  }
  if (state.step === "land") {
    stop([
      "bench-merge: STOPPED. Setup and the four typechecks pass.",
      `Run the page against a dev server of ${state.xaxis} (apps/pult/AGENTS.md, Running), fix there`,
      "(`continue` re-runs the typechecks), then `land`.",
    ]);
  }
}

function land(bench: string, state: State): void {
  if (state.step === "land") {
    const status = JSON.parse(xaxis(state.xaxis, "status", "--json")) as {
      head: string;
      stack: unknown[];
    };
    if (status.head !== state.changeset || status.stack.length > 0) {
      stop([
        `bench-merge: ${state.xaxis} has moved from ${state.changeset} or holds commits; land it by hand.`,
      ]);
    }
    // Step 4: the trailer names upstream's own commit, the mapped commit's second parent.
    const message = [
      `Merge upstream ${state.upstream.slice(0, 10)} into main`,
      `Merged on the bench onto ${state.pinned.slice(0, 10)} with \`-X no-renames\`; ${STRIPPED.join(" and ")} removed.`,
      `Git-Parent: ${state.upstream}`,
    ].join("\n\n");
    NodeFS.writeFileSync(messagePath(state), message);
    process.stdout.write(xaxis(state.xaxis, "commit", "-m", message));
    state = writeState(bench, { ...state, step: "finish" });
    const landed = run("xaxis", ["-C", state.xaxis, "land"], {
      cwd: bench,
      allowFail: true,
      inherit: true,
    });
    if (landed.status !== 0) {
      stop([
        `bench-merge: STOPPED. \`xaxis land\` exited ${landed.status}.`,
        `On a conflict, resolve it in ${state.xaxis}, then commit there with this same message, or the trailer is lost:`,
        `  xaxis commit -m "$(cat ${messagePath(state)})" && xaxis land`,
        "then `land` again.",
      ]);
    }
  }
  if (state.step !== "finish")
    stop([`bench-merge: at step \`${state.step}\`; \`continue\` first.`]);
  // Step 5: export, and verify upstream is the second parent of exactly one new commit.
  const mirrored = mirror(bench);
  const merges = git(bench, "rev-list", "--parents", `${state.pinned}..${mirrored.commit}`)
    .split("\n")
    .map((line) => line.split(" "))
    .filter((parents) => parents[2] === state.upstream);
  if (merges.length !== 1) {
    stop([
      `bench-merge: ${merges.length} mirrored commits between ${state.pinned} and ${mirrored.commit} have ${state.upstream} as second parent; expected one. Nothing retired.`,
    ]);
  }
  retire(bench, state);
  console.log(
    `bench-merge: mirrored ${merges[0]![0]}, second parent ${state.upstream}. The xaxis checkout ${state.xaxis} is left; remove it when done.`,
  );
}

/** Retires the temporary worktree; its merge was never committed, so never pushed. */
function retire(bench: string, state: State): void {
  if (NodeFS.existsSync(state.git)) {
    run("git", ["worktree", "remove", "--force", state.git], { cwd: bench });
  }
  NodeFS.rmSync(statePath(bench));
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  // The bench, also when run from the temporary worktree.
  const bench = NodePath.dirname(
    git(process.cwd(), "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  switch (command) {
    case "start":
      return start(bench, rest[0] ?? "upstream/main");
    case "continue":
      return proceed(bench, readState(bench));
    case "land":
      return land(bench, readState(bench));
    case "abort": {
      const state = readState(bench);
      if (state.step === "finish") {
        stop(["bench-merge: committed already, and may have landed; `land` finishes it."]);
      }
      retire(bench, state);
      console.log(`bench-merge: aborted; the xaxis checkout ${state.xaxis} is left as it is.`);
      return;
    }
    default:
      stop(["usage: node scripts/bench-merge.ts start [upstream-ref] | continue | land | abort"]);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
