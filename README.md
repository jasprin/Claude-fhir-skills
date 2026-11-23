# Claude FHIR skills

Personal archive of Claude Code skills for working on the FHIR repositories of Stichting MedMij. Published versions are maintained elsewhere.

- [`fsh-build`](skills/fsh-build/SKILL.md): builds a MedMij data service repository from FSH. It runs SUSHI in `fsh/`, copies the generated resources to `StructureDefinitions/`, `vocabulary/generated/`, `CapabilityStatements/`, `SearchParameters/` and `examples/`, applies Prettier when it is installed, validates with the HL7 validator, and fixes what is reported.

## Credits

The two-loop approach of `fsh-build` (a fast SUSHI loop and a slower validation loop, with a list of decisions to leave to a human) follows the `ig-qa-loop` skill in [hl7ch/agentic-ig](https://github.com/hl7ch/agentic-ig) by HL7 Switzerland. The text and scripts here are written for MedMij's own workflow, which uses Simplifier instead of the IG Publisher.
