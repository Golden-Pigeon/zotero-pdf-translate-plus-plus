import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const json = (path) => JSON.parse(read(path));
const pkg = json("package.json");
const { addonID, addonName, addonRef, addonInstance, prefsPrefix } = pkg.config;
const legacyID = "zoteropdftranslate@euclpts.com";
const legacy = json("updates/legacy-2.4.8.json").addons[legacyID];
const repo = new URL(pkg.repository.url.replace(/^git\+/, ""));
repo.pathname = repo.pathname.replace(/\.git$/, "");
assert.equal(repo.protocol, "https:");
assert.equal(repo.hostname, "github.com");
function repositoryURL(value) {
  const url = new URL(value);
  assert.equal(url.origin, repo.origin, value);
  const path = `${url.pathname}/`;
  assert.ok(path.startsWith(`${repo.pathname}/`), value);
  return url.href;
}
const releaseURL = (path) =>
  new URL(`${repo.pathname}/releases/${path}`, repo).href;
const artifactURL = releaseURL(`download/v${pkg.version}/${pkg.name}.xpi`);
const artifact = readFileSync(new URL(`build/${pkg.name}.xpi`, root));
const hash = `sha512:${createHash("sha512").update(artifact).digest("hex")}`;
const manifest = json("build/addon/manifest.json");
const app = manifest.applications.zotero;
const compatibility = {
  strict_min_version: "9.0",
  strict_max_version: "9.0.*",
};
assert.notEqual(addonID, legacyID);
assert.equal(app.id, addonID);
assert.equal(manifest.name, addonName);
assert.equal(manifest.version, pkg.version);
for (const [key, value] of Object.entries(compatibility))
  assert.equal(app[key], value);
assert.equal(repositoryURL(manifest.homepage_url), repositoryURL(pkg.homepage));
repositoryURL(pkg.bugs.url);
const channel = pkg.version.includes("-") ? "update-beta.json" : "update.json";
assert.equal(
  repositoryURL(app.update_url),
  releaseURL(`download/release/${channel}`),
);

const identity = [addonRef, addonInstance, prefsPrefix];
const resources = {
  "bootstrap.js": [addonRef, addonInstance],
  "prefs.js": [prefsPrefix],
  "chrome/content/preferences.xhtml": identity,
  "chrome/content/standalone.xhtml": [
    `chrome://${addonRef}/`,
    `${addonRef}-translator-panel`,
  ],
  [`chrome/content/scripts/${addonRef}.js`]: identity,
  "chrome/content/scripts/customElements.js": [addonRef],
  "chrome/content/styles/katex.min.css": [
    `.${addonRef}-math-root`,
    `${addonRef}-KaTeX_Main`,
  ],
};
for (const [path, expected] of Object.entries(resources)) {
  const content = read(`build/addon/${path}`);
  for (const value of expected)
    assert.ok(content.includes(value), `${path} is missing ${value}`);
}
const addonDirectory = new URL("build/addon/", root);
const placeholders =
  /__addon(?:Ref|Instance|ID|Name)__|__prefsPrefix__|__(?:panelTag|mathTag)__/;
for (const path of readdirSync(addonDirectory, { recursive: true })) {
  assert.doesNotMatch(path, placeholders, path);
  if (!/\.(js|json|xhtml|ftl|css)$/.test(path)) continue;
  assert.doesNotMatch(read(`build/addon/${path}`), placeholders, path);
}
let preferenceCount = 0;
runInNewContext(read("build/addon/prefs.js"), {
  pref(name) {
    assert.ok(name.startsWith(`${prefsPrefix}.`), name);
    preferenceCount++;
  },
});
assert.ok(preferenceCount > 0, "Missing default preferences");

const updateFiles = pkg.version.includes("-")
  ? ["update-beta.json"]
  : ["update.json", "update-beta.json"];
for (const name of updateFiles) {
  const { addons } = json(`build/${name}`);
  assert.deepEqual(Object.keys(addons).sort(), [addonID, legacyID].sort());
  assert.deepEqual(addons[legacyID], legacy, `${name} changed legacy updates`);
  const current = addons[addonID].updates;
  assert.equal(current.length, 1, `${name} must contain one current release`);
  assert.equal(current[0].version, pkg.version);
  assert.equal(repositoryURL(current[0].update_link), artifactURL);
  assert.equal(current[0].update_hash, hash);
  assert.deepEqual(current[0].applications.zotero, compatibility);
  assert.ok(addons[legacyID].updates.length > 0);
  for (const update of addons[legacyID].updates) {
    assert.notEqual(update.version, pkg.version);
    assert.notEqual(repositoryURL(update.update_link), artifactURL);
    assert.match(update.update_hash, /^sha512:[a-f0-9]{128}$/);
  }
}
console.log(`Verified ${pkg.name} ${pkg.version} release artifacts.`);
