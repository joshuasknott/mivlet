fn main() {
    // Recompile native icon resources when branding changes.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
