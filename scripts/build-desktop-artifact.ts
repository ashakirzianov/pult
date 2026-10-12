#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - hashes the WSL runtime and resolves native packages with Node.s own APIs.

import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";

import * as Identity from "@pult/shared/identity";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/pult-desktop/package.json" with { type: "json" };
import gnomeCaptureBundle from "../apps/pult-desktop/gnome-extension/bundle.json" with { type: "json" };

import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";
import {
  BRAND_ASSET_PATHS,
  resolveWebAssetBrandForChannel,
  type WebAssetBrand,
} from "./lib/brand-assets.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";
import { loadRepoEnv } from "./lib/public-config.ts";
import { selectDesktopRuntimeExternalDependencies } from "./lib/desktop-external-packages.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const LINUX_ICON_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512] as const;
const DESKTOP_APP_ID = Identity.APP_BUNDLE_ID;
// Pult has no releases of its own yet, and a feed taken from the environment
// (GITHUB_REPOSITORY in CI) could point the app at upstream's, whose update
// would replace Pult with T3 Code. Without a feed the app ships no
// app-update.yml and reports updates as unavailable.
const PULT_UPDATE_FEED_ENABLED = false;
// Repo-relative directory of the built client the packaged renderer serves;
// the desktop reads it at the same path (DesktopEnvironment.clientAssetsDir).
const CLIENT_DIST_DIR = "apps/pult/dist";
const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;

const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  // pnpm 11 only reads these from pnpm-workspace.yaml (not package.json#pnpm).
  // Without allowBuilds the staged `vp install --prod` fails with
  // ERR_PNPM_IGNORED_BUILDS for packages that have lifecycle scripts.
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  nodeLinker: Schema.optional(Schema.Literals(["hoisted"])),
});
type StageWorkspaceConfig = typeof StageWorkspaceConfig.Type;

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

interface DesktopBuildIconAssets {
  readonly macIconPng: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

export function resolveResourceMonitorRustTargets(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): ReadonlyArray<string> {
  if (platform === "mac") {
    if (arch === "universal") {
      return ["aarch64-apple-darwin", "x86_64-apple-darwin"];
    }
    return [arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
  }
  if (platform === "linux") {
    return [arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"];
  }
  return [arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"];
}

export function resourceMonitorExecutableName(platform: typeof BuildPlatform.Type): string {
  return platform === "win" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<number>;
  readonly wslRuntime: Option.Option<string>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

const getDefaultArch = Effect.fn("getDefaultArch")(function* (platform: typeof BuildPlatform.Type) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  return yield* getDefaultBuildArch(platform, config);
});

export class MacPasskeySigningConfigurationResolutionError extends Schema.TaggedError<MacPasskeySigningConfigurationResolutionError>()(
  "MacPasskeySigningConfigurationResolutionError",
  {
    cause: Schema.Defect(),
  },
) {
  static fromCause(
    cause: unknown,
  ): MacPasskeySigningConfigurationError | MacPasskeySigningConfigurationResolutionError {
    return isMacPasskeySigningConfigurationError(cause)
      ? cause
      : new MacPasskeySigningConfigurationResolutionError({ cause });
  }

  override get message(): string {
    return "Failed to resolve macOS passkey signing configuration.";
  }
}

export class KeyringNativePackageMissingError extends Schema.TaggedError<KeyringNativePackageMissingError>()(
  "KeyringNativePackageMissingError",
  {
    packageName: Schema.String,
    binaryFileName: Schema.String,
    packageEntryPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Keyring native package is missing: ${this.packageName}`;
  }
}

export class ClerkPasskeyNativePackageMissingError extends Schema.TaggedError<ClerkPasskeyNativePackageMissingError>()(
  "ClerkPasskeyNativePackageMissingError",
  {
    packageName: Schema.String,
    binaryFileName: Schema.String,
    packageEntryPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Clerk passkey native package is missing: ${this.packageName}`;
  }
}

export class UnsupportedHostBuildPlatformError extends Schema.TaggedError<UnsupportedHostBuildPlatformError>()(
  "UnsupportedHostBuildPlatformError",
  {
    hostPlatform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported host platform '${this.hostPlatform}'.`;
  }
}

export class UnsupportedDesktopBuildArchitectureError extends Schema.TaggedError<UnsupportedDesktopBuildArchitectureError>()(
  "UnsupportedDesktopBuildArchitectureError",
  {
    platform: BuildPlatform,
    arch: BuildArch,
    supportedArchitectures: Schema.Array(BuildArch),
  },
) {
  override get message(): string {
    return `Unsupported architecture '${this.arch}' for ${this.platform}.`;
  }
}

const InvalidMockUpdateServerPortReason = Schema.Literals([
  "not-numeric",
  "not-integer",
  "out-of-range",
]);

export class InvalidMockUpdateServerPortError extends Schema.TaggedError<InvalidMockUpdateServerPortError>()(
  "InvalidMockUpdateServerPortError",
  {
    reason: InvalidMockUpdateServerPortReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid mock update server port.";
  }

  static fromConfigValue(configuredPort: string, cause: unknown) {
    return new InvalidMockUpdateServerPortError({
      reason: invalidMockUpdateServerPortReason(configuredPort),
      inputLength: configuredPort.length,
      cause,
    });
  }
}

export class BuildCommandFailedError extends Schema.TaggedError<BuildCommandFailedError>()(
  "BuildCommandFailedError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    stdoutTail: Schema.optionalKey(Schema.String),
    stderrTail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const outputSections = [
      `Command: ${this.command}`,
      formatOutputSection("stdout", this.stdoutTail ?? ""),
      formatOutputSection("stderr", this.stderrTail ?? ""),
    ].filter((section): section is string => section !== undefined);
    const outputSuffix = outputSections.length > 0 ? `\n\n${outputSections.join("\n\n")}` : "";
    return `Command exited with non-zero exit code (${this.exitCode})${outputSuffix}`;
  }
}

export const LINUX_DESKTOP_BUILD_PREREQUISITES = [
  { id: "cargo", description: "Rust compiler and Cargo", packages: ["cargo", "rustc"] },
  { id: "rust-target", description: "Requested Rust standard library", packages: [] },
  { id: "cc", description: "C/C++ build toolchain", packages: ["build-essential"] },
  { id: "make", description: "Make", packages: ["build-essential"] },
  {
    id: "libsecret",
    description: "libsecret development headers and pkg-config",
    packages: ["libsecret-1-dev", "pkg-config"],
  },
  { id: "imagemagick", description: "ImageMagick", packages: ["imagemagick"] },
] as const;

export class LinuxDesktopBuildPrerequisitesMissingError extends Schema.TaggedError<LinuxDesktopBuildPrerequisitesMissingError>()(
  "LinuxDesktopBuildPrerequisitesMissingError",
  {
    missing: Schema.Array(Schema.String),
    rustTarget: Schema.String,
  },
) {
  override get message(): string {
    const missingRequirements = LINUX_DESKTOP_BUILD_PREREQUISITES.filter((requirement) =>
      this.missing.includes(requirement.id),
    );
    const details = missingRequirements
      .map((requirement) =>
        requirement.packages.length > 0
          ? `  - ${requirement.description} (${requirement.packages.join(", ")})`
          : `  - ${requirement.description}`,
      )
      .join("\n");
    const packages = [
      ...new Set(missingRequirements.flatMap((requirement) => requirement.packages)),
    ];
    return [
      "Linux desktop build prerequisites are missing:",
      details,
      "",
      ...(packages.length > 0
        ? ["On Ubuntu/Debian, install them with:", `  sudo apt-get install ${packages.join(" ")}`]
        : []),
      ...(this.missing.includes("rust-target")
        ? ["Add the requested Rust target with:", `  rustup target add ${this.rustTarget}`]
        : []),
      "",
      "For other distributions, see docs/operations/development.md#linux-appimage-prerequisites.",
      "Then rerun `vp run dist:desktop:linux`.",
    ].join("\n");
  }
}

const MAC_DESKTOP_BUILD_PREREQUISITES = [
  { id: "rust", description: "Rust/Cargo and the requested Rust target" },
  { id: "clang", description: "Xcode Command Line Tools (clang)" },
  { id: "make", description: "Xcode Command Line Tools (make)" },
  { id: "sips", description: "macOS image tool (sips)" },
  { id: "iconutil", description: "macOS icon tool (iconutil)" },
  { id: "lipo", description: "Xcode universal-binary tool (lipo)" },
] as const;

export class MacDesktopBuildPrerequisitesMissingError extends Schema.TaggedError<MacDesktopBuildPrerequisitesMissingError>()(
  "MacDesktopBuildPrerequisitesMissingError",
  {
    missing: Schema.Array(Schema.String),
    rustTargets: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const details = MAC_DESKTOP_BUILD_PREREQUISITES.filter((requirement) =>
      this.missing.includes(requirement.id),
    )
      .map((requirement) => `  - ${requirement.description}`)
      .join("\n");
    return [
      "macOS desktop build prerequisites are missing:",
      details,
      "",
      "Install Apple's build tools with:",
      "  xcode-select --install",
      "Install Rust from https://rustup.rs, then add the requested target(s):",
      `  rustup target add ${this.rustTargets.join(" ")}`,
      "",
      "Then rerun the desktop artifact command.",
    ].join("\n");
  }
}

const WINDOWS_DESKTOP_BUILD_PREREQUISITES = [
  { id: "rust", description: "Rust/Cargo and the requested MSVC Rust target" },
  { id: "python", description: "Python 3 for node-gyp" },
  {
    id: "msvc",
    description: "Visual Studio Build Tools with C++, Windows SDK, and Spectre libraries",
  },
  { id: "tar", description: "tar to inspect the bundled WSL runtime archive" },
] as const;

export class WindowsDesktopBuildPrerequisitesMissingError extends Schema.TaggedError<WindowsDesktopBuildPrerequisitesMissingError>()(
  "WindowsDesktopBuildPrerequisitesMissingError",
  {
    missing: Schema.Array(Schema.String),
    rustTarget: Schema.String,
  },
) {
  override get message(): string {
    const details = WINDOWS_DESKTOP_BUILD_PREREQUISITES.filter((requirement) =>
      this.missing.includes(requirement.id),
    )
      .map((requirement) => `  - ${requirement.description}`)
      .join("\n");
    return [
      "Windows desktop build prerequisites are missing:",
      details,
      "",
      "Install Rust from https://rustup.rs and add the requested target:",
      `  rustup target add ${this.rustTarget}`,
      "Install Python 3 and the Visual Studio Build Tools components listed in",
      "docs/operations/development.md#windows-installer-prerequisites.",
      "",
      "Then rerun the desktop artifact command.",
    ].join("\n");
  }
}

export class ResourceMonitorBuildOutputMissingError extends Schema.TaggedError<ResourceMonitorBuildOutputMissingError>()(
  "ResourceMonitorBuildOutputMissingError",
  {
    binaryPath: Schema.String,
    rustTarget: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Resource monitor build for ${this.rustTarget} did not produce ${this.binaryPath}.`;
  }
}

const desktopIconPlatformNames = {
  mac: "macOS",
  linux: "Linux",
  win: "Windows",
} satisfies Record<typeof BuildPlatform.Type, string>;

export class LinuxBrowserSecretHostError extends Schema.TaggedError<LinuxBrowserSecretHostError>()(
  "LinuxBrowserSecretHostError",
  { hostPlatform: Schema.String },
) {
  override get message(): string {
    return `Linux desktop builds must run on a Linux host: the browser secret helper links against libsecret and cannot be built on '${this.hostPlatform}'.`;
  }
}

export class DesktopIconSourceMissingError extends Schema.TaggedError<DesktopIconSourceMissingError>()(
  "DesktopIconSourceMissingError",
  {
    platform: BuildPlatform,
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop ${desktopIconPlatformNames[this.platform]} icon source is missing at ${this.sourcePath}`;
  }
}

export class DesktopDmgBackgroundSourceMissingError extends Schema.TaggedError<DesktopDmgBackgroundSourceMissingError>()(
  "DesktopDmgBackgroundSourceMissingError",
  {
    channel: Schema.Literals(["latest", "nightly"]),
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop ${this.channel} DMG background source is missing at ${this.sourcePath}`;
  }
}

export class BundledClientAssetsMissingError extends Schema.TaggedError<BundledClientAssetsMissingError>()(
  "BundledClientAssetsMissingError",
  {
    indexPath: Schema.String,
    missingFiles: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const preview = this.missingFiles.slice(0, 6).join(", ");
    const suffix = this.missingFiles.length > 6 ? ` (+${this.missingFiles.length - 6} more)` : "";
    return `Bundled client references missing files in ${this.indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`;
  }
}

export class UnsupportedDesktopBuildPlatformError extends Schema.TaggedError<UnsupportedDesktopBuildPlatformError>()(
  "UnsupportedDesktopBuildPlatformError",
  {
    platform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported platform '${this.platform}'.`;
  }
}

const dependencyResolutionDescriptions = {
  "workspace-overrides": "overrides",
  "desktop-runtime": "desktop runtime dependencies",
} as const;
const DependencyResolutionKind = Schema.Literals(["workspace-overrides", "desktop-runtime"]);

export class DesktopBuildDependencyResolutionError extends Schema.TaggedError<DesktopBuildDependencyResolutionError>()(
  "DesktopBuildDependencyResolutionError",
  {
    kind: DependencyResolutionKind,
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not resolve ${dependencyResolutionDescriptions[this.kind]} from ${this.manifestPath}.`;
  }
}

const DesktopBuildInputArtifact = Schema.Literals([
  "desktop-dist",
  "desktop-resources",
  "bundled-client",
]);
type DesktopBuildInputArtifact = typeof DesktopBuildInputArtifact.Type;
const desktopBuildInputArtifactNames = {
  "desktop-dist": "desktopDist",
  "desktop-resources": "desktopResources",
  "bundled-client": "bundled client",
} satisfies Record<DesktopBuildInputArtifact, string>;

export class MissingDesktopBuildInputError extends Schema.TaggedError<MissingDesktopBuildInputError>()(
  "MissingDesktopBuildInputError",
  {
    artifact: DesktopBuildInputArtifact,
    artifactPath: Schema.String,
    buildCommand: Schema.Literal("vp run build:desktop"),
  },
) {
  override get message(): string {
    return `Missing ${desktopBuildInputArtifactNames[this.artifact]} at ${this.artifactPath}. Run '${this.buildCommand}' first.`;
  }
}

export class MacProvisioningProfileNotFoundError extends Schema.TaggedError<MacProvisioningProfileNotFoundError>()(
  "MacProvisioningProfileNotFoundError",
  {
    provisioningProfilePath: Schema.String,
  },
) {
  override get message(): string {
    return `macOS provisioning profile not found: ${this.provisioningProfilePath}`;
  }
}

export class DesktopBuildDistDirectoryMissingError extends Schema.TaggedError<DesktopBuildDistDirectoryMissingError>()(
  "DesktopBuildDistDirectoryMissingError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but dist directory was not found at ${this.distPath}`;
  }
}

export class DesktopBuildNoArtifactsProducedError extends Schema.TaggedError<DesktopBuildNoArtifactsProducedError>()(
  "DesktopBuildNoArtifactsProducedError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but no files were produced in ${this.distPath}`;
  }
}

export class WslRuntimeArchiveMissingError extends Schema.TaggedError<WslRuntimeArchiveMissingError>()(
  "WslRuntimeArchiveMissingError",
  {
    archivePath: Schema.String,
  },
) {
  override get message(): string {
    return `WSL runtime archive not found at ${this.archivePath}.`;
  }
}

export class LinuxIconResizeError extends Schema.TaggedError<LinuxIconResizeError>()(
  "LinuxIconResizeError",
  {
    operation: Schema.Literal("resize"),
    iconSize: Schema.Int,
    primaryTool: Schema.Literal("magick"),
    fallbackTool: Schema.Literal("convert"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the Linux desktop icon to ${this.iconSize}x${this.iconSize} with \`${this.primaryTool}\` or \`${this.fallbackTool}\`. Install ImageMagick so either tool is available.`;
  }
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const COMMAND_OUTPUT_TAIL_LENGTH = 20_000;

function appendOutputTail(acc: string, chunk: string): string {
  const next = acc + chunk;
  return next.length > COMMAND_OUTPUT_TAIL_LENGTH ? next.slice(-COMMAND_OUTPUT_TAIL_LENGTH) : next;
}

function formatOutputSection(label: string, output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return `${label} tail:\n${trimmed}`;
}

const collectCommandStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  output: NodeJS.WriteStream,
  verbose: boolean,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => "",
      (acc, chunk) =>
        Effect.as(
          verbose ? Effect.sync(() => output.write(chunk)) : Effect.void,
          appendOutputTail(acc, chunk),
        ),
    ),
  );

const spawnAndCollectOutput = Effect.fn("spawnAndCollectOutput")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } as const;
});

const resolveGitCommitHash = Effect.fn("resolveGitCommitHash")(function* (repoRoot: string) {
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoRoot,
    }),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (result.exitCode !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
});

const resolvePythonForNodeGyp = Effect.fn("resolvePythonForNodeGyp")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcessPlatform;
  const env = yield* Config.all({
    configuredPython: Config.String("npm_config_python").pipe(
      Config.orElse(() => Config.String("PYTHON")),
      Config.option,
    ),
    localAppData: Config.String("LOCALAPPDATA").pipe(Config.option),
  });
  const isPython3 = (candidate: string) =>
    spawnAndCollectOutput(
      ChildProcess.make(candidate, [
        "-c",
        "import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)",
      ]),
    ).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );
  const configured = Option.getOrUndefined(env.configuredPython);
  if (configured && (yield* fs.exists(configured)) && (yield* isPython3(configured))) {
    return configured;
  }

  if (hostPlatform === "win32") {
    const localAppData = Option.getOrUndefined(env.localAppData);
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = path.join(localAppData, "Programs", "Python", version, "python.exe");
        if ((yield* fs.exists(candidate)) && (yield* isPython3(candidate))) {
          return candidate;
        }
      }
    }
  }

  const probe = yield* spawnAndCollectOutput(
    ChildProcess.make("python", ["-c", "import sys;print(sys.executable)"]),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (probe.exitCode !== 0) {
    return undefined;
  }

  const executable = probe.stdout.trim();
  if (!executable || !(yield* fs.exists(executable)) || !(yield* isPython3(executable))) {
    return undefined;
  }

  return executable;
});

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: number | undefined;
  readonly wslRuntime: string | undefined;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly t3codeCommitHash: string;
  readonly private: true;
  readonly packageManager: string;
  readonly description: string;
  readonly license: string;
  readonly homepage: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
}

export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;
export const DESKTOP_ELECTRON_LANGUAGES = ["en-US"] as const;
export const DESKTOP_FILE_EXCLUSIONS = [
  // T3 Code always passes the user's installed Claude executable to the SDK,
  // so the SDK's optional platform packages (each a ~200MB bundled executable)
  // are dead weight. The trailing dash keeps the SDK's own JS package.
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
  // Nothing in the packaged app enables source maps or serves them: the web
  // client's maps alone were 50 MB of app.asar that no request ever read.
  "!**/*.map",
  "!**/*.d.cts",
  "!apps/pult-desktop/resources/browser-secret",
  "!apps/pult-desktop/resources/browser-secret/**/*",
  "!apps/pult-desktop/prod-resources/browser-secret",
  "!apps/pult-desktop/prod-resources/browser-secret/**/*",
  // The WSL runtime is staged below prod-resources so electron-builder can copy
  // it using project-relative extraResources matchers. Keep it out of app.asar;
  // it is emitted once at resources/.
  "!apps/pult-desktop/prod-resources/wsl-runtime.tar.gz",
  "!apps/pult-desktop/prod-resources/wsl-runtime.tar.gz.sha256",
  "!apps/pult-desktop/gnome-extension",
  "!apps/pult-desktop/gnome-extension/**/*",
] as const;
// Windows terminal helpers cannot run on macOS and slow signing and notarization.
export const MAC_FILE_EXCLUSIONS = [
  "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
  "!**/node_modules/node-pty/third_party/conpty/**/*",
] as const;
// Linux builds node-pty from source, so every prebuild in the package is for
// another platform (58 MB of it Windows debug symbols).
export const LINUX_FILE_EXCLUSIONS = [
  ...MAC_FILE_EXCLUSIONS,
  "!**/node_modules/node-pty/prebuilds/darwin-*/**/*",
] as const;

// node-pty publishes both Darwin prebuilds in one package. Single-architecture
// apps only need the native target; universal apps need both. An omitted arch
// preserves the existing common exclusions for callers that only inspect the
// generic platform config.
export function resolveMacFileExclusions(arch?: typeof BuildArch.Type) {
  if (arch === undefined || arch === "universal") {
    return [...MAC_FILE_EXCLUSIONS];
  }

  const unusedArch = arch === "arm64" ? "x64" : "arm64";
  return [...MAC_FILE_EXCLUSIONS, `!**/node_modules/node-pty/prebuilds/darwin-${unusedArch}/**/*`];
}
// dlopen/spawn need real files, so native modules, shared libraries, and
// helper executables live in app.asar's .unpacked sibling (the standard asar
// redirect convention). Everything else stays packed.
export const WINDOWS_NATIVE_ASAR_UNPACK_GLOB =
  "{**/*.node,**/*.dll,**/*.exe,**/*.so,**/*.so.*,**/*.dylib}";
export const WSL_RUNTIME_ARCHIVE_NAME = "wsl-runtime.tar.gz";
export const WSL_RUNTIME_ARCHIVE_HASH_NAME = `${WSL_RUNTIME_ARCHIVE_NAME}.sha256`;
export const WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE = {
  from: `apps/pult-desktop/prod-resources/${WSL_RUNTIME_ARCHIVE_NAME}`,
  to: WSL_RUNTIME_ARCHIVE_NAME,
} as const;
export const WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE = {
  from: `apps/pult-desktop/prod-resources/${WSL_RUNTIME_ARCHIVE_HASH_NAME}`,
  to: WSL_RUNTIME_ARCHIVE_HASH_NAME,
} as const;

// The WSL runtime is the Linux CLI release archive (t3-<version>-linux-<arch>
// .tar.gz, built by scripts/build-cli-archive.ts) copied in verbatim, so WSL
// runs the exact bytes a Linux user downloads. This one predicate decides both
// whether the archive is staged and whether the packaging config ships it:
// listing an extraResource whose source was never written fails electron-builder.
export const bundlesWslRuntime = (input: {
  readonly platform: typeof BuildPlatform.Type;
  readonly runtimeArchivePath: string | undefined;
}): boolean => input.platform === "win" && input.runtimeArchivePath !== undefined;

export const WSL_RUNTIME_EXTRA_RESOURCES = [
  WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE,
] as const;
export const DESKTOP_EXTRA_RESOURCES = [
  {
    from: "apps/pult-desktop/prod-resources/resource-monitor",
    to: "resource-monitor",
  },
] as const;
export const LINUX_CAPTURE_EXTRA_RESOURCES = [
  {
    from: "apps/pult-desktop/prod-resources/hyprland-capture",
    to: "hyprland-capture",
  },
  {
    from: "apps/pult-desktop/prod-resources/kde-capture",
    to: "kde-capture",
  },
  {
    from: "apps/pult-desktop/gnome-extension",
    to: "gnome-extension",
    filter: gnomeCaptureBundle.files,
  },
] as const;
export const LINUX_BROWSER_SECRET_EXTRA_RESOURCES = [
  { from: "apps/pult-desktop/prod-resources/browser-secret", to: "browser-secret" },
] as const;

export interface MacPasskeySigningConfiguration {
  readonly appId: string;
  readonly teamId: string;
  readonly rpDomains: readonly string[];
  readonly provisioningProfilePath: string;
}

export const InvalidMacPasskeyRpDomainReason = Schema.Literals([
  "empty",
  "scheme-not-allowed",
  "parse-failed",
  "credentials-not-allowed",
  "port-not-allowed",
  "path-not-allowed",
  "query-not-allowed",
  "fragment-not-allowed",
  "hostname-mismatch",
]);
export type InvalidMacPasskeyRpDomainReason = typeof InvalidMacPasskeyRpDomainReason.Type;

export class InvalidMacPasskeyRpDomainError extends Schema.TaggedError<InvalidMacPasskeyRpDomainError>()(
  "InvalidMacPasskeyRpDomainError",
  {
    reason: InvalidMacPasskeyRpDomainReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Invalid passkey RP domain (${this.reason}).`;
  }
}

export class InvalidAppleTeamIdError extends Schema.TaggedError<InvalidAppleTeamIdError>()(
  "InvalidAppleTeamIdError",
  {
    teamId: Schema.String,
  },
) {
  override get message(): string {
    return `T3CODE_APPLE_TEAM_ID '${this.teamId}' must be a 10-character Apple Developer Team ID.`;
  }
}

export class MissingMacPasskeyProvisioningProfileError extends Schema.TaggedError<MissingMacPasskeyProvisioningProfileError>()(
  "MissingMacPasskeyProvisioningProfileError",
  {},
) {
  override get message(): string {
    return "T3CODE_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.";
  }
}

export class MissingMacPasskeyDomainConfigurationError extends Schema.TaggedError<MissingMacPasskeyDomainConfigurationError>()(
  "MissingMacPasskeyDomainConfigurationError",
  {},
) {
  override get message(): string {
    return "T3CODE_CLERK_PUBLISHABLE_KEY or T3CODE_CLERK_PASSKEY_RP_DOMAINS is required for signed macOS passkey builds.";
  }
}

export class InvalidMacPasskeyPublishableKeyError extends Schema.TaggedError<InvalidMacPasskeyPublishableKeyError>()(
  "InvalidMacPasskeyPublishableKeyError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "T3CODE_CLERK_PUBLISHABLE_KEY is invalid.";
  }
}

export class MissingMacPasskeyRpDomainError extends Schema.TaggedError<MissingMacPasskeyRpDomainError>()(
  "MissingMacPasskeyRpDomainError",
  {},
) {
  override get message(): string {
    return "At least one Clerk passkey RP domain is required.";
  }
}

export const MacPasskeySigningConfigurationError = Schema.Union([
  InvalidMacPasskeyRpDomainError,
  InvalidAppleTeamIdError,
  MissingMacPasskeyProvisioningProfileError,
  MissingMacPasskeyDomainConfigurationError,
  InvalidMacPasskeyPublishableKeyError,
  MissingMacPasskeyRpDomainError,
]);
export type MacPasskeySigningConfigurationError = typeof MacPasskeySigningConfigurationError.Type;
export const isMacPasskeySigningConfigurationError = Schema.is(MacPasskeySigningConfigurationError);

function normalizePasskeyRpDomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  const inputLength = value.length;
  if (normalized.length === 0) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "empty", inputLength });
  }
  if (/^[a-z][a-z\d+.-]*:\/\//u.test(normalized)) {
    throw new InvalidMacPasskeyRpDomainError({
      reason: "scheme-not-allowed",
      inputLength,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch (cause) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "parse-failed", inputLength, cause });
  }

  let reason: InvalidMacPasskeyRpDomainReason | undefined;
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    reason = "credentials-not-allowed";
  } else if (parsed.port.length > 0) {
    reason = "port-not-allowed";
  } else if (parsed.pathname !== "/") {
    reason = "path-not-allowed";
  } else if (parsed.search.length > 0) {
    reason = "query-not-allowed";
  } else if (parsed.hash.length > 0) {
    reason = "fragment-not-allowed";
  } else if (parsed.host !== normalized) {
    reason = "hostname-mismatch";
  }
  if (reason) {
    throw new InvalidMacPasskeyRpDomainError({ reason, inputLength });
  }

  return parsed.hostname;
}

export function resolveMacPasskeySigningConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): MacPasskeySigningConfiguration {
  const teamId = env.T3CODE_APPLE_TEAM_ID?.trim().toUpperCase() ?? "";
  if (!APPLE_TEAM_ID_PATTERN.test(teamId)) {
    throw new InvalidAppleTeamIdError({ teamId });
  }

  const provisioningProfilePath = env.T3CODE_MACOS_PROVISIONING_PROFILE?.trim() ?? "";
  if (provisioningProfilePath.length === 0) {
    throw new MissingMacPasskeyProvisioningProfileError();
  }

  const configuredRpDomains = env.T3CODE_CLERK_PASSKEY_RP_DOMAINS?.trim();
  let rpDomains: readonly string[];
  if (configuredRpDomains) {
    rpDomains = configuredRpDomains.split(",").map(normalizePasskeyRpDomain);
  } else {
    const publishableKey = env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim();
    if (!publishableKey) {
      throw new MissingMacPasskeyDomainConfigurationError();
    }
    let hostname: string;
    try {
      hostname = clerkFrontendApiHostnameFromPublishableKey(publishableKey);
    } catch (cause) {
      throw new InvalidMacPasskeyPublishableKeyError({ cause });
    }
    rpDomains = [normalizePasskeyRpDomain(hostname)];
  }

  const uniqueRpDomains = [...new Set(rpDomains)];
  if (uniqueRpDomains.length === 0) {
    throw new MissingMacPasskeyRpDomainError();
  }

  return {
    appId: DESKTOP_APP_ID,
    teamId,
    rpDomains: uniqueRpDomains,
    provisioningProfilePath,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderMacPasskeyEntitlements(
  configuration: MacPasskeySigningConfiguration,
): string {
  const associatedDomains = configuration.rpDomains
    .map((domain) => `      <string>webcredentials:${escapeXml(domain)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.application-identifier</key>
    <string>${escapeXml(`${configuration.teamId}.${configuration.appId}`)}</string>
    <key>com.apple.developer.team-identifier</key>
    <string>${escapeXml(configuration.teamId)}</string>
    <key>com.apple.developer.associated-domains</key>
    <array>
${associatedDomains}
    </array>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
  </dict>
</plist>
`;
}

export interface ClerkPasskeyNativeArtifact {
  readonly packageName: string;
  readonly binaryFileName: string;
}

export function resolveClerkPasskeyNativeArtifacts(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return architectures.map((architecture) => ({
      packageName: `@clerk/electron-passkeys-darwin-${architecture}`,
      binaryFileName: `electron-passkeys.darwin-${architecture}.node`,
    }));
  }

  if (platform === "win") {
    return architectures.map((architecture) => ({
      packageName: `@clerk/electron-passkeys-win32-${architecture}-msvc`,
      binaryFileName: `electron-passkeys.win32-${architecture}-msvc.node`,
    }));
  }

  return [];
}

export function resolveKeyringNativeArtifacts(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return architectures.map((architecture) => ({
      packageName: `@napi-rs/keyring-darwin-${architecture}`,
      binaryFileName: `keyring.darwin-${architecture}.node`,
    }));
  }

  if (platform === "win") {
    return architectures.map((architecture) => ({
      packageName: `@napi-rs/keyring-win32-${architecture}-msvc`,
      binaryFileName: `keyring.win32-${architecture}-msvc.node`,
    }));
  }

  return architectures.map((architecture) => ({
    packageName: `@napi-rs/keyring-linux-${architecture}-gnu`,
    binaryFileName: `keyring.linux-${architecture}-gnu.node`,
  }));
}

/**
 * Same nesting problem as the Clerk passkey binaries: pnpm keeps the platform
 * package under `@napi-rs/keyring`, electron-builder only retains collected
 * top-level dependencies, and the generated loader checks for a sibling
 * `keyring.<platform>.node` before falling back to the package. Staging the
 * binary beside `index.js` lets that first branch win.
 */
const stageKeyringNativeBinaries = Effect.fn("stageKeyringNativeBinaries")(function* (
  stageAppDir: string,
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageEntryPath = yield* fs.realPath(
    path.join(stageAppDir, "node_modules", "@napi-rs", "keyring", "index.js"),
  );
  const packageDir = path.dirname(packageEntryPath);
  const packageRequire = NodeModule.createRequire(packageEntryPath);

  for (const artifact of resolveKeyringNativeArtifacts(platform, arch)) {
    const sourcePath = yield* Effect.try({
      try: () => packageRequire.resolve(`${artifact.packageName}/${artifact.binaryFileName}`),
      catch: (cause) =>
        new KeyringNativePackageMissingError({
          packageName: artifact.packageName,
          binaryFileName: artifact.binaryFileName,
          packageEntryPath,
          platform,
          arch,
          cause,
        }),
    });
    yield* fs.copyFile(sourcePath, path.join(packageDir, artifact.binaryFileName));
  }
});

// pnpm nests the architecture package under @clerk/electron-passkeys, while electron-builder only
// retains collected top-level dependencies. The SDK loader checks beside index.js first, so stage
// the binary there and let electron-builder's native-addon handling unpack it from the ASAR.
const stageClerkPasskeyNativeBinaries = Effect.fn("stageClerkPasskeyNativeBinaries")(function* (
  stageAppDir: string,
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageEntryPath = yield* fs.realPath(
    path.join(stageAppDir, "node_modules", "@clerk", "electron-passkeys", "index.js"),
  );
  const packageDir = path.dirname(packageEntryPath);
  const packageRequire = NodeModule.createRequire(packageEntryPath);

  for (const artifact of resolveClerkPasskeyNativeArtifacts(platform, arch)) {
    const sourcePath = yield* Effect.try({
      try: () => packageRequire.resolve(artifact.packageName),
      catch: (cause) =>
        new ClerkPasskeyNativePackageMissingError({
          packageName: artifact.packageName,
          binaryFileName: artifact.binaryFileName,
          packageEntryPath,
          platform,
          arch,
          cause,
        }),
    });
    yield* fs.copyFile(sourcePath, path.join(packageDir, artifact.binaryFileName));
  }
});

export function createStageWorkspaceConfig(input: {
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}): StageWorkspaceConfig {
  const { platform, arch, allowBuilds, patchedDependencies, overrides } = input;
  const hostOs = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  const hostCpu = arch === "universal" ? ["arm64", "x64"] : [arch];
  // Linux AppImages execute a Linux/glibc Node process that loads
  // Linux-native optional deps at runtime. Keep libc explicit so pnpm
  // includes those optional packages in the staged production install.
  const supportedArchitectures =
    platform === "linux"
      ? {
          os: [hostOs],
          cpu: hostCpu,
          libc: ["glibc"],
        }
      : {
          os: [hostOs],
          cpu: hostCpu,
        };

  return {
    supportedArchitectures,
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

const AzureTrustedSigningOptionsConfig = Config.all({
  publisherName: Config.String("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  endpoint: Config.String("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: Config.String("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  codeSigningAccountName: Config.String("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: Config.String("AZURE_TRUSTED_SIGNING_FILE_DIGEST").pipe(Config.withDefault("SHA256")),
  timestampDigest: Config.String("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST").pipe(
    Config.withDefault("SHA256"),
  ),
  timestampRfc3161: Config.String("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161").pipe(
    Config.withDefault("http://timestamp.acs.microsoft.com"),
  ),
});

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "T3CODE_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.String("T3CODE_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "T3CODE_DESKTOP_ARCH").pipe(Config.option),
  version: Config.String("T3CODE_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.String("T3CODE_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.Boolean("T3CODE_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.Boolean("T3CODE_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  signed: Config.Boolean("T3CODE_DESKTOP_SIGNED").pipe(Config.withDefault(false)),
  verbose: Config.Boolean("T3CODE_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
  mockUpdates: Config.Boolean("T3CODE_DESKTOP_MOCK_UPDATES").pipe(Config.withDefault(false)),
  mockUpdateServerPort: Config.String("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
  // Path to the Linux CLI release archive (t3-<version>-linux-x64.tar.gz) built
  // by the build_linux_cli CI job. The Windows build embeds it verbatim as the
  // WSL runtime.
  wslRuntime: Config.String("T3CODE_DESKTOP_WSL_RUNTIME").pipe(Config.option),
});

const MockUpdateServerPortSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);
const decodeMockUpdateServerPort = Schema.decodeUnknownEffect(MockUpdateServerPortSchema);

function invalidMockUpdateServerPortReason(
  configuredPort: string,
): typeof InvalidMockUpdateServerPortReason.Type {
  const parsed = Number(configuredPort);
  if (!Number.isFinite(parsed)) return "not-numeric";
  if (!Number.isInteger(parsed)) return "not-integer";
  if (parsed < 1 || parsed > 65535) return "out-of-range";
  // This mapper is only called after schema decoding failed. An otherwise
  // valid integer therefore used a representation the decoder did not accept.
  return "not-numeric";
}

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

export const resolveMockUpdateServerPort = Effect.fn("resolveMockUpdateServerPort")(function* (
  mockUpdateServerPort: string | undefined,
) {
  const port = mockUpdateServerPort?.trim();
  if (!port) {
    return undefined;
  }

  return yield* decodeMockUpdateServerPort(port);
});

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig;
  const hostPlatform = yield* HostProcessPlatform;

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(hostPlatform),
  );

  if (!platform) {
    return yield* new UnsupportedHostBuildPlatformError({ hostPlatform });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const defaultArch = yield* getDefaultArch(platform);
  const arch = mergeOptions(input.arch, env.arch, defaultArch);
  const supportedArchitectures = PLATFORM_CONFIG[platform].archChoices;
  if (!supportedArchitectures.includes(arch)) {
    return yield* new UnsupportedDesktopBuildArchitectureError({
      platform,
      arch,
      supportedArchitectures: [...supportedArchitectures],
    });
  }
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const releaseDir = resolveBooleanFlag(input.mockUpdates, env.mockUpdates)
    ? "release-mock"
    : "release";
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, env.outputDir, releaseDir),
  );

  const skipBuild = resolveBooleanFlag(input.skipBuild, env.skipBuild);
  const keepStage = resolveBooleanFlag(input.keepStage, env.keepStage);
  const signed = resolveBooleanFlag(input.signed, env.signed);
  const verbose = resolveBooleanFlag(input.verbose, env.verbose);

  const mockUpdates = resolveBooleanFlag(input.mockUpdates, env.mockUpdates);
  const configuredMockUpdateServerPort = Option.getOrUndefined(env.mockUpdateServerPort);
  const mockUpdateServerPort =
    Option.getOrUndefined(input.mockUpdateServerPort) ??
    (configuredMockUpdateServerPort === undefined
      ? undefined
      : yield* resolveMockUpdateServerPort(configuredMockUpdateServerPort).pipe(
          Effect.mapError((cause) =>
            InvalidMockUpdateServerPortError.fromConfigValue(configuredMockUpdateServerPort, cause),
          ),
        ));

  const wslRuntime =
    Option.getOrUndefined(input.wslRuntime) ?? Option.getOrUndefined(env.wslRuntime);

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild,
    keepStage,
    signed,
    verbose,
    mockUpdates,
    mockUpdateServerPort,
    wslRuntime,
  } satisfies ResolvedBuildOptions;
});

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  options: {
    readonly label: string;
    readonly verbose: boolean;
  },
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectCommandStream(child.stdout, process.stdout, options.verbose),
      collectCommandStream(child.stderr, process.stderr, options.verbose),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new BuildCommandFailedError({
      command: options.label,
      exitCode,
      ...(stdout.trim() ? { stdoutTail: stdout } : {}),
      ...(stderr.trim() ? { stderrTail: stderr } : {}),
    });
  }
});

const desktopBuildProbeSucceeds = Effect.fn("desktopBuildProbeSucceeds")(function* (
  command: ChildProcess.Command,
  label: string,
) {
  return yield* runCommand(command, { label, verbose: false }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

const rustTargetIsInstalled = Effect.fn("rustTargetIsInstalled")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("rustc", ["--print", "target-libdir", "--target", target]),
  ).pipe(Effect.orElseSucceed(() => null));
  if (result === null || result.exitCode !== 0) return false;

  const targetLibDir = result.stdout.trim();
  if (targetLibDir === "") return false;
  const entries = yield* fs.readDirectory(targetLibDir).pipe(Effect.orElseSucceed(() => []));
  return entries.some((entry) => entry.startsWith("libstd-") && entry.endsWith(".rlib"));
});

export const preflightLinuxDesktopBuild = Effect.fn("preflightLinuxDesktopBuild")(function* (
  arch: typeof BuildArch.Type = "x64",
) {
  const reuseResourceMonitor = yield* Config.Boolean("T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR").pipe(
    Config.withDefault(false),
  );
  const reuseCaptureHelpers = yield* Config.Boolean(
    "T3CODE_DESKTOP_REUSE_LINUX_CAPTURE_HELPERS",
  ).pipe(Config.withDefault(false));
  // Rust is only optional when every Linux Rust artifact comes from a cache.
  const needsRust = !reuseResourceMonitor || !reuseCaptureHelpers;
  const rustTarget = resolveResourceMonitorRustTargets("linux", arch)[0]!;

  const checks = yield* Effect.all(
    {
      cargo: needsRust
        ? desktopBuildProbeSucceeds(ChildProcess.make("cargo", ["--version"]), "cargo")
        : Effect.succeed(true),
      "rust-target": needsRust ? rustTargetIsInstalled(rustTarget) : Effect.succeed(true),
      cc: desktopBuildProbeSucceeds(ChildProcess.make("cc", ["--version"]), "cc"),
      make: desktopBuildProbeSucceeds(ChildProcess.make("make", ["--version"]), "make"),
      libsecret: desktopBuildProbeSucceeds(
        ChildProcess.make("pkg-config", ["--exists", "libsecret-1"]),
        "libsecret",
      ),
      imagemagick: Effect.all([
        desktopBuildProbeSucceeds(ChildProcess.make("magick", ["-version"]), "magick"),
        desktopBuildProbeSucceeds(ChildProcess.make("convert", ["-version"]), "convert"),
      ]).pipe(Effect.map(([magick, convert]) => magick || convert)),
    },
    { concurrency: "unbounded" },
  );
  const missing = LINUX_DESKTOP_BUILD_PREREQUISITES.filter(
    (requirement) => !checks[requirement.id],
  ).map((requirement) => requirement.id);

  if (missing.length > 0) {
    return yield* new LinuxDesktopBuildPrerequisitesMissingError({ missing, rustTarget });
  }
});

export const preflightMacDesktopBuild = Effect.fn("preflightMacDesktopBuild")(function* (
  arch: typeof BuildArch.Type,
) {
  const rustTargets = resolveResourceMonitorRustTargets("mac", arch);
  const reuseResourceMonitor = yield* Config.Boolean("T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR").pipe(
    Config.withDefault(false),
  );
  const checks = yield* Effect.all(
    {
      rust: reuseResourceMonitor
        ? Effect.succeed(true)
        : Effect.all([
            desktopBuildProbeSucceeds(ChildProcess.make("cargo", ["--version"]), "cargo"),
            Effect.forEach(rustTargets, rustTargetIsInstalled).pipe(
              Effect.map((results) => results.every(Boolean)),
            ),
          ]).pipe(Effect.map(([cargo, targets]) => cargo && targets)),
      clang: desktopBuildProbeSucceeds(ChildProcess.make("clang", ["--version"]), "clang"),
      make: desktopBuildProbeSucceeds(ChildProcess.make("make", ["--version"]), "make"),
      sips: desktopBuildProbeSucceeds(ChildProcess.make("sips", ["--help"]), "sips"),
      iconutil: desktopBuildProbeSucceeds(
        ChildProcess.make("xcrun", ["--find", "iconutil"]),
        "iconutil",
      ),
      lipo:
        arch === "universal"
          ? desktopBuildProbeSucceeds(ChildProcess.make("lipo", ["-version"]), "lipo")
          : Effect.succeed(true),
    },
    { concurrency: "unbounded" },
  );
  const missing = MAC_DESKTOP_BUILD_PREREQUISITES.filter(
    (requirement) => !checks[requirement.id],
  ).map((requirement) => requirement.id);
  if (missing.length > 0) {
    return yield* new MacDesktopBuildPrerequisitesMissingError({ missing, rustTargets });
  }
});

function windowsVswherePrerequisiteScript(arch: typeof BuildArch.Type): string {
  const toolComponents =
    arch === "arm64"
      ? ["Microsoft.VisualStudio.Component.VC.Tools.ARM64"]
      : ["Microsoft.VisualStudio.Component.VC.Tools.x86.x64"];
  const spectreArch = arch === "arm64" ? "arm64" : "x64";
  return [
    "$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\\Installer\\vswhere.exe'",
    "if (!(Test-Path $vswhere)) { exit 1 }",
    `$install = & $vswhere -latest -products * -requires ${toolComponents.join(" ")} -property installationPath`,
    "if (!$install) { exit 1 }",
    "$kitsRoot = Get-ItemPropertyValue 'HKLM:\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots' -Name KitsRoot10 -ErrorAction SilentlyContinue",
    "if (!$kitsRoot -or !(Test-Path (Join-Path $kitsRoot 'Lib'))) { exit 1 }",
    "$msvcToolset = Get-ChildItem (Join-Path $install 'VC\\Tools\\MSVC') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1",
    "if (!$msvcToolset) { exit 1 }",
    `if (!(Test-Path (Join-Path $msvcToolset.FullName 'lib\\spectre\\${spectreArch}'))) { exit 1 }`,
  ].join("; ");
}

export const preflightWindowsDesktopBuild = Effect.fn("preflightWindowsDesktopBuild")(
  function* (input: { readonly arch: typeof BuildArch.Type; readonly bundlesWslRuntime: boolean }) {
    const rustTarget = resolveResourceMonitorRustTargets("win", input.arch)[0]!;
    const reuseResourceMonitor = yield* Config.Boolean(
      "T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR",
    ).pipe(Config.withDefault(false));
    const python = yield* resolvePythonForNodeGyp();
    const checks = yield* Effect.all(
      {
        rust: reuseResourceMonitor
          ? Effect.succeed(true)
          : Effect.all([
              desktopBuildProbeSucceeds(ChildProcess.make("cargo", ["--version"]), "cargo"),
              rustTargetIsInstalled(rustTarget),
            ]).pipe(Effect.map(([cargo, target]) => cargo && target)),
        python: Effect.succeed(python !== undefined),
        msvc: reuseResourceMonitor
          ? Effect.succeed(true)
          : desktopBuildProbeSucceeds(
              ChildProcess.make("powershell.exe", [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                windowsVswherePrerequisiteScript(input.arch),
              ]),
              "Visual Studio Build Tools",
            ),
        tar: input.bundlesWslRuntime
          ? desktopBuildProbeSucceeds(ChildProcess.make("tar.exe", ["--version"]), "tar")
          : Effect.succeed(true),
      },
      { concurrency: "unbounded" },
    );
    const missing = WINDOWS_DESKTOP_BUILD_PREREQUISITES.filter(
      (requirement) => !checks[requirement.id],
    ).map((requirement) => requirement.id);
    if (missing.length > 0) {
      return yield* new WindowsDesktopBuildPrerequisitesMissingError({ missing, rustTarget });
    }
  },
);

export const stageLinuxCaptureHelper = Effect.fn("stageLinuxCaptureHelper")(function* (input: {
  readonly backend: "kde" | "hyprland";
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [rustTarget] = resolveResourceMonitorRustTargets("linux", input.arch);
  // Release CI restores these binaries from a cache keyed on the crate sources and
  // skips the Rust toolchain on a hit, so the build must be skippable too.
  const reuseHelpers = yield* Config.Boolean("T3CODE_DESKTOP_REUSE_LINUX_CAPTURE_HELPERS").pipe(
    Config.withDefault(false),
  );
  const binaryPath = path.join(
    input.repoRoot,
    `native/${input.backend}-snap-shot/target`,
    rustTarget!,
    `release/t3-${input.backend}-snap-shot`,
  );
  if (!reuseHelpers) {
    const spawnCommand = yield* resolveSpawnCommand("cargo", [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      path.join(input.repoRoot, `native/${input.backend}-snap-shot/Cargo.toml`),
      "--target",
      rustTarget!,
    ]);
    yield* runCommand(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.repoRoot,
        shell: spawnCommand.shell,
      }),
      {
        label: `cargo build ${input.backend} capture helper (${rustTarget})`,
        verbose: input.verbose,
      },
    );
  } else if (!(yield* fs.exists(binaryPath))) {
    return yield* new ResourceMonitorBuildOutputMissingError({
      binaryPath,
      rustTarget: rustTarget!,
      platform: "linux",
      arch: input.arch,
    });
  }
  const destination = path.join(input.stageResourcesDir, `${input.backend}-capture`);
  yield* fs.makeDirectory(destination, { recursive: true });
  const executable = path.join(destination, `t3-${input.backend}-snap-shot`);
  yield* fs.copyFile(binaryPath, executable);
  yield* fs.chmod(executable, 0o755);
  if (input.backend === "hyprland") {
    // The official protocol XML includes the BSD notices required with binary distribution.
    yield* fs.copy(
      path.join(input.repoRoot, "native/hyprland-snap-shot/protocols"),
      path.join(destination, "protocols"),
    );
  }
});

export const stageResourceMonitor = Effect.fn("stageResourceMonitor")(function* (input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(input.repoRoot, "native/resource-monitor/Cargo.toml");
  const executableName = resourceMonitorExecutableName(input.platform);
  const rustTargets = resolveResourceMonitorRustTargets(input.platform, input.arch);
  const reuseResourceMonitor = yield* Config.Boolean("T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR").pipe(
    Config.withDefault(false),
  );
  const builtBinaries: string[] = [];

  for (const rustTarget of rustTargets) {
    if (!reuseResourceMonitor) {
      const spawnCommand = yield* resolveSpawnCommand("cargo", [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        manifestPath,
        "--target",
        rustTarget,
      ]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.repoRoot,
          shell: spawnCommand.shell,
        }),
        {
          label: `cargo build resource monitor (${rustTarget})`,
          verbose: input.verbose,
        },
      );
    }

    const binaryPath = path.join(
      input.repoRoot,
      "native/resource-monitor/target",
      rustTarget,
      "release",
      executableName,
    );
    if (!(yield* fs.exists(binaryPath))) {
      return yield* new ResourceMonitorBuildOutputMissingError({
        binaryPath,
        rustTarget,
        platform: input.platform,
        arch: input.arch,
      });
    }
    if (reuseResourceMonitor) {
      yield* Effect.log(`[desktop-artifact] Reusing cached resource monitor (${rustTarget}).`);
    }
    builtBinaries.push(binaryPath);
  }

  const destinationDirectory = path.join(input.stageResourcesDir, "resource-monitor");
  const destinationPath = path.join(destinationDirectory, executableName);
  yield* fs.remove(destinationDirectory, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(destinationDirectory, { recursive: true });

  if (builtBinaries.length === 1) {
    yield* fs.copyFile(builtBinaries[0]!, destinationPath);
  } else {
    yield* runCommand(
      ChildProcess.make("lipo", ["-create", ...builtBinaries, "-output", destinationPath]),
      {
        label: "lipo resource monitor universal binary",
        verbose: input.verbose,
      },
    );
  }

  if (input.platform !== "win") {
    yield* fs.chmod(destinationPath, 0o755);
  }
});

export const stageBrowserSecret = Effect.fn("stageBrowserSecret")(function* (input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  if (input.platform !== "linux") return;
  // The helper links against the host's libsecret, so it can only be built on
  // Linux; the build script is a no-op elsewhere. A Linux artifact from
  // another host would ship without it and every v11 cookie import would
  // report the keyring as unavailable, so refuse rather than package that
  // silently. `universal` is a mac-only arch the option type still admits;
  // the helper script rejects it, so it maps to the concrete x64 the Linux
  // resource monitor uses for the same request.
  const hostPlatform = yield* HostProcessPlatform;
  if (hostPlatform !== "linux") {
    return yield* new LinuxBrowserSecretHostError({ hostPlatform });
  }
  const path = yield* Path.Path;
  yield* runCommand(
    ChildProcess.make(
      "node",
      [
        path.join(input.repoRoot, "apps/pult-desktop/scripts/build-browser-secret.mjs"),
        "--arch",
        input.arch === "arm64" ? "arm64" : "x64",
        "--output",
        path.join(input.stageResourcesDir, "browser-secret", "t3-browser-secret"),
      ],
      { cwd: input.repoRoot },
    ),
    { label: "build Linux browser secret helper", verbose: input.verbose },
  );
});

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make(
          {},
        )`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
        { label: `sips icon ${size}x${size}`, verbose },
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make(
          {},
        )`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
        { label: `sips icon ${size}x${size}@2x`, verbose },
      );
    }

    yield* runCommand(ChildProcess.make({})`iconutil -c icns ${iconsetDir} -o ${targetIcns}`, {
      label: "iconutil icns",
      verbose,
    });
  });
}

function stageMacIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "mac",
        sourcePath: sourcePng,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3code-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

    yield* runCommand(ChildProcess.make({})`sips -z 512 512 ${sourcePng} --out ${iconPngPath}`, {
      label: "sips mac icon",
      verbose,
    });

    yield* generateMacIconSet(sourcePng, iconIcnsPath, tmpRoot, path, verbose);
  });
}

export const stageDesktopDmgBackground = Effect.fn("stageDesktopDmgBackground")(function* (
  stageResourcesDir: string,
  channel: "latest" | "nightly",
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(stageResourcesDir, "dmg", `dmg-background-${channel}.svg`);
  if (!(yield* fs.exists(sourcePath))) {
    return yield* new DesktopDmgBackgroundSourceMissingError({ channel, sourcePath });
  }

  for (const output of [
    { suffix: "", width: 640, height: 432 },
    { suffix: "@2x", width: 1280, height: 864 },
  ] as const) {
    const targetPath = path.join(
      stageResourcesDir,
      "dmg",
      `dmg-background-${channel}${output.suffix}.png`,
    );
    yield* runCommand(
      ChildProcess.make(
        {},
      )`sips -s format png -z ${output.height} ${output.width} ${sourcePath} --out ${targetPath}`,
      {
        label: `sips ${channel} DMG background${output.suffix || "@1x"}`,
        verbose,
      },
    );
  }
});

function stageLinuxIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "linux",
        sourcePath: sourcePng,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(sourcePng, iconPath);

    const iconsDir = path.join(stageResourcesDir, "icons");
    yield* fs.makeDirectory(iconsDir, { recursive: true });
    for (const iconSize of LINUX_ICON_SIZES) {
      yield* stageLinuxIconSize(
        sourcePng,
        path.join(iconsDir, `${iconSize}x${iconSize}.png`),
        iconSize,
        verbose,
      );
    }
  });
}

export function stageLinuxIconSize(
  sourcePng: string,
  targetPng: string,
  iconSize: number,
  verbose: boolean,
) {
  const resize = (command: string) =>
    runCommand(
      ChildProcess.make(command, [sourcePng, "-resize", `${iconSize}x${iconSize}`, targetPng]),
      { label: `${command} linux icon ${iconSize}x${iconSize}`, verbose },
    );

  return resize("magick").pipe(
    Effect.catch((primaryCause) =>
      resize("convert").pipe(
        Effect.mapError(
          (fallbackCause) =>
            new LinuxIconResizeError({
              operation: "resize",
              iconSize,
              primaryTool: "magick",
              fallbackTool: "convert",
              cause: new AggregateError(
                [primaryCause, fallbackCause],
                "Both Linux icon resize tool attempts failed.",
                { cause: primaryCause },
              ),
            }),
        ),
      ),
    ),
  );
}

function stageWindowsIcons(stageResourcesDir: string, sourceIco: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourceIco))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "win",
        sourcePath: sourceIco,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.ico");
    yield* fs.copyFile(sourceIco, iconPath);
  });
}

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      return yield* new BundledClientAssetsMissingError({
        indexPath,
        missingFiles: missing,
      });
    }
  });
}

// The main-process bundle inlines every JS dependency (see
// apps/pult-desktop/vite.config.ts), so the packaged app only installs the packages
// that bundle leaves external: native addons and playwright-core. Everything
// else already lives inside dist-electron.
export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  return resolveCatalogDependencies(
    selectDesktopRuntimeExternalDependencies(dependencies),
    catalog,
    "apps/pult-desktop",
  );
}

export const resolveGitHubPublishConfig = Effect.fn("resolveGitHubPublishConfig")(function* (
  updateChannel: "latest" | "nightly",
) {
  const env = yield* Config.all({
    updateRepository: Config.String("T3CODE_DESKTOP_UPDATE_REPOSITORY").pipe(Config.option),
    githubRepository: Config.String("GITHUB_REPOSITORY").pipe(Config.option),
  });
  const rawRepo = (
    Option.getOrUndefined(env.updateRepository)?.trim() ||
    Option.getOrUndefined(env.githubRepository)?.trim() ||
    ""
  ).trim();
  if (!rawRepo) return undefined;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return {
    provider: "github",
    owner,
    repo,
    releaseType: updateChannel === "nightly" ? "prerelease" : "release",
    ...(updateChannel === "nightly" ? { channel: "nightly" as const } : {}),
  };
});

export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}

// Pull request builds (`-pr.<n>.`) and the maintainers' preview train
// (`-preview.<date>.<run>`) are downloaded by hand and never through an
// updater. Building them without a publish config means electron-builder
// emits no `latest*.yml`/`nightly*.yml` manifests or blockmaps for them and
// the app ships without `app-update.yml`, so neither a stable nor a nightly
// install can be pointed at one of these releases, and the build itself
// reports that no update feed is configured instead of polling.
export function isDesktopPreviewVersion(version: string): boolean {
  return /-pr\./.test(version) || /-preview\.\d{8}\.\d+$/.test(version);
}

export function resolveDesktopWebAssetBrand(version: string): WebAssetBrand {
  return resolveWebAssetBrandForChannel(resolveDesktopUpdateChannel(version));
}

export function resolveDesktopBuildIconAssets(version: string): DesktopBuildIconAssets {
  if (resolveDesktopUpdateChannel(version) === "nightly") {
    return {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    };
  }

  return {
    macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
    linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  };
}

export function resolveMockUpdateServerUrl(mockUpdateServerPort: number | undefined): string {
  return `http://localhost:${mockUpdateServerPort ?? 3000}`;
}

// Electron Builder detects pnpm from npm_config_user_agent, whose value uses
// user-agent syntax (pnpm/11.10.0) rather than packageManager syntax
// (pnpm@11.10.0).
export function resolvePackageManagerUserAgent(packageManager: string): string {
  const trimmed = packageManager.trim();
  const versionSeparator = trimmed.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === trimmed.length - 1) {
    return trimmed;
  }

  return `${trimmed.slice(0, versionSeparator)}/${trimmed.slice(versionSeparator + 1)}`;
}

export function resolveDesktopProductName(version: string): string {
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? `${Identity.APP_BASE_NAME} (Nightly)`
    : (desktopPackageJson.productName ?? Identity.APP_DISPLAY_NAME);
}

export const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  version: string,
  signed: boolean,
  mockUpdates: boolean,
  mockUpdateServerPort: number | undefined,
  macPasskeySigning:
    | {
        readonly entitlementsPath: string;
        readonly provisioningProfilePath: string;
      }
    | undefined,
  // Windows only, and false when no Linux CLI archive was handed to the build:
  // staging skips the archive in that case, and listing a resource whose
  // source file was never written fails the electron-builder step.
  wslRuntimeBundled = false,
  arch?: typeof BuildArch.Type,
) {
  const buildConfig: Record<string, unknown> = {
    appId: DESKTOP_APP_ID,
    productName: resolveDesktopProductName(version),
    artifactName: `${Identity.APP_BASE_NAME}-\${version}-\${arch}.\${ext}`,
    electronLanguages: [...DESKTOP_ELECTRON_LANGUAGES],
    files: [
      ...DESKTOP_FILE_EXCLUSIONS,
      ...(platform === "mac"
        ? resolveMacFileExclusions(arch)
        : platform === "linux"
          ? LINUX_FILE_EXCLUSIONS
          : []),
    ],
    directories: {
      buildResources: "apps/pult-desktop/resources",
    },
    // Smart unpack extracts entire native packages, including JavaScript and
    // metadata. Windows keeps those files archived so native dependencies do
    // not inflate the loose-file count and slow NSIS installation.
    ...(platform === "win"
      ? { asar: { smartUnpack: false }, asarUnpack: [WINDOWS_NATIVE_ASAR_UNPACK_GLOB] }
      : {}),
    extraResources: [
      ...DESKTOP_EXTRA_RESOURCES,
      ...(platform === "linux" ? LINUX_CAPTURE_EXTRA_RESOURCES : []),
      ...(platform === "linux" ? LINUX_BROWSER_SECRET_EXTRA_RESOURCES : []),
      ...(platform === "win" && wslRuntimeBundled ? WSL_RUNTIME_EXTRA_RESOURCES : []),
    ],
  };
  const updateChannel = resolveDesktopUpdateChannel(version);
  if (!isDesktopPreviewVersion(version)) {
    const publishConfig = PULT_UPDATE_FEED_ENABLED
      ? yield* resolveGitHubPublishConfig(updateChannel)
      : undefined;
    if (publishConfig) {
      buildConfig.publish = [publishConfig];
    } else if (mockUpdates) {
      buildConfig.publish = [
        {
          provider: "generic",
          url: resolveMockUpdateServerUrl(mockUpdateServerPort),
        },
      ];
    }
  }

  if (platform === "mac") {
    const path = yield* Path.Path;
    const repoRoot = yield* RepoRoot;
    buildConfig.mac = {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
      extendInfo: {
        NSScreenCaptureUsageDescription:
          "T3 Code captures the active window when you use the window capture shortcut.",
      },
      protocols: [
        {
          name: Identity.APP_DISPLAY_NAME,
          schemes: [...Identity.APP_SCHEMES],
        },
      ],
      // An unsigned build is signed ad hoc: without it the bundle carries only
      // linker signatures and does not verify. An ad hoc signature has no team
      // id, so hardened runtime's library validation would refuse Electron's
      // frameworks; it stays off.
      ...(signed
        ? { sign: path.join(repoRoot, "scripts/sign-macos.ts") }
        : { identity: "-", hardenedRuntime: false }),
      ...(macPasskeySigning
        ? {
            entitlements: macPasskeySigning.entitlementsPath,
            provisioningProfile: macPasskeySigning.provisioningProfilePath,
          }
        : {}),
    };
  }

  if (platform === "mac" && target === "dmg") {
    buildConfig.dmg = {
      // Give the themed installer its own Finder volume name. Finder caches
      // DMG window backgrounds by volume name, so reusing a generic name can
      // make a newly built background look unchanged during testing.
      title: `${resolveDesktopProductName(version)} ${version} Installer`,
      background: `dmg/dmg-background-${updateChannel}.png`,
      window: {
        width: 640,
        // The DMG backend derives bounds from the image, including Finder's
        // 32px title bar. Keep the last 32px of the artwork free of content.
        height: 432,
      },
      contents: [
        { x: 166, y: 214, type: "file" },
        { x: 474, y: 214, type: "link", path: "/Applications" },
      ],
      iconSize: 120,
      iconTextSize: 12,
    };
  }

  if (platform === "linux") {
    // electron-builder 26 defaults to its legacy AppImage runtime, which
    // dynamically loads the system libfuse2 library. Pin the static runtime so
    // the AppImage also launches on distributions that only provide FUSE 3.
    buildConfig.toolsets = { appimage: "1.0.3" };
    const path = yield* Path.Path;
    const repoRoot = yield* RepoRoot;
    buildConfig.linux = {
      // The .deb is built from the same unpacked app after the AppImage.
      // electron-builder lists both in latest-linux.yml and writes
      // resources/package-type into the .deb only, so electron-updater updates
      // each install in its own format.
      target: target === "AppImage" ? [target, "deb"] : [target],
      executableName: Identity.APP_LINUX_WM_CLASS,
      icon: "icons",
      category: "Development",
      synopsis: "Desktop GUI for coding agents",
      // Required by the .deb control file.
      maintainer: "T3 Tools <hello@t3.codes>",
      // electron-builder turns these into MimeType=x-scheme-handler/<scheme>;
      // in the .desktop entry (Exec already gets %U), so browsers can hand
      // pult:// OAuth callbacks to the app.
      protocols: [
        {
          name: Identity.APP_DISPLAY_NAME,
          schemes: [...Identity.APP_SCHEMES],
        },
      ],
      desktop: {
        entry: {
          StartupWMClass: Identity.APP_LINUX_WM_CLASS,
        },
      },
    };
    buildConfig.deb = {
      // FPM runs outside the staged app directory, so source paths must be absolute.
      // Upstream also installs its AppStream metainfo here; Pult has none of its
      // own yet, and upstream's names T3 Code.
      fpm: [
        `${path.join(repoRoot, "LICENSE")}=/usr/share/doc/${Identity.APP_LINUX_WM_CLASS}/copyright`,
      ],
      // Electron's runtime libraries. Debian 13 and Ubuntu 24.04 renamed some
      // for 64-bit time; the old name is the fallback for older releases.
      depends: [
        "libasound2t64 | libasound2",
        "libatspi2.0-0t64 | libatspi2.0-0",
        "libgbm1",
        "libgtk-3-0t64 | libgtk-3-0",
        "libnotify4",
        "libnss3",
        "libsecret-1-0",
        "libuuid1",
        "libxss1",
        "libxtst6",
        "xdg-utils",
      ],
    };
  }

  if (platform === "win") {
    buildConfig.npmRebuild = false;
    // Keep blockmap-based differential downloads enabled while changing the
    // installed file topology. The optimization is in the payload shape, not
    // in trading update bandwidth for install speed.
    buildConfig.nsis = { differentialPackage: true };
    const winConfig: Record<string, unknown> = {
      target: [target],
      icon: "icon.ico",
      // Resource editing applies the product metadata and icon independently
      // of code signing. Disabling it for local unsigned builds leaves the
      // packaged executable with Electron's stock icon.
      signAndEditExecutable: true,
    };
    if (signed) {
      winConfig.azureSignOptions = yield* AzureTrustedSigningOptionsConfig;
    }
    buildConfig.win = winConfig;
  }

  return buildConfig;
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  iconAssets: DesktopBuildIconAssets,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, iconAssets.macIconPng, verbose);
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir, iconAssets.linuxIconPng, verbose);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir, iconAssets.windowsIconIco);
  }
});

// Copy the Linux CLI release archive into the stage verbatim and record its
// SHA-256 beside it. The desktop app verifies the digest inside the distro
// before extracting, and the digest also names the extracted runtime's cache
// directory, so it must be computed from the exact bytes that ship.
export const stageWslRuntimeArchive = Effect.fn("stageWslRuntimeArchive")(function* (input: {
  readonly sourceArchivePath: string;
  readonly archivePath: string;
  readonly hashPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceExists = yield* fs
    .exists(input.sourceArchivePath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!sourceExists) {
    return yield* new WslRuntimeArchiveMissingError({ archivePath: input.sourceArchivePath });
  }
  yield* fs.makeDirectory(path.dirname(input.archivePath), { recursive: true });
  yield* fs.copyFile(input.sourceArchivePath, input.archivePath);
  const hash = NodeCrypto.createHash("sha256");
  yield* fs
    .stream(input.archivePath)
    .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
  const digest = hash.digest("hex");
  yield* fs.writeFileString(input.hashPath, `${digest}\n`);
  yield* Effect.log(
    `[desktop-artifact] Staged WSL runtime archive at ${input.archivePath} (${digest}).`,
  );
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  if (hostPlatform === "linux" && options.platform === "linux") {
    yield* preflightLinuxDesktopBuild(options.arch);
  }
  if (hostPlatform === "darwin" && options.platform === "mac") {
    yield* preflightMacDesktopBuild(options.arch);
  }
  if (hostPlatform === "win32" && options.platform === "win") {
    yield* preflightWindowsDesktopBuild({
      arch: options.arch,
      bundlesWslRuntime: bundlesWslRuntime({
        platform: options.platform,
        runtimeArchivePath: options.wslRuntime,
      }),
    });
  }
  const workspaceConfig = yield* readWorkspaceConfig();
  const workspaceCatalog = workspaceConfig.catalog ?? {};
  const workspaceOverrides = workspaceConfig.overrides ?? {};
  const workspacePatchedDependencies = workspaceConfig.patchedDependencies ?? {};
  const workspaceAllowBuilds = workspaceConfig.allowBuilds ?? {};

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new UnsupportedDesktopBuildPlatformError({
      platform: options.platform,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const resolvedOverrides = yield* Effect.try({
    try: () =>
      resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/pult-desktop"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "workspace-overrides",
        manifestPath: "pnpm-workspace.yaml",
        cause,
      }),
  });

  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () => resolveDesktopRuntimeDependencies(desktopPackageJson.dependencies, workspaceCatalog),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "desktop-runtime",
        manifestPath: "apps/pult-desktop/package.json",
        cause,
      }),
  });

  const appVersion = options.version ?? desktopPackageJson.version;
  const iconAssets = resolveDesktopBuildIconAssets(appVersion);
  const commitHash = yield* resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `t3code-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/pult-desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/pult-desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/pult-desktop/resources"),
    clientDist: path.join(repoRoot, CLIENT_DIST_DIR),
  };
  const bundledClientEntry = path.join(distDirs.clientDist, "index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop and client artifacts...");
    const spawnCommand = yield* resolveSpawnCommand("vp", ["run", "build:desktop"]);
    yield* runCommand(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: repoRoot,
        shell: spawnCommand.shell,
      }),
      { label: "vp run build:desktop", verbose: options.verbose },
    );
  }

  const requiredBuildInputs = [
    { artifact: "desktop-dist", artifactPath: distDirs.desktopDist },
    { artifact: "desktop-resources", artifactPath: distDirs.desktopResources },
  ] as const;
  for (const input of requiredBuildInputs) {
    if (!(yield* fs.exists(input.artifactPath))) {
      return yield* new MissingDesktopBuildInputError({
        ...input,
        buildCommand: "vp run build:desktop",
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new MissingDesktopBuildInputError({
      artifact: "bundled-client",
      artifactPath: bundledClientEntry,
      buildCommand: "vp run build:desktop",
    });
  }

  const webAssetBrand = resolveDesktopWebAssetBrand(appVersion);
  yield* applyWebBrandAssets(webAssetBrand, CLIENT_DIST_DIR);
  yield* Effect.log(`[desktop-artifact] Applied ${webAssetBrand} web client branding.`);
  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/pult-desktop"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/pult-desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  if (options.platform === "linux") {
    const extensionDir = path.join(stageAppDir, "apps/pult-desktop/gnome-extension");
    yield* fs.makeDirectory(extensionDir, { recursive: true });
    for (const file of gnomeCaptureBundle.files) {
      yield* fs.copyFile(
        path.join(repoRoot, "apps/pult-desktop/gnome-extension", file),
        path.join(extensionDir, file),
      );
    }
  }
  if (options.platform === "mac" && options.target === "dmg") {
    yield* stageDesktopDmgBackground(
      stageResourcesDir,
      resolveDesktopUpdateChannel(appVersion),
      options.verbose,
    );
  }
  yield* fs.copy(distDirs.clientDist, path.join(stageAppDir, CLIENT_DIST_DIR));
  yield* stageResourceMonitor({
    repoRoot,
    stageResourcesDir,
    platform: options.platform,
    arch: options.arch,
    verbose: options.verbose,
  });
  if (options.platform === "linux") {
    for (const backend of ["kde", "hyprland"] as const)
      yield* stageLinuxCaptureHelper({
        backend,
        repoRoot,
        stageResourcesDir,
        arch: options.arch,
        verbose: options.verbose,
      });
  }
  yield* stageBrowserSecret({
    repoRoot,
    stageResourcesDir,
    platform: options.platform,
    arch: options.arch,
    verbose: options.verbose,
  });

  yield* assertPlatformBuildResources(
    options.platform,
    stageResourcesDir,
    {
      macIconPng: path.join(repoRoot, iconAssets.macIconPng),
      linuxIconPng: path.join(repoRoot, iconAssets.linuxIconPng),
      windowsIconIco: path.join(repoRoot, iconAssets.windowsIconIco),
    },
    options.verbose,
  );

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  const stageProdResourcesDir = path.join(stageAppDir, "apps/pult-desktop/prod-resources");
  yield* fs.copy(stageResourcesDir, stageProdResourcesDir);

  const configuredMacPasskeySigning =
    options.platform === "mac" && options.signed
      ? yield* Effect.try({
          try: () => resolveMacPasskeySigningConfiguration(loadRepoEnv({ repoRoot })),
          catch: MacPasskeySigningConfigurationResolutionError.fromCause,
        })
      : undefined;
  const macPasskeySigning = configuredMacPasskeySigning
    ? {
        ...configuredMacPasskeySigning,
        provisioningProfilePath: path.resolve(
          repoRoot,
          configuredMacPasskeySigning.provisioningProfilePath,
        ),
      }
    : undefined;
  const macEntitlementsPath = macPasskeySigning
    ? path.join(stageAppDir, "entitlements.mac.plist")
    : undefined;
  if (macPasskeySigning && macEntitlementsPath) {
    if (!(yield* fs.exists(macPasskeySigning.provisioningProfilePath))) {
      return yield* new MacProvisioningProfileNotFoundError({
        provisioningProfilePath: macPasskeySigning.provisioningProfilePath,
      });
    }
    yield* fs.writeFileString(macEntitlementsPath, renderMacPasskeyEntitlements(macPasskeySigning));
  }

  // The app installs only the desktop main-process externals; Pult bundles no
  // server (DECISIONS.md, `no-local-server`).
  const stageDependencies = { ...resolvedDesktopRuntimeDependencies };
  const stagePatchedDependencies = createStagePatchedDependencies(
    workspacePatchedDependencies,
    stageDependencies,
  );
  const stagePackageJson: StagePackageJson = {
    name: "t3code",
    version: appVersion,
    buildVersion: appVersion,
    t3codeCommitHash: commitHash,
    private: true,
    packageManager: rootPackageJson.packageManager,
    description:
      "T3 Code is an open-source desktop app for coding agents. Work with your existing agent subscriptions, review code changes, and run commands in your projects. Connect from desktop, web, or mobile to continue working remotely.",
    license: "MIT",
    // Required by the .deb control file.
    homepage: "https://t3.codes",
    author: "T3 Tools",
    main: "apps/pult-desktop/dist-electron/boot.cjs",
    build: yield* createBuildConfig(
      options.platform,
      options.target,
      appVersion,
      options.signed,
      options.mockUpdates,
      options.mockUpdateServerPort,
      macPasskeySigning && macEntitlementsPath
        ? {
            entitlementsPath: macEntitlementsPath,
            provisioningProfilePath: macPasskeySigning.provisioningProfilePath,
          }
        : undefined,
      bundlesWslRuntime({ platform: options.platform, runtimeArchivePath: options.wslRuntime }),
      options.arch,
    ),
    dependencies: stageDependencies,
    devDependencies: {
      electron: electronVersion,
    },
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);
  const stageWorkspaceConfig = createStageWorkspaceConfig({
    platform: options.platform,
    arch: options.arch,
    allowBuilds: workspaceAllowBuilds,
    patchedDependencies: stagePatchedDependencies,
    overrides: resolvedOverrides,
  });
  const stageWorkspaceConfigString = yield* encodeStageWorkspaceConfig(stageWorkspaceConfig);
  yield* fs.writeFileString(
    path.join(stageAppDir, "pnpm-workspace.yaml"),
    stageWorkspaceConfigString,
  );

  // Each patch at the repo-relative path the staged workspace names it by.
  for (const patchFile of new Set(Object.values(stagePatchedDependencies))) {
    yield* fs.makeDirectory(path.dirname(path.join(stageAppDir, patchFile)), { recursive: true });
    yield* fs.copyFile(path.join(repoRoot, patchFile), path.join(stageAppDir, patchFile));
  }

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: stageAppDir,
      shell: installCommand.shell,
    }),
    { label: "vp install --prod", verbose: options.verbose },
  );
  yield* stageClerkPasskeyNativeBinaries(stageAppDir, options.platform, options.arch);
  yield* stageKeyringNativeBinaries(stageAppDir, options.platform, options.arch);

  // Only the Windows artifact carries the WSL runtime; other platforms ignore
  // the --wsl-runtime input.
  if (
    options.wslRuntime !== undefined &&
    bundlesWslRuntime({ platform: options.platform, runtimeArchivePath: options.wslRuntime })
  ) {
    yield* stageWslRuntimeArchive({
      sourceArchivePath: options.wslRuntime,
      archivePath: path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE.from),
      hashPath: path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE.from),
    });
  }

  // electron-builder treats several set-but-empty variables (e.g. CSC_LINK="")
  // as enabled, so copy the host env and scrub empty values instead of relying
  // on `extendEnv` merging.
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  buildEnv.npm_config_user_agent = resolvePackageManagerUserAgent(rootPackageJson.packageManager);
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (options.platform === "linux") {
    // fpm compresses the .deb with the system xz through tar. Threaded mode
    // takes seconds on a many-core runner instead of about two minutes.
    buildEnv.XZ_DEFAULTS = "-T0";
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }

  if (hostPlatform === "win32") {
    const python = yield* resolvePythonForNodeGyp();
    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }
    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }
  if (options.verbose) {
    const debugNamespaces = [
      "electron-builder",
      "electron-builder:*",
      ...(options.platform === "mac" ? ["electron-osx-sign*", "electron-notarize*"] : []),
    ];
    buildEnv.DEBUG = [buildEnv.DEBUG, ...debugNamespaces].filter(Boolean).join(",");
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  const builderArgs = [
    "exec",
    "--filter",
    "@pult/desktop",
    "--",
    "electron-builder",
    "--projectDir",
    stageAppDir,
    platformConfig.cliFlag,
    `--${options.arch}`,
    "--publish",
    "never",
  ];
  const builderCommand = yield* resolveSpawnCommand("vp", builderArgs, { env: buildEnv });
  yield* runCommand(
    ChildProcess.make(builderCommand.command, builderCommand.args, {
      cwd: repoRoot,
      env: buildEnv,
      shell: builderCommand.shell,
    }),
    {
      label: `vp exec --filter @pult/desktop -- electron-builder --projectDir ${stageAppDir} ${platformConfig.cliFlag} --${options.arch} --publish never`,
      verbose: options.verbose,
    },
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new DesktopBuildDistDirectoryMissingError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.orElseSucceed(() => null));
    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new DesktopBuildNoArtifactsProducedError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.Literals("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: T3CODE_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.String("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: T3CODE_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.Literals("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal (env: T3CODE_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.String("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: T3CODE_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.String("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: T3CODE_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.Boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `vp run build:desktop` and use existing dist artifacts (env: T3CODE_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.Boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: T3CODE_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.Boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses Azure Trusted Signing (env: T3CODE_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.Boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: T3CODE_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.Boolean("mock-updates").pipe(
    Flag.withDescription("Enable mock updates (env: T3CODE_DESKTOP_MOCK_UPDATES)."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.Int("mock-update-server-port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Mock update server port (env: T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT)."),
    Flag.optional,
  ),
  wslRuntime: Flag.String("wsl-runtime").pipe(
    Flag.withDescription(
      "Path to the Linux CLI release archive (t3-<version>-linux-x64.tar.gz) to embed as the WSL runtime of a Windows build (env: T3CODE_DESKTOP_WSL_RUNTIME).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for T3 Code."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
