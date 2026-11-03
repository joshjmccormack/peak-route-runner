import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const target = "es2022";

// Copied byte-for-byte. DeploymentPlan has its own service worker, scoped to
// /DeploymentPlan/, and must not be minified or rewritten.
const VERBATIM_DIRS = new Set(["DeploymentPlan"]);

// Not part of the static site. Everything else is emitted, so a new app file
// is picked up without editing this list.
const SKIP_DIRS = new Set([
  ".git",
  ".github",
  "dist",
  "node_modules",
  "scripts",
  "supabase"
]);
const SKIP_FILES = new Set([
  ".gitignore",
  "DEPLOY.md",
  "LICENSE",
  "README.txt",
  "package-lock.json",
  "package.json"
]);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

async function writeOut(rel, contents) {
  const outfile = path.join(dist, rel);
  await mkdir(path.dirname(outfile), { recursive: true });
  await writeFile(outfile, contents);
}

async function copyRel(rel) {
  const dest = path.join(dist, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(path.join(root, rel), dest);
}

// Bundle the two self-contained entry points so their top-level names are mangled.
// Other scripts stay as classic scripts: top-level and public property names
// (window.PinLegislation, window.PinLongerThanPermitted, window.PEAK_*) remain.
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

async function minifyCss(rel) {
  const css = await readFile(path.join(root, rel), "utf8");
  const result = await esbuild.transform(css, {
    loader: "css",
    minify: true,
    legalComments: "none",
    sourcemap: false,
    sourcefile: rel,
    target
  });
  await writeOut(rel, result.code);
}

async function minifyHtmlFile(rel) {
  const html = await readFile(path.join(root, rel), "utf8");
  const minHtml = await minifyHtml(html, {
    collapseWhitespace: true,
    conservativeCollapse: true,
    removeComments: true,
    keepClosingSlash: true,
    minifyCSS: false,
    minifyJS: false
  });
  await writeOut(rel, minHtml);
}

async function minifyJson(rel) {
  const source = await readFile(path.join(root, rel), "utf8");
  await writeOut(rel, JSON.stringify(JSON.parse(source)));
}

async function emit(rel) {
  if (rel === "sw.js" || rel === "js/app.js") {
    await bundleScript(rel);
    return "bundle";
  }
  if (rel.startsWith("js/vendor/")) {
    await copyRel(rel);
    return "copy";
  }
  if (rel.endsWith(".js")) {
    await minifyScript(rel);
    return "minify-js";
  }
  if (rel.endsWith(".css")) {
    await minifyCss(rel);
    return "minify-css";
  }
  if (rel.endsWith(".html")) {
    await minifyHtmlFile(rel);
    return "minify-html";
  }
  if (rel.endsWith(".json") || rel.endsWith(".webmanifest")) {
    await minifyJson(rel);
    return "minify-json";
  }
  await copyRel(rel);
  return "copy";
}

async function listSiteFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!prefix && (SKIP_DIRS.has(entry.name) || VERBATIM_DIRS.has(entry.name))) continue;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      files.push(...await listSiteFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function skipFile(rel) {
  const name = rel.split("/").pop();
  if (SKIP_FILES.has(name) && !rel.includes("/")) return true;
  if (rel.endsWith(".sql")) return true;
  return false;
}

for (const dir of VERBATIM_DIRS) {
  await cp(path.join(root, dir), path.join(dist, dir), { recursive: true });
}

const actions = new Map();
for (const rel of await listSiteFiles(root)) {
  if (skipFile(rel)) continue;
  actions.set(rel, await emit(rel));
}

async function assertSameTree(srcDir, destDir) {
  const srcFiles = (await filesUnder(srcDir)).map((file) => path.relative(srcDir, file)).sort();
  const destFiles = (await filesUnder(destDir)).map((file) => path.relative(destDir, file)).sort();
  if (srcFiles.join("\n") !== destFiles.join("\n")) {
    throw new Error(`${path.relative(root, srcDir)} file list was not copied intact`);
  }
  for (const rel of srcFiles) {
    const a = await readFile(path.join(srcDir, rel));
    const b = await readFile(path.join(destDir, rel));
    if (!a.equals(b)) throw new Error(`${path.relative(root, srcDir)}/${rel} was modified during the build`);
  }
  return srcFiles.length;
}

const rosterCount = await assertSameTree(
  path.join(root, "DeploymentPlan"),
  path.join(dist, "DeploymentPlan")
);
const rosterSw = await readFile(path.join(dist, "DeploymentPlan/sw.js"), "utf8");
if (!rosterSw.includes('const CACHE = "deployment-roster-v43"')) {
  throw new Error("DeploymentPlan/sw.js cache name is not deployment-roster-v43");
}
const rosterApp = await readFile(path.join(dist, "DeploymentPlan/js/app.js"), "utf8");
if (!rosterApp.includes('navigator.serviceWorker.register("./sw.js", { scope: "/DeploymentPlan/" })')) {
  throw new Error("DeploymentPlan service worker scope is not /DeploymentPlan/");
}

const built = await filesUnder(dist);
for (const file of built) {
  const rel = path.relative(dist, file);
  if (rel.startsWith("DeploymentPlan/")) continue;
  if (rel.endsWith(".map")) throw new Error(`Source map emitted: ${rel}`);
  if (rel.endsWith(".js") || rel.endsWith(".css") || rel.endsWith(".html")) {
    const text = await readFile(file, "utf8");
    if (text.includes("sourceMappingURL")) throw new Error(`sourceMappingURL found in ${rel}`);
  }
  if (rel.startsWith("node_modules") || rel.startsWith("supabase") || rel.endsWith(".sql") || rel.startsWith("scripts/")) {
    throw new Error(`Build copied a non-site file: ${rel}`);
  }
}

const sourceSw = await readFile(path.join(root, "sw.js"), "utf8");
const cacheMatch = sourceSw.match(/const CACHE = "([^"]+)"/);
if (!cacheMatch) throw new Error("Could not read the root service worker cache name");
const cacheName = cacheMatch[1];
const sw = await readFile(path.join(dist, "sw.js"), "utf8");
if (!sw.includes(cacheName)) throw new Error(`Built service worker is missing cache name ${cacheName}`);
if (!sw.includes("/DeploymentPlan")) {
  throw new Error("Built root service worker no longer leaves /DeploymentPlan/ to the roster worker");
}
if (!sw.includes("deployment-roster-")) {
  throw new Error("Built root service worker no longer preserves deployment-roster caches");
}

const precache = [...new Set([...sw.matchAll(/"(\.\/[^"]*)"/g)].map((match) => match[1]))];
if (!precache.includes("./")) throw new Error("Root precache list is missing ./");
for (const item of precache) {
  if (item === "./") continue;
  const file = item.replace(/^\.\//, "").split("?")[0];
  try {
    await readFile(path.join(dist, file));
  } catch {
    throw new Error(`Precache path ${item} is not in dist/`);
  }
}
for (const required of ["./js/longer-than-permitted.js", "./icons/longer-than-permitted.svg?v=1.31"]) {
  if (!precache.includes(required)) throw new Error(`Root precache list is missing ${required}`);
}

const appJs = await readFile(path.join(dist, "js/app.js"), "utf8");
if (/\bfunction showHome\b/.test(appJs) || /\bfunction bootAuth\b/.test(appJs)) {
  throw new Error("js/app.js top-level names were not mangled");
}
for (const needle of ["PinLegislation", "PinLongerThanPermitted", "createClient", "PEAK_SUPABASE_URL", "PEAK_VEHICLES", "./sw.js"]) {
  if (!appJs.includes(needle)) throw new Error(`Built js/app.js is missing ${needle}`);
}

const ltp = await readFile(path.join(dist, "js/longer-than-permitted.js"), "utf8");
if (!ltp.includes("PinLongerThanPermitted") || !ltp.includes("open:")) {
  throw new Error("Built longer-than-permitted.js lost its public API");
}
await readFile(path.join(dist, "icons/longer-than-permitted.svg"));

const cname = (await readFile(path.join(dist, "CNAME"), "utf8")).trim();
if (cname !== "pinassist.app") throw new Error(`CNAME is ${JSON.stringify(cname)}`);

const sourceHtml = await readFile(path.join(root, "index.html"), "utf8");
const builtHtml = await readFile(path.join(dist, "index.html"), "utf8");
for (const match of sourceHtml.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
  const ref = match[1];
  if (/^(https?:|data:|#|mailto:)/.test(ref)) continue;
  if (!builtHtml.includes(ref)) throw new Error(`Built index.html is missing ${ref}`);
  const file = ref.split("?")[0].replace(/^\.\//, "");
  if (!file || file.endsWith("/")) continue;
  await readFile(path.join(dist, file));
}

const counts = {};
for (const action of actions.values()) counts[action] = (counts[action] || 0) + 1;
console.log(
  `Built ${built.length} files in dist/ (${cacheName}, no source maps). ` +
  `DeploymentPlan/: ${rosterCount} files copied verbatim (deployment-roster-v43, scope /DeploymentPlan/). ` +
  Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(", ") + "."
);
