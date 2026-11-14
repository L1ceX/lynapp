export type Translate = (en: string, ru: string) => string;

export function detectCrash(log: string, t: Translate): { title: string; hint: string; generic?: boolean; missingMod?: string } | null {
  const text = log.slice(-30000);
  const lower = text.toLowerCase();
  if (!lower.trim()) return null;
  const nonZeroExit = /(?:^|[\s(])exit code\s+(?!0(?:\D|$))(?:-?[1-9]\d*|0x[0-9a-f]+)/.test(lower);
  const crashEvidence = nonZeroExit || /(outofmemoryerror|java heap space|unsupportedclassversionerror|unsupported class file|unsatisfiedlinkerror|invalid_grant|mod resolution failed|incompatible mods found|formattedexception|duplicate mod|pixel format not accelerated|glfw error 6554|could not set pixel format|no space left|cannot access the file|mixin apply failed|critical injection failure|failed injection|missing or unsupported mandatory|which is missing|exception in thread|caused by:|a fatal error|crash report|process crashed|game crashed|mixintransformererror)/.test(lower);
  if (!crashEvidence) return null;
  if (lower.includes("outofmemoryerror") || lower.includes("java heap space")) {
    return { title: t("Out of memory", "Нехватка памяти"), hint: t("Close other apps or give the instance more memory on the RAM tab.", "Закройте другие приложения или увеличьте объём памяти во вкладке RAM.") };
  }
  if (lower.includes("unsupportedclassversionerror")) {
    return { title: t("Wrong Java version", "Неподходящая версия Java"), hint: t("Install the Java version this instance needs in launcher settings.", "Установите версию Java, требуемую инстанцией, в настройках лаунчера.") };
  }
  if (lower.includes("unsatisfiedlinkerror")) {
    return { title: t("Native libraries are broken", "Повреждены нативные библиотеки"), hint: t("Delete the game version and launch again so the libraries download fresh.", "Удалите версию игры и запустите снова, чтобы библиотеки скачались заново.") };
  }
  const majorMatch = lower.match(/unsupported class file major version (\d+)/);
  if (majorMatch) {
    const javaByMajor: Record<string, string> = { "69": "25", "68": "24", "67": "23", "66": "22", "65": "21", "64": "20", "63": "19", "62": "18", "61": "17", "60": "16", "55": "11", "52": "8" };
    const java = javaByMajor[majorMatch[1]] ?? `? (class ${majorMatch[1]})`;
    return { title: t(`Loader is too old for Java ${java}`, `Загрузчик устарел для Java ${java}`), hint: t("Update the loader to a release that supports this Java, or wait for one.", "Обновите загрузчик до выпуска с поддержкой этой Java либо дождитесь его.") };
  }
  if (lower.includes("modules minecraft and") && lower.includes("export package")) {
    return { title: t("Forge client conflict", "Конфликт клиента Forge"), hint: t("Reinstall the game version or the loader.", "Переустановите версию игры или загрузчик.") };
  }
  if (lower.includes("invalid_grant") || lower.includes("xsts") || (lower.includes("minecraft profile") && lower.includes("401"))) {
    return { title: t("Login session expired", "Сессия входа истекла"), hint: t("Sign in again on the Accounts page.", "Войдите снова во вкладке аккаунтов.") };
  }
  const gpuHint = t("Update your graphics drivers. The game could not start OpenGL.", "Обновите драйверы видеокарты. Игре не удалось запустить OpenGL.");
  const known: Array<{ keys: string[]; title: string; hint: string }> = [
    { keys: ["duplicate mod"], title: t("Duplicate mod", "Дублирующийся мод"), hint: t("Remove one of the two copies from the mods folder.", "Удалите одну из двух копий из папки mods.") },
    { keys: ["pixel format not accelerated"], title: t("Graphics failed to start", "Не удалось инициализировать графику"), hint: t("Update your graphics drivers. Old integrated GPUs may not run new versions.", "Обновите драйверы видеокарты. Старое встроенное видео может не запускать новые версии.") },
    { keys: ["glfw error 65542"], title: t("Graphics failed to start", "Не удалось инициализировать графику"), hint: gpuHint },
    { keys: ["glfw error 65543"], title: t("Graphics failed to start", "Не удалось инициализировать графику"), hint: gpuHint },
    { keys: ["could not set pixel format"], title: t("Graphics failed to start", "Не удалось инициализировать графику"), hint: gpuHint },
    { keys: ["no space left on device"], title: t("Disk is full", "Диск переполнен"), hint: t("Free up disk space and launch again.", "Освободите место на диске и запустите снова.") },
    { keys: ["the process cannot access the file"], title: t("File is locked", "Файл заблокирован"), hint: t("Close other launchers, antivirus scans and leftover game processes.", "Закройте другие лаунчеры, проверки антивируса и оставшиеся процессы игры.") },
    { keys: ["sinytra connector is present"], title: t("Sinytra conflict", "Конфликт Sinytra"), hint: t("Remove Connector or the conflicting Fabric mod and try again.", "Удалите Connector или конфликтующий Fabric-мод и повторите.") }
  ];
  for (const rule of known) {
    if (rule.keys.every((key) => lower.includes(key))) {
      return { title: rule.title, hint: rule.hint };
    }
  }
  const runtimeDeps = new Set(["java", "minecraft", "fabricloader", "fabric-loader", "quilt_loader", "quilt-loader", "forge", "neoforge"]);
  const missingDep = lower.match(/requires [^\n]*?\bof (?:'[^'\n]+'\s*\()?([a-z0-9_\-.+]+)\)?,? which is missing/);
  if (missingDep && !runtimeDeps.has(missingDep[1])) {
    return { title: t(`Missing ${missingDep[1]}`, `Отсутствует ${missingDep[1]}`), hint: t(`Install ${missingDep[1]} on the Content tab.`, `Установите ${missingDep[1]} во вкладке контента.`), missingMod: missingDep[1] };
  }
  const forgeDep = lower.includes("missing or unsupported mandatory dependencies")
    ? lower.match(/mod id: '([^']+)'/)
    : null;
  if (forgeDep) {
    return { title: t(`Missing mod '${forgeDep[1]}'`, `Отсутствует мод '${forgeDep[1]}'`), hint: t(`Install '${forgeDep[1]}' on the Content tab.`, `Установите '${forgeDep[1]}' во вкладке контента.`), missingMod: forgeDep[1] };
  }
  const mixinMod = lower.match(/failed injection[^\r\n]*?from mod (\S+)|mixin apply failed[^\r\n]*?\b(?:from|for) mod (\S+)/);
  const mixinModName = mixinMod?.[1] ?? mixinMod?.[2];
  if (mixinModName) {
    return { title: t(`Mod '${mixinModName}' mixin crashed`, `Миксин мода '${mixinModName}' вызвал краш`), hint: t(`Remove or update '${mixinModName}', or test without Sinytra Connector.`, `Удалите или обновите мод '${mixinModName}' либо проверьте без Sinytra Connector.`) };
  }
  const incompatible = { title: t("Incompatible mods", "Несовместимость модов"), hint: t("Remove recently added mods, or match the loader and game version.", "Удалите недавно добавленные моды либо приведите загрузчик и версию игры в соответствие.") };
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-40);
  if (lower.includes("mod resolution failed") || lower.includes("incompatible mods found") || lower.includes("formattedexception")) {
    const installs = [...text.matchAll(/Install ([A-Za-z0-9_'.()+ -]+?), (?:version ([\w.*+-]+) or later|any (?:([\w.*+-]+) )?version)/gi)]
      .map((m) => {
        const raw = m[1].trim();
        const paren = raw.match(/\(([a-z0-9_\-.+]+)\)$/i);
        return { name: (paren ? paren[1] : raw).replace(/^'+|'+$/g, ""), minVersion: m[2] ?? "", anyVersion: m[3] ?? "" };
      })
      .filter((i) => !runtimeDeps.has(i.name.toLowerCase()));
    const api = installs.find((i) => i.name.toLowerCase().includes("fabric-api")) ?? installs[0];
    if (api) {
      return {
        title: t(`Missing ${api.name}`, `Отсутствует ${api.name}`),
        hint: api.minVersion
          ? t(`Install ${api.name} ${api.minVersion} or newer on the Content tab.`, `Установите ${api.name} версии ${api.minVersion} или новее во вкладке контента.`)
          : api.anyVersion
            ? t(`Install ${api.name} (${api.anyVersion}) on the Content tab.`, `Установите ${api.name} (${api.anyVersion}) во вкладке контента.`)
            : t(`Install ${api.name} on the Content tab.`, `Установите ${api.name} во вкладке контента.`),
        missingMod: api.name
      };
    }
    const javaNeed = text.match(/requires version (\d+) or later of[^\r\n]*?java/i);
    const javaHave = text.match(/but only the wrong version is present:\s*(\d+)/i);
    if (javaNeed) {
      return {
        title: t(`Java ${javaNeed[1]} required`, `Требуется Java ${javaNeed[1]}`),
        hint: javaHave
          ? t(`Java ${javaHave[1]} is in use now. Install Java ${javaNeed[1]} in launcher settings.`, `Сейчас используется Java ${javaHave[1]}. Установите Java ${javaNeed[1]} в настройках лаунчера.`)
          : t(`Install Java ${javaNeed[1]} in launcher settings.`, `Установите Java ${javaNeed[1]} в настройках лаунчера.`)
      };
    }
    return incompatible;
  }
  if (lower.includes("mixin apply failed")) {
    return { title: t("Mixin error", "Ошибка миксина"), hint: t("A mod tried to patch the game and failed. Remove recently added mods.", "Мод попытался изменить игру и не смог. Удалите недавно добавленные моды.") };
  }
  const optifineLoaded = /(?:optifine[_-]|optifine\s+hd[_\s]u|net\.optifine|\boptifine\.jar\b|\[\s*optifine\s*\])/i.test(lower);
  const sodiumLoaded = /(?:me\.jellysquid\.mods\.sodium|net\.caffeinemc\.mods\.sodium|\bsodium(?:-[0-9]| extras| extra|\.jar)\b|\[\s*sodium\s*\])/i.test(lower);
  if (optifineLoaded && sodiumLoaded) {
    return { title: t("OptiFine vs Sodium", "OptiFine против Sodium"), hint: t("Use either OptiFine, or Sodium with Iris, not both.", "Используйте либо OptiFine, либо Sodium с Iris, но не вместе.") };
  }
  const benign = (l: string): boolean => l.includes("reference map") || l.includes("error loading class") || l.includes("force-disabling mixin") || l.includes("workaround") || l.includes("pdh counter") || l.includes("invalid query") || l.includes("disabling further attempts");
  for (const line of lines) {
    const l = line.toLowerCase();
    if (benign(l)) continue;
    if (l.includes("mod resolution") || l.includes("missing mods") || l.includes("incompatible mods") || l.includes("requires mod") || l.includes("mixin apply failed") || l.includes("failed to launch")) {
      return incompatible;
    }
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const l = line.toLowerCase();
    if (benign(l)) continue;
    if (l.includes("exception in thread") || l.includes("caused by:") || l.includes("a fatal error") || l.includes("crash report") || l.includes("process crashed") || (l.includes("exit code") && !l.includes("exit code 0"))) {
      return { title: t("Crashed", "Краш"), hint: line.trim().slice(0, 180), generic: true };
    }
  }
  return null;
}
