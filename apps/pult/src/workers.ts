// The workbench's web workers, by the label VS Code asks for. `?worker&url` has Vite bundle each
// as a module worker and give its URL: a bare `new URL(...)` would be an unbundled asset, whose
// relative imports fail in the production build.
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker&url";
import extensionHostWorker from "@codingame/monaco-vscode-api/workers/extensionHost.worker?worker&url";
import textMateWorker from "@codingame/monaco-vscode-textmate-service-override/worker?worker&url";
import outputLinkDetectionWorker from "@codingame/monaco-vscode-output-service-override/worker?worker&url";
import languageDetectionWorker from "@codingame/monaco-vscode-language-detection-worker-service-override/worker?worker&url";
import localFileSearchWorker from "@codingame/monaco-vscode-search-service-override/worker?worker&url";

const workers: Partial<Record<string, string>> = {
  editorWorkerService: editorWorker,
  extensionHostWorkerMain: extensionHostWorker,
  TextMateWorker: textMateWorker,
  OutputLinkDetectionWorker: outputLinkDetectionWorker,
  LanguageDetectionWorker: languageDetectionWorker,
  LocalFileSearchWorker: localFileSearchWorker,
};

export function installWorkers(): void {
  window.MonacoEnvironment = {
    getWorkerUrl(_moduleId: string, label: string) {
      const url = workers[label];
      if (url === undefined) throw new Error(`No worker registered for ${label}`);
      // Absolute: the extension host imports its worker's URL from a `blob:` worker, where a
      // root-relative one cannot resolve.
      return new URL(url, import.meta.url).toString();
    },
    getWorkerOptions() {
      return { type: "module" };
    },
  };
}
