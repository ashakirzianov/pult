/**
 * The names and defaults a desktop build ships under, T3 Code's by default.
 * `T3CODE_DESKTOP_BRAND` names a module exporting a `DesktopBrandOverride`
 * (`scripts/lib/desktop-brand.ts`), baked in as `__T3CODE_DESKTOP_BRAND__`.
 */

interface PerMode<T> {
  readonly production: T;
  readonly development: T;
}

/** An icon's sources, relative to the repository's root. */
export interface DesktopIconSources {
  /** macOS's 1024 px PNG, its margin drawn in. */
  readonly macPng: string;
  /** The 1024 px PNG for Linux and Windows' window. */
  readonly universalPng: string;
  readonly windowsIco: string;
}

export interface DesktopBrand {
  /** The app's name before its stage label: "T3 Code" in "T3 Code (Beta)". */
  readonly baseName: PerMode<string>;
  /** The production app's name carries its stage label ("Beta", "Nightly"); development's always does. */
  readonly productionStageLabel: boolean;
  /** The packaged app's icons (a nightly build takes `nightly`), and a source-tree run's dock and window icon. */
  readonly icons: PerMode<DesktopIconSources> & { readonly nightly: DesktopIconSources };
  /** The renderer's privileged scheme, its origin `<scheme>://app`, and the OS URL handler's. */
  readonly scheme: PerMode<string>;
  /** `userData` under the OS app-data directory, and a legacy profile to adopt (`null`: none). */
  readonly userData: PerMode<{ readonly current: string; readonly legacy: string | null }>;
  readonly appUserModelId: PerMode<string>;
  readonly linuxDesktopEntryName: PerMode<string>;
  /** Profiles whose v1 local storage the app imports once. */
  readonly legacyLocalStorageProfiles: ReadonlyArray<string>;
  /** The packaged renderer's assets, relative to the app's root; `null` is the server's web client. */
  readonly rendererAssetsDir: string | null;
  /** The renderer needs `'unsafe-eval'` in its script sources. */
  readonly rendererAllowsEval: boolean;
  /** `T3CODE_TELEMETRY_ENABLED` for the supervised server when the environment sets none; `null` leaves the server's default. */
  readonly serverTelemetryDefault: boolean | null;
  /**
   * Chromium's intensive wake-up throttling of a page hidden five minutes,
   * its chained timers woken once a minute. Off, they wake once a second, as
   * a hidden page's always do: a page hosting the agents' browsers must
   * attach an agent's new tab within the server's ten seconds while hidden.
   */
  readonly intensiveWakeUpThrottling: boolean;
  /** The package's bundle id (`appId`) and its name; `null` keeps `apps/desktop/package.json`'s. */
  readonly appId: string;
  readonly productName: string | null;
  /** The packaged `package.json`'s name, Electron's default app name, which names its Keychain item. */
  readonly packageName: string;
  /**
   * What the About panel calls the compiled bundles' version when the packaged
   * app carries a version of its own (the artifact script's `--app-version`):
   * "T3 Code" in "Version 0.0.1 (T3 Code 0.1.7, <commit>)". `null` shows the commit alone.
   */
  readonly bundleVersionName: string | null;
}

export type DesktopBrandOverride = Partial<DesktopBrand>;

export const T3CODE_DESKTOP_BRAND: DesktopBrand = {
  baseName: { production: "T3 Code", development: "T3 Code" },
  productionStageLabel: true,
  icons: {
    production: {
      macPng: "assets/prod/black-macos-1024.png",
      universalPng: "assets/prod/black-universal-1024.png",
      windowsIco: "assets/prod/t3-black-windows.ico",
    },
    nightly: {
      macPng: "assets/nightly/nightly-macos-1024.png",
      universalPng: "assets/nightly/nightly-universal-1024.png",
      windowsIco: "assets/nightly/nightly-windows.ico",
    },
    development: {
      macPng: "assets/dev/blueprint-macos-1024.png",
      universalPng: "assets/dev/blueprint-universal-1024.png",
      windowsIco: "assets/dev/blueprint-windows.ico",
    },
  },
  scheme: { production: "t3code", development: "t3code-dev" },
  userData: {
    production: { current: "t3code-v2", legacy: "T3 Code (Alpha)" },
    development: { current: "t3code-dev", legacy: "T3 Code (Dev)" },
  },
  appUserModelId: { production: "com.t3tools.t3code", development: "com.t3tools.t3code.dev" },
  linuxDesktopEntryName: {
    production: "com.t3tools.T3Code.desktop",
    development: "com.t3tools.T3Code.Development.desktop",
  },
  legacyLocalStorageProfiles: ["T3 Code (Alpha)", "t3code"],
  rendererAssetsDir: null,
  rendererAllowsEval: false,
  serverTelemetryDefault: null,
  intensiveWakeUpThrottling: true,
  appId: "com.t3tools.t3code",
  productName: null,
  packageName: "t3code",
  bundleVersionName: null,
};

export const brandFor = <T>(value: PerMode<T>, isDevelopment: boolean): T =>
  isDevelopment ? value.development : value.production;

declare const __T3CODE_DESKTOP_BRAND__: DesktopBrandOverride | null | undefined;

export const desktopBrand: DesktopBrand = {
  ...T3CODE_DESKTOP_BRAND,
  ...(typeof __T3CODE_DESKTOP_BRAND__ === "object" ? __T3CODE_DESKTOP_BRAND__ : null),
};

/**
 * The `--disable-features` value a brand needs, `current` (the switch's value
 * so far, Chromium keeping only the last one) with the brand's features
 * added; null when the brand adds none.
 */
export function brandDisabledFeatures(
  current: string | null,
  brand: DesktopBrand = desktopBrand,
): string | null {
  if (brand.intensiveWakeUpThrottling) return null;
  const features = (current ?? "").split(",").filter((feature) => feature.trim() !== "");
  if (features.includes("IntensiveWakeUpThrottling")) return null;
  return [...features, "IntensiveWakeUpThrottling"].join(",");
}

/**
 * The About panel's version, shown after the app's own: the build's commit,
 * led by the compiled bundles' version, under the brand's name for it, when
 * the app's version differs from theirs.
 */
export function brandAboutVersion(
  input: {
    readonly appVersion: string;
    readonly bundleVersion: string | null;
    readonly commitHash: string;
  },
  brand: DesktopBrand = desktopBrand,
): string {
  const { appVersion, bundleVersion, commitHash } = input;
  if (brand.bundleVersionName === null || bundleVersion === null || bundleVersion === appVersion)
    return commitHash;
  return `${brand.bundleVersionName} ${bundleVersion}, ${commitHash}`;
}

/**
 * What a brand changes in the environment the supervised server inherits:
 * its telemetry default, and the brand's renderer origins among the origins a
 * development server allows, since the server names only T3 Code's.
 */
export function brandServerEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  brand: DesktopBrand = desktopBrand,
): Record<string, string> {
  const patch: Record<string, string> = {};
  if (brand.serverTelemetryDefault !== null && env.T3CODE_TELEMETRY_ENABLED === undefined)
    patch.T3CODE_TELEMETRY_ENABLED = String(brand.serverTelemetryDefault);
  const t3codeSchemes: ReadonlyArray<string> = Object.values(T3CODE_DESKTOP_BRAND.scheme);
  const origins = [brand.scheme.production, brand.scheme.development]
    .filter((scheme) => !t3codeSchemes.includes(scheme))
    .map((scheme) => `${scheme}://app`);
  if (origins.length > 0)
    patch.T3CODE_DEV_ALLOWED_ORIGINS = [env.T3CODE_DEV_ALLOWED_ORIGINS, ...origins]
      .filter((entry) => entry !== undefined && entry.trim() !== "")
      .join(",");
  return patch;
}
