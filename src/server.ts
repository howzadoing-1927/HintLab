import { pathToFileURL } from "node:url";
import path from "node:path";
import { createApp } from "./app";
import { startCleanupLoop } from "./sessions";
import { PORT } from "./config";

export const app = createApp();

// Start the TTL cleanup loop (removes idle sessions and their temp workdirs).
startCleanupLoop();

const isMainModule =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`HintLab server listening on http://localhost:${PORT}`);
  });
}

