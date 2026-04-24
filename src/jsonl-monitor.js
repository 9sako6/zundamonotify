import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

function readNewBytes(filePath, offset, size) {
  const fd = openSync(filePath, "r");
  try {
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

export function createJsonlMonitor({
  pollIntervalMs,
  completionDelayMs,
  onTaskComplete = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
  createTrackedEntry,
  listFiles,
  processLine,
}) {
  const tracked = new Map();
  const pendingTimers = new Set();
  let hasPrimed = false;

  function emitTaskComplete(event) {
    let timer;
    let fired = false;
    timer = schedule(() => {
      fired = true;
      if (timer !== undefined) {
        pendingTimers.delete(timer);
      }
      onTaskComplete(event);
    }, completionDelayMs);
    if (!fired) {
      pendingTimers.add(timer);
    }
  }

  function pollFile(filePath, stat, notifyOnTaskComplete) {
    let entry = tracked.get(filePath);
    if (!entry) {
      entry = createTrackedEntry(filePath);
      if (!entry) return;
      tracked.set(filePath, entry);
    }

    if (stat.size <= entry.offset) return;

    const text = entry.partial + readNewBytes(filePath, entry.offset, stat.size);
    entry.offset = stat.size;
    const lines = text.split("\n");
    entry.partial = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      processLine(line, entry, notifyOnTaskComplete ? emitTaskComplete : null);
    }
  }

  function cleanStaleEntries(activeFiles) {
    for (const [filePath] of tracked) {
      if (!existsSync(filePath) || !activeFiles.has(filePath)) {
        tracked.delete(filePath);
      }
    }
  }

  function poll() {
    const activeFiles = new Set();

    for (const filePath of listFiles()) {
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }

      activeFiles.add(filePath);
      pollFile(filePath, stat, hasPrimed);
    }

    cleanStaleEntries(activeFiles);
    hasPrimed = true;
  }

  return {
    pollIntervalMs,
    tracked,
    poll,
    start() {
      poll();
      const timer = setInterval(poll, pollIntervalMs);
      return {
        stop() {
          clearInterval(timer);
          for (const pendingTimer of pendingTimers) {
            cancel(pendingTimer);
          }
          pendingTimers.clear();
        },
      };
    },
  };
}
