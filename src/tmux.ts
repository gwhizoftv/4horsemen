import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const tmux = (args: string[]): string | null => {
  const res = spawnSync("tmux", args, { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
};

export const ensureSession = (sessionName: string) => {
  if (!tmux(["has-session", "-t", sessionName])) {
    tmux(["new-session", "-d", "-s", sessionName]);
  }
};

export const ensureWindow = (sessionName: string, windowName: string, startDir: string, agent: string) => {
  const target = `${sessionName}:${windowName}`;
  if (!tmux(["list-panes", "-t", target])) {
    tmux(["new-window", "-t", sessionName, "-n", windowName, "-c", startDir]);
    const script = resolve(startDir, `start-${agent}.sh`);
    tmux(["send-keys", "-t", target, `${script}`, "C-m"]);
  }
};

export const isHarnessActive = (sessionName: string, windowName: string): boolean => {
  const out = tmux(["list-panes", "-t", `${sessionName}:${windowName}`, "-F", "#{pane_current_command}"]);
  if (!out) return false;
  return out.includes("bash") || out.includes("zsh") || out.includes("sh") || out.includes("node");
};

export const deliverNudge = (sessionName: string, windowName: string, agent: string, actionId: string) => {
  if (agent !== "claude") return;
  const target = `${sessionName}:${windowName}`;
  const msg = `Please pick up action ${actionId}\\n`;
  spawnSync("tmux", ["set-buffer", msg]);
  tmux(["paste-buffer", "-t", target]);
};
