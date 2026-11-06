import type { IConfigurationService } from "@codingame/monaco-vscode-api";
import { ConfigurationTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration";

/** Writes a user setting, or removes it where the value is the default already, so the user's settings hold only what differs; a list is the default with the same items in the same order. */
export function writeUserValue(
  configuration: IConfigurationService,
  key: string,
  value: unknown,
): Promise<void> {
  const { defaultValue } = configuration.inspect(key);
  return configuration.updateValue(
    key,
    JSON.stringify(value) === JSON.stringify(defaultValue) ? undefined : value,
    ConfigurationTarget.USER,
  );
}
