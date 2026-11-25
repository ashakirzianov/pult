// The composer's model picker in a Star's details (`src/details/ChannelDetails.tsx`, through the
// host's `modelPickers`): upstream's `ProviderModelPicker` over the environment's server config's
// models, as its settings page builds them, portalled from the view's tree, inside its providers,
// into an element of the shell's own (`ThreadDetailsCard.tsx`). The element carries
// `pult-view-theme`, so the view's stylesheet, which stops at the shell's island, starts again in it.
import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { pickModelSelection } from "@t3tools/shared/model";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "~/components/settings/settingsLayout";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { useEnvironmentProviders } from "~/state/environments";
import { EMPTY_SERVER_PROVIDERS } from "~/state/server";
import { type DetailsModelPicker, threadViewHost } from "./host.ts";

/** Every picker a Star's cards ask for, each in its element. */
export function DetailsModelPickers() {
  const { detailsCards } = threadViewHost();
  const pickers = useSyncExternalStore(
    detailsCards.subscribeModelPickers,
    detailsCards.modelPickers,
  );
  return pickers.map((picker, index) =>
    createPortal(<ModelPicker picker={picker} />, picker.element, String(index)),
  );
}

function ModelPicker({ picker }: { picker: DetailsModelPicker }) {
  const environmentId = picker.environmentId as EnvironmentId;
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, picker.projectId as ProjectId);
  const selection = picker.selection;
  const instanceId = (selection?.instanceId ?? entries[0]?.instanceId) as
    | ProviderInstanceId
    | undefined;
  // Before the server's config is in, no picker: the row shows nothing rather than a guess.
  if (instanceId === undefined) return null;
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    instanceId,
    selection?.model,
  );
  // The selection's chosen values of the model's select options, its effort among them, as the composer's trigger names them.
  const descriptors =
    providers
      .find((provider) => provider.instanceId === selection?.instanceId)
      ?.models.find((model) => model.slug === selection?.model)?.capabilities?.optionDescriptors ??
    [];
  const chosen = (selection?.options ?? []).flatMap((option) => {
    const descriptor = descriptors.find((each) => each.id === option.id);
    const label =
      descriptor?.type === "select"
        ? descriptor.options.find((each) => each.id === option.value)?.label
        : undefined;
    return label === undefined ? [] : [label];
  });
  return (
    <ProviderModelPicker
      environmentId={environmentId}
      activeInstanceId={instanceId}
      model={selection?.model ?? ""}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={modelOptions}
      popupAlign="end"
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      {...(selection === null ? { triggerLabel: "Choose model" } : {})}
      {...(chosen.length === 0
        ? {}
        : {
            triggerSuffix: (
              <span className="shrink-0 text-muted-foreground">{chosen.join(" · ")}</span>
            ),
            triggerDetail: chosen.join(" · "),
          })}
      onInstanceModelChange={(instance, model) =>
        picker.onPick(
          pickModelSelection(
            selection === null
              ? null
              : {
                  instanceId: selection.instanceId as ProviderInstanceId,
                  model: selection.model,
                  ...(selection.options === undefined
                    ? {}
                    : { options: selection.options.map((option) => ({ ...option })) }),
                },
            instance,
            model,
          ),
        )
      }
    />
  );
}
