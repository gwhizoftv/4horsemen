import { existsSync, readFileSync, writeFileSync } from "node:fs";

const block = (begin: string, end: string, lines: readonly string[]): string =>
  [begin, ...lines, end].join("\n");

export const replaceManagedBlock = (
  current: string,
  begin: string,
  end: string,
  lines: readonly string[]
): string => {
  const start = current.indexOf(begin);
  const finish = current.indexOf(end);
  if ((start === -1) !== (finish === -1) || (start !== -1 && finish < start)) {
    throw new Error(`Malformed managed block ${begin}. Remove or repair it before continuing.`);
  }
  const managed = block(begin, end, lines);
  if (start === -1) {
    const prefix = current === "" ? "" : current.endsWith("\n") ? `${current}\n` : `${current}\n\n`;
    return `${prefix}${managed}\n`;
  }
  const after = finish + end.length;
  return `${current.slice(0, start)}${managed}${current.slice(after)}`;
};

export const removeManagedBlock = (current: string, begin: string, end: string): string => {
  const start = current.indexOf(begin);
  const finish = current.indexOf(end);
  if (start === -1 && finish === -1) return current;
  if (start === -1 || finish === -1 || finish < start) {
    throw new Error(`Malformed managed block ${begin}. Refusing to edit it.`);
  }
  let before = current.slice(0, start);
  let after = current.slice(finish + end.length);
  if (before.endsWith("\n\n") && after.startsWith("\n")) after = after.slice(1);
  if (before === "" && after.startsWith("\n")) after = after.slice(1);
  if (after === "" && before.endsWith("\n\n")) before = before.slice(0, -1);
  return `${before}${after}`;
};

const writeIfChanged = (path: string, next: string): boolean => {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current === next) return false;
  writeFileSync(path, next, "utf8");
  return true;
};

export const cloneExcludeMarkers = (agent: string): { begin: string; end: string } => ({
  begin: `# BEGIN coord managed (${agent})`,
  end: `# END coord managed (${agent})`
});

export const updateCloneExclude = (path: string, agent: string, lines: readonly string[]): boolean => {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const markers = cloneExcludeMarkers(agent);
  return writeIfChanged(path, replaceManagedBlock(current, markers.begin, markers.end, lines));
};

export const removeCloneExclude = (path: string, agent: string): boolean => {
  if (!existsSync(path)) return false;
  const current = readFileSync(path, "utf8");
  const markers = cloneExcludeMarkers(agent);
  return writeIfChanged(path, removeManagedBlock(current, markers.begin, markers.end));
};

export const PRODUCT_IGNORE_BEGIN = "# BEGIN coord managed";
export const PRODUCT_IGNORE_END = "# END coord managed";

export const updateProductIgnore = (path: string, lines: readonly string[]): boolean => {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  return writeIfChanged(path, replaceManagedBlock(current, PRODUCT_IGNORE_BEGIN, PRODUCT_IGNORE_END, lines));
};

export const removeProductIgnore = (path: string): boolean => {
  if (!existsSync(path)) return false;
  const current = readFileSync(path, "utf8");
  return writeIfChanged(path, removeManagedBlock(current, PRODUCT_IGNORE_BEGIN, PRODUCT_IGNORE_END));
};
