#!/usr/bin/env node
// Validates the FHIR resources of a MedMij data service repository with the
// HL7 FHIR validator (validator_cli.jar) and sorts the messages into:
//
//   - terminology: the validator could not check a code, usually because the
//     terminology server does not know a Dutch code system or edition
//     (SNOMED CT NL, G-Standaard, NHG, Vektis, urn:oid:2.16.840.1.113883.2.4.*)
//   - other: everything else. These are the messages to fix.
//
// Nothing is suppressed: both groups are reported. The full validator output is
// written to fsh/fsh-generated/validation/ (git-ignored).
//
// Usage:
//   node validate.mjs [--repo <dir>] [--jar <validator_cli.jar>] [--tx <url|n/a>]
//                     [--only <folder>[,<folder>]] [--memory <java heap, default 4g>]
//                     [--report-only  (summarise the previous output again, no new run)]
//                     [-- <extra validator args>]
//
// The jar is taken from --jar, then $FHIR_VALIDATOR_JAR, then
// ~/.fhir/validator/validator_cli.jar, which is downloaded when missing.
// Exit code: 0 when there are no "other" errors, 1 when there are, 2 on a setup problem.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const args = dashdash >= 0 ? argv.slice(0, dashdash) : argv;
const extra = dashdash >= 0 ? argv.slice(dashdash + 1) : [];
const val = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const repo = path.resolve(val("--repo") ?? process.cwd());
const fshDir = path.join(repo, "fsh");
const configPath = path.join(fshDir, "sushi-config.yaml");
const JAR_URL = "https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar";

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}

if (!fs.existsSync(configPath)) fail(`no fsh/sushi-config.yaml in ${repo}. Pass --repo <root of the data service repository>.`);

// --- sushi-config.yaml: fhirVersion and dependencies -------------------------
// A small reader for the two keys we need, so the script has no npm dependencies.
// Supports "pkg: 1.0.0" and the long form "pkg:\n    version: 1.0.0".
function readConfig(text) {
  const lines = text.split(/\r?\n/);
  let fhirVersion = "4.0.1";
  const deps = [];
  let inDeps = false;
  let current;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent === 0) {
      inDeps = /^dependencies\s*:/.test(line);
      const fv = line.match(/^fhirVersion\s*:\s*(.+)$/);
      if (fv) fhirVersion = fv[1].trim().replace(/^\[|\]$/g, "").split(",")[0].trim().replace(/['"]/g, "");
      current = undefined;
      continue;
    }
    if (!inDeps) continue;
    const kv = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (current && indent > current.indent) {
      if (key === "version") current.dep.version = value.replace(/['"]/g, "");
      continue;
    }
    const dep = { id: key.trim().replace(/['"]/g, ""), version: value.replace(/['"]/g, "") || undefined };
    deps.push(dep);
    current = { indent, dep };
  }
  return { fhirVersion, deps: deps.filter((d) => d.version) };
}
const config = readConfig(fs.readFileSync(configPath, "utf8"));

// --- Java and the validator jar ---------------------------------------------
const java = spawnSync("java", ["-version"], { encoding: "utf8" });
if (java.error || java.status !== 0) {
  fail(`could not run "java -version" (${java.error?.message ?? `exit ${java.status}: ${java.stderr}`}). The HL7 validator needs Java 17 or later on the PATH.`);
}

async function ensureJar() {
  const explicit = val("--jar") ?? process.env.FHIR_VALIDATOR_JAR;
  if (explicit) {
    if (!fs.existsSync(explicit)) fail(`validator jar not found: ${explicit}`);
    return explicit;
  }
  const jar = path.join(os.homedir(), ".fhir", "validator", "validator_cli.jar");
  if (fs.existsSync(jar)) return jar;
  console.log(`Downloading the HL7 validator to ${jar} ...`);
  fs.mkdirSync(path.dirname(jar), { recursive: true });
  const res = await fetch(JAR_URL, { redirect: "follow" });
  if (!res.ok) fail(`download failed: HTTP ${res.status} for ${JAR_URL}`);
  // Stream to disk: the jar is too large to hold in memory as one buffer.
  const tmp = `${jar}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, jar);
  return jar;
}

// --- What to validate and what to load as context ----------------------------
const DEFAULT_SOURCES = ["StructureDefinitions", path.join("vocabulary", "generated"), path.join("vocabulary", "manual"), "vocabulary", "CapabilityStatements", "SearchParameters", "examples"];
const only = val("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
const jsonFilesIn = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f)) : [];

const sourceDirs = (only ?? DEFAULT_SOURCES).map((d) => path.join(repo, d)).filter((d) => jsonFilesIn(d).length > 0);
if (sourceDirs.length === 0) fail("no JSON files found in the folders to validate.");
// The repository's own conformance resources are loaded as context, so that
// examples are checked against the profiles and value sets in this repository.
const contextDirs = ["StructureDefinitions", path.join("vocabulary", "generated"), path.join("vocabulary", "manual"), "vocabulary", "SearchParameters"]
  .map((d) => path.join(repo, d))
  .filter((d) => jsonFilesIn(d).length > 0);

const outDir = path.join(fshDir, "fsh-generated", "validation");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "validation-results.json");
const logFile = path.join(outDir, "validator.log");
const htmlFile = path.join(outDir, "validation.html");

const reportOnly = args.includes("--report-only");
if (reportOnly && !fs.existsSync(outFile)) fail(`--report-only: no earlier output in ${outFile}.`);
const jar = reportOnly ? undefined : await ensureJar();
const cmd = [
  `-Xmx${val("--memory") ?? "4g"}`,
  "-jar",
  jar,
  ...sourceDirs,
  "-version",
  config.fhirVersion,
  ...config.deps.flatMap((d) => ["-ig", `${d.id}#${d.version}`]),
  ...contextDirs.flatMap((d) => ["-ig", d]),
  ...(val("--tx") ? ["-tx", val("--tx")] : []),
  // MedMij defaults: SNOMED CT Netherlands edition, Dutch messages and
  // displays, and a display that differs from the code system is a warning.
  "-sct",
  "nl",
  "-language",
  "nl",
  "-display-issues-are-warnings",
  "-output",
  outFile,
  "-html-output",
  htmlFile,
  ...extra,
];

const started = Date.now();
let run = { status: "(not run, --report-only)" };
if (reportOnly) {
  console.log(`Reading the earlier output in ${outFile}`);
} else {
  console.log(`Validating ${sourceDirs.map((d) => path.relative(repo, d)).join(", ")}`);
  console.log(`FHIR ${config.fhirVersion}; packages: ${config.deps.map((d) => `${d.id}#${d.version}`).join(", ") || "(none)"}`);
  console.log(`Log: ${logFile}`);
  // Remove the previous output so that a failed run cannot be mistaken for a passed one.
  for (const f of [outFile, htmlFile]) fs.rmSync(f, { force: true });
  // cwd = outDir, so that a JVM crash report (hs_err_pid*.log) lands there and
  // not in the repository.
  run = spawnSync("java", cmd, { cwd: outDir, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  fs.writeFileSync(logFile, `java ${cmd.join(" ")}\n\n${run.stdout ?? ""}\n${run.stderr ?? ""}`);
  if (/insufficient memory for the Java Runtime|OutOfMemoryError/.test(`${run.stdout}${run.stderr}`)) {
    fail(`the validator ran out of memory. Close other applications, or pass a different heap size with --memory (now ${val("--memory") ?? "4g"}). See ${logFile}.`);
  }
  if (!fs.existsSync(outFile)) {
    fail(`the validator produced no output (exit ${run.status}). See ${logFile}:\n${(run.stdout || "").split(/\r?\n/).slice(-30).join("\n")}\n${run.stderr || ""}`);
  }
}

// --- Read and sort the messages ---------------------------------------------
const output = JSON.parse(fs.readFileSync(outFile, "utf8"));
const outcomes =
  output.resourceType === "Bundle" ? (output.entry ?? []).map((e) => e.resource) : [output];

const ext = (el, url) => (el?.extension ?? []).find((e) => e.url === url);
const FILE_EXT = "http://hl7.org/fhir/StructureDefinition/operationoutcome-file";
const MSGID_EXT = "http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id";

const DUTCH_SYSTEM = [
  /urn:oid:2\.16\.840\.1\.113883\.2\.4\./, // Dutch OIDs: G-Standaard, NHG, Vektis, AGB, ...
  /urn:oid:2\.16\.528\./,
  /11000146104/, // SNOMED CT Netherlands edition module
  /snomed\.info\/sct\/11000146104/,
  /loinc\.org.*\bnl\b/i,
  /nictiz|medmij|zibs?\b/i,
];
function category(issue) {
  const id = ext(issue, MSGID_EXT)?.valueString ?? "";
  const text = issue.details?.text ?? issue.diagnostics ?? "";
  const tx =
    /^(Terminology_|TERMINOLOGY_|TX_|UNKNOWN_CODESYSTEM|UNKNOWN_CODE|VALUESET_|CODESYSTEM_|Display_Name|BINDING_)/i.test(id) ||
    /\b(code ?system|value ?set|terminology server|tx\.fhir\.org|unknown code|not found in the value set|wasn't found|could not be validated|display)\b/i.test(text) ||
    (issue.code === "code-invalid");
  if (!tx) return "other";
  return DUTCH_SYSTEM.some((re) => re.test(text)) ? "terminology-nl" : "terminology";
}

const rows = [];
for (const oo of outcomes) {
  if (!oo || oo.resourceType !== "OperationOutcome") continue;
  const file = ext(oo, FILE_EXT)?.valueString ?? "(unknown file)";
  for (const issue of oo.issue ?? []) {
    if (issue.severity === "information") continue;
    rows.push({
      file: path.relative(repo, file) || file,
      severity: issue.severity,
      category: category(issue),
      id: ext(issue, MSGID_EXT)?.valueString ?? "",
      where: (issue.expression ?? issue.location ?? []).join(", "),
      text: (issue.details?.text ?? issue.diagnostics ?? "").replace(/\s+/g, " ").trim(),
    });
  }
}

const count = (cat, sev) => rows.filter((r) => r.category === cat && r.severity === sev).length;
const sevs = ["fatal", "error", "warning"];
const cats = [
  ["other", "Other (fix these)"],
  ["terminology-nl", "Terminology, Dutch system"],
  ["terminology", "Terminology, other"],
];

const line = (s = "") => console.log(s);
line();
line(
  reportOnly
    ? `${outcomes.length} file(s) in the earlier output.`
    : `Validated ${outcomes.length} file(s) in ${Math.round((Date.now() - started) / 1000)} s. Validator exit code ${run.status}.`,
);
line();
line(`${"Category".padEnd(28)}${sevs.map((s) => s.padStart(9)).join("")}`);
for (const [cat, label] of cats) line(`${label.padEnd(28)}${sevs.map((s) => String(count(cat, s)).padStart(9)).join("")}`);
line();

function printGroup(cat, title, limit) {
  const list = rows.filter((r) => r.category === cat && r.severity !== "information");
  if (list.length === 0) return;
  line(`## ${title}`);
  // Group identical messages so that one cause shows once with its files.
  const groups = new Map();
  for (const r of list) {
    // Some messages end with the element they are about ("... at mz-lm-X.Comment").
    // Leave that out of the key so that one rule shows once, not once per element.
    const key = `${r.severity}|${r.text.replace(/\s+at\s+[\w.\-\[\]:]+$/, "")}`;
    if (!groups.has(key)) groups.set(key, { ...r, text: key.slice(key.indexOf("|") + 1), files: new Set(), wheres: new Set(), count: 0 });
    groups.get(key).count++;
    groups.get(key).files.add(r.file);
    if (r.where) groups.get(key).wheres.add(r.where);
  }
  const order = { fatal: 0, error: 1, warning: 2 };
  const sorted = [...groups.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.files.size - a.files.size);
  for (const g of sorted.slice(0, limit)) {
    line(`- [${g.severity}] ${g.text}${g.id ? `  (${g.id})` : ""}${g.count > 1 ? `  [${g.count}x]` : ""}`);
    const files = [...g.files];
    line(`    files (${files.length}): ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", ..." : ""}`);
    const wheres = [...g.wheres];
    if (wheres.length) line(`    at: ${wheres.slice(0, 3).join(" | ")}${wheres.length > 3 ? " | ..." : ""}`);
  }
  if (sorted.length > limit) line(`  ... ${sorted.length - limit} more distinct messages; see ${outFile}`);
  line();
}
printGroup("other", "Other messages", 60);
printGroup("terminology-nl", "Terminology messages about Dutch code systems", 30);
printGroup("terminology", "Other terminology messages", 30);
line(`Full output: ${outFile}`);
if (fs.existsSync(htmlFile)) line(`HTML report: ${htmlFile}`);

const blocking = rows.filter((r) => r.category === "other" && (r.severity === "error" || r.severity === "fatal")).length;
process.exit(blocking > 0 ? 1 : 0);
