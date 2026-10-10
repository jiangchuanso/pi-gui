/*
 * Locale-independent translation core: the registered catalogs plus a pure
 * translator. Kept free of React so non-component callers (and unit specs) can
 * translate without a tree.
 */
import { LOCALES, defaultLocale, type AppLocale, type MessageKey, type Messages } from "./catalog";

export type { AppLocale, LocaleDefinition, MessageKey, Messages } from "./catalog";

/** Values substituted into `{name}` placeholders in a message. */
export type TranslateParams = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, params?: TranslateParams) => string;

/** Every registered locale's copy, by id. */
export const catalogs: Readonly<Record<AppLocale, Partial<Messages>>> = Object.fromEntries(
  LOCALES.map((locale) => [locale.id, locale.messages]),
) as Readonly<Record<AppLocale, Partial<Messages>>>;

const fallbackMessages: Partial<Messages> = catalogs[defaultLocale];

/** Replaces `{name}` placeholders; unknown names are left untouched rather than dropped. */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * One message for a catalog, walking the fallback chain: the locale's own copy,
 * then `defaultLocale`, then the key itself (which makes a missing string obvious
 * in the UI instead of rendering `undefined`).
 */
export function resolveMessage(catalog: Partial<Messages>, key: MessageKey): string {
  return catalog[key] ?? fallbackMessages[key] ?? key;
}

/** A translator bound to one locale. */
export function translatorFor(locale: AppLocale): Translate {
  const catalog = catalogs[locale];
  return (key, params) => interpolate(resolveMessage(catalog, key), params);
}

/** The default locale's translator, used wherever no locale is known. */
export const translate: Translate = translatorFor(defaultLocale);
