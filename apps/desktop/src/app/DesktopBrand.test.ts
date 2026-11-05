import { describe, expect, it } from "vite-plus/test";

import { brandServerEnvironment, desktopBrand, T3CODE_DESKTOP_BRAND } from "./DesktopBrand.ts";

describe("DesktopBrand", () => {
  it("is T3 Code's when the build names no brand", () => {
    expect(desktopBrand).toEqual(T3CODE_DESKTOP_BRAND);
  });

  it("leaves the server's environment alone under T3 Code's brand", () => {
    expect(brandServerEnvironment({ T3CODE_DEV_ALLOWED_ORIGINS: "http://a" })).toEqual({});
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
});
