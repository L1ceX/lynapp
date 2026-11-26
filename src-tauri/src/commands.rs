use crate::i18n::{set_main_language, tr, tr_string};
use crate::paths::{get_fonts_root, get_launcher_root, get_store_path, sanitize_folder_name};
use crate::services::auth::AuthService;
use crate::services::content::ContentService;
use crate::services::curseforge::CurseForgeService;
use crate::services::discord::DiscordPresence;
use crate::services::importer::ExternalImportService;
use crate::services::instances::InstanceService;
use crate::services::java::{self, JavaService};
use crate::services::minecraft::MinecraftService;
use crate::services::modpacks::ModpackService;
use crate::services::mods::ModService;
use crate::services::servers::ServerService;
use crate::services::skins::SkinService;
use crate::services::updater::UpdaterService;
use crate::services::worlds::WorldService;
use crate::store::{
    get_max_allocatable_memory_mb, get_system_memory_mb, public_accounts, JsonStore,
};
use crate::types::{
    AccountsState, AddCustomFontResult, BootstrapState, CapeInfo, ContentImportResult,
    ContentUpdateInfo, CreateInstancePayload, CustomFontInfo, DownloadModpackPayload,
    ElySkinResult, ExportEntry, ExternalImportResult, ExternalLauncher, GameVersionInfo,
    GoogleFontInfo, InstallModPayload, InstanceLogsResult, JavaInstallation, LaunchResult,
    LauncherInstance,
    LauncherSettings, LocalContentItem, LocalContentPayload, LoginStartResult, ModInstallPlan,
    ModProjectDetails, ModSearchPayload, ModSearchResponse, ModVersionInfo, MrpackBeginResult,
    MrpackTargetResult, PickedExternalFolder, PrepareModInstallPayload, QuickPlayTarget,
    ScreenshotInfo, ServerEntry, ServerPingResult, SkinActivateResult, SkinAddPayload, SkinInfo,
    SkinRemoveResult, SkinUpdatePayload, UpdateInstancePayload, WorldInfo,
};
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

pub struct AppState {
    pub store: Arc<JsonStore>,
    pub java: Arc<JavaService>,
    pub minecraft: Arc<MinecraftService>,
    pub auth: Arc<AuthService>,
    pub discord: Arc<DiscordPresence>,
    pub instances: Arc<InstanceService>,
    pub curseforge: Arc<CurseForgeService>,
    pub mods: Arc<ModService>,
    pub content: Arc<ContentService>,
    pub modpacks: Arc<ModpackService>,
    pub worlds: Arc<WorldService>,
    pub servers: Arc<ServerService>,
    pub skins: Arc<SkinService>,
    pub importer: Arc<ExternalImportService>,
    pub updater: Arc<UpdaterService>,
    pub app_version: String,
    pub curseforge_available: bool,
}

#[tauri::command]
pub async fn launcher_bootstrap(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BootstrapState, String> {
    state.store.reconcile_instances().await;
    let data = state.store.get_data().await;
    state
        .discord
        .apply_settings(data.settings.discord_presence, data.settings.discord_hide_instance)
        .await;
    let updater = state.updater.clone();
    let app_upd = app.clone();
    let allow_beta = data.settings.beta_updates;
    let edition = data.settings.update_edition.clone();
    tokio::spawn(async move {
        updater.check(&app_upd, allow_beta, edition.as_deref()).await;
    });
    let extra = vec![data.settings.java_path.clone()];
    let java_candidates = tokio::task::spawn_blocking(move || java::list_candidate_paths(&extra))
        .await
        .unwrap_or_default();
    let accs = public_accounts(&data);
    Ok(BootstrapState {
        settings: data.settings,
        instances: data.instances,
        active_instance_id: data.active_instance_id,
        accounts: accs.accounts,
        active_account_id: accs.active_account_id,
        storage_path: get_store_path().to_string_lossy().to_string(),
        java_candidates,
        app_version: state.app_version.clone(),
        curseforge_available: state.curseforge_available,
        system_memory_mb: get_system_memory_mb(),
        max_memory_mb: get_max_allocatable_memory_mb(),
    })
}

#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: Value,
) -> Result<LauncherSettings, String> {
    let prev_settings = state.store.get_data().await.settings;
    let prev_beta = prev_settings.beta_updates;
    let prev_edition = prev_settings.update_edition.clone();
    let updated = state
        .store
        .update(|data| {
            let mut merged = serde_json::to_value(&data.settings).map_err(|e| e.to_string())?;
            if let (Some(base_obj), Some(patch_obj)) = (merged.as_object_mut(), patch.as_object()) {
                for (key, val) in patch_obj {
                    if matches!(
                        key.as_str(),
                        "theme" | "effects" | "versionTypes" | "javaPaths"
                    ) {
                        if let (Some(dst_sub), Some(src_sub)) =
                            (base_obj.get_mut(key).and_then(Value::as_object_mut), val.as_object())
                        {
                            for (sk, sv) in src_sub {
                                dst_sub.insert(sk.clone(), sv.clone());
                            }
                            continue;
                        }
                    }
                    base_obj.insert(key.clone(), val.clone());
                }
            }
            let next: LauncherSettings =
                serde_json::from_value(merged).map_err(|e| e.to_string())?;
            set_main_language(&next.language);
            data.settings = next.clone();
            Ok(next)
        })
        .await?;
    state
        .discord
        .apply_settings(updated.discord_presence, updated.discord_hide_instance)
        .await;
    if updated.beta_updates != prev_beta || updated.update_edition != prev_edition {
        let updater = state.updater.clone();
        let app_upd = app.clone();
        let allow_beta = updated.beta_updates;
        let edition = updated.update_edition.clone();
        tokio::spawn(async move {
            updater.check(&app_upd, allow_beta, edition.as_deref()).await;
        });
    }
    Ok(updated)
}

#[tauri::command]
pub async fn create_instance(
    state: State<'_, AppState>,
    payload: CreateInstancePayload,
) -> Result<LauncherInstance, String> {
    state.instances.create(payload).await
}

#[tauri::command]
pub async fn update_instance(
    state: State<'_, AppState>,
    payload: UpdateInstancePayload,
) -> Result<LauncherInstance, String> {
    state.instances.update_instance(payload).await
}

#[tauri::command]
pub async fn remove_instance(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    state.instances.remove(&id).await
}

#[tauri::command]
pub async fn duplicate_instance(
    state: State<'_, AppState>,
    id: String,
) -> Result<LauncherInstance, String> {
    state.instances.duplicate(&id).await
}

#[tauri::command]
pub async fn get_running_instances(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.instances.get_running().await)
}

#[tauri::command]
pub async fn launch_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    quick_play: Option<QuickPlayTarget>,
) -> Result<LaunchResult, String> {
    state.instances.launch(&app, &id, quick_play).await
}

#[tauri::command]
pub async fn stop_instance(state: State<'_, AppState>, id: String) -> Result<LaunchResult, String> {
    state.instances.stop(&id).await
}

#[tauri::command]
pub async fn cancel_launch(state: State<'_, AppState>, id: String) -> Result<LaunchResult, String> {
    state.instances.cancel_launch(&id).await
}

#[tauri::command]
pub async fn get_instance_logs(
    state: State<'_, AppState>,
    id: String,
) -> Result<InstanceLogsResult, String> {
    state.instances.get_logs(&id).await
}

#[tauri::command]
pub async fn open_instance_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    folder: Option<String>,
) -> Result<String, String> {
    state.store.reconcile_instances().await;
    let data = state.store.get_data().await;
    let inst = data
        .instances
        .iter()
        .find(|i| i.id == id)
        .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
    let rel = match folder.as_deref().unwrap_or("root") {
        "logs" => ".launcher/logs",
        "saves" => "saves",
        "screenshots" => "screenshots",
        "mod" => "mods",
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        "datapack" => "datapacks",
        _ => "",
    };
    let target = if rel.is_empty() {
        PathBuf::from(&inst.directory)
    } else {
        let p = PathBuf::from(&inst.directory).join(rel);
        let _ = fs::create_dir_all(&p);
        p
    };
    let target_str = target.to_string_lossy().to_string();
    app.opener()
        .open_path(&target_str, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(String::new())
}

#[tauri::command]
pub async fn open_data_folder(app: AppHandle) -> Result<String, String> {
    let dir = get_store_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    let dir_str = dir.to_string_lossy().to_string();
    app.opener()
        .open_path(&dir_str, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(String::new())
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<bool, String> {
    let parsed = Url::parse(&url).map_err(|_| tr("Invalid URL", "Некорректная ссылка").to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(tr(
            "Only http and https URLs can be opened",
            "Можно открывать только ссылки http и https",
        )
        .to_string());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn begin_microsoft_login(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LoginStartResult, String> {
    Ok(state.auth.begin_microsoft_login(&app).await)
}

#[tauri::command]
pub async fn refresh_session(state: State<'_, AppState>) -> Result<AccountsState, String> {
    Ok(state.auth.try_silent_refresh().await)
}

#[tauri::command]
pub async fn ely_login(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AccountsState, String> {
    state.auth.ely_login(&app).await
}

#[tauri::command]
pub async fn use_offline_profile(
    state: State<'_, AppState>,
    username: String,
) -> Result<AccountsState, String> {
    state.auth.use_offline_profile(&username).await
}

#[tauri::command]
pub async fn set_active_account(
    state: State<'_, AppState>,
    id: String,
) -> Result<AccountsState, String> {
    state.auth.set_active_account(&id).await
}

#[tauri::command]
pub async fn remove_account(
    state: State<'_, AppState>,
    id: String,
) -> Result<AccountsState, String> {
    state.auth.remove_account(&id).await
}

#[tauri::command]
pub async fn get_java_installations(
    state: State<'_, AppState>,
) -> Result<Vec<JavaInstallation>, String> {
    let paths = state.store.get_data().await.settings.java_paths;
    tokio::task::spawn_blocking(move || java::get_installations(&paths))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_java(
    state: State<'_, AppState>,
    major: u32,
) -> Result<JavaInstallation, String> {
    let javaw = state.java.install_major(major).await?;
    let saved = javaw.clone();
    state
        .store
        .update(|d| {
            d.settings.java_paths.insert(major.to_string(), saved);
            Ok(())
        })
        .await?;
    tokio::task::spawn_blocking(move || java::describe_installation(major, Some(&javaw)))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn detect_java(
    state: State<'_, AppState>,
    major: u32,
) -> Result<JavaInstallation, String> {
    let found = tokio::task::spawn_blocking(move || java::find_compatible_path(major))
        .await
        .map_err(|e| e.to_string())?;
    let Some(path_str) = found else {
        let data = state.store.get_data().await;
        let current = data.settings.java_paths.get(&major.to_string()).cloned();
        let mut described = tokio::task::spawn_blocking(move || {
            java::describe_installation(major, current.as_deref())
        })
        .await
        .map_err(|e| e.to_string())?;
        described.message = tr_string(
            format!("No Java {major} found on this PC"),
            format!("Java {major} на этом компьютере не найдена"),
        );
        return Ok(described);
    };
    let saved = path_str.clone();
    state
        .store
        .update(|data| {
            data.settings.java_paths.insert(major.to_string(), saved);
            Ok(())
        })
        .await?;
    tokio::task::spawn_blocking(move || java::describe_installation(major, Some(&path_str)))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browse_java(
    app: AppHandle,
    state: State<'_, AppState>,
    major: u32,
) -> Result<Option<JavaInstallation>, String> {
    let title = tr_string(
        format!("Select Java executable for Java {major}"),
        format!("Выберите исполняемый файл для Java {major}"),
    );
    let mut dialog = app.dialog().file().set_title(title);
    #[cfg(windows)]
    {
        dialog = dialog.add_filter(tr("Java executable", "Исполняемый файл Java"), &["exe"]);
    }
    let picked = tokio::task::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let raw = file_path.to_string();
    let (detected_major, normalized) =
        tokio::task::spawn_blocking(move || java::inspect_picked_path(&raw))
            .await
            .map_err(|e| e.to_string())?;
    if detected_major != Some(major) {
        let got_en = detected_major
            .map(|m| m.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let got_ru = detected_major
            .map(|m| m.to_string())
            .unwrap_or_else(|| "неизвестной версии".to_string());
        return Err(tr_string(
            format!("Selected Java is version {got_en}, but Java {major} is needed here."),
            format!("Выбрана Java {got_ru}, а здесь нужна Java {major}."),
        ));
    }
    let saved = normalized.clone();
    state
        .store
        .update(|data| {
            data.settings.java_paths.insert(major.to_string(), saved);
            Ok(())
        })
        .await?;
    let described =
        tokio::task::spawn_blocking(move || java::describe_installation(major, Some(&normalized)))
            .await
            .map_err(|e| e.to_string())?;
    Ok(Some(described))
}

#[tauri::command]
pub async fn get_game_versions(
    state: State<'_, AppState>,
) -> Result<Vec<GameVersionInfo>, String> {
    state.minecraft.list_game_versions().await
}

#[tauri::command]
pub async fn get_loader_support(
    state: State<'_, AppState>,
) -> Result<HashMap<String, Vec<String>>, String> {
    state.minecraft.get_loader_support().await
}

#[tauri::command]
pub async fn get_loader_versions(
    state: State<'_, AppState>,
    loader: String,
    game_version: String,
) -> Result<Vec<String>, String> {
    state.minecraft.list_loader_versions(&loader, &game_version).await
}

#[tauri::command]
pub async fn search_mods(
    state: State<'_, AppState>,
    payload: ModSearchPayload,
) -> Result<ModSearchResponse, String> {
    if payload.provider.as_deref() == Some("curseforge") {
        state.curseforge.search(&payload).await
    } else {
        state.mods.search(&payload).await
    }
}

#[tauri::command]
pub async fn get_category_tags(
    state: State<'_, AppState>,
    project_type: String,
    provider: Option<String>,
) -> Result<Vec<String>, String> {
    if provider.as_deref() == Some("curseforge") {
        state.curseforge.get_category_tags(&project_type).await
    } else {
        state.mods.get_category_tags(&project_type).await
    }
}

#[tauri::command]
pub async fn prepare_mod_install(
    state: State<'_, AppState>,
    payload: PrepareModInstallPayload,
) -> Result<ModInstallPlan, String> {
    if payload.provider == "curseforge" {
        state.curseforge.prepare_install(&payload).await
    } else {
        state.mods.prepare_install(&payload).await
    }
}

#[tauri::command]
pub async fn install_mod(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: InstallModPayload,
) -> Result<LauncherInstance, String> {
    let key = format!("mod:{}", payload.project_id);
    let name = payload.name.clone();
    let mut last = Instant::now() - Duration::from_secs(1);
    let mut on_bytes = |received: u64, total: Option<u64>| {
        if last.elapsed().as_millis() >= 100 || Some(received) == total {
            last = Instant::now();
            let _ = app.emit(
                "transfer:progress",
                json!({
                    "key": key,
                    "fileName": name,
                    "received": received,
                    "total": total
                }),
            );
        }
    };
    if payload.provider == "curseforge" {
        state.curseforge.install(&payload, &mut on_bytes).await
    } else {
        state.mods.install(&payload, &mut on_bytes).await
    }
}

#[tauri::command]
pub async fn download_modpack(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: DownloadModpackPayload,
) -> Result<String, String> {
    let key = format!("modpack:{}", payload.project_id);
    let name = payload.name.clone();
    let mut last = Instant::now() - Duration::from_secs(1);
    let mut on_bytes = |received: u64, total: Option<u64>| {
        if last.elapsed().as_millis() >= 100 || Some(received) == total {
            last = Instant::now();
            let _ = app.emit(
                "transfer:progress",
                json!({
                    "key": key,
                    "fileName": name,
                    "received": received,
                    "total": total
                }),
            );
        }
    };
    if payload.provider.as_deref() == Some("curseforge") {
        state.curseforge.download_modpack_file(&payload, &mut on_bytes).await
    } else {
        state.mods.download_modpack_file(&payload, &mut on_bytes).await
    }
}

#[tauri::command]
pub async fn list_mod_versions(
    state: State<'_, AppState>,
    instance_id: String,
    project_id: String,
    project_type: String,
    provider: Option<String>,
) -> Result<Vec<ModVersionInfo>, String> {
    if provider.as_deref() == Some("curseforge") {
        state
            .curseforge
            .list_versions(&instance_id, &project_id, &project_type)
            .await
    } else {
        state
            .mods
            .list_versions(&instance_id, &project_id, &project_type)
            .await
    }
}

#[tauri::command]
pub async fn get_mod_details(
    state: State<'_, AppState>,
    project_id: String,
    project_type: String,
    provider: String,
) -> Result<ModProjectDetails, String> {
    if provider == "curseforge" {
        state
            .curseforge
            .get_project_details(&project_id, &project_type)
            .await
    } else {
        state
            .mods
            .get_project_details(&project_id, &project_type)
            .await
    }
}

#[tauri::command]
pub async fn check_content_updates(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Vec<ContentUpdateInfo>, String> {
    state.mods.check_updates(&instance_id).await
}

#[tauri::command]
pub async fn get_local_content(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Vec<LocalContentItem>, String> {
    state.store.reconcile_instances().await;
    state.content.list(&instance_id).await
}

#[tauri::command]
pub async fn toggle_local_content(
    state: State<'_, AppState>,
    payload: LocalContentPayload,
) -> Result<Vec<LocalContentItem>, String> {
    state
        .content
        .toggle(
            &payload.instance_id,
            &payload.file_name,
            payload.kind.as_deref(),
            payload.world.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn remove_local_content(
    state: State<'_, AppState>,
    payload: LocalContentPayload,
) -> Result<Vec<LocalContentItem>, String> {
    state
        .content
        .remove(
            &payload.instance_id,
            &payload.file_name,
            payload.kind.as_deref(),
            payload.world.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn detect_local_content(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<LauncherInstance, String> {
    state.content.detect_from_modrinth(&instance_id).await
}

#[tauri::command]
pub async fn import_local_content(
    state: State<'_, AppState>,
    instance_id: String,
    paths: Vec<String>,
) -> Result<ContentImportResult, String> {
    state.content.import_files(&instance_id, &paths).await
}

#[tauri::command]
pub async fn scan_external_launchers(
    state: State<'_, AppState>,
    extra_roots: Option<Vec<String>>,
) -> Result<Vec<ExternalLauncher>, String> {
    state.importer.scan(extra_roots.unwrap_or_default()).await
}

#[tauri::command]
pub async fn import_external_instances(
    app: AppHandle,
    state: State<'_, AppState>,
    keys: Vec<String>,
    extra_roots: Option<Vec<String>>,
) -> Result<ExternalImportResult, String> {
    state
        .importer
        .import_instances(&app, keys, extra_roots.unwrap_or_default())
        .await
}

#[tauri::command]
pub async fn pick_external_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<PickedExternalFolder>, String> {
    let title = tr(
        "Choose a launcher or instances folder",
        "Выберите папку лаунчера или инстанций",
    )
    .to_string();
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog().file().set_title(title).blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(folder_path) = picked else {
        return Ok(None);
    };
    let folder = folder_path.to_string();
    let launcher = state.importer.scan_folder(folder.clone()).await?;
    Ok(Some(PickedExternalFolder { folder, launcher }))
}

#[tauri::command]
pub async fn import_mrpack_start(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<MrpackBeginResult, String> {
    state.modpacks.begin_import(&file_path).await
}

#[tauri::command]
pub async fn import_mrpack_start_to_instance(
    state: State<'_, AppState>,
    file_path: String,
    instance_id: String,
) -> Result<MrpackTargetResult, String> {
    state
        .modpacks
        .begin_import_to_instance(&file_path, &instance_id)
        .await
}

#[tauri::command]
pub async fn import_mrpack_cancel(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<(), String> {
    state.modpacks.cancel_import(&instance_id).await;
    Ok(())
}

#[tauri::command]
pub async fn export_mrpack(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    include: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    let data = state.store.get_data().await;
    let inst = data
        .instances
        .iter()
        .find(|i| i.id == instance_id)
        .ok_or_else(|| tr("Instance not found", "Инстанция не найдена").to_string())?;
    let default_name = format!("{}.mrpack", inst.name);
    let title = tr("Export modpack", "Экспорт модпака").to_string();
    let filter_name = tr("Modrinth modpack", "Модпак Modrinth").to_string();
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(title)
            .set_file_name(&default_name)
            .add_filter(filter_name, &["mrpack"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(save_path) = picked else {
        return Ok(None);
    };
    let out = state
        .modpacks
        .export_instance(&instance_id, &save_path.to_string(), include)
        .await?;
    Ok(Some(out))
}

#[tauri::command]
pub async fn list_export_entries(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Vec<ExportEntry>, String> {
    state.modpacks.list_export_entries(&instance_id).await
}

#[tauri::command]
pub async fn import_mrpack_files(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<LauncherInstance, String> {
    state.modpacks.finish_import(&app, &instance_id).await
}

#[tauri::command]
pub async fn list_worlds(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Vec<WorldInfo>, String> {
    state.worlds.list(&instance_id).await
}

#[tauri::command]
pub async fn backup_world(
    state: State<'_, AppState>,
    instance_id: String,
    folder_name: String,
) -> Result<Vec<WorldInfo>, String> {
    state.worlds.backup(&instance_id, &folder_name).await
}

#[tauri::command]
pub async fn restore_world_backup(
    state: State<'_, AppState>,
    instance_id: String,
    folder_name: String,
    backup_id: String,
) -> Result<Vec<WorldInfo>, String> {
    state
        .worlds
        .restore(&instance_id, &folder_name, &backup_id)
        .await
}

#[tauri::command]
pub async fn delete_world_backup(
    state: State<'_, AppState>,
    instance_id: String,
    folder_name: String,
    backup_id: String,
) -> Result<Vec<WorldInfo>, String> {
    state
        .worlds
        .delete_backup(&instance_id, &folder_name, &backup_id)
        .await
}

#[tauri::command]
pub async fn delete_world(
    state: State<'_, AppState>,
    instance_id: String,
    folder_name: String,
) -> Result<Vec<WorldInfo>, String> {
    state.worlds.delete_world(&instance_id, &folder_name).await
}

#[tauri::command]
pub async fn list_servers(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Vec<ServerEntry>, String> {
    state.servers.list(&instance_id).await
}

#[tauri::command]
pub async fn add_server(
    state: State<'_, AppState>,
    instance_id: String,
    name: String,
    ip: String,
) -> Result<Vec<ServerEntry>, String> {
    state.servers.add(&instance_id, &name, &ip).await
}

#[tauri::command]
pub async fn remove_server(
    state: State<'_, AppState>,
    instance_id: String,
    ip: String,
) -> Result<Vec<ServerEntry>, String> {
    state.servers.remove(&instance_id, &ip).await
}

#[tauri::command]
pub async fn ping_server(
    state: State<'_, AppState>,
    ip: String,
) -> Result<ServerPingResult, String> {
    Ok(state.servers.ping(&ip).await)
}

#[tauri::command]
pub async fn list_screenshots(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<Vec<ScreenshotInfo>, String> {
    state.content.list_screenshots(&instance_id).await
}

#[tauri::command]
pub async fn copy_screenshot(
    state: State<'_, AppState>,
    instance_id: String,
    file_name: String,
) -> Result<bool, String> {
    state.content.copy_screenshot(&instance_id, &file_name).await
}

#[tauri::command]
pub async fn delete_screenshot(
    state: State<'_, AppState>,
    instance_id: String,
    file_name: String,
) -> Result<Vec<ScreenshotInfo>, String> {
    state
        .content
        .delete_screenshot(&instance_id, &file_name)
        .await
}

#[tauri::command]
pub async fn list_skins(state: State<'_, AppState>) -> Result<Vec<SkinInfo>, String> {
    state.skins.list().await
}

#[tauri::command]
pub async fn ely_skin(state: State<'_, AppState>) -> Result<Option<ElySkinResult>, String> {
    Ok(state.skins.ely_skin().await)
}

#[tauri::command]
pub async fn account_skin(state: State<'_, AppState>) -> Result<Option<ElySkinResult>, String> {
    Ok(state.skins.account_skin().await)
}

#[tauri::command]
pub async fn add_skin(
    state: State<'_, AppState>,
    payload: SkinAddPayload,
) -> Result<Vec<SkinInfo>, String> {
    state.skins.add(payload).await
}

#[tauri::command]
pub async fn update_skin(
    state: State<'_, AppState>,
    payload: SkinUpdatePayload,
) -> Result<Vec<SkinInfo>, String> {
    state.skins.update(payload).await
}

#[tauri::command]
pub async fn remove_skin(
    state: State<'_, AppState>,
    id: String,
) -> Result<SkinRemoveResult, String> {
    state.skins.remove(&id).await
}

#[tauri::command]
pub async fn activate_skin(
    state: State<'_, AppState>,
    id: String,
) -> Result<SkinActivateResult, String> {
    state.skins.activate(&id).await
}

#[tauri::command]
pub async fn list_capes(state: State<'_, AppState>) -> Result<Vec<CapeInfo>, String> {
    state.skins.list_capes().await
}

#[tauri::command]
pub async fn equip_cape(
    state: State<'_, AppState>,
    cape_id: Option<String>,
) -> Result<Vec<CapeInfo>, String> {
    state.skins.equip_cape(cape_id).await
}

#[tauri::command]
pub async fn updater_download(
    app: AppHandle,
    state: State<'_, AppState>,
    edition: Option<String>,
) -> Result<(), String> {
    state.updater.download(&app, edition).await
}

#[tauri::command]
pub async fn updater_install(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.updater.install(&app).await
}

const MAX_CUSTOM_FONT_BYTES: u64 = 20 * 1024 * 1024;

fn font_mime_for_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "woff2" => Some("font/woff2"),
        "woff" => Some("font/woff"),
        "otf" => Some("font/otf"),
        "ttf" => Some("font/ttf"),
        _ => None,
    }
}

fn clean_font_display_name(stem: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for ch in stem.chars() {
        let normalized = if ch == '_' || ch == '-' { ' ' } else { ch };
        if normalized.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(normalized);
            prev_space = false;
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        "Custom Font".to_string()
    } else {
        trimmed.to_string()
    }
}

fn read_single_custom_font(path: &Path) -> Option<CustomFontInfo> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_CUSTOM_FONT_BYTES {
        return None;
    }
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    let mime = font_mime_for_ext(&ext)?;
    let file_name = path.file_name()?.to_string_lossy().to_string();
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let bytes = fs::read(path).ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(CustomFontInfo {
        id: format!("custom:{file_name}"),
        name: clean_font_display_name(&stem),
        file_name,
        data_url: format!("data:{mime};base64,{encoded}"),
    })
}

fn read_custom_fonts_sync() -> Vec<CustomFontInfo> {
    let dir = get_fonts_root();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut list = Vec::new();
    for entry in entries.flatten() {
        if let Some(info) = read_single_custom_font(&entry.path()) {
            list.push(info);
        }
    }
    list.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()))
    });
    list
}

#[tauri::command]
pub async fn list_custom_fonts() -> Result<Vec<CustomFontInfo>, String> {
    tokio::task::spawn_blocking(read_custom_fonts_sync)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_custom_font(app: AppHandle) -> Result<Option<AddCustomFontResult>, String> {
    let title = tr("Select font file", "Выберите файл шрифта").to_string();
    let filter_label = tr("Font files", "Файлы шрифтов").to_string();
    let dialog = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter(filter_label, &["ttf", "otf", "woff", "woff2"]);
    let picked = tokio::task::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let src = PathBuf::from(file_path.to_string());
    tokio::task::spawn_blocking(move || {
        let meta = fs::metadata(&src).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err(tr("Selected item is not a file", "Выбранный объект не является файлом").to_string());
        }
        if meta.len() == 0 || meta.len() > MAX_CUSTOM_FONT_BYTES {
            return Err(tr(
                "Font file must be between 1 byte and 20 MB",
                "Размер файла шрифта должен быть не больше 20 МБ",
            )
            .to_string());
        }
        let ext = src
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if font_mime_for_ext(&ext).is_none() {
            return Err(tr(
                "Unsupported font format. Use .ttf, .otf, .woff or .woff2",
                "Неподдерживаемый формат шрифта. Используйте .ttf, .otf, .woff или .woff2",
            )
            .to_string());
        }
        let raw_stem = src
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "CustomFont".to_string());
        let stem = sanitize_folder_name(&raw_stem);
        let dir = get_fonts_root();
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut dest = dir.join(format!("{stem}.{ext}"));
        if dest.exists() {
            let mut placed = false;
            for i in 1..1000 {
                let candidate = dir.join(format!("{stem} ({i}).{ext}"));
                if !candidate.exists() {
                    dest = candidate;
                    placed = true;
                    break;
                }
            }
            if !placed {
                dest = dir.join(format!("{stem}-{}.{ext}", uuid::Uuid::new_v4().simple()));
            }
        }
        fs::copy(&src, &dest).map_err(|e| e.to_string())?;
        let added = read_single_custom_font(&dest);
        let fonts = read_custom_fonts_sync();
        Ok(Some(AddCustomFontResult { added, fonts }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remove_custom_font(file_name: String) -> Result<Vec<CustomFontInfo>, String> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
    {
        return Err(tr("Invalid font file name", "Некорректное имя файла шрифта").to_string());
    }
    let clean = Path::new(&file_name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if clean != file_name {
        return Err(tr("Invalid font file name", "Некорректное имя файла шрифта").to_string());
    }
    tokio::task::spawn_blocking(move || {
        let target = get_fonts_root().join(&clean);
        if target.is_file() {
            fs::remove_file(&target).map_err(|e| e.to_string())?;
        }
        Ok(read_custom_fonts_sync())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_fonts_folder(app: AppHandle) -> Result<String, String> {
    let dir = get_fonts_root();
    let _ = fs::create_dir_all(&dir);
    let dir_str = dir.to_string_lossy().to_string();
    app.opener()
        .open_path(&dir_str, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(String::new())
}

#[cfg(windows)]
fn read_system_fonts_sync() -> Vec<String> {
    use std::collections::BTreeSet;
    use windows_sys::Win32::Foundation::LPARAM;
    use windows_sys::Win32::Graphics::Gdi::{
        EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
    };

    unsafe extern "system" fn callback(
        lpelfe: *const LOGFONTW,
        _lpntme: *const TEXTMETRICW,
        _font_type: u32,
        lparam: LPARAM,
    ) -> i32 {
        if !lpelfe.is_null() && lparam != 0 {
            let set = &mut *(lparam as *mut BTreeSet<String>);
            let face = &(*lpelfe).lfFaceName;
            let len = face.iter().position(|&c| c == 0).unwrap_or(face.len());
            if len > 0 {
                let name = String::from_utf16_lossy(&face[..len]);
                let trimmed = name.trim();
                if !trimmed.is_empty() && !trimmed.starts_with('@') {
                    set.insert(trimmed.to_string());
                }
            }
        }
        1
    }

    let mut set = BTreeSet::new();
    unsafe {
        let hdc = GetDC(std::ptr::null_mut());
        if !hdc.is_null() {
            let mut lf: LOGFONTW = std::mem::zeroed();
            lf.lfCharSet = DEFAULT_CHARSET;
            EnumFontFamiliesExW(
                hdc,
                &lf,
                Some(callback),
                (&mut set as *mut BTreeSet<String>) as LPARAM,
                0,
            );
            ReleaseDC(std::ptr::null_mut(), hdc);
        }
    }
    let mut list: Vec<String> = set.into_iter().collect();
    list.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    list
}

#[cfg(not(windows))]
fn read_system_fonts_sync() -> Vec<String> {
    use std::collections::BTreeSet;
    let mut set = BTreeSet::new();
    if let Ok(output) = std::process::Command::new("fc-list")
        .args([":", "family"])
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                for part in line.split(',') {
                    let trimmed = part.trim();
                    if !trimmed.is_empty() && !trimmed.starts_with('.') {
                        set.insert(trimmed.to_string());
                    }
                }
            }
        }
    }
    let mut list: Vec<String> = set.into_iter().collect();
    list.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    list
}

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(read_system_fonts_sync)
        .await
        .map_err(|e| e.to_string())
}

fn parse_google_fonts_metadata(raw: &str) -> Result<Vec<GoogleFontInfo>, String> {
    let trimmed = raw.trim_start();
    let body = trimmed.strip_prefix(")]}'").unwrap_or(trimmed).trim_start();
    let root: Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let items = root
        .get("familyMetadataList")
        .and_then(Value::as_array)
        .ok_or_else(|| "Invalid Google Fonts metadata".to_string())?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(family) = item.get("family").and_then(Value::as_str) else {
            continue;
        };
        let family = family.trim();
        if family.is_empty() {
            continue;
        }
        let category = item
            .get("category")
            .and_then(Value::as_str)
            .unwrap_or("Sans Serif")
            .to_string();
        let cyrillic = item
            .get("subsets")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().any(|s| s.as_str() == Some("cyrillic")))
            .unwrap_or(false);
        let popularity = item
            .get("popularity")
            .and_then(Value::as_u64)
            .unwrap_or(99999) as u32;
        let mut weights: Vec<u16> = item
            .get("fonts")
            .and_then(Value::as_object)
            .map(|obj| {
                obj.keys()
                    .filter(|k| !k.ends_with('i'))
                    .filter_map(|k| k.parse::<u16>().ok())
                    .collect()
            })
            .unwrap_or_default();
        weights.sort_unstable();
        weights.dedup();
        if weights.is_empty() {
            weights.push(400);
        }
        out.push(GoogleFontInfo {
            family: family.to_string(),
            category,
            cyrillic,
            popularity,
            weights,
        });
    }
    out.sort_by(|a, b| {
        a.popularity
            .cmp(&b.popularity)
            .then_with(|| a.family.to_lowercase().cmp(&b.family.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub async fn list_google_fonts() -> Result<Vec<GoogleFontInfo>, String> {
    let cache_path = get_launcher_root().join("cache").join("google-fonts.json");
    let cache_read_path = cache_path.clone();
    let cached = tokio::task::spawn_blocking(move || -> Option<(bool, Vec<GoogleFontInfo>)> {
        let meta = fs::metadata(&cache_read_path).ok()?;
        let fresh = meta
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|age| age < Duration::from_secs(60 * 60 * 24 * 7))
            .unwrap_or(false);
        let raw = fs::read_to_string(&cache_read_path).ok()?;
        let parsed = serde_json::from_str::<Vec<GoogleFontInfo>>(&raw).ok()?;
        if parsed.is_empty() {
            return None;
        }
        Some((fresh, parsed))
    })
    .await
    .ok()
    .flatten();

    if let Some((true, list)) = cached {
        return Ok(list);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let fetched = async {
        let resp = client
            .get("https://fonts.google.com/metadata/fonts")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status().as_u16()));
        }
        let text = resp.text().await.map_err(|e| e.to_string())?;
        parse_google_fonts_metadata(&text)
    }
    .await;

    match fetched {
        Ok(list) => {
            let to_save = list.clone();
            let save_path = cache_path.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Some(parent) = save_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if let Ok(json) = serde_json::to_string(&to_save) {
                    let _ = fs::write(&save_path, json);
                }
            })
            .await;
            Ok(list)
        }
        Err(err) => {
            if let Some((_, fallback)) = cached {
                Ok(fallback)
            } else {
                Err(err)
            }
        }
    }
}
