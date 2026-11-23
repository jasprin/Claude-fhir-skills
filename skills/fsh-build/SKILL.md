---
name: fsh-build
description: Build a MedMij FHIR data service repository from FSH and fix what the build reports. Runs SUSHI in fsh/, copies the generated resources to StructureDefinitions/, vocabulary/generated/, CapabilityStatements/, SearchParameters/ and examples/, applies Prettier, and validates with the HL7 validator. Use after editing .fsh files or fsh/sushi-config.yaml in a MedMij-R4-* or MedMij-STU3-* repository, when asked to build, regenerate or sync the FHIR artifacts, when asked to fix SUSHI or validator errors, or before reporting a change to profiles, terminology or examples as done.
---

# FSH build for MedMij data services

A MedMij data service repository is not built with the IG Publisher. SUSHI generates the resources in `fsh/fsh-generated/`, they are copied to the repository folders, and Simplifier renders the guide from `guides/`. The layout is set out in the MedMij "GitHub way of working", section 2.2.

| Resource type | Folder |
|---|---|
| StructureDefinition (profiles, extensions, logical models) | `StructureDefinitions/` |
| CodeSystem, ValueSet, ConceptMap, NamingSystem | `vocabulary/generated/` |
| CapabilityStatement | `CapabilityStatements/` |
| SearchParameter | `SearchParameters/` |
| every other instance | `examples/` |

File names stay as SUSHI writes them, for example `StructureDefinition-mz-CariesRisk.json`. Hand-made terminology lives in `vocabulary/manual/` and is never touched by this workflow.

The FSH is the source. The JSON in the repository folders is output, not a reference: it can be stale, incomplete or produced in a way nobody can repeat. When the build and the committed JSON disagree, or when the committed state cannot be built at all, report that as a finding. Do not explain it away as a problem of your own environment, and do not assume the committed JSON is right.

The scripts below are in the `scripts/` folder next to this file. They need Node.js only; the validator also needs Java 17 or later. They work the same on Windows and macOS.

## Before you start

1. Find the repository root: the folder that contains `fsh/sushi-config.yaml`.
2. Check the branch with `git branch --show-current`. Work happens on a version branch (such as `1.0.0-rc.3`) or a ticket branch (such as `DOSINZAGE1-123`). If the branch is `main`, stop and ask; `main` is protected.
3. Run `node <this skill>/scripts/check-repo.mjs --repo <repository root>`. It changes nothing and reports:
   - each dependency package from `fsh/sushi-config.yaml`, and the packages those depend on, with the StructureDefinitions that have no snapshot. SUSHI cannot build anything that derives from those.
   - `package.json`, which Simplifier uses, against the repository: dependencies that differ from `fsh/sushi-config.yaml`, a different FHIR version, and on a version branch a version number that differs from the branch name.

   A package that is not in the cache yet is downloaded by SUSHI; run the check again after step 1. Everything it reports is a finding for the report. Do not fix a dependency or a version number on your own: that is a decision for a human (see "Stop and ask").

## Step 1. SUSHI (inner loop)

1. In `fsh/`, run `sushi build`. If `sushi` is not on the PATH, run `npx --yes --registry=https://registry.npmjs.org fsh-sushi build`. The explicit registry matters: many MedMij machines point npm at the Simplifier package registry, which does not have SUSHI.
2. SUSHI takes about a minute because it loads the dependency packages. Run one at a time.
3. Fix every error and warning in `fsh/input/fsh/`. SUSHI gives the file and the line. Fix the first error first: later errors are often caused by it.
4. Repeat until the result line shows `0 Errors 0 Warnings`.

If an error comes from a dependency package rather than from the FSH, see "Common causes" and stop: it cannot be fixed in this repository.

## Step 2. Copy to the repository folders

1. Dry run: `node <this skill>/scripts/sync-generated.mjs --repo <repository root>`. It writes nothing and lists the files that are new, changed or unchanged.
2. Read the report before you apply it.
   - A warning that the FSH is newer than `fsh-generated` means SUSHI must run again first.
   - "In target folders but not produced by SUSHI": never delete these on your own. They can be stale output of FSH that was removed, but also output that SUSHI failed to produce in this run (compare with the SUSHI errors), or a file someone added by hand. List them and ask.
   - "No agreed folder for this resource type": ask where it belongs.
3. Apply: run the same command with `--apply`. It copies the new and changed files and then runs Prettier on them with its default settings (`--no-config`), using `node_modules/.bin/prettier` in the repository or else `prettier` on the PATH. When neither exists it says so and leaves the files as SUSHI wrote them; mention that in the report.
4. Run `git status` and `git diff --stat` to see what changed.

Never edit the JSON in the repository folders by hand. The next sync overwrites it. Fix the FSH and build again.

## Step 3. HL7 validator (outer loop)

1. Run `node <this skill>/scripts/validate.mjs --repo <repository root>`. It takes several minutes: run it in the background and do not start a second one. On first use it downloads `validator_cli.jar` to `~/.fhir/validator/`; set `FHIR_VALIDATOR_JAR` or pass `--jar` to use an existing copy.
   - It validates the repository folders, loads the packages from `sushi-config.yaml` and loads the repository's own profiles and terminology as context.
   - It uses the MedMij settings: `-sct nl` (SNOMED CT Netherlands edition), `-language nl` and `-display-issues-are-warnings`.
   - `--report-only` summarises the previous output again without a new run.
   - If it reports that Java ran out of memory, ask the user to close applications, or pass a smaller heap such as `--memory 2g`. The validator needs 2 to 4 GB of free memory.
   - `--only examples` validates one folder. Arguments after `--` go to the validator unchanged, for example `-- -tx n/a` to skip the terminology server.
   - The full output is in `fsh/fsh-generated/validation/` (ignored by git): `validation.html` to read in a browser, `validation-results.json` and `validator.log`.
2. Read the summary table. Messages are sorted into three groups:
   - **Other**: fix these. Find the cause in the FSH, then go back to step 1.
   - **Terminology, Dutch system**: the terminology server could not check a code in a Dutch code system or edition (SNOMED CT NL edition, G-Standaard, NHG, Vektis, `urn:oid:2.16.840.1.113883.2.4.*`). This is expected with MedMij material. Do not change a code to make such a message go away.
   - **Terminology, other**: read each one. A typo in a code or a system URL looks just like an unknown code.
3. Look up the SNOMED CT codes. The summary ends with a list of the SNOMED CT codes named in the messages.
   - When a SNOMED CT terminology tool is available (such as the SNOMED CT Terminology connector with `snomed_lookup`), look up each code in the **Netherlands edition** (terminology `snomedct-nl`), with acceptability, so you see the Dutch preferred and acceptable terms. Show for each code: active or inactive, the fully specified name with its semantic tag, and the Dutch preferred term.
   - Use what you find to read the message correctly. "Display is no longer correct (status = inactive)" can mean the description is inactive while the concept is active. "Is a finding" depends on the semantic tag. A refset or concept that the lookup cannot find in the NL edition either confirms the message from a second source.
   - Without such a tool, run `node <this skill>/scripts/lookup-snomed.mjs <code> [<code> ...]`. It asks tx.fhir.org, the server the validator already uses, for the same codes in the NL edition, and sends nothing but the codes. It gives active or inactive, the Dutch preferred term, the semantic tag and the parents. It also lists all descriptions, but the server does not say which of those are preferred, acceptable or inactive: never present one of them as the preferred term, and say in the report that the lookup came from tx.fhir.org.
   - If neither works, for example without a network connection, list the codes as unchecked in the report.
   - Never describe a code from memory: not its meaning, its semantic tag, its status or its terms. Only state what a lookup in this run returned.
   - Never pick a replacement code yourself. Show the result and ask (see "Stop and ask").
4. Check codes from other systems that you doubt in the same way when a tool for them is available, and say so when none is.
5. The exit code is 1 as long as there are errors in the "Other" group.

## Common causes

| Message | Usual cause |
|---|---|
| SUSHI: `Structure Definition ... is missing a snapshot. Snapshot is required for import.` | The dependency package that holds this parent was published without snapshots, so this repository cannot be built from source. `check-repo.mjs` names the package and the StructureDefinitions. It cannot be fixed in the FSH. Do not edit `~/.fhir/packages`. Report it as a finding: name the package and version, and list the profiles, logical models and instances that SUSHI could not produce. |
| SUSHI: `Unable to find source "X"` | A follow-on error when X itself failed to build; fix the first error. Otherwise the Mapping or Instance names X by a name that does not exist. |
| SUSHI: an alias or canonical that cannot be resolved | The alias is missing from `Aliases.fsh`, or the package that defines it is missing from the dependencies in `sushi-config.yaml`. |
| Validator: a profile or value set that cannot be found | The package version in `sushi-config.yaml` is not the one that defines it, or the sync was not applied. |
| Validator: a slice or discriminator | The example does not match the pattern that the slice fixes. |
| Validator: a code that is not in a value set | For a Dutch code system, see the terminology group above. Otherwise the code or the system URL is wrong. |
| Many files "not produced by SUSHI" after a clean build | FSH was removed or renamed. The old JSON is still in the folder; ask before deleting it. |

## Stop and ask when

- the fix would change a cardinality, a must-support flag or a binding strength
- the fix would replace a code from an external terminology
- the fix would add, remove or change a dependency in `fsh/sushi-config.yaml` or `package.json`
- the only way to clear a message is to suppress it, or to remove or loosen an example or a constraint
- a file in the repository folders would have to be deleted
- you are on the `main` branch

## Report

End with:

- the findings of `check-repo.mjs`: dependency packages without snapshots, and differences between `package.json` and the repository
- the SUSHI result: errors and warnings
- the sync: new, changed and unchanged files, files not produced by SUSHI, and whether Prettier ran
- the validator table, each remaining error or warning in the "Other" group with the reason it was left, and the number of terminology messages with the code systems involved
- the SNOMED CT codes you looked up, with which tool, and what the lookup showed, and the codes you could not check
- the FSH files you changed and why
- findings outside your change: a dependency package that blocks the build, committed JSON that the FSH does not reproduce, errors that were already there before your change

Do not commit unless asked. When asked, use the MedMij commit message format `<ticket>: <clear description>`, for example `DOSINZAGE2-532: Changed time zone format`, with the ticket taken from the branch name.

## Out of scope

The pages in `guides/`, the sync to Simplifier, and test material in the MedMij-testscripts repository.
