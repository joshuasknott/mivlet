fn main() {
    // Recompile native icon resources when branding changes.
    println!("cargo:rerun-if-changed=icons");
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // The MCP test engine retains an AppHandle, bringing Tauri's native
        // Common Controls imports into the lib test executable. Tauri's usual
        // resource manifest only covers app binaries. Link the same v6
        // dependency into every MSVC executable, including cargo test, instead.
        // Disable the resource copy to avoid duplicate RT_MANIFEST resources.
        // https://github.com/tauri-apps/tauri/blob/dev/examples/api/src-tauri/build.rs
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"),
        )
        .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attributes).expect("Mivlet native resources could not be built");
}
