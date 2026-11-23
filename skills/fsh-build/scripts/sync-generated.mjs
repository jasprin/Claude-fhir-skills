#!/usr/bin/env node
// Copies the resources that SUSHI generated in fsh/fsh-generated/resources to
// the folders of a MedMij data service repository, following the MedMij
// "GitHub way of working" (section 2.2.1 and 2.2.2):
//
//   StructureDefinition                          -> StructureDefinitions/
//   CodeSystem, ValueSet, ConceptMap, NamingSystem -> vocabulary/generated/
//   CapabilityStatement                          -> CapabilityStatements/
//   SearchParameter                              -> SearchParameters/
//   any other instance                           -> examples/
//
// File names stay as SUSHI wrote them. Without --apply the script only reports
// what it would do. It never deletes a file: files in the target folders that
// SUSHI did not produce are listed for a human to decide on.
//
// Usage: node sync-generated.mjs [--repo <dir>] [--apply] [--no-prettier]

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name) => args.includes(name);
const val = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const repo = path.resolve(val("--repo") ?? process.cwd());
const apply = opt("--apply");
const usePrettier = !opt("--no-prettier");

const fshDir = path.join(repo, "fsh");
const genDir = path.join(fshDir, "fsh-generated", "resources");

const TARGETS = {
  StructureDefinition: "StructureDefinitions",
  CodeSystem: path.join("vocabulary", "generated"),
  ValueSet: path.join("vocabulary", "generated"),
  ConceptMap: path.join("vocabulary", "generated"),
  NamingSystem: path.join("vocabulary", "generated"),
  CapabilityStatement: "CapabilityStatements",
  SearchParameter: "SearchParameters",
};
// Definitional resources that have no agreed folder yet. They are reported and
// not copied, so that nobody finds them in examples/ by accident.
const UNMAPPED = new Set([
  "ImplementationGuide",
  "OperationDefinition",
  "CompartmentDefinition",
  "GraphDefinition",
  "MessageDefinition",
  "StructureMap",
  "TerminologyCapabilities",
  "ActorDefinition",
  "Requirements",
]);
const EXAMPLES = "examples";
const ALL_TARGET_DIRS = [...new Set([...Object.values(TARGETS), EXAMPLES])];

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}

if (!fs.existsSync(path.join(fshDir, "sushi-config.yaml"))) {
  fail(`no fsh/sushi-config.yaml in ${repo}. Pass --repo <root of the data service repository>.`);
}
if (!fs.existsSync(genDir)) {
  fail(`${path.relative(repo, genDir)} does not exist. Run SUSHI in fsh/ first.`);
}

// Warn when the generated output is older than the FSH sources.
function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else if (entry.name.endsWith(".fsh")) newest = Math.max(newest, fs.statSync(p).mtimeMs);
  }
  return newest;
}
const generatedFiles = fs.readdirSync(genDir).filter((f) => f.endsWith(".json"));
if (generatedFiles.length === 0) fail(`${path.relative(repo, genDir)} contains no JSON files.`);
const oldestGenerated = Math.min(...generatedFiles.map((f) => fs.statSync(path.join(genDir, f)).mtimeMs));
const newestSource = Math.max(
  newestMtime(path.join(fshDir, "input")),
  fs.statSync(path.join(fshDir, "sushi-config.yaml")).mtimeMs,
);
const stale = newestSource > oldestGenerated;

// Compare JSON by content, ignoring key order and formatting, so that a file
// that Prettier reformatted earlier does not show up as changed.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}
const sameContent = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const result = { new: [], changed: [], unchanged: [], unmapped: [], unreadable: [] };
const produced = new Set();

for (const file of generatedFiles.sort()) {
  const src = path.join(genDir, file);
  let resource;
  try {
    resource = readJson(src);
  } catch (e) {
    result.unreadable.push(`${file}: ${e.message}`);
    continue;
  }
  const type = resource.resourceType;
  if (UNMAPPED.has(type)) {
    result.unmapped.push(`${file} (${type})`);
    continue;
  }
  const dir = TARGETS[type] ?? EXAMPLES;
  const rel = path.join(dir, file);
  produced.add(path.normalize(rel).toLowerCase());
  const dest = path.join(repo, rel);
  if (!fs.existsSync(dest)) result.new.push({ src, dest, rel });
  else {
    let existing;
    try {
      existing = readJson(dest);
    } catch {
      existing = undefined;
    }
    if (existing && sameContent(existing, resource)) result.unchanged.push(rel);
    else result.changed.push({ src, dest, rel });
  }
}

// Files in the target folders that this SUSHI run did not produce.
const notProduced = [];
for (const dir of ALL_TARGET_DIRS) {
  const abs = path.join(repo, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs)) {
    if (!f.endsWith(".json")) continue;
    const rel = path.join(dir, f);
    if (!produced.has(path.normalize(rel).toLowerCase())) notProduced.push(rel);
  }
}

// Find Prettier: the repository's own copy first, then one on the PATH.
function findPrettier() {
  const bin = process.platform === "win32" ? "prettier.cmd" : "prettier";
  const local = path.join(repo, "node_modules", ".bin", bin);
  if (fs.existsSync(local)) return local;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["prettier"], {
    encoding: "utf8",
  });
  if (which.status === 0) {
    const lines = which.stdout.split(/\r?\n/).filter(Boolean);
    return (process.platform === "win32" && lines.find((l) => l.toLowerCase().endsWith(".cmd"))) || lines[0];
  }
  return undefined;
}

const toCopy = [...result.new, ...result.changed];
let prettierNote = "skipped (--no-prettier)";
if (apply) {
  for (const { src, dest } of toCopy) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  if (usePrettier) {
    const prettier = findPrettier();
    if (!prettier) prettierNote = "not found (no node_modules/.bin/prettier, none on PATH); files left as SUSHI wrote them";
    else if (toCopy.length === 0) prettierNote = `found at ${prettier}; nothing to format`;
    else {
      // --no-config: MedMij uses Prettier's default settings, whatever config
      // file may be lying around.
      const run = spawnSync(prettier, ["--no-config", "--write", ...toCopy.map((c) => c.dest)], {
        cwd: repo,
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      prettierNote =
        run.status === 0
          ? `applied to ${toCopy.length} file(s) with ${prettier}`
          : `FAILED (exit ${run.status}): ${(run.stderr || run.stdout).trim()}`;
    }
  }
} else {
  prettierNote = usePrettier ? (findPrettier() ? `will run (${findPrettier()})` : "not found; will be skipped") : prettierNote;
}

// Report
const line = (s = "") => console.log(s);
line(`Repository: ${repo}`);
line(`Mode: ${apply ? "APPLY (files copied)" : "dry run (nothing written; pass --apply to copy)"}`);
if (stale) {
  line("WARNING: a .fsh file or sushi-config.yaml is newer than fsh/fsh-generated. Run SUSHI again before syncing.");
}
line();
line(`New:       ${result.new.length}`);
for (const r of result.new) line(`  + ${r.rel}`);
line(`Changed:   ${result.changed.length}`);
for (const r of result.changed) line(`  ~ ${r.rel}`);
line(`Unchanged: ${result.unchanged.length}`);
if (result.unmapped.length) {
  line(`Not copied, no agreed folder for this resource type: ${result.unmapped.length}`);
  for (const r of result.unmapped) line(`  ? ${r}`);
}
if (result.unreadable.length) {
  line(`Not copied, not valid JSON: ${result.unreadable.length}`);
  for (const r of result.unreadable) line(`  ! ${r}`);
}
line(`In target folders but not produced by SUSHI: ${notProduced.length}`);
for (const r of notProduced) line(`  - ${r}`);
line();
line(`Prettier: ${prettierNote}`);
