// The reader's find bar (`pane.ts`): the workbench's own find widget, the one
// its webviews and terminal show, with no toggles, over the page's frame,
// which finds and highlights (`ReaderFrame.find`). The pane opens it and
// steps it from the keyboard.
import { StandaloneServices } from "@codingame/monaco-vscode-api";
import { IAccessibilityService } from "@codingame/monaco-vscode-api/vscode/vs/platform/accessibility/common/accessibility.service";
import { IConfigurationService } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration.service";
import { IContextKeyService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey.service";
import { IContextViewService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { IHoverService } from "@codingame/monaco-vscode-api/vscode/vs/platform/hover/browser/hover.service";
import { IKeybindingService } from "@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybinding.service";
import { SimpleFindWidget } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/codeEditor/browser/find/simpleFindWidget";

import type { Found, ReaderFrame } from "./render.ts";

export class ReaderFind extends SimpleFindWidget {
  /** Whether the bar is open: the widget's own `isVisible` lags its closing animation. */
  opened = false;
  private found: Found = { count: 0, current: -1 };

  /** `theme` is an element of the workbench, whose find colours the highlights take; `focusFrame` puts focus back in the page. */
  constructor(
    private readonly frame: ReaderFrame,
    private readonly theme: HTMLElement,
    private readonly focusFrame: () => void,
  ) {
    super(
      { showCommonFindToggles: false, showResultCount: true, checkImeCompletionState: true },
      StandaloneServices.get(IContextViewService),
      StandaloneServices.get(IContextKeyService),
      StandaloneServices.get(IHoverService),
      StandaloneServices.get(IKeybindingService),
      StandaloneServices.get(IConfigurationService),
      StandaloneServices.get(IAccessibilityService),
    );
  }

  /** Opens the bar, `query` its text when given, its text selected, and finds it. */
  open(query: string | undefined): void {
    this.opened = true;
    this.reveal(query);
    this.search(true);
  }

  /** Finds the bar's text again in a page rendered anew, staying where the reader is. */
  refresh(): void {
    if (this.opened) this.search(false);
  }

  /** Closes the bar without moving focus, for a pane showing another file. */
  dismiss(): void {
    this.opened = false;
    this.hide();
  }

  // Closed without the slide-out, whose pending end would hide the bar again were it reopened meanwhile.
  override hide(): void {
    super.hide(false);
    this.frame.clearFind();
    if (!this.opened) return;
    this.opened = false;
    this.focusFrame();
  }

  find(previous: boolean): void {
    if (!this.opened) return;
    this.found = this.frame.findStep(previous ? -1 : 1);
    void this.updateResultCount();
  }

  findFirst(): void {
    this.search(true);
  }

  private search(reveal: boolean): void {
    const style = getComputedStyle(this.theme);
    this.found = this.frame.find(this.inputValue, {
      // The editor's current match is its selection too, which is what tells it from the others in
      // a theme whose two find colours are close (Dark 2026's), so it takes the selection's colour.
      colors: {
        match: style.getPropertyValue("--vscode-editor-findMatchHighlightBackground"),
        current: style.getPropertyValue("--vscode-editor-selectionBackground"),
      },
      reveal,
    });
    void this.updateResultCount();
  }

  protected _onInputChanged(): boolean {
    this.search(true);
    return this.found.count > 0;
  }

  protected async _getResultCount() {
    return { resultIndex: this.found.current, resultCount: this.found.count };
  }

  protected _onFocusTrackerFocus(): void {}
  protected _onFocusTrackerBlur(): void {}
  protected _onFindInputFocusTrackerFocus(): void {}
  protected _onFindInputFocusTrackerBlur(): void {}
}
