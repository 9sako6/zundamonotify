import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stopSound from "../assets/stop/みてほしいのだ.wav" with { type: "file" };
import notificationSound from "../assets/notification/たすけてほしいのだ.wav" with { type: "file" };
import { setBundledAssetFiles } from "./server.js";

function materializeEmbeddedFile(sourcePath, dir, fileName) {
  const targetPath = join(dir, fileName);
  writeFileSync(targetPath, readFileSync(sourcePath));
  return targetPath;
}

export function installBundledAssetFiles() {
  const dir = mkdtempSync(join(tmpdir(), "zundamonotify-assets-"));
  const files = {
    stop: [materializeEmbeddedFile(stopSound, dir, "stop.wav")],
    notification: [materializeEmbeddedFile(notificationSound, dir, "notification.wav")],
  };

  setBundledAssetFiles(files);
  process.once("exit", () => {
    rmSync(dir, { recursive: true, force: true });
  });

  return files;
}
