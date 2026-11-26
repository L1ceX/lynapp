use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMod {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub installed_at: String,
    #[serde(default)]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherInstance {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub game_version: String,
    #[serde(default)]
    pub loader: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loader_version: Option<String>,
    #[serde(default)]
    pub directory: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub java_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_memory_mb: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_jvm_args: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_played_at: Option<String>,
    #[serde(default)]
    pub mods: Vec<InstalledMod>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectsSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub background: bool,
    #[serde(default = "default_true")]
    pub springs: bool,
    #[serde(default = "default_true")]
    pub launch: bool,
    #[serde(default = "default_true")]
    pub cascade: bool,
    #[serde(default = "default_true")]
    pub cards: bool,
    #[serde(default = "default_true")]
    pub details: bool,
}

impl Default for EffectsSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            background: true,
            springs: true,
            launch: true,
            cascade: true,
            cards: true,
            details: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionTypeFilter {
    #[serde(default = "default_true")]
    pub release: bool,
    #[serde(default)]
    pub snapshot: bool,
    #[serde(default)]
    pub beta: bool,
    #[serde(default)]
    pub alpha: bool,
}

impl Default for VersionTypeFilter {
    fn default() -> Self {
        Self {
            release: true,
            snapshot: false,
            beta: false,
            alpha: false,
        }
    }
}

pub fn default_theme_map() -> HashMap<String, String> {
    HashMap::from([
        ("background".into(), "#0b111d".into()),
        ("sidebar".into(), "#0d1522".into()),
        ("cards".into(), "#101d2e".into()),
        ("inputs".into(), "#0b1524".into()),
        ("borders".into(), "#21364e".into()),
        ("buttons".into(), "#132137".into()),
        ("accent".into(), "#4e8cc5".into()),
        ("active".into(), "#1c4973".into()),
        ("primary".into(), "#224e78".into()),
        ("danger".into(), "#b96b82".into()),
        ("glow".into(), "#ffffff".into()),
        ("text".into(), "#e8f0fb".into()),
        ("muted".into(), "#8ba2ba".into()),
    ])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherSettings {
    #[serde(default)]
    pub java_path: String,
    #[serde(default)]
    pub java_paths: HashMap<String, String>,
    #[serde(default = "default_memory_mb")]
    pub max_memory_mb: u32,
    #[serde(default)]
    pub extra_jvm_args: String,
    #[serde(default)]
    pub launcher_data_dir: String,
    #[serde(default = "default_concurrent_downloads")]
    pub concurrent_downloads: u32,
    #[serde(default = "default_after_launch")]
    pub after_launch: String,
    #[serde(default = "default_true")]
    pub discord_presence: bool,
    #[serde(default)]
    pub discord_hide_instance: bool,
    #[serde(default)]
    pub beta_updates: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_edition: Option<String>,
    #[serde(default)]
    pub auto_install_dependencies: bool,
    #[serde(default)]
    pub version_types: VersionTypeFilter,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home_layout: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nav_layout: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_layouts: Option<Value>,
    #[serde(default)]
    pub microsoft_client_id: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_theme_map")]
    pub theme: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub glow_enabled: bool,
    #[serde(default = "default_hundred")]
    pub glow_size: u32,
    #[serde(default = "default_hundred")]
    pub glow_speed: u32,
    #[serde(default = "default_true")]
    pub animations_enabled: bool,
    #[serde(default = "default_hundred")]
    pub animation_speed: u32,
    #[serde(default)]
    pub effects: EffectsSettings,
    #[serde(default)]
    pub active_skin_id: Option<String>,
    #[serde(default)]
    pub font_family: String,
}

fn default_memory_mb() -> u32 {
    4096
}

fn default_concurrent_downloads() -> u32 {
    8
}

fn default_after_launch() -> String {
    "keep".to_string()
}

fn default_true() -> bool {
    true
}

fn default_language() -> String {
    "en".to_string()
}

fn default_hundred() -> u32 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFontInfo {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCustomFontResult {
    pub added: Option<CustomFontInfo>,
    pub fonts: Vec<CustomFontInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleFontInfo {
    pub family: String,
    pub category: String,
    pub cyrillic: bool,
    pub popularity: u32,
    pub weights: Vec<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinMeta {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub slim: bool,
    #[serde(default)]
    pub added_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinInfo {
    pub id: String,
    pub name: String,
    pub slim: bool,
    pub added_at: String,
    pub account_id: Option<String>,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinAddPayload {
    pub name: String,
    pub data_url: String,
    pub slim: bool,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinUpdatePatch {
    pub name: Option<String>,
    pub slim: Option<bool>,
    pub account_id: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinUpdatePayload {
    pub id: String,
    pub patch: SkinUpdatePatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinActivateResult {
    pub active_skin_id: String,
    pub uploaded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinRemoveResult {
    pub skins: Vec<SkinInfo>,
    pub active_skin_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElySkinResult {
    pub data_url: String,
    pub slim: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapeInfo {
    pub id: String,
    pub alias: String,
    pub url: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minecraft_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minecraft_access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microsoft_refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ely_access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ely_client_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ely_refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ely_auth_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xbox_uhs: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_skin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
}

impl AccountState {
    pub fn sanitized(&self) -> Self {
        let mut copy = self.clone();
        copy.minecraft_access_token = None;
        copy.microsoft_refresh_token = None;
        copy.ely_access_token = None;
        copy.ely_client_token = None;
        copy.ely_refresh_token = None;
        copy.xbox_uhs = None;
        copy
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsState {
    pub accounts: Vec<AccountState>,
    pub active_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapState {
    pub settings: LauncherSettings,
    pub instances: Vec<LauncherInstance>,
    pub active_instance_id: Option<String>,
    pub accounts: Vec<AccountState>,
    pub active_account_id: Option<String>,
    pub storage_path: String,
    pub java_candidates: Vec<String>,
    pub app_version: String,
    pub curseforge_available: bool,
    pub system_memory_mb: u32,
    pub max_memory_mb: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameVersionInfo {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaRuntimeState {
    pub required_major: u32,
    pub major: u32,
    pub path: String,
    pub source: String,
    pub installed_now: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaInstallation {
    pub major: u32,
    pub path: String,
    pub valid: bool,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickPlayTarget {
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceLogsResult {
    pub log: String,
    pub plan: String,
    pub has_log: bool,
    pub crash: Option<CrashReportInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportInfo {
    pub file: String,
    pub description: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInstancePayload {
    pub name: String,
    pub game_version: String,
    pub loader: String,
    pub loader_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstancePatch {
    pub name: Option<String>,
    pub game_version: Option<String>,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
    pub java_path: Option<String>,
    pub max_memory_mb: Option<u32>,
    pub extra_jvm_args: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstancePayload {
    pub id: String,
    pub patch: UpdateInstancePatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherData {
    pub settings: LauncherSettings,
    #[serde(default)]
    pub instances: Vec<LauncherInstance>,
    #[serde(default)]
    pub active_instance_id: Option<String>,
    #[serde(default)]
    pub accounts: Vec<AccountState>,
    #[serde(default)]
    pub active_account_id: Option<String>,
    #[serde(default)]
    pub running_processes: HashMap<String, u32>,
    #[serde(default)]
    pub skins: Vec<SkinMeta>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartResult {
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModSearchPayload {
    pub provider: Option<String>,
    pub query: String,
    pub instance_id: Option<String>,
    pub project_type: String,
    pub sort: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub categories: Option<Vec<String>>,
    pub versions: Option<Vec<String>>,
    pub loaders: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModSearchResult {
    pub id: String,
    pub provider: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloads: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_modified: Option<String>,
    pub categories: Vec<String>,
    pub project_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distribution_blocked: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModSearchResponse {
    pub results: Vec<ModSearchResult>,
    pub total_hits: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallModPayload {
    pub instance_id: String,
    pub provider: String,
    pub project_id: String,
    pub version_id: Option<String>,
    pub replace_mod_id: Option<String>,
    pub name: String,
    pub slug: Option<String>,
    pub icon_url: Option<String>,
    pub project_type: String,
    pub game_versions: Option<Vec<String>>,
    pub loaders: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareModInstallPayload {
    pub instance_id: String,
    pub provider: String,
    pub project_id: String,
    pub version_id: Option<String>,
    pub project_type: String,
    pub game_versions: Option<Vec<String>>,
    pub loaders: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadModpackPayload {
    pub provider: Option<String>,
    pub instance_id: String,
    pub project_id: String,
    pub version_id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModVersionInfo {
    pub id: String,
    pub name: String,
    pub version_number: String,
    pub version_type: String,
    pub date_published: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub file_name: String,
    pub size: u64,
    pub compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distribution_blocked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModDependencyItem {
    pub project_id: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_number: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    pub dependency_type: String,
    pub installed: bool,
    pub compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distribution_blocked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModInstallPlan {
    pub target_version: Option<ModVersionInfo>,
    pub has_compatible_version: bool,
    pub versions: Vec<ModVersionInfo>,
    pub dependencies: Vec<ModDependencyItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentIncompatibility {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader: Option<String>,
    pub supported_game_versions: Vec<String>,
    pub supported_loaders: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentUpdateInfo {
    pub project_id: String,
    pub project_type: String,
    pub file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version_number: Option<String>,
    pub latest: Option<ModVersionInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incompatible: Option<ContentIncompatibility>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModGalleryItem {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProjectDetails {
    pub id: String,
    pub provider: String,
    pub project_type: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub summary: String,
    pub body: String,
    pub body_format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloads: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_published: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_modified: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    pub categories: Vec<String>,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub gallery: Vec<ModGalleryItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issues_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wiki_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discord_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distribution_blocked: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalContentPayload {
    pub instance_id: String,
    pub file_name: String,
    pub kind: Option<String>,
    pub world: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalContentItem {
    pub kind: String,
    pub file_name: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    pub size: u64,
    pub modified: String,
    pub enabled: bool,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependents: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentImportAdded {
    pub file_name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentImportSkipped {
    pub file_name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentImportResult {
    pub added: Vec<ContentImportAdded>,
    pub skipped: Vec<ContentImportSkipped>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotInfo {
    pub file_name: String,
    pub size: u64,
    pub modified: String,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldBackupInfo {
    pub id: String,
    pub file_name: String,
    pub size: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldInfo {
    pub folder_name: String,
    pub name: String,
    pub last_played: Option<String>,
    pub game_mode: String,
    pub hardcore: bool,
    pub cheats: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_name: Option<String>,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
    pub backups: Vec<WorldBackupInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEntry {
    pub name: String,
    pub ip: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPingResult {
    pub ip: String,
    pub online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub players_online: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub players_max: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrpackBeginResult {
    pub instance: LauncherInstance,
    pub total_files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrpackTargetResult {
    pub total_files: usize,
    pub pack_name: String,
    pub pack_game_version: String,
    pub pack_loader: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalInstance {
    pub key: String,
    pub launcher: String,
    pub name: String,
    pub game_version: String,
    pub loader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader_version: Option<String>,
    pub directory: String,
    pub mods: usize,
    pub worlds: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_played: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_memory_mb: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_jvm_args: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalLauncher {
    pub key: String,
    pub id: String,
    pub root: String,
    pub instances: Vec<ExternalInstance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalImportImported {
    pub key: String,
    pub instance_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalImportFailed {
    pub key: String,
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalImportResult {
    pub imported: Vec<ExternalImportImported>,
    pub failed: Vec<ExternalImportFailed>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedExternalFolder {
    pub folder: String,
    pub launcher: Option<ExternalLauncher>,
}
