/*
 * Locale-independent translation core: catalogs plus a pure translator. Kept free
 * of React so non-component callers (and unit specs) can translate without a tree.
 */
import type { AppLocale } from "./locale";
import { en, type MessageKey } from "./messages/en";
import { zhCN } from "./messages/zh-CN";

export type { MessageKey } from "./messages/en";
export type { AppLocale, LocalePreference } from "./locale";

/** Values substituted into `{name}` placeholders in a message. */
export type TranslateParams = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, params?: TranslateParams) => string;

export const catalogs: Readonly<Record<AppLocale, Readonly<Record<MessageKey, string>>>> = {
  en,
  "zh-CN": zhCN,
};

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

/** A translator bound to one locale. */
export function translatorFor(locale: AppLocale): Translate {
  const catalog = catalogs[locale];
  return (key, params) => interpolate(catalog[key], params);
}

/** The English translator, the default wherever no locale is known. */
export const translate: Translate = translatorFor("en");
