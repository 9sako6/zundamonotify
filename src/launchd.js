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
    const res = await request(`http://127.0.0.1:${port}/agent-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "approval_review.completed", source: "status" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function inspectLaunchAgent({
  target = getLaunchdTarget(),
  runCommand = execFileSync,
  probeServer = probeNotificationServer,
} = {}) {
  const running = isLaunchAgentRunning(target, runCommand);
  const serverReachable = running ? await probeServer() : false;
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
