# Releasing

Push a version tag such as `v1.0.50` to start a release. The workflow builds Linux
x86_64 desktop packages, signed Android APK and AAB files, and standalone Linux
AMD64 and ARM64 server binaries. It publishes a multi-architecture Docker image
and attaches the build files and server checksums to the GitHub release.

Configure these GitHub Actions secrets before releasing:

- `ANDROID_KEYSTORE_BASE64`: the release JKS keystore encoded as one base64 string.
- `ANDROID_KEY_ALIAS`: the key alias in that keystore.
- `ANDROID_KEYSTORE_PASSWORD`: the keystore password.
- `ANDROID_KEY_PASSWORD`: the key password. It can match the keystore password.
- `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`: credentials with push access to the Docker Hub repository.

The Docker Hub destination defaults to `wardpearce/korero-server`. Set the
`DOCKERHUB_REPOSITORY` Actions variable to use another repository. Each release
publishes both the Git tag and `latest` image tags.

Android's displayed version comes from the Git tag, and its version code comes
from the GitHub Actions run number. Keep the release keystore unchanged so users
can install future APK updates over earlier releases.
