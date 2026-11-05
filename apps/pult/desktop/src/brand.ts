/**
 * Pult's brand for upstream's desktop app (`apps/desktop`, its
 * `src/app/DesktopBrand.ts`): the names Pult.app ships under, from
 * `src/identity.ts`, and its renderer, the shell's built page. A build of
 * upstream's desktop takes it with `T3CODE_DESKTOP_BRAND=apps/pult/desktop/src/brand.ts`
 * (`scripts/upstream-dev.ts`, `scripts/package.ts`). Plain data, loaded by
 * Node at build time.
 *
 * Development runs as "Pult Host (Dev)", `pult-host-dev`, so it shares no
 * profile, Keychain item or scheme with T3 Code, an installed Pult or the
 * thin wrapper's "Pult (Dev)" (`pult-dev`).
 */
import type {
  DesktopBrandOverride,
  DesktopIconSources,
} from "../../../desktop/src/app/DesktopBrand.ts";
import { APP_BASE_NAME, APP_BUNDLE_ID, APP_SCHEME } from "../../src/identity.ts";

const DEV = "pult-host-dev";

/**
 * Pult.app's update feed, the GitHub releases a `pnpm desktop:package --feed`
 * build names (`scripts/package.ts`); never upstream's, whose next update would
 * replace Pult with T3 Code (`pult/decisions`, `update-feed`).
 */
export const UPDATE_FEED_REPOSITORY = "ashakirzianov/pult";

const icons = (variant: "prod" | "dev"): DesktopIconSources => ({
  macPng: `apps/pult/assets/pult/${variant}/macos-1024.png`,
  universalPng: `apps/pult/assets/pult/${variant}/universal-1024.png`,
  windowsIco: `apps/pult/assets/pult/${variant}/windows.ico`,
});

const brand: DesktopBrandOverride = {
  baseName: { production: APP_BASE_NAME, development: `${APP_BASE_NAME} Host` },
  // "Pult", not "Pult (Beta)"; development stays "Pult Host (Dev)".
  productionStageLabel: false,
  // Rendered by `vp run icons:export` (`assets/pult/README.md`); nightly builds are not Pult's.
  icons: {
    production: icons("prod"),
    nightly: icons("prod"),
    development: icons("dev"),
  },
  scheme: { production: APP_SCHEME, development: DEV },
  userData: {
    production: { current: "pult", legacy: null },
    development: { current: DEV, legacy: null },
  },
  appUserModelId: { production: APP_BUNDLE_ID, development: `${APP_BUNDLE_ID}.host-dev` },
  linuxDesktopEntryName: {
    production: `${APP_BUNDLE_ID}.desktop`,
    development: `${APP_BUNDLE_ID}.host-dev.desktop`,
  },
  // No T3 Code profile is Pult's to import.
  legacyLocalStorageProfiles: [],
  rendererAssetsDir: "apps/pult/dist",
  // The workbench's extension host loads extensions with `new Function`.
  rendererAllowsEval: true,
  // No analytics from the supervised server unless the environment asks for them.
  serverTelemetryDefault: false,
  // Pult.app installs its updates without asking: its server while the fleet and the host rest,
  // and on any quit (`pult/issues/release-feed`).
  serverInstallUpdatesAtRest: true,
  autoInstallOnAppQuit: true,
  // The page hosts the agents' browsers (`view/browserHost.tsx`), and the server waits ten seconds
  // for it to attach an agent's new tab: a page hidden five minutes, its timers woken once a
  // minute, missed it and left the tab headless (`pult/decisions`, `hidden-page-timers`).
  intensiveWakeUpThrottling: false,
  appId: APP_BUNDLE_ID,
  productName: APP_BASE_NAME,
  packageName: "pult",
  // Pult.app's version is its own line, its server and bundles upstream's
  // (`pult/decisions`, `release-stream`): About reads "Version 0.0.1 (T3 Code 0.1.7, <commit>)".
  bundleVersionName: "T3 Code",
};

export default brand;
