import { FolderOpen, HardDrive, KeyRound, Plus, Trash2, User, UserRoundCog } from "lucide-react";
import { Board } from "../components/Board";
import { getLauncherApi } from "../lib/api";
import { useApp } from "../state/context";

export function AccountsPage() {
  const { section } = useApp();
  return section === "accounts" ? <AccountsContent /> : null;
}

function AccountsContent() {
  const { activeAccount, beginLogin, bootstrap, busy, elyLogin, offlineName, removeAccount, sectionExiting, setOfflineName, status, switchAccount, t, useOfflineProfile } = useApp();
  const blocks = {
    list: <div className="settings-content"><div className="surface-heading"><User size={19} /><div><h3>{t("Playing as", "Вы играете как")}</h3><span>{t("Click an account to switch, no re-login needed.", "Щёлкните по учётной записи, чтобы переключиться без повторного входа.")}</span></div></div><div className="account-list">{bootstrap.accounts.map((item) => <div key={item.id} role="button" tabIndex={0} onClick={() => void switchAccount(item.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void switchAccount(item.id); } }} className={item.id === activeAccount?.id ? "account-row active" : "account-row"}>{item.id === activeAccount?.id ? <span className="account-dot on" /> : <span className="account-dot" />}{item.kind === "microsoft" ? <KeyRound size={20} /> : <User size={20} />}<div><strong>{item.profileName ?? item.kind}</strong><span>{(item.kind === "microsoft" ? t("Minecraft account", "Учётная запись Minecraft") : item.kind === "ely" ? "Ely.by" : t("Offline", "Офлайн")) + (item.status === "signed-out" ? ` · ${t("Session expired — sign in again", "Сессия истекла — войдите снова")}` : "")}</span></div><button type="button" title={t("Remove account", "Удалить учётную запись")} onClick={(event) => { event.stopPropagation(); void removeAccount(item.id, item.profileName ?? item.kind); }} disabled={busy}><Trash2 size={15} /></button></div>)}{bootstrap.accounts.length ? null : <span className="muted">{t("No accounts yet. Add one below.", "Учётных записей пока нет. Добавьте ниже.")}</span>}</div><div className="button-row"><button className="primary-button" onClick={beginLogin} disabled={busy}><Plus size={16} /> {t("Add Microsoft account", "Добавить аккаунт Microsoft")}</button></div></div>,
    offline: <div className="settings-content"><div className="surface-heading"><UserRoundCog size={19} /><div><h3>{t("Offline profile", "Офлайн-профиль")}</h3><span>{t("No Microsoft account needed.", "Учётная запись Microsoft не требуется.")}</span></div></div><label>{t("Username", "Имя пользователя")}<input value={offlineName} maxLength={16} onChange={(event) => setOfflineName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !busy) void useOfflineProfile(); }} placeholder={t("Player", "Игрок")} /></label><button onClick={useOfflineProfile} disabled={busy}><User size={16} /> {t("Add offline profile", "Добавить офлайн-профиль")}</button></div>,
    ely: <div className="settings-content"><div className="surface-heading"><KeyRound size={19} /><div><h3>Ely.by {t("account", "учётная запись")}</h3><span>{t("Login, skins and Ely servers.", "Вход, скины и серверы Ely.")}</span></div></div><span className="muted">{t("Opens the official Ely.by sign-in window (supports 2FA and automatic skin uploads).", "Откроет официальное окно входа Ely.by (поддерживает 2FA и сразу авторизует загрузку скинов).")}</span><div className="button-row"><button className="primary-button" onClick={() => void elyLogin()} disabled={busy}><KeyRound size={16} /> {t("Sign in with Ely.by", "Войти через Ely.by")}</button></div></div>,
    storage: <div className="settings-content"><div className="surface-heading"><HardDrive size={19} /><div><h3>{t("Data folder", "Папка данных")}</h3><span>{t("Where accounts and settings are stored.", "Где хранятся учётные записи и настройки.")}</span></div></div><div className="readonly-path"><HardDrive size={16} /><span>{bootstrap.storagePath}</span><button type="button" className="path-open" onClick={() => void getLauncherApi().openDataFolder()} title={t("Open folder", "Открыть папку")} aria-label={t("Open folder", "Открыть папку")}><FolderOpen size={15} /></button></div></div>
  };
  return (
    <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}>
      <header className="workspace-header"><div><span className="eyebrow">{t("Identity", "Профиль")}</span><h2>{t("Account settings", "Аккаунты")}</h2><span className="status-line">{status}</span></div></header>
      <Board id="accounts" blocks={blocks} />
    </main>
  );
}
