let language: "en" | "ru" = "en";

export function setMainLanguage(next: string | undefined): void {
  language = next === "ru" ? "ru" : "en";
}

export function tr(en: string, ru: string): string {
  return language === "ru" ? ru : en;
}
