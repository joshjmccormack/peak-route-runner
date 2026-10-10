import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

const CACHE_NAME = "pinassist-v1.31";

// Paths the service worker precaches. Built files must keep these names.
const CORE_PATHS = [
  "./index.html",
  "./manifest.webmanifest",
  "./icon.jpg",
  "./css/app.css",
  "./js/app.js",
  "./js/supabase-config.js",
  "./js/vehicles.js",
  "./js/legislation.js",
  "./js/vendor/supabase.js",
  "./data/parking-offences.json",
  "./icons/peak-routes.png",
  "./icons/run-maps.png",
  "./icons/vehicles.png",
  "./icons/job-closures.png",
  "./icons/torum-index.png"
];

const target = "es2022";

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

async function writeOut(rel, contents) {
  const outfile = path.join(dist, rel);
  await mkdir(path.dirname(outfile), { recursive: true });
  await writeFile(outfile, contents);
}

// Bundle first-party scripts so top-level names are mangled. Public property
// names (window.PinLegislation.open, window.PEAK_*) stay intact.
async function bundleScript(rel) {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [rel],
    bundle: true,
    format: "iife",
    minify: true,
    legalComments: "none",
    sourcemap: false,
    charset: "utf8",
    target: [target],
    platform: "browser",
    write: false,
    logLevel: "warning"
  });
  if (result.outputFiles.length !== 1) {
    throw new Error(`Expected one output for ${rel}, got ${result.outputFiles.length}`);
  }
  await writeOut(rel, result.outputFiles[0].text);
}

async function minifyScript(rel) {
  const source = await readFile(path.join(root, rel), "utf8");
  const result = await esbuild.transform(source, {
    loader: "js",
    minify: true,
    legalComments: "none",
    sourcemap: false,
    charset: "utf8",
    target,
    sourcefile: rel
  });
  await writeOut(rel, result.code);
}

await bundleScript("js/app.js");
await bundleScript("sw.js");
await minifyScript("js/legislation.js");
await minifyScript("js/vehicles.js");
await minifyScript("js/supabase-config.js");

// Already minified and mangled by its publisher. Reprocessing risks the global `supabase`.
await mkdir(path.join(dist, "js/vendor"), { recursive: true });
await cp(path.join(root, "js/vendor/supabase.js"), path.join(dist, "js/vendor/supabase.js"));

const css = await readFile(path.join(root, "css/app.css"), "utf8");
const cssResult = await esbuild.transform(css, {
  loader: "css",
  minify: true,
  legalComments: "none",
  sourcemap: false,
  sourcefile: "css/app.css",
  target
});
await writeOut("css/app.css", cssResult.code);

const html = await readFile(path.join(root, "index.html"), "utf8");
const minHtml = await minifyHtml(html, {
  collapseWhitespace: true,
  conservativeCollapse: true,
  removeComments: true,
  keepClosingSlash: true,
  minifyCSS: false,
  minifyJS: false
});
await writeOut("index.html", minHtml);

async function minifyJson(rel) {
  const source = await readFile(path.join(root, rel), "utf8");
  await writeOut(rel, JSON.stringify(JSON.parse(source)));
}

await minifyJson("data/parking-offences.json");
await minifyJson("manifest.webmanifest");

for (const rel of ["CNAME", ".nojekyll", "icon.jpg", "icon.svg"]) {
  const dest = path.join(dist, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(path.join(root, rel), dest);
}
await cp(path.join(root, "icons"), path.join(dist, "icons"), { recursive: true });
await cp(path.join(root, "photos"), path.join(dist, "photos"), { recursive: true });

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const built = await walk(dist);
const maps = built.filter((file) => file.endsWith(".map") || file.includes("sourceMappingURL"));
if (maps.length) throw new Error(`Source maps were emitted: ${maps.join(", ")}`);

for (const file of built.filter((name) => name.endsWith(".js") || name.endsWith(".css") || name.endsWith(".html"))) {
  const text = await readFile(file, "utf8");
  if (text.includes("sourceMappingURL")) {
    throw new Error(`sourceMappingURL found in ${path.relative(dist, file)}`);
  }
}

const sw = await readFile(path.join(dist, "sw.js"), "utf8");
if (!sw.includes(CACHE_NAME)) {
  throw new Error(`Built service worker is missing cache name ${CACHE_NAME}`);
}
for (const rel of CORE_PATHS) {
  if (!sw.includes(rel)) {
    throw new Error(`Built service worker is missing cache path ${rel}`);
  }
  await readFile(path.join(dist, rel.replace(/^\.\//, "")));
}

const appJs = await readFile(path.join(dist, "js/app.js"), "utf8");
if (/\bfunction showHome\b/.test(appJs) || /\bfunction bootAuth\b/.test(appJs)) {
  throw new Error("js/app.js top-level names were not mangled");
}
for (const needle of ["PinLegislation", "createClient", "PEAK_SUPABASE_URL", "PEAK_VEHICLES", "./sw.js"]) {
  if (!appJs.includes(needle)) throw new Error(`Built js/app.js is missing ${needle}`);
}

const cname = (await readFile(path.join(dist, "CNAME"), "utf8")).trim();
if (cname !== "pinassist.app") throw new Error(`CNAME is ${JSON.stringify(cname)}`);

const builtHtml = await readFile(path.join(dist, "index.html"), "utf8");
for (const src of [
  "js/vendor/supabase.js",
  "js/supabase-config.js",
  "js/vehicles.js?v=1.28",
  "js/legislation.js?v=1.30",
  "js/app.js?v=1.30",
  "css/app.css?v=1.30"
]) {
  if (!builtHtml.includes(src)) throw new Error(`Built index.html is missing ${src}`);
}

console.log(`Built ${built.length} files in dist/ (${CACHE_NAME}, no source maps).`);
