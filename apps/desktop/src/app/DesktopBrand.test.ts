import { describe, expect, it } from "vite-plus/test";

import {
  brandAboutVersion,
  brandDisabledFeatures,
  brandServerEnvironment,
  desktopBrand,
  T3CODE_DESKTOP_BRAND,
} from "./DesktopBrand.ts";

describe("DesktopBrand", () => {
  it("is T3 Code's when the build names no brand", () => {
    expect(desktopBrand).toEqual(T3CODE_DESKTOP_BRAND);
  });

  it("leaves the server's environment alone under T3 Code's brand", () => {
    expect(brandServerEnvironment({ T3CODE_DEV_ALLOWED_ORIGINS: "http://a" })).toEqual({});
  });

  it("disables no Chromium feature under T3 Code's brand", () => {
    expect(brandDisabledFeatures(null)).toBeNull();
    expect(brandDisabledFeatures("Foo")).toBeNull();
  });

  it("adds a brand's disabled features to those already disabled", () => {
    const brand = { ...T3CODE_DESKTOP_BRAND, intensiveWakeUpThrottling: false };
    expect(brandDisabledFeatures(null, brand)).toBe("IntensiveWakeUpThrottling");
    expect(brandDisabledFeatures("Foo,Bar", brand)).toBe("Foo,Bar,IntensiveWakeUpThrottling");
    expect(brandDisabledFeatures("IntensiveWakeUpThrottling", brand)).toBeNull();
  });

  it("adds another brand's renderer origins and its telemetry default", () => {
    const brand = {
      ...T3CODE_DESKTOP_BRAND,
      scheme: { production: "pult", development: "pult-dev" },
      serverTelemetryDefault: false,
    };
    expect(brandServerEnvironment({ T3CODE_DEV_ALLOWED_ORIGINS: "http://a" }, brand)).toEqual({
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_DEV_ALLOWED_ORIGINS: "http://a,pult://app,pult-dev://app",
    });
    expect(brandServerEnvironment({ T3CODE_TELEMETRY_ENABLED: "true" }, brand)).toEqual({
      T3CODE_DEV_ALLOWED_ORIGINS: "pult://app,pult-dev://app",
    });
  });

  it("turns on installing at rest for a brand that asks, unless the environment says", () => {
    const brand = { ...T3CODE_DESKTOP_BRAND, serverInstallUpdatesAtRest: true };
    expect(brandServerEnvironment({}, brand)).toEqual({
      T3CODE_DESKTOP_INSTALL_UPDATES_AT_REST: "true",
    });
    expect(
      brandServerEnvironment({ T3CODE_DESKTOP_INSTALL_UPDATES_AT_REST: "false" }, brand),
    ).toEqual({});
  });

  it("shows the commit alone in About under T3 Code's brand", () => {
    expect(
      brandAboutVersion({
        appVersion: "0.0.1",
        bundleVersion: "0.1.7",
        commitHash: "abcdef123456",
      }),
    ).toBe("abcdef123456");
  });

  it("leads About's commit with the bundles' version when the app carries its own", () => {
    const brand = { ...T3CODE_DESKTOP_BRAND, bundleVersionName: "T3 Code" };
    expect(
      brandAboutVersion(
        { appVersion: "0.0.1", bundleVersion: "0.1.7", commitHash: "abcdef123456" },
        brand,
      ),
    ).toBe("T3 Code 0.1.7, abcdef123456");
    expect(
      brandAboutVersion(
        { appVersion: "0.1.7", bundleVersion: "0.1.7", commitHash: "abcdef123456" },
        brand,
      ),
    ).toBe("abcdef123456");
    expect(
      brandAboutVersion(
        { appVersion: "0.0.1", bundleVersion: null, commitHash: "abcdef123456" },
        brand,
      ),
    ).toBe("abcdef123456");
  });
});
