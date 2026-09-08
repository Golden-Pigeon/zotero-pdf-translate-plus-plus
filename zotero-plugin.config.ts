import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import legacyUpdate from "./updates/legacy-2.4.8.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: "build",
  name: pkg.config.addonName,
  xpiName: pkg.name,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  server: {
    asProxy: false,
  },

  build: {
    assets: ["addon/**/*.*"],
    hooks: {
      "build:copyAssets": (ctx) => {
        copyFileSync("LICENSE", join(ctx.dist, "addon", "LICENSE"));
        copyFileSync("README.md", join(ctx.dist, "addon", "README.md"));
      },
      "build:makeUpdateJSON": (ctx) => {
        for (const name of ["update.json", "update-beta.json"]) {
          const path = join(ctx.dist, name);
          if (!existsSync(path)) continue;
          const manifest = JSON.parse(readFileSync(path, "utf8"));
          manifest.addons = { ...legacyUpdate.addons, ...manifest.addons };
          writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
        }
      },
    },
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    esbuildOptions: [
      {
        entryPoints: [
          { in: "src/index.ts", out: pkg.config.addonRef },
          { in: "src/extras/*.*", out: "" },
        ],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outdir: "build/addon/chrome/content/scripts",
      },
    ],
    // If you want to checkout update.json into the repository, uncomment the following lines:
    // makeUpdateJson: {
    //   hash: false,
    // },
    // hooks: {
    //   "build:makeUpdateJSON": (ctx) => {
    //     copyFileSync("build/update.json", "update.json");
    //     copyFileSync("build/update-beta.json", "update-beta.json");
    //   },
    // },
  },
  release: {
    github: {
      releaseNote: (ctx) => {
        const path = `docs/releases/${ctx.version}.md`;
        return existsSync(path)
          ? readFileSync(path, "utf8")
          : ctx.release.changelog;
      },
    },
  },

  // If you need to see a more detailed build log, uncomment the following line:
  // logLevel: "trace",
});
