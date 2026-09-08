import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";
import { copyFileSync, readFileSync } from "fs";
import { join } from "path";

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
      releaseNote: (ctx) =>
        ctx.version === "2.4.8"
          ? readFileSync("docs/releases/2.4.8.md", "utf8")
          : ctx.release.changelog,
    },
  },

  // If you need to see a more detailed build log, uncomment the following line:
  // logLevel: "trace",
});
