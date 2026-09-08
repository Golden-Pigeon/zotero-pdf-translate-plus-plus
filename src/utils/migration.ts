import { config } from "../../package.json";

const LEGACY_PREFS_PREFIX = "extensions.zotero.ZoteroPDFTranslate.";
const MIGRATION_MARKER = "migration.legacyPreferences.v1";

export function migrateLegacyPreferences(
  prefs: nsIPrefBranch = Services.prefs,
) {
  const destinationPrefix = `${config.prefsPrefix}.`;
  const marker = `${destinationPrefix}${MIGRATION_MARKER}`;
  if (
    prefs.prefHasUserValue(marker) &&
    prefs.getPrefType(marker) === prefs.PREF_BOOL &&
    prefs.getBoolPref(marker)
  ) {
    return;
  }

  // Enumerate the user branch so custom services and future keys migrate too.
  for (const source of prefs.getChildList(LEGACY_PREFS_PREFIX)) {
    if (!source.startsWith(LEGACY_PREFS_PREFIX)) continue;
    const suffix = source.slice(LEGACY_PREFS_PREFIX.length);
    if (!suffix || suffix === MIGRATION_MARKER) continue;
    const destination = `${destinationPrefix}${suffix}`;
    if (
      !prefs.prefHasUserValue(source) ||
      prefs.prefHasUserValue(destination)
    ) {
      continue;
    }

    switch (prefs.getPrefType(source)) {
      case prefs.PREF_BOOL:
        prefs.setBoolPref(destination, prefs.getBoolPref(source));
        break;
      case prefs.PREF_INT:
        prefs.setIntPref(destination, prefs.getIntPref(source));
        break;
      case prefs.PREF_STRING:
        prefs.setStringPref(destination, prefs.getStringPref(source));
        break;
      default:
        throw new Error("Unsupported legacy preference type");
    }
  }

  // Only a complete migration prevents imports on subsequent starts.
  prefs.setBoolPref(marker, true);
}

export function migrateNiuTransLibraryPreferences(
  prefs: nsIPrefBranch = Services.prefs,
) {
  for (const [key, legacyListKey] of [
    ["niutransDictLibList", "dlist"],
    ["niutransMemoryLibList", "mlist"],
  ]) {
    const prefName = `${config.prefsPrefix}.${key}`;
    let list: unknown;
    try {
      list = JSON.parse(prefs.getStringPref(prefName, "[]"));
    } catch {
      list = undefined;
    }
    if (Array.isArray(list)) continue;
    const legacyList = (list as Record<string, unknown> | undefined | null)?.[
      legacyListKey
    ];
    prefs.setStringPref(
      prefName,
      JSON.stringify(Array.isArray(legacyList) ? legacyList : []),
    );
  }
}
