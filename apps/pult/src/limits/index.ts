import { INotificationService, type ServicesAccessor } from "@codingame/monaco-vscode-api";
import {
  Action2,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";

import { ConnectedContext } from "../connection/index.ts";
import { showThreads } from "../panel/explorer.ts";
import { limitsShelf } from "./limits.ts";
import { limitsStore, refreshLimits, startLimitsModel } from "./model.ts";
import { revealLimits } from "./shelf.ts";

/**
 * The usage limits (xaxis `pult/issues/provider-limits-page`): the model
 * (`model.ts`), and the palette's Pult: Show Usage Limits and Refresh Usage
 * Limits. The shelf itself is the left panel's (`src/panel/LimitsShelf.tsx`).
 * Registered before the workbench starts.
 */
export function registerLimits(): void {
  const category = { value: "Pult", original: "Pult" };
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.showUsageLimits",
          title: { value: "Show Usage Limits", original: "Show Usage Limits" },
          category,
          f1: true,
        });
      }

      async run(accessor: ServicesAccessor): Promise<void> {
        const notifications = accessor.get(INotificationService);
        if (limitsShelf(limitsStore.get().accounts, Date.now(), true) === null) {
          notifications.info("Pult: no provider reports any usage of its limits.");
          return;
        }
        // The Pult tab first, so the shelf is laid out when it scrolls into view.
        await showThreads();
        revealLimits();
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.refreshUsageLimits",
          title: { value: "Refresh Usage Limits", original: "Refresh Usage Limits" },
          category,
          f1: true,
          precondition: ConnectedContext,
        });
      }

      run(): Promise<void> {
        return refreshLimits();
      }
    },
  );
  startLimitsModel();
}
