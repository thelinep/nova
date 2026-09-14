fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["open_provider_browser", "pick_local_folder"]),
        ),
    )
    .expect("failed to build NOVA Runtime's Tauri configuration");
}
