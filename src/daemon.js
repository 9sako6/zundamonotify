import { spawn } from "node:child_process";
import {
  existsSync,
  closeSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, "..", "bin", "cli.js");

const STATE_DIR = resolve(homedir(), ".zundamonotify");
const PID_FILE = resolve(STATE_DIR, "server.pid");
const LOG_FILE = resolve(STATE_DIR, "server.log");

export { PID_FILE, LOG_FILE, STATE_DIR };

/**
 * PID ファイルからプロセスが生きてるか確認するのだ
 */
function readAlivePid() {
  if (!existsSync(PID_FILE)) return null;

  const pid = Number(readFileSync(PID_FILE, "utf-8").trim());
  if (Number.isNaN(pid)) return null;

  try {
    process.kill(pid, 0); // シグナル 0 で生存確認なのだ
    return pid;
  } catch {
    // プロセスがもういないのだ、PID ファイルを掃除するのだ
    try {
      unlinkSync(PID_FILE);
    } catch {}
    return null;
  }
}

export function daemonize(port) {
  const alivePid = readAlivePid();
  if (alivePid) {
    console.log(`もう起動してるのだ！ (PID: ${alivePid})`);
    console.log(`止めたいなら pnpm stop するのだ！`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(STATE_DIR, { recursive: true });

  const logFd = openSync(LOG_FILE, "a");

  try {
    const child = spawn(
      process.execPath,
      [CLI_PATH, "serve", "-p", String(port)],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, ZUNDAMONOTIFY_CHILD: "1" },
      },
    );

    writeFileSync(PID_FILE, String(child.pid));
    child.unref();

    console.log(`ずんだもんデーモンが起動したのだ！ (PID: ${child.pid})`);
    console.log(`  ポート: ${port}`);
    console.log(`  ログ:   ${LOG_FILE}`);
    console.log(`止めるときは pnpm stop なのだ！`);
  } catch (err) {
    console.error(`⚠ デーモンの起動に失敗したのだ！: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeSync(logFd);
  }
}

export function stopDaemon() {
  const pid = readAlivePid();
  if (!pid) {
    console.log("ずんだもんデーモンは動いてないのだ！");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    try {
      unlinkSync(PID_FILE);
    } catch {}
    console.log(`ずんだもんデーモンを止めたのだ！ (PID: ${pid})`);
  } catch (err) {
    console.error(`止められなかったのだ！: ${err.message}`);
    process.exitCode = 1;
  }
}

