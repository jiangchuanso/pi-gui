import { expect, test } from "@playwright/test";
import {
  LOCALES,
  appLocaleIds,
  defaultLocale,
  localeDefinition,
  matchSystemLocale,
  type AppLocale,
  type LocaleDefinition,
  type MessageKey,
} from "../../src/i18n/catalog";
import { localePreferences, resolveLocale, type LocalePreference } from "../../src/i18n/preference";
import { catalogs, interpolate, resolveMessage, translatorFor } from "../../src/i18n/translate";
import { en } from "../../src/i18n/messages/en";

const englishKeys = Object.keys(en).sort() as readonly MessageKey[];
const localeIds = LOCALES.map((locale) => locale.id);

function placeholders(template: string): readonly string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

function isPartial(locale: { readonly id: string }): boolean {
  return (locale as LocaleDefinition).partial === true;
}

test("the locale registry is well formed and covers its own preferences", () => {
  expect(LOCALES.length).toBeGreaterThan(0);
  // The first entry is the locale everything falls back to.
  expect(LOCALES[0].id).toBe(defaultLocale);
  expect(new Set(localeIds).size, "locale ids are unique").toBe(LOCALES.length);
  // "system" is the only preference that is not a locale.
  expect([...localePreferences]).toEqual(["system", ...appLocaleIds]);

  for (const locale of LOCALES) {
    const reason = `locale ${locale.id}`;
    expect(locale.label.trim(), `${reason} label`).not.toBe("");
    // BCP 47-ish: a primary subtag, then optional subtags ("zh-CN", "pt-BR").
    expect(locale.id, `${reason} looks like a language tag`).toMatch(
      /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
    );
    expect(localeDefinition(locale.id as AppLocale).id, reason).toBe(locale.id);
    expect(Object.keys(catalogs), `${reason} has a catalog`).toContain(locale.id);
  }
});

test("every shipped locale translates every key, with no stale extras", () => {
  for (const locale of LOCALES) {
    const keys = Object.keys(catalogs[locale.id]).sort();
    const reason = `locale ${locale.id}`;
    if (isPartial(locale)) {
      expect(englishKeys, `${reason} defines an unknown key`).toEqual(
        expect.arrayContaining(keys),
      );
    } else {
      // The failure message is the checklist of what is left to translate.
      expect(keys, `${reason} is missing keys`).toEqual(englishKeys);
    }
    for (const key of keys) {
      const copy = catalogs[locale.id][key as MessageKey] ?? "";
      expect(copy.trim(), `${reason} ${key}`).not.toBe("");
    }
  }
});

test("translations keep every placeholder the English source uses", () => {
  for (const locale of LOCALES) {
    for (const [key, source] of Object.entries(en)) {
      const translated = catalogs[locale.id][key as MessageKey];
      if (translated === undefined) continue;
      expect(placeholders(translated), `locale ${locale.id} ${key}`).toEqual(placeholders(source));
    }
  }
});

test("interpolate substitutes known names and leaves unknown ones alone", () => {
  expect(interpolate("Search {title}", { title: "settings" })).toBe("Search settings");
  expect(interpolate("{a} {b}", { a: 1 })).toBe("1 {b}");
  expect(interpolate("no placeholders")).toBe("no placeholders");
  const quoted = interpolate("No matches for “{query}”", { query: "zz" });
  expect(quoted).toBe("No matches for “zz”");
});

test("a translator reads its own catalog, and falls back to the default locale", () => {
  expect(translatorFor("en")("topbar.newThread")).toBe("New thread");
  expect(translatorFor("zh-CN")("topbar.newThread")).toBe("新会话");
  const sections = translatorFor("en")("secondarySurface.sectionsLabel", { title: "Settings" });
  expect(sections).toBe("Settings sections");
  // A half-translated catalog renders the default locale's copy instead of `undefined`…
  expect(resolveMessage({}, "topbar.newThread")).toBe("New thread");
  // …and an unknown key falls back to the key itself, never to `undefined`.
  expect(resolveMessage({}, "totally.unknown" as MessageKey)).toBe("totally.unknown");
});

test("resolveLocale follows the system language unless a locale is chosen", () => {
  const cases: readonly (readonly [LocalePreference, readonly string[], AppLocale])[] = [
    ["system", ["zh-CN", "en-US"], "zh-CN"],
    ["system", ["zh-Hans-CN"], "zh-CN"],
    ["system", ["en-US", "zh-CN"], "en"],
    ["system", [], "en"],
    // A language we do not ship reads the default locale.
    ["system", ["fr-FR"], "en"],
    ["en", ["zh-CN"], "en"],
    ["zh-CN", ["en-US"], "zh-CN"],
  ];
  for (const [preference, systemLanguages, expected] of cases) {
    const reason = `${preference} ${systemLanguages}`;
    expect(resolveLocale(preference, systemLanguages), reason).toBe(expected);
  }
});

test("system-tag matching is registered per locale, not hardcoded", () => {
  expect(matchSystemLocale("ZH-hant")).toBe("zh-CN");
  expect(matchSystemLocale("  en-GB  ")).toBe("en");
  expect(matchSystemLocale("de-DE")).toBeUndefined();
  expect(matchSystemLocale("")).toBeUndefined();
});
