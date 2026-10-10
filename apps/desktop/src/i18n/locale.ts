/*
 * Locale preference resolution for the renderer.
 *
 * Browser-safe: the renderer owns the preference (Settings can change it live) and
 * remembers it in this profile's localStorage, next to the other renderer-only
 * layout preferences. `system` follows the OS language on every launch.
 */

export const localePreferences = ["system", "en", "zh-CN"] as const;
export type LocalePreference = (typeof localePreferences)[number];

/** Locales the app ships translated copy for. */
export const appLocales = ["en", "zh-CN"] as const;
export type AppLocale = (typeof appLocales)[number];

export const LOCALE_STORAGE_KEY = "pi-gui:locale";

export function isLocalePreference(value: unknown): value is LocalePreference {
  return typeof value === "string" && (localePreferences as readonly string[]).includes(value);
}

/**
 * The language tags the OS reports, most preferred first. `navigator.languages`
 * is the full list; `navigator.language` is the fallback on older shells.
 */
export function detectSystemLanguages(): readonly string[] {
  const language = typeof navigator === "undefined" ? undefined : navigator.language;
  const languages = typeof navigator === "undefined" ? undefined : navigator.languages;
  if (languages && languages.length > 0) {
    return languages;
  }
  return language ? [language] : [];
}

/** Chinese variants (zh, zh-CN, zh-Hans, zh-TW…) all read our Simplified copy for now. */
export function resolveLocale(
  preference: LocalePreference,
  systemLanguages: readonly string[],
): AppLocale {
  if (preference !== "system") {
    return preference;
  }
  const firstMatch = systemLanguages.find((tag) => tag.trim().length > 0);
  if (!firstMatch) {
    return "en";
  }
  return firstMatch.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function readStoredLocale(): LocalePreference {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocalePreference(raw) ? raw : "system";
  } catch {
    // Reading preferences is best-effort; the system language still applies.
    return "system";
  }
}

export function writeStoredLocale(preference: LocalePreference): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, preference);
  } catch {
    // The choice stays live for this window even if it cannot be saved.
  }
}
