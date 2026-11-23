#!/usr/bin/env node
// Looks up SNOMED CT codes in the Netherlands edition with $lookup on a FHIR
// terminology server: by default tx.fhir.org, the server the HL7 validator
// uses. Only the codes are sent.
//
// This is the fallback for when no SNOMED CT terminology tool is available.
// Limitation: the server lists the descriptions of a concept, but does not say
// which ones are preferred, acceptable or inactive. Only the display is the
// preferred term in the requested language.
//
// Usage: node lookup-snomed.mjs <code> [<code> ...] [--tx <base url>] [--edition <module id>]
//        [--language <code>]
// Exit code: 0 when all codes were found, 1 when one was not, 2 on a setup problem.

const argv = process.argv.slice(2);
const opts = {};
const codes = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[++i];
  else codes.push(argv[i]);
}
const tx = (opts.tx ?? "https://tx.fhir.org/r4").replace(/\/$/, "");
const edition = opts.edition ?? "11000146104"; // SNOMED CT Netherlands edition
const language = opts.language ?? "nl";

if (codes.length === 0 || codes.some((c) => !/^\d{6,18}$/.test(c))) {
  console.error("Usage: node lookup-snomed.mjs <SNOMED CT code> [<code> ...]  (codes are 6 to 18 digits)");
  process.exit(2);
}

const part = (p, name) => p.part?.find((x) => x.name === name);
const semanticTag = (fsn) => fsn?.match(/\(([^()]+)\)\s*$/)?.[1];

async function lookup(code) {
  const url =
    `${tx}/CodeSystem/$lookup?system=${encodeURIComponent("http://snomed.info/sct")}` +
    `&code=${code}&version=${encodeURIComponent(`http://snomed.info/sct/${edition}`)}` +
    `&displayLanguage=${language}&property=inactive&property=parent&property=designation`;
  const res = await fetch(url, { headers: { Accept: "application/fhir+json" } });
  const body = await res.json().catch(() => undefined);
  if (!res.ok || body?.resourceType !== "Parameters") {
    const why = body?.issue?.map((i) => i.details?.text ?? i.diagnostics).filter(Boolean).join("; ");
    return { code, found: false, why: why || `HTTP ${res.status}` };
  }
  const r = { code, found: true, terms: [], parents: [] };
  for (const p of body.parameter ?? []) {
    if (p.name === "display") r.display = p.valueString;
    if (p.name === "version") r.version = p.valueString;
    if (p.name === "property") {
      const c = part(p, "code")?.valueCode;
      const v = part(p, "value");
      if (c === "inactive") r.inactive = v?.valueBoolean;
      if (c === "parent") r.parents.push(`${v?.valueCode}${part(p, "description") ? ` ${part(p, "description").valueString}` : ""}`);
    }
    if (p.name === "designation") {
      r.terms.push({
        lang: part(p, "language")?.valueCode ?? "?",
        use: part(p, "use")?.valueCoding?.display ?? "",
        value: part(p, "value")?.valueString ?? "",
      });
    }
  }
  return r;
}

console.log(`Server: ${tx}  edition: ${edition}  language: ${language}`);
console.log(
  "Note: the server does not mark descriptions as preferred, acceptable or inactive. " +
    "Only 'display' is the preferred term; do not take any other listed term as preferred.",
);
let missing = 0;
for (const code of codes) {
  let r;
  try {
    r = await lookup(code);
  } catch (e) {
    console.error(`ERROR: could not reach ${tx}: ${e.message}`);
    process.exit(2);
  }
  console.log();
  if (!r.found) {
    missing++;
    console.log(`${code}: NOT FOUND in this edition. ${r.why}`);
    continue;
  }
  const fsns = r.terms.filter((t) => /fully specified/i.test(t.use));
  const tags = [...new Set(fsns.map((t) => semanticTag(t.value)).filter(Boolean))];
  console.log(`${code}: ${r.inactive === true ? "INACTIVE concept" : r.inactive === false ? "active concept" : "status unknown"}`);
  console.log(`  preferred term (${language}): ${r.display ?? "(none)"}`);
  console.log(`  semantic tag(s): ${tags.join(", ") || "(none found)"}`);
  if (r.parents.length) console.log(`  parent(s): ${r.parents.join("; ")}`);
  console.log(`  edition version: ${r.version ?? "(not given)"}`);
  console.log(`  all descriptions (status not known):`);
  for (const t of r.terms) console.log(`    [${t.lang}] ${t.use}: ${t.value}`);
}
process.exit(missing ? 1 : 0);
