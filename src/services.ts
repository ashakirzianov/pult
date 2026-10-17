import type { IEditorOverrideServices, IWorkbenchConstructionOptions } from "@codingame/monaco-vscode-api";
import getAccessibilityServiceOverride from "@codingame/monaco-vscode-accessibility-service-override";
import getBulkEditServiceOverride from "@codingame/monaco-vscode-bulk-edit-service-override";
import getCommentsServiceOverride from "@codingame/monaco-vscode-comments-service-override";
import getConfigurationServiceOverride from "@codingame/monaco-vscode-configuration-service-override";
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override";
import getEnvironmentServiceOverride from "@codingame/monaco-vscode-environment-service-override";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getExtensionGalleryServiceOverride from "@codingame/monaco-vscode-extension-gallery-service-override";
import getExtensionServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getLanguageDetectionWorkerServiceOverride from "@codingame/monaco-vscode-language-detection-worker-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getLifecycleServiceOverride from "@codingame/monaco-vscode-lifecycle-service-override";
import getLogServiceOverride from "@codingame/monaco-vscode-log-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getMultiDiffEditorServiceOverride from "@codingame/monaco-vscode-multi-diff-editor-service-override";
import getNotificationServiceOverride from "@codingame/monaco-vscode-notifications-service-override";
import getOutlineServiceOverride from "@codingame/monaco-vscode-outline-service-override";
import getOutputServiceOverride from "@codingame/monaco-vscode-output-service-override";
import getPreferencesServiceOverride from "@codingame/monaco-vscode-preferences-service-override";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import getRemoteAgentServiceOverride from "@codingame/monaco-vscode-remote-agent-service-override";
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override";
import getSecretStorageServiceOverride from "@codingame/monaco-vscode-secret-storage-service-override";
import getSnippetServiceOverride from "@codingame/monaco-vscode-snippets-service-override";
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getTimelineServiceOverride from "@codingame/monaco-vscode-timeline-service-override";
import getUserDataProfileServiceOverride from "@codingame/monaco-vscode-user-data-profile-service-override";
import getBannerServiceOverride from "@codingame/monaco-vscode-view-banner-service-override";
import getStatusBarServiceOverride from "@codingame/monaco-vscode-view-status-bar-service-override";
import getTitleBarServiceOverride from "@codingame/monaco-vscode-view-title-bar-service-override";
import getWorkbenchServiceOverride from "@codingame/monaco-vscode-workbench-service-override";
import getWorkingCopyServiceOverride from "@codingame/monaco-vscode-working-copy-service-override";
import getWorkspaceTrustOverride from "@codingame/monaco-vscode-workspace-trust-service-override";

/**
 * The workbench's services: the full workbench (layout, editor groups, views)
 * with what the Pult extension needs below it (a worker extension host, secrets,
 * storage, files, configuration) and the editor's own (themes, grammars,
 * languages, search, markers). Terminal, SCM, debug, testing, notebooks, chat
 * and the rest are left out on purpose.
 */
export function workbenchServices(): IEditorOverrideServices {
  return {
    ...getLogServiceOverride(),
    ...getExtensionServiceOverride({ enableWorkerExtensionHost: true }),
    ...getModelServiceOverride(),
    ...getNotificationServiceOverride(),
    ...getDialogsServiceOverride(),
    ...getConfigurationServiceOverride(),
    ...getKeybindingsServiceOverride(),
    ...getTextmateServiceOverride(),
    ...getThemeServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getLanguageDetectionWorkerServiceOverride(),
    ...getPreferencesServiceOverride(),
    ...getSnippetServiceOverride(),
    ...getOutlineServiceOverride(),
    ...getSearchServiceOverride(),
    ...getMarkersServiceOverride(),
    ...getOutputServiceOverride(),
    ...getAccessibilityServiceOverride(),
    ...getStorageServiceOverride({ fallbackOverride: { "workbench.activity.showAccounts": false } }),
    ...getSecretStorageServiceOverride(),
    ...getLifecycleServiceOverride(),
    ...getEnvironmentServiceOverride(),
    ...getWorkspaceTrustOverride(),
    ...getWorkingCopyServiceOverride(),
    ...getUserDataProfileServiceOverride(),
    ...getBulkEditServiceOverride(),
    ...getCommentsServiceOverride(),
    ...getMultiDiffEditorServiceOverride(),
    ...getTimelineServiceOverride(),
    ...getExplorerServiceOverride(),
    ...getBannerServiceOverride(),
    ...getStatusBarServiceOverride(),
    ...getTitleBarServiceOverride(),
    // Question 5: the remote agent path, for a Node extension host on the environment.
    ...getRemoteAgentServiceOverride({ scanRemoteExtensions: true }),
    // Open VSX as the gallery (the construct options name its URLs).
    ...getExtensionGalleryServiceOverride({ webOnly: false }),
    ...getWorkbenchServiceOverride(),
    ...getQuickAccessServiceOverride({
      isKeybindingConfigurationVisible: () => true,
      shouldUseGlobalPicker: () => true,
    }),
  };
}

/** The Open VSX gallery, in VS Code's product.json shape. */
export const openVsxGallery: NonNullable<IWorkbenchConstructionOptions["productConfiguration"]> = {
  extensionsGallery: {
    serviceUrl: "https://open-vsx.org/vscode/gallery",
    resourceUrlTemplate: "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}",
    extensionUrlTemplate: "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest",
    controlUrl: "",
    nlsBaseUrl: "",
  },
};
