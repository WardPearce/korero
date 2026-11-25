import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { prepareWorker } from "./worker";

const targets: Record<string, { name: string; machine: number }> = {
  x64: { name: "amd64", machine: 62 },
  arm64: { name: "arm64", machine: 183 },
};
const target = targets[process.arch];
if (process.platform !== "linux" || !target) throw new Error("Build on native Linux AMD64 or ARM64");
const root = resolve(import.meta.dir, "..");
const { path: worker, sha256, version } = await prepareWorker();
const bytes = await Bun.file(worker).bytes();
const elf = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
if (bytes.length < 64 || elf.getUint32(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1 || elf.getUint16(18, true) !== target.machine) {
  throw new Error("Installed media worker does not match the build architecture");
}
const output = resolve(process.argv[2] ?? join(root, "dist", `voice-server-linux-${target.name}`));
await mkdir(dirname(output), { recursive: true });
const define = JSON.stringify({ path: "/$bunfs/root/mediasoup-worker", sha256, version });
const build = Bun.spawn([process.execPath, "build", "./src/index.ts", "--compile", "--minify",
  "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--asset", worker,
  "--asset", "./src/database/migrations", "--define", `EMBEDDED_WORKER=${define}`, "--outfile", output],
{ cwd: root, stdout: "inherit", stderr: "inherit" });
if (await build.exited) process.exitCode = 1;
