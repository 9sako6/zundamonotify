import { execFileSync } from "node:child_process";

export const LAUNCHD_LABEL = "com.9sako6.zundamonotify";

export function getLaunchdTarget({ uid = process.getuid?.() ?? process.env.UID } = {}) {
  return `gui/${uid}`;
}

function isLaunchAgentRunning(target, runCommand) {
  try {
    runCommand("launchctl", ["print", `${target}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function probeNotificationServer({ port = 12378, request = fetch } = {}) {
  try {
    const res = await request(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function inspectLaunchAgent({
  target = getLaunchdTarget(),
  runCommand = execFileSync,
  request = fetch,
} = {}) {
  const running = isLaunchAgentRunning(target, runCommand);
  const serverReachable = running ? await probeNotificationServer({ request }) : false;
  const issues = !running ? ["not_running"] : serverReachable ? [] : ["server_unreachable"];

  return {
    label: LAUNCHD_LABEL,
    target,
    running,
    serverReachable,
    issues,
    ok: issues.length === 0,
  };
}
