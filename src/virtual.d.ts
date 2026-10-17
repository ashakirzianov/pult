declare module "virtual:pult-extension" {
  import type { IExtensionManifest } from "@codingame/monaco-vscode-api/extensions";
  export const manifest: IExtensionManifest;
  export const files: ReadonlyArray<string>;
  export const base: string;
  export const extensionDir: string;
}
