import { readFile } from "node:fs/promises";

// Load prototype-local settings without replacing values already supplied by
// the launching environment. Values are never logged by this module.
export async function loadLocalEnv(filePath, env = process.env) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const [name, value] of Object.entries(parseEnv(contents))) {
    if (env[name] === undefined) env[name] = value;
  }
}

export function parseEnv(contents) {
  const values = {};
  for (const rawLine of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}
