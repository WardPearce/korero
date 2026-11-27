import { spawn } from "node:child_process";
import { createServer } from "vite";

const server = await createServer();
await server.listen();
server.printUrls();

const electron = spawn("electron", [".", "--dev"], { stdio: "inherit" });
const stop = () => electron.kill();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  process.exitCode = await new Promise((resolve, reject) => {
    electron.once("error", reject);
    electron.once("exit", (code, signal) => resolve(code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1)));
  });
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await server.close();
}
