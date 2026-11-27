mod commands;
mod crypto;
mod i18n;
mod paths;
mod services;
mod store;
mod tray;
mod types;

use commands::AppState;
use services::auth::AuthService;
use services::content::ContentService;
use services::curseforge::{curseforge_available, CurseForgeService};
use services::discord::DiscordPresence;
use services::importer::ExternalImportService;
use services::instances::InstanceService;
use services::java::JavaService;
use services::minecraft::MinecraftService;
use services::modpacks::ModpackService;
use services::mods::ModService;
use services::servers::ServerService;
use services::skins::SkinService;
use services::updater::UpdaterService;
use services::worlds::WorldService;
use std::fs;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use store::JsonStore;
use tauri::Manager;

fn cleanup_stale_modpack_cache() {
    let dir = paths::get_launcher_root().join("cache").join("modpacks");
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(60 * 60 * 24))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    if meta.is_dir() {
                        let _ = fs::remove_dir_all(&p);
                    } else {
                        let _ = fs::remove_file(&p);
                    }
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    cleanup_stale_modpack_cache();
    let app_version = env!("CARGO_PKG_VERSION").to_string();
    let store = Arc::new(
        JsonStore::load_sync(&app_version).expect("failed to initialize launcher store"),
    );
    let java = Arc::new(JavaService::new());
    let minecraft = Arc::new(MinecraftService::new());
    let auth = Arc::new(AuthService::new(store.clone()));
    let discord = DiscordPresence::new();
    let instances = Arc::new(InstanceService::new(
        store.clone(),
        java.clone(),
        minecraft.clone(),
        auth.clone(),
        discord.clone(),
    ));
    let curseforge = Arc::new(CurseForgeService::new(store.clone()));
    let mods = Arc::new(ModService::new(store.clone(), curseforge.clone()));
    let content = Arc::new(ContentService::new(store.clone(), curseforge.clone()));
    let modpacks = Arc::new(ModpackService::new(
        store.clone(),
        instances.clone(),
        minecraft.clone(),
        curseforge.clone(),
    ));
    let worlds = Arc::new(WorldService::new(store.clone()));
    let servers = Arc::new(ServerService::new(store.clone()));
    let skins = Arc::new(SkinService::new(store.clone(), auth.clone()));
    let importer = Arc::new(ExternalImportService::new(
        instances.clone(),
        content.clone(),
        minecraft.clone(),
    ));
    let updater = UpdaterService::new(app_version.clone());

    let state = AppState {
        store,
        java,
        minecraft,
        auth,
        discord,
        instances,
        curseforge,
        mods,
        content,
        modpacks,
        worlds,
        servers,
        skins,
        importer,
        updater,
        app_version,
        curseforge_available: curseforge_available(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = tray::restore_from_tray(app);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::launcher_bootstrap,
            commands::update_settings,
            commands::create_instance,
            commands::update_instance,
            commands::remove_instance,
            commands::duplicate_instance,
            commands::get_running_instances,
            commands::get_instance_logs,
            commands::open_instance_folder,
            commands::open_data_folder,
            commands::open_external,
            commands::use_offline_profile,
            commands::set_active_account,
            commands::remove_account,
            commands::refresh_session,
            commands::get_java_installations,
            commands::detect_java,
            commands::browse_java,
            commands::install_java,
            commands::get_game_versions,
            commands::get_loader_support,
            commands::get_loader_versions,
            commands::launch_instance,
            commands::stop_instance,
            commands::cancel_launch,
            commands::begin_microsoft_login,
            commands::ely_login,
            commands::search_mods,
            commands::get_category_tags,
            commands::install_mod,
            commands::prepare_mod_install,
            commands::download_modpack,
            commands::list_mod_versions,
            commands::get_mod_details,
            commands::check_content_updates,
            commands::get_local_content,
            commands::toggle_local_content,
            commands::remove_local_content,
            commands::detect_local_content,
            commands::import_local_content,
            commands::scan_external_launchers,
            commands::import_external_instances,
            commands::pick_external_folder,
            commands::import_mrpack_start,
            commands::import_mrpack_start_to_instance,
            commands::import_mrpack_cancel,
            commands::export_mrpack,
            commands::list_export_entries,
            commands::import_mrpack_files,
            commands::list_worlds,
            commands::backup_world,
            commands::restore_world_backup,
            commands::delete_world_backup,
            commands::delete_world,
            commands::list_servers,
            commands::add_server,
            commands::remove_server,
            commands::ping_server,
            commands::list_screenshots,
            commands::copy_screenshot,
            commands::delete_screenshot,
            commands::list_skins,
            commands::ely_skin,
            commands::account_skin,
            commands::add_skin,
            commands::update_skin,
            commands::remove_skin,
            commands::activate_skin,
            commands::list_capes,
            commands::equip_cape,
            commands::updater_check,
            commands::updater_download,
            commands::updater_install,
            commands::list_custom_fonts,
            commands::add_custom_font,
            commands::remove_custom_font,
            commands::open_fonts_folder,
            commands::list_system_fonts,
            commands::list_google_fonts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running lynapp");
}
