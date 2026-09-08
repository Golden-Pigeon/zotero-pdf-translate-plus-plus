/**
 * Most of this code is from Zotero team's official Make It Red example[1]
 * or the Zotero 7 documentation[2].
 * [1] https://github.com/zotero/make-it-red
 * [2] https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle;
var addonManager;
var conflictListener;
var pluginStarted = false;
var shuttingDown = false;
var conflictDetected = false;
var conflictNotified = false;

function isLegacyPluginEnabled(plugin) {
  return (
    plugin?.id === "zoteropdftranslate@euclpts.com" &&
    !plugin.userDisabled &&
    !plugin.appDisabled
  );
}

function notifyPluginConflict() {
  if (conflictNotified) return;
  conflictNotified = true;
  Zotero.uiReadyPromise.then(() => {
    Zotero.alert(
      Zotero.getMainWindow(),
      "__addonName__",
      "Translate for Zotero or Translate for Zotero++ 2.4.8 is enabled. " +
        "Disable the old plugin, then enable Translate for Zotero++ and restart Zotero. " +
        "Both plugins cannot run together. Your old settings will be preserved.",
    );
  });
}

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  shuttingDown = false;
  conflictDetected = false;
  conflictNotified = false;
  await Zotero.initializationPromise;
  if (shuttingDown) return;

  ({ AddonManager: addonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs",
  ));
  const onLegacyEnabled = (plugin) => {
    if (!isLegacyPluginEnabled(plugin) || shuttingDown) return;
    conflictDetected = true;
    if (pluginStarted) {
      pluginStarted = false;
      Zotero.__addonInstance__?.hooks.onShutdown();
      addonManager
        .getAddonByID(id)
        .then((current) => current?.disable())
        .catch((error) => Zotero.logError(error));
    }
    notifyPluginConflict();
  };
  conflictListener = {
    onEnabling: onLegacyEnabled,
    onEnabled: onLegacyEnabled,
    onInstalled: onLegacyEnabled,
  };
  addonManager.addAddonListener(conflictListener);
  const legacyPlugin = await addonManager.getAddonByID(
    "zoteropdftranslate@euclpts.com",
  );
  if (shuttingDown) return;
  if (conflictDetected || isLegacyPluginEnabled(legacyPlugin)) {
    notifyPluginConflict();
    return;
  }

  // String 'rootURI' introduced in Zotero 7
  if (!rootURI) {
    rootURI = resourceURI.spec;
  }

  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", rootURI + "chrome/content/"],
  ]);

  /**
   * Global variables for plugin code.
   * The `_globalThis` is the global root variable of the plugin sandbox environment
   * and all child variables assigned to it is globally accessible.
   * See `src/index.ts` for details.
   */
  const ctx = {
    rootURI,
  };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}/chrome/content/scripts/__addonRef__.js`,
    ctx,
  );
  pluginStarted = true;
}

async function onMainWindowLoad({ window }, reason) {
  Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  shuttingDown = true;
  pluginStarted = false;
  if (conflictListener) {
    addonManager.removeAddonListener(conflictListener);
    conflictListener = null;
  }
  if (reason === APP_SHUTDOWN) {
    return;
  }

  Zotero.__addonInstance__?.hooks.onShutdown();

  Cc["@mozilla.org/intl/stringbundle;1"]
    .getService(Components.interfaces.nsIStringBundleService)
    .flushBundles();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
