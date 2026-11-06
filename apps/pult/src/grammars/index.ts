import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";

import gdscriptConfiguration from "./gdscript/language-configuration.json?url";
import gdscriptGrammar from "./gdscript/gdscript.tmLanguage.json?url";
import tomlConfiguration from "./toml/language-configuration.json?url";
import tomlGrammar from "./toml/toml.tmLanguage.json?url";

/**
 * The languages VS Code ships no grammar for, each a built-in extension of
 * its own, as the `@codingame/*-default-extension` packages register
 * theirs: TOML's from Even Better TOML (`tamasfe.even-better-toml` 0.21.2),
 * GDScript's from godot-tools (`geequlim.godot-tools` 2.7.1), both MIT, their
 * files copied unchanged but for formatting beside their licences.
 */
export function registerGrammars(): void {
  register("toml", {
    language: { aliases: ["TOML"], extensions: [".toml"], filenames: ["Cargo.lock", "uv.lock"] },
    scopeName: "source.toml",
    grammar: tomlGrammar,
    configuration: tomlConfiguration,
  });
  register("gdscript", {
    language: { aliases: ["GDScript", "gdscript"], extensions: [".gd"] },
    scopeName: "source.gdscript",
    grammar: gdscriptGrammar,
    configuration: gdscriptConfiguration,
  });
}

function register(
  id: string,
  input: {
    readonly language: { aliases: string[]; extensions: string[]; filenames?: string[] };
    readonly scopeName: string;
    readonly grammar: string;
    readonly configuration: string;
  },
): void {
  const { registerFileUrl } = registerExtension(
    {
      name: `pult-${id}`,
      publisher: "pult",
      version: "0.0.0",
      engines: { vscode: "*" },
      contributes: {
        languages: [{ id, ...input.language, configuration: "./language-configuration.json" }],
        grammars: [{ language: id, scopeName: input.scopeName, path: "./grammar.json" }],
      },
    },
    // No code to run: the host kind only types the result as a local extension's, with its files.
    ExtensionHostKind.LocalWebWorker,
    { system: true },
  );
  registerFileUrl("language-configuration.json", input.configuration);
  registerFileUrl("grammar.json", input.grammar);
}
