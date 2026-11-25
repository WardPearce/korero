import { constants } from "node:fs";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { availableParallelism } from "node:os";
import { version } from "mediasoup";
import { atomicWrite, sha256, workerBuildPolicy } from "../src/security/files";

const root = resolve(import.meta.dir, "../node_modules/mediasoup/worker");

export const workerPath = join(root, "out", "Release", "mediasoup-worker");
const stamp = workerPath + ".korero-build.json";

async function command(args: string[], cwd = process.cwd()) {
  let child: ReturnType<typeof Bun.spawn>;
  try { child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" }); }
  catch { throw new Error(`Could not start build dependency ${args[0]}. See docs/deployment.md`); }
  if (await child.exited) throw new Error(`Native worker build command failed: ${args.join(" ")}`);
}

function replace(text: string, search: string | RegExp, updated: string) {
  const result = text.replace(search, updated);
  if (result === text) throw new Error("mediasoup source changed. Recheck the OpenSSL build adjustment");
  return result;
}

export async function prepareWorker() {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    throw new Error("Packaged workers require native Linux AMD64 or ARM64");
  }
  const platform = `${process.platform}-${process.arch}`;
  const current = await Bun.file(stamp).json().catch(() => null);
  const binary = await Bun.file(workerPath).bytes().catch(() => null);
  if (binary && current?.version === version && current?.platform === platform &&
      current?.policy === workerBuildPolicy && current?.sha256 === sha256(binary)) {
    return { path: workerPath, sha256: current.sha256 as string, version };
  }
  if (version !== "3.32.2") throw new Error("Review the native worker build adjustment before upgrading mediasoup");
  await command(["pkg-config", "--atleast-version=3.5.9", "openssl"]);
  const work = join(root, "out", workerBuildPolicy);
  const source = join(work, "source");
  const build = join(work, "build");
  await mkdir(source, { recursive: true });
  // The npm cache and lockfile remain untouched. Only the isolated build copy is adjusted.
  for (const name of ["meson.build", "meson_options.txt", "fbs", "include", "src", "subprojects", "scripts", "test", "fuzzer", "mocks"]) {
    await cp(join(root, name), join(source, name), { recursive: true });
  }

  const meson = join(source, "meson.build");
  let mesonFile = await readFile(meson, "utf8");
  mesonFile = replace(mesonFile, /openssl_proj = subproject\([\s\S]+?\n\)\n/, "openssl_dep = dependency('openssl', version: '>= 3.5.9', method: 'pkg-config')\n");
  mesonFile = replace(mesonFile, "openssl_proj.get_variable('openssl_dep')", "openssl_dep");
  mesonFile = replace(mesonFile, /  openssl_proj\.get_variable\('libcrypto_lib'\),\n  openssl_proj\.get_variable\('libssl_lib'\),\n/, "");
  await writeFile(meson, mesonFile);
  const main = join(source, "src", "main.cpp");
  let cpp = await readFile(main, "utf8");
  cpp = replace(cpp, "#include", "#include <openssl/crypto.h>\n#include <cstdio>\n#include");
  cpp = replace(cpp, /\{\s*(?=const char\* envVersion)/, `{
  const auto major = OPENSSL_version_major();
  const auto minor = OPENSSL_version_minor();
  const auto patch = OPENSSL_version_patch();
  if (major < 3 || (major == 3 && (minor < 5 || (minor == 5 && patch < 9))))
  {
    std::fputs("mediasoup requires OpenSSL 3.5.9 or newer\\n", stderr);
    return 43;
  }

  `);
  await writeFile(main, cpp);
  const configured = await Bun.file(join(build, "meson-info", "intro-buildoptions.json")).exists();
  await command(["meson", "setup", ...(configured ? ["--reconfigure"] : []), "--buildtype=release", "-Db_ndebug=true", build, source]);
  const jobs = Number(process.env.VOICE_BUILD_JOBS ?? Math.min(8, availableParallelism()));
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 64) throw new Error("VOICE_BUILD_JOBS must be an integer from 1 to 64");
  await command(["meson", "compile", "-C", build, "-j", String(jobs), "mediasoup-worker"]);
  const worker = await Bun.file(join(build, "mediasoup-worker")).bytes();
  const digest = sha256(worker);
  await mkdir(dirname(workerPath), { recursive: true });
  await atomicWrite(workerPath, worker, 0o700);
  await chmod(workerPath, constants.S_IRWXU);
  await atomicWrite(stamp, JSON.stringify({ version, platform, policy: workerBuildPolicy, sha256: digest }) + "\n");
  return { path: workerPath, sha256: digest, version };
}

if (import.meta.main) console.log((await prepareWorker()).path);
