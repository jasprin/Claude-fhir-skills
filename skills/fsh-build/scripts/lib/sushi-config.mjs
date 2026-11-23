// Reads the keys of fsh/sushi-config.yaml that the scripts need, without an npm
// dependency on a YAML parser. Supports both dependency forms:
//   dependencies:
//     some.package: 1.0.0
//     other.package:
//       version: 2.0.0

export function readSushiConfig(text) {
  let fhirVersion = "4.0.1";
  const deps = [];
  let inDeps = false;
  let current;
  for (const raw of text.split(/\r?\n/)) {
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
