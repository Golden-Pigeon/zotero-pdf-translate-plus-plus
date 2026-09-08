import { config, version } from "../../package.json";

export function getCustomElementNames(addonVersion = version) {
  // Encoding preserves distinct release/prerelease versions in valid tag names.
  const versionKey = Array.from(addonVersion, (character) =>
    character.charCodeAt(0).toString(16).padStart(2, "0"),
  ).join("");
  return {
    panelTag: `${config.addonRef}-translator-panel-v${versionKey}`,
    mathTag: `${config.addonRef}-math-textbox-v${versionKey}`,
  };
}

export const { panelTag, mathTag } = getCustomElementNames();
