import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export const LAUNCHD_LABEL = "com.9sako6.zundamonotify";
export const LAUNCH_AGENTS_DIR = resolve(homedir(), "Library", "LaunchAgents");
export const LAUNCH_AGENT_PATH = resolve(LAUNCH_AGENTS_DIR, `${LAUNCHD_LABEL}.plist`);

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function getLaunchdTarget({ uid = process.getuid?.() ?? process.env.UID } = {}) {
  return `gui/${uid}`;
}

export function getCurrentProgramArguments({
  execPath = process.execPath,
  scriptPath = process.argv[1],
} = {}) {
  const args = [resolve(execPath)];
  if (scriptPath && !scriptPath.startsWith("/$bunfs/") && resolve(scriptPath) !== resolve(execPath)) {
    args.push(resolve(scriptPath));
  }
  args.push("serve");
  return args;
}

export function buildLaunchAgentPlist({
  label = LAUNCHD_LABEL,
  programArguments = getCurrentProgramArguments(),
  port = 12378,
} = {}) {
  const args = [...programArguments, "--port", String(port)]
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

function runLaunchctl(args, { runCommand = execFileSync, allowFailure = false } = {}) {
  try {
    runCommand("launchctl", args, { stdio: "ignore" });
    return true;
  } catch (error) {
    if (!allowFailure) throw error;
    return false;
  }
}

export function installLaunchAgent({
  plistPath = LAUNCH_AGENT_PATH,
  target = getLaunchdTarget(),
  programArguments = getCurrentProgramArguments(),
  port = 12378,
  runCommand = execFileSync,
} = {}) {
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, buildLaunchAgentPlist({ programArguments, port }));
  runLaunchctl(["bootout", target, plistPath], { runCommand, allowFailure: true });
  runLaunchctl(["bootstrap", target, plistPath], { runCommand });
  return { label: LAUNCHD_LABEL, path: plistPath, target };
}

export function uninstallLaunchAgent({
  plistPath = LAUNCH_AGENT_PATH,
  target = getLaunchdTarget(),
  runCommand = execFileSync,
} = {}) {
  const wasInstalled = existsSync(plistPath);
  runLaunchctl(["bootout", target, plistPath], { runCommand, allowFailure: true });
  rmSync(plistPath, { force: true });
  return { label: LAUNCHD_LABEL, path: plistPath, target, wasInstalled };
}

export function getLaunchAgentStatus({
  plistPath = LAUNCH_AGENT_PATH,
  target = getLaunchdTarget(),
  runCommand = execFileSync,
} = {}) {
  const installed = existsSync(plistPath);
  const running = runLaunchctl(["print", `${target}/${LAUNCHD_LABEL}`], {
    runCommand,
    allowFailure: true,
  });
  return { label: LAUNCHD_LABEL, path: plistPath, target, installed, running };
}

export function describeProgram(programArguments = getCurrentProgramArguments()) {
  return basename(programArguments[0]);
}
