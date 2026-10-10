/*
 * The locale registry: the one place a language is declared. Everything else —
 * the Settings picker, system-language detection, the `t()` locale type, and the
 * copy checks in tests/unit/i18n.spec.ts — derives from this list.
 */
import { en, type Messages } from "./messages/en";
import { zhCN } from "./messages/zh-CN";

export type { MessageKey, Messages } from "./messages/en";

export interface LocaleDefinition {
  /** BCP 47 tag; also the value persisted as the user's locale preference. */
  readonly id: string;
  /** Shown in Settings, written in the language itself ("简体中文", not "Chinese"). */
  readonly label: string;
  /** Copy for this locale. Keys may be missing while a translation is in progress. */
  readonly messages: Partial<Messages>;
  /** Whether an OS language tag should select this locale, e.g. "zh-Hans-CN". */
  readonly matchesSystemTag: (languageTag: string) => boolean;
  /**
   * Marks a translation that is still being filled in. Only used by checks: a
   * partial locale renders the missing strings from `defaultLocale` instead.
   */
  readonly partial?: boolean;
}

/** Locale used for every fallback, and the one the key type is authored against. */
export const defaultLocale = "en" as const;

/**
 * To add a language:
 *   1. Copy `messages/en.ts` to `messages/<tag>.ts`, translate the values, keep the keys.
 *   2. Import it below and add one entry here.
 * Nothing else needs to change; missing keys fall back to `defaultLocale`.
 */
export const LOCALES = [
  {
    id: "en",
    label: "English",
    messages: en,
    matchesSystemTag: (languageTag) => languageTag.startsWith("en"),
  },
  {
    id: "zh-CN",
    label: "简体中文",
    messages: zhCN,
    matchesSystemTag: (languageTag) => languageTag.startsWith("zh"),
  },
] as const satisfies readonly LocaleDefinition[];

export type AppLocale = (typeof LOCALES)[number]["id"];

export const appLocaleIds: readonly AppLocale[] = LOCALES.map((locale) => locale.id);

export function localeDefinition(locale: AppLocale): LocaleDefinition {
  return LOCALES.find((definition) => definition.id === locale) ?? LOCALES[0];
}

/** The first registered locale whose system-tag matcher accepts `languageTag`. */
export function matchSystemLocale(languageTag: string): AppLocale | undefined {
  const normalized = languageTag.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return LOCALES.find((locale) => locale.matchesSystemTag(normalized))?.id;
}
