fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["atlas_call"])
    )).expect("Tauri build configuration");
}
