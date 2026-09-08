# Migrating to Translate for Zotero++

Starting with version 2.4.9, Translate for Zotero++ has its own plugin identity and
settings. This version supports Zotero 9.0.x.

The upstream plugin and Translate for Zotero++ 2.4.8 use the original plugin ID.
They cannot automatically update to the new ID, so this transition requires one
manual installation. Subsequent updates to the independent plugin come from this
repository.

## Installation

1. In Zotero's plugin manager, disable Translate for Zotero or Translate for
   Zotero++ 2.4.8, then restart Zotero.
2. Download `zotero-pdf-translate-plus-plus.xpi` from the
   [latest release](https://github.com/Golden-Pigeon/zotero-pdf-translate-plus-plus/releases/latest).
3. Open Zotero's plugin manager, choose **Install Plugin From File**, and select
   the downloaded file. Restart Zotero if prompted.
4. Open the new plugin's settings and verify your translation services, API keys,
   endpoints, models, and custom prompts. You can remove the old plugin after
   verifying the settings.

Keep the original plugin disabled. Running both translation plugins together is
not supported; Translate for Zotero++ pauses its startup if it detects the
original plugin enabled. Disable the original plugin and restart Zotero to resume
startup. If the original plugin is enabled or installed after Translate for
Zotero++ has started, Translate for Zotero++ stops and disables itself. Disable
the original plugin, enable Translate for Zotero++, and restart Zotero.

## Settings

On its first successful startup, the new plugin copies saved preferences from
the original settings into its own settings. It preserves values already set for
the new plugin, including `false`, `0`, and empty strings, and leaves the original
preferences unchanged. The copy happens once; later changes to either plugin's
settings are independent.

Use the same Zotero profile to retain access to the existing preferences. This
migration does not copy settings from another profile or restore preferences
that have already been deleted.

## Identity

- Plugin ID: `zotero-pdf-translate-plus-plus@golden-pigeon`
- Preference prefix: `extensions.zotero.ZoteroPDFTranslatePlusPlus`

For full feature documentation, see the
[upstream repository](https://github.com/windingwind/zotero-pdf-translate). Report
problems specific to this version in
[this repository](https://github.com/Golden-Pigeon/zotero-pdf-translate-plus-plus/issues).
