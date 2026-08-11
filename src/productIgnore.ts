import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BLOCK_START = "# --- BEGIN COORDINATION MANAGED BLOCK ---";
export const BLOCK_END = "# --- END COORDINATION MANAGED BLOCK ---";

export const defaultExcludeLines = [
  "tags",
  "directory_tree.md",
  ".plans/",
  ".signals/",
  ".code-reviews/",
  ".amendments/",
  ".escalations/",
  "start-*.sh"
];

export const writeProductIgnore = (productRoot: string, blockContent: string): void => {
  const ignorePath = join(productRoot, ".gitignore");
  let content = "";
  if (existsSync(ignorePath)) {
    content = readFileSync(ignorePath, "utf8");
  }
  
  if (content.includes(BLOCK_START)) {
    const regex = new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}`, "g");
    content = content.replace(regex, `${BLOCK_START}\n${blockContent.trim()}\n${BLOCK_END}`);
  } else {
    if (content.length > 0 && !content.endsWith("\n")) {
      content += "\n";
    }
    content += `\n${BLOCK_START}\n${blockContent.trim()}\n${BLOCK_END}\n`;
  }
  
  writeFileSync(ignorePath, content, "utf8");
};

export const removeProductIgnore = (productRoot: string): void => {
  const ignorePath = join(productRoot, ".gitignore");
  if (!existsSync(ignorePath)) return;
  let content = readFileSync(ignorePath, "utf8");
  if (content.includes(BLOCK_START)) {
    const regex = new RegExp(`\\n?${BLOCK_START}[\\s\\S]*?${BLOCK_END}\\n?`, "g");
    content = content.replace(regex, "\n");
    writeFileSync(ignorePath, content, "utf8");
  }
};
