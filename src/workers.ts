// The workbench's web workers, by the label VS Code asks for. Vite bundles each
// `new URL(..., import.meta.url)` as a module worker.
const workers: Partial<Record<string, URL>> = {
  editorWorkerService: new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url),
  extensionHostWorkerMain: new URL(
    "@codingame/monaco-vscode-api/workers/extensionHost.worker",
    import.meta.url,
  ),
  TextMateWorker: new URL("@codingame/monaco-vscode-textmate-service-override/worker", import.meta.url),
  OutputLinkDetectionWorker: new URL(
    "@codingame/monaco-vscode-output-service-override/worker",
    import.meta.url,
  ),
  LanguageDetectionWorker: new URL(
    "@codingame/monaco-vscode-language-detection-worker-service-override/worker",
    import.meta.url,
  ),
  LocalFileSearchWorker: new URL("@codingame/monaco-vscode-search-service-override/worker", import.meta.url),
};

export function installWorkers(): void {
  window.MonacoEnvironment = {
    getWorkerUrl(_moduleId: string, label: string) {
      const url = workers[label];
      if (url === undefined) throw new Error(`No worker registered for ${label}`);
      return url.toString();
    },
    getWorkerOptions() {
      return { type: "module" };
    },
  };
}
