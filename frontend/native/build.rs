use std::{env, path::PathBuf, process};

fn main() {
    println!("cargo:rerun-if-changed=src/media.rs");
    println!("cargo:rerun-if-changed=cpp");
    println!("cargo:rerun-if-env-changed=KORERO_MEDIA_SDK");
    if env::var_os("CARGO_FEATURE_MEDIA").is_none() {
        return;
    }
    let target = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let frontend = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("..");
    let root = match env::var_os("KORERO_MEDIA_SDK") {
        Some(path) => PathBuf::from(path),
        None => frontend.join(format!(".native/m140-{target}-{arch}")),
    };

    for asset in [
        "lib/libmediasoupclient.a",
        "lib/libsdptransform.a",
        "lib/libwebrtc.a",
        "field_trials.cc",
        "libcxx-config/__config_site",
        "libcxx-config/__assertion_handler",
        "libcxx/include/__config",
        "libsdptransform/include/json.hpp",
        "libmediasoupclient/include/mediasoupclient.hpp",
        "webrtc/include/api/peer_connection_interface.h",
    ] {
        let path = root.join(asset);
        println!("cargo:rerun-if-changed={}", path.display());
        if !path.is_file() {
            eprintln!("Native WebRTC SDK file is missing: {}", path.display());
            if target == "linux" && arch == "x86_64" {
                eprintln!(
                    "Run `bun run prepare:media` from frontend."
                );
            } else {
                eprintln!("Prepare the matching target SDK and select it with KORERO_MEDIA_SDK.");
            }
            process::exit(1);
        }
    }

    let include = root.join("webrtc/include");
    let mut build = cxx_build::bridge("src/media.rs");
    if target == "linux" && arch == "x86_64" {
        let local_compiler = frontend.join(".native/toolchain/bin/clang++");
        println!("cargo:rerun-if-env-changed=CXX");
        if env::var_os("CXX").is_none() {
            if local_compiler.is_file() {
                build.compiler(local_compiler);
            } else {
                build.compiler("clang++");
            }
        }
    }
    build
        .file("cpp/voice.cpp")
        .file(root.join("field_trials.cc"))
        .include(".")
        .include(root.join("libmediasoupclient/include"))
        .include(root.join("libsdptransform/include"))
        .flag(format!("-isystem{}", include.display()))
        .flag(format!(
            "-isystem{}",
            include.join("third_party/abseil-cpp").display()
        ))
        .define("WEBRTC_POSIX", None)
        .define("_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS", None)
        .define("_LIBCPP_INSTRUMENTED_WITH_ASAN", "0")
        .define(
            "_LIBCPP_HARDENING_MODE_DEFAULT",
            "_LIBCPP_HARDENING_MODE_NONE",
        )
        .std("c++20")
        .flag_if_supported("-Wno-nullability-completeness")
        .flag_if_supported("-Wno-deprecated-literal-operator")
        .flag("-nostdinc++")
        .flag(format!("-isystem{}", root.join("libcxx-config").display()))
        .flag(format!("-isystem{}", root.join("libcxx/include").display()))
        .cpp_link_stdlib(None)
        .compile("korero-voice-bridge");
    println!(
        "cargo:rustc-link-search=native={}",
        root.join("lib").display()
    );
    println!("cargo:rustc-link-lib=static=mediasoupclient");
    println!("cargo:rustc-link-lib=static=sdptransform");
    println!("cargo:rustc-link-lib=static=webrtc");
    println!("cargo:rustc-link-lib=dl");
    println!("cargo:rustc-link-lib=m");
    if target == "linux" {
        println!("cargo:rustc-link-lib=X11");
    }
}
