# Third-party notices

- [Bun v1.4.5 source and MIT licence](https://github.com/oven-sh/bun/tree/bun-v1.4.5)
- [Bun's statically linked software, licence terms and JavaScriptCore relinking instructions](https://bun.com/docs/project/license)
- [mediasoup 3.32.2 source, ISC licence and worker releases](https://github.com/versatica/mediasoup/tree/3.32.2)
- [mediasoup worker dependency versions and upstream sources](https://github.com/versatica/mediasoup/tree/3.32.2/worker/subprojects)
- [SQLite public domain declaration](https://sqlite.org/copyright.html)

The `licenses/` directory contains upstream notices for Bun and mediasoup. The build
also collects bundled npm notices and worker dependency notices. Release archives put
those files next to the executable. Debian's operating system library notices are in
the distribution's package documentation and installed container's `/usr/share/doc`.

The mediasoup worker build uses its published [source and wrap versions](https://github.com/versatica/mediasoup/tree/3.32.2/worker)
with the system OpenSSL linkage adjustment in [scripts/worker.ts](scripts/worker.ts).
[OpenSSL 3.5's source and licence](https://github.com/openssl/openssl/tree/openssl-3.5.9)
are available upstream. The project source is available in this repository and its
release source archives. To build an executable using a rebuilt Bun runtime, put
that runtime on the build PATH and run the same standalone build command.
