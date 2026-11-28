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
  if (result === text) throw new Error("mediasoup source changed. Recheck the native worker patches");
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
  // Keep Meson's build directory stable across policy changes so it can reuse its dependency cache.
  const work = join(root, "out", "system-openssl-3.5.9-v1");
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
  cpp = replace(cpp, "int main(", `constexpr bool koreroSupportedOpenSsl(unsigned major, unsigned minor, unsigned patch)
{
  return (major > 3 || (major == 3 && minor >= 5)) &&
         !(major == 3 && minor == 5 && patch < 9) &&
         !(major == 3 && minor == 6 && patch < 5) &&
         !(major == 4 && minor == 0 && patch < 3);
}

static_assert(koreroSupportedOpenSsl(OPENSSL_VERSION_MAJOR, OPENSSL_VERSION_MINOR, OPENSSL_VERSION_PATCH),
              "OpenSSL must include the September 2026 DTLS fixes");

int main(`);
  cpp = replace(cpp, /\{\s*(?=const char\* envVersion)/, `{
  if (!koreroSupportedOpenSsl(OPENSSL_version_major(), OPENSSL_version_minor(), OPENSSL_version_patch()))
  {
    std::fputs("OpenSSL must include the September 2026 DTLS fixes (3.5.9, 3.6.5 or 4.0.3 on those branches)\\n", stderr);
    return 43;
  }

  `);
  await writeFile(main, cpp);

  await cp(join(import.meta.dir, "worker-rtp-limits.hpp"), join(source, "include", "RTC", "KoreroRtpLimits.hpp"));
  const transportHeader = join(source, "include", "RTC", "Transport.hpp");
  let header = await readFile(transportHeader, "utf8");
  header = replace(header, '#include "RTC/RateCalculator.hpp"', '#include "RTC/RateCalculator.hpp"\n#include "RTC/KoreroRtpLimits.hpp"');
  header = replace(header, "int64_t maxIncomingBitrate{ 0 };", "int64_t maxIncomingBitrate{ 0 };\n\t\tKoreroRtpBudget koreroIncomingRtp;");
  await writeFile(transportHeader, header);

  const transportSource = join(source, "src", "RTC", "Transport.cpp");
  let transport = await readFile(transportSource, "utf8");
  transport = replace(transport, "// Pass the RTP packet to the corresponding Producer.", `// Limit accepted audio RTP even when the sender ignores congestion feedback.
		if (producer->GetKind() == RTC::Media::Kind::AUDIO &&
		    this->maxIncomingBitrate > 0 && this->maxIncomingBitrate != AbsoluteMaxBitrate &&
		    !this->koreroIncomingRtp.Allow(this->maxIncomingBitrate, receivedAtUs, packet->GetLength() + GetPacketOverhead()))
		{
			delete packet;
			return;
		}

		// Pass the RTP packet to the corresponding Producer.`);
  await writeFile(transportSource, transport);

  const webRtcSource = join(source, "src", "RTC", "WebRtcTransport.cpp");
  let webRtc = await readFile(webRtcSource, "utf8");
  webRtc = replace(webRtc, "if (!this->srtpSendSession->EncryptRtp", `// Every router in this worker shares one RTP egress budget.
		static thread_local KoreroRtpBudget koreroOutgoingRtp;
		static const auto koreroEgressBitrate = KoreroRtpEgressBitrate();
		if (!koreroOutgoingRtp.Allow(koreroEgressBitrate, this->shared->GetTimeUs(), len + GetPacketOverhead()))
		{
			if (cb)
				cb(false);
			return;
		}

		if (!this->srtpSendSession->EncryptRtp`);
  await writeFile(webRtcSource, webRtc);
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
