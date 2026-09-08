import { config } from "../package.json";
import {
  migrateLegacyPreferences,
  migrateNiuTransLibraryPreferences,
} from "../src/utils/migration";

describe("Independent plugin preference migration", function () {
  const testRoot = `extensions.zotero.preferenceMigrationTest.${Date.now()}.`;
  const legacyPrefix = "extensions.zotero.ZoteroPDFTranslate.";
  const destinationPrefix = `${config.prefsPrefix}.`;
  const marker = `${destinationPrefix}migration.legacyPreferences.v1`;
  let prefs: nsIPrefBranch;
  let defaults: nsIPrefBranch;

  beforeEach(function () {
    prefs = Services.prefs.getBranch(testRoot);
    defaults = Services.prefs.getDefaultBranch(testRoot);
  });

  afterEach(function () {
    Services.prefs.deleteBranch(testRoot);
  });

  it("copies false, zero, empty strings and dynamic settings over defaults", function () {
    const strings = {
      "customGPT8.endPoint": "https://example.invalid/v1/responses",
      "customGPT8.model": "custom-model",
      "customGPT8.prompt": "Translate ${sourceText}",
      secretObj: JSON.stringify({ customgpt8: "test-secret" }),
      extraEngines: "customgpt8,customgpt9",
      "customGPT8.customParams": '{"reasoning":{"effort":"high"}}',
      "customGPT9.prompt": "",
    };
    prefs.setBoolPref(`${legacyPrefix}enable`, false);
    prefs.setIntPref(`${legacyPrefix}fontSize`, 0);
    defaults.setBoolPref(`${destinationPrefix}enable`, true);
    defaults.setIntPref(`${destinationPrefix}fontSize`, 12);
    for (const [key, value] of Object.entries(strings)) {
      prefs.setStringPref(`${legacyPrefix}${key}`, value);
      defaults.setStringPref(`${destinationPrefix}${key}`, "default");
    }

    migrateLegacyPreferences(prefs);

    assert.isFalse(prefs.getBoolPref(`${destinationPrefix}enable`));
    assert.strictEqual(prefs.getIntPref(`${destinationPrefix}fontSize`), 0);
    for (const [key, value] of Object.entries(strings)) {
      assert.strictEqual(
        prefs.getStringPref(`${destinationPrefix}${key}`),
        value,
      );
      assert.strictEqual(prefs.getStringPref(`${legacyPrefix}${key}`), value);
    }
    assert.isFalse(prefs.getBoolPref(`${legacyPrefix}enable`));
    assert.strictEqual(prefs.getIntPref(`${legacyPrefix}fontSize`), 0);
    assert.isTrue(prefs.getBoolPref(marker));
  });

  it("preserves destination user values, including false, zero and empty strings", function () {
    prefs.setBoolPref(`${legacyPrefix}enable`, true);
    prefs.setIntPref(`${legacyPrefix}fontSize`, 12);
    prefs.setStringPref(`${legacyPrefix}secretObj`, '{"chatgpt":"old-secret"}');
    prefs.setBoolPref(`${destinationPrefix}enable`, false);
    prefs.setIntPref(`${destinationPrefix}fontSize`, 0);
    prefs.setStringPref(`${destinationPrefix}secretObj`, "");

    migrateLegacyPreferences(prefs);

    assert.isFalse(prefs.getBoolPref(`${destinationPrefix}enable`));
    assert.strictEqual(prefs.getIntPref(`${destinationPrefix}fontSize`), 0);
    assert.strictEqual(
      prefs.getStringPref(`${destinationPrefix}secretObj`),
      "",
    );
  });

  it("ignores legacy defaults and neighboring preference branches", function () {
    defaults.setStringPref(`${legacyPrefix}defaultOnly`, "old-default");
    defaults.setStringPref(`${destinationPrefix}defaultOnly`, "new-default");
    prefs.setStringPref(
      "extensions.zotero.ZoteroPDFTranslateOther.model",
      "other",
    );
    prefs.setStringPref("extensions.zotero.Unrelated.secretObj", "unrelated");

    migrateLegacyPreferences(prefs);

    assert.isFalse(prefs.prefHasUserValue(`${destinationPrefix}defaultOnly`));
    assert.strictEqual(
      prefs.getStringPref(`${destinationPrefix}defaultOnly`),
      "new-default",
    );
    assert.sameMembers(prefs.getChildList(destinationPrefix), [
      `${destinationPrefix}defaultOnly`,
      marker,
    ]);
    assert.strictEqual(
      prefs.getStringPref("extensions.zotero.Unrelated.secretObj"),
      "unrelated",
    );
  });

  it("does not reimport after settings are changed or cleared", function () {
    prefs.setStringPref(`${legacyPrefix}model`, "legacy-model");
    prefs.setStringPref(`${legacyPrefix}secretObj`, "legacy-secret");
    defaults.setStringPref(`${destinationPrefix}secretObj`, "{}");
    migrateLegacyPreferences(prefs);

    prefs.setStringPref(`${destinationPrefix}model`, "new-model");
    prefs.clearUserPref(`${destinationPrefix}secretObj`);
    prefs.setStringPref(`${legacyPrefix}addedLater`, "late-value");
    migrateLegacyPreferences(prefs);

    assert.strictEqual(
      prefs.getStringPref(`${destinationPrefix}model`),
      "new-model",
    );
    assert.isFalse(prefs.prefHasUserValue(`${destinationPrefix}secretObj`));
    assert.isFalse(prefs.prefHasUserValue(`${destinationPrefix}addedLater`));
    assert.strictEqual(
      prefs.getStringPref(`${legacyPrefix}secretObj`),
      "legacy-secret",
    );
  });

  it("leaves failed migrations retryable without overwriting prior copies", function () {
    prefs.setStringPref(`${legacyPrefix}first`, "first-value");
    prefs.setStringPref(`${legacyPrefix}second`, "second-value");
    // Forward native calls explicitly: XPConnect objects cannot be proxied safely.
    const failingPrefs: Partial<nsIPrefBranch> = {
      PREF_BOOL: prefs.PREF_BOOL,
      PREF_INT: prefs.PREF_INT,
      PREF_STRING: prefs.PREF_STRING,
      getChildList: () => [`${legacyPrefix}first`, `${legacyPrefix}second`],
      prefHasUserValue: (name: string) => prefs.prefHasUserValue(name),
      getPrefType: (name: string) => prefs.getPrefType(name),
      getBoolPref: (name: string) => prefs.getBoolPref(name),
      setBoolPref: (name: string, value: boolean) =>
        prefs.setBoolPref(name, value),
      getIntPref: (name: string) => prefs.getIntPref(name),
      setIntPref: (name: string, value: number) =>
        prefs.setIntPref(name, value),
      getStringPref: (name: string) => prefs.getStringPref(name),
      setStringPref(name: string, value: string) {
        if (name === `${destinationPrefix}second`) {
          throw new Error("Simulated preference write failure");
        }
        prefs.setStringPref(name, value);
      },
    };

    assert.throws(
      () => migrateLegacyPreferences(failingPrefs as nsIPrefBranch),
      "Simulated preference write failure",
    );
    assert.isFalse(prefs.prefHasUserValue(marker));
    assert.strictEqual(
      prefs.getStringPref(`${destinationPrefix}first`),
      "first-value",
    );
    prefs.setStringPref(`${destinationPrefix}first`, "updated-value");
    migrateLegacyPreferences(prefs);

    assert.strictEqual(
      prefs.getStringPref(`${destinationPrefix}first`),
      "updated-value",
    );
    assert.strictEqual(
      prefs.getStringPref(`${destinationPrefix}second`),
      "second-value",
    );
    assert.isTrue(prefs.getBoolPref(marker));
  });

  it("preserves NiuTrans arrays and converts old wrapped lists once", function () {
    const dict = '[{"id":"dict-1","name":"Dictionary"}]';
    const memory = [{ id: "memory-1", name: "Memory" }];
    prefs.setStringPref(`${legacyPrefix}niutransDictLibList`, dict);
    prefs.setStringPref(
      `${legacyPrefix}niutransMemoryLibList`,
      JSON.stringify({ mlist: memory }),
    );

    migrateLegacyPreferences(prefs);
    migrateNiuTransLibraryPreferences(prefs);
    migrateNiuTransLibraryPreferences(prefs);

    assert.strictEqual(
      prefs.getStringPref(`${destinationPrefix}niutransDictLibList`),
      dict,
    );
    assert.deepEqual(
      JSON.parse(
        prefs.getStringPref(`${destinationPrefix}niutransMemoryLibList`),
      ),
      memory,
    );
    assert.strictEqual(
      prefs.getStringPref(`${legacyPrefix}niutransDictLibList`),
      dict,
    );
  });

  it("does not discard a valid NiuTrans list when the other list is malformed", function () {
    const memory = '[{"id":"memory-1"}]';
    prefs.setStringPref(
      `${destinationPrefix}niutransDictLibList`,
      "invalid-json",
    );
    prefs.setStringPref(`${destinationPrefix}niutransMemoryLibList`, memory);

    migrateNiuTransLibraryPreferences(prefs);

    assert.strictEqual(
      prefs.getStringPref(`${destinationPrefix}niutransDictLibList`),
      "[]",
    );
    assert.strictEqual(
      prefs.getStringPref(`${destinationPrefix}niutransMemoryLibList`),
      memory,
    );
  });
});
