# Open source license notices

The client build emits `third-party-licenses.json` beside `index.html`. The Settings page loads that static file, so the same artifact works in the browser and in the desktop, which serves the same client. It does not depend on the connected environment or an RPC.

## What the build collects

The generator ([`scripts/lib/third-party-licenses.ts`](../../scripts/lib/third-party-licenses.ts), wired in `apps/pult/vite.config.ts`) follows installed production and optional dependencies, including dependencies of workspace packages, starting from the `apps/pult` and `apps/pult-desktop` package manifests, and omits the first-party `@t3tools/*` and `@pult/*` packages. During the bundle, it also checks emitted module ids to catch a bundled npm import missing from a package manifest.

The build fails when a collected package has no distributable license identifier or contains no license or notice text. Generated notices use license templates from the pinned SPDX License List. A strict build downloads a missing template into the gitignored `.generated/` cache; `vp run licenses:sync` can warm that cache explicitly. Local development makes no network request and omits generated rows until the cache exists. This keeps dev startup offline while preventing incomplete release artifacts.

## Custom notices and package overrides

The repository-level `third-party-licenses.config.json` holds manually maintained exceptions. Add an entry to `customNotices` for adapted icons, fonts, media, native modules, or another asset that did not come from an npm package:

```json
{
  "name": "asset-name",
  "license": "CC-BY-4.0",
  "generatedNotices": [
    {
      "licenseId": "CC-BY-4.0",
      "preamble": ["Asset by Example Author. Changes: converted to MP3."]
    }
  ],
  "sourceUrl": "https://example.com/source",
  "bundles": ["assets", "web"]
}
```

Each `generatedNotices` item names an SPDX license template and can add `copyrights` or a short `preamble` for attribution and provenance. Multiple items are joined into one row for software that vendors separately licensed code. Keep `noticeFile` or `noticeFiles` only when a vendored source tree already carries an intrinsic license file that should remain beside it. Paths are relative to the config file. `bundles` controls which generated manifests include the entry and supplies the label shown to users. Use `includeInBundles` when those differ, such as a tool that should appear in the client's notices but is not bundled into it.

Use `packageOverrides` only when an installed npm archive omits its notice or has incorrect metadata:

```json
{
  "name": "package-name",
  "version": "1.2.3",
  "generatedNotice": {
    "licenseId": "MIT",
    "copyrights": ["Copyright (c) 2026 Example Author"]
  },
  "license": "MIT",
  "sourceUrl": "https://example.com/package-name"
}
```

For packages containing separately licensed code, use `generatedNotices` with an array of templates instead of `generatedNotice`. The generator includes every notice in the package row.

`version`, `license`, and `sourceUrl` are optional. Omitting `version` applies the override to every installed version of that package. An override can use `repositoryUrl` instead of `name` when several packages from one monorepo share the same notice:

```json
{
  "repositoryUrl": "https://github.com/example/project",
  "generatedNotice": {
    "licenseId": "Apache-2.0"
  }
}
```

The generator also reuses an installed sibling package's notice when both packages declare the same normalized repository and license. A name-and-version override always wins over these repository fallbacks.

The `@react-grab/cli` override uses the root React Grab repository's MIT license because the CLI's npm archive omits both its license field and license file. Keep the override until the published CLI package carries that metadata itself.

Fetched SPDX templates live under the repository `.generated/` directory, which is ignored. Do not commit or edit them; updating dependencies or configuration is enough for the next strict build to refresh the output.
