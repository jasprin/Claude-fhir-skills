#!/usr/bin/env node
// Checks a MedMij data service repository before and around a build. It only
// reports; it changes nothing.
//
// 1. Dependency packages: every package in fsh/sushi-config.yaml, and the
//    packages they depend on, must be in the local FHIR package cache with
//    snapshots in their StructureDefinitions. SUSHI cannot build a profile or
//    logical model whose parent has no snapshot.
// 2. package.json (the package Simplifier builds) against the repository:
//    - its dependencies against those in fsh/sushi-config.yaml
//    - its fhirVersions against fhirVersion in fsh/sushi-config.yaml
//    - its version against the branch name, on a version branch
//
// Usage: node check-repo.mjs [--repo <dir>]
// Exit code: 0 when nothing was found, 1 when there are findings, 2 on a setup problem.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readSushiConfig } from "./lib/sushi-config.mjs";

const args = process.argv.slice(2);
const val = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const repo = path.resolve(val("--repo") ?? process.cwd());
const configPath = path.join(repo, "fsh", "sushi-config.yaml");
if (!fs.existsSync(configPath)) {
  console.error(`ERROR: no fsh/sushi-config.yaml in ${repo}. Pass --repo <root of the data service repository>.`);
  process.exit(2);
}
const config = readSushiConfig(fs.readFileSync(configPath, "utf8"));
const cache = process.env.FHIR_PACKAGE_CACHE ?? path.join(os.homedir(), ".fhir", "packages");

const findings = [];
const notes = [];
const line = (s = "") => console.log(s);

// --- 1. Dependency packages --------------------------------------------------
// The core package of the FHIR version itself is checked by nobody but needed
// by everybody; it always has snapshots.
const isCore = (id) => /^hl7\.fhir\.r\d+b?\.core$/.test(id);
const FLOATING = new Set(["current", "dev", "latest"]);

function packageDir(id, version) {
  const dir = path.join(cache, `${id}#${version}`, "package");
  return fs.existsSync(dir) ? dir : undefined;
}

function checkPackage(id, version) {
  const dir = packageDir(id, version);
  if (!dir) return { id, version, cached: false };
  let total = 0;
  const missing = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "package.json" || f.startsWith(".")) continue;
    let r;
    try {
      r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (r.resourceType !== "StructureDefinition") continue;
    total++;
    if (!r.snapshot) missing.push(r.id ?? f);
  }
  let deps = {};
  try {
    deps = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dependencies ?? {};
  } catch {}
  return { id, version, cached: true, total, missing, deps };
}

line(`Repository: ${repo}`);
line(`Package cache: ${cache}`);
line();
line("## Dependency packages");
const seen = new Map();
const queue = config.deps.map((d) => ({ ...d, via: "sushi-config.yaml" }));
while (queue.length) {
  const { id, version, via } = queue.shift();
  const key = `${id}#${version}`;
  if (seen.has(key) || isCore(id)) continue;
  if (FLOATING.has(version)) {
    seen.set(key, true);
    notes.push(`${key}: a floating version; it is not checked, and the build is not repeatable with it.`);
    continue;
  }
  const result = checkPackage(id, version);
  seen.set(key, result);
  const from = via === "sushi-config.yaml" ? "" : ` (needed by ${via})`;
  if (!result.cached) {
    line(`- ${key}${from}: not in the cache yet. SUSHI downloads it on its first run; run this check again afterwards.`);
    continue;
  }
  if (result.missing.length === 0) {
    line(`- ${key}${from}: ${result.total} StructureDefinitions, all with a snapshot.`);
  } else {
    line(`- ${key}${from}: ${result.missing.length} of ${result.total} StructureDefinitions have NO snapshot:`);
    for (const m of result.missing) line(`    ${m}`);
    findings.push(
      `${key} was published without snapshots for ${result.missing.length} of ${result.total} StructureDefinitions. ` +
        `SUSHI cannot build anything in this repository that derives from them.`,
    );
  }
  for (const [depId, depVersion] of Object.entries(result.deps)) queue.push({ id: depId, version: depVersion, via: key });
}
line();

// --- 2. package.json ---------------------------------------------------------
line("## package.json");
const pkgPath = path.join(repo, "package.json");
if (!fs.existsSync(pkgPath)) {
  line("- There is no package.json in the repository root.");
  findings.push("There is no package.json in the repository root.");
} else {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (e) {
    findings.push(`package.json is not valid JSON: ${e.message}`);
  }
  if (pkg) {
    line(`- name ${pkg.name}, version ${pkg.version}`);

    // Dependencies: compare both ways, leaving out the FHIR core package that
    // SUSHI adds from fhirVersion.
    const fromPkg = Object.fromEntries(Object.entries(pkg.dependencies ?? {}).filter(([id]) => !isCore(id)));
    const fromSushi = Object.fromEntries(config.deps.map((d) => [d.id, d.version]));
    for (const [id, v] of Object.entries(fromSushi)) {
      if (!(id in fromPkg)) {
        findings.push(`${id}#${v} is a dependency in fsh/sushi-config.yaml but not in package.json.`);
      } else if (fromPkg[id] !== v) {
        findings.push(`${id}: version ${v} in fsh/sushi-config.yaml, ${fromPkg[id]} in package.json.`);
      }
    }
    for (const [id, v] of Object.entries(fromPkg)) {
      if (!(id in fromSushi)) findings.push(`${id}#${v} is a dependency in package.json but not in fsh/sushi-config.yaml.`);
    }

    // FHIR version
    const pkgFhir = pkg.fhirVersions ?? (pkg["fhir-version-list"] || []);
    if (pkgFhir.length && !pkgFhir.includes(config.fhirVersion)) {
      findings.push(`fhirVersions in package.json is ${pkgFhir.join(", ")}; fhirVersion in fsh/sushi-config.yaml is ${config.fhirVersion}.`);
    }

    // Version against the branch name. Version branches are named after the
    // version (MedMij GitHub way of working, 2.2.4); ticket branches are not.
    const git = spawnSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" });
    const branch = git.status === 0 ? git.stdout.trim() : "";
    const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
    if (!branch) {
      notes.push("Could not read the current branch; the version in package.json was not compared with it.");
    } else if (SEMVER.test(branch)) {
      line(`- branch ${branch} (a version branch)`);
      if (branch !== pkg.version) {
        findings.push(`The branch is ${branch}, but the version in package.json is ${pkg.version}.`);
      }
    } else {
      line(`- branch ${branch} (not a version branch; the version was not compared)`);
    }
  }
}
line();

// --- Result -----------------------------------------------------------------
line(`## Findings (${findings.length})`);
for (const f of findings) line(`- ${f}`);
if (findings.length === 0) line("- none");
if (notes.length) {
  line();
  line("## Notes");
  for (const n of notes) line(`- ${n}`);
}
process.exit(findings.length ? 1 : 0);
