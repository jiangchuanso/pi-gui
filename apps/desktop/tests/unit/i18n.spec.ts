import { expect, test } from "@playwright/test";
import { en } from "../../src/i18n/messages/en";
import { resolveLocale, type LocalePreference } from "../../src/i18n/locale";
import { catalogs, interpolate, translatorFor } from "../../src/i18n/translate";

const englishKeys = Object.keys(en).sort();

function placeholders(template: string): readonly string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

test("every locale covers exactly the English keys, with no empty copy", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    expect(Object.keys(catalog).sort(), locale).toEqual(englishKeys);
    for (const [key, value] of Object.entries(catalog)) {
      expect(value.trim(), `${locale} ${key}`).not.toBe("");
    }
  }
});

test("translations keep every placeholder the English source uses", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const [key, source] of Object.entries(en)) {
      expect(placeholders(catalog[key as keyof typeof en]), `${locale} ${key}`).toEqual(
        placeholders(source),
      );
    }
  }
});

test("interpolate substitutes known names and leaves unknown ones alone", () => {
  expect(interpolate("Search {title}", { title: "settings" })).toBe("Search settings");
  expect(interpolate("No matches for “{query}”", { query: "zz" })).toBe("No matches for “zz”");
  expect(interpolate("{a} {b}", { a: 1 })).toBe("1 {b}");
  expect(interpolate("no placeholders")).toBe("no placeholders");
});

test("a translator reads its own catalog", () => {
  expect(translatorFor("en")("topbar.newThread")).toBe("New thread");
  expect(translatorFor("zh-CN")("topbar.newThread")).toBe("新会话");
  expect(translatorFor("en")("secondarySurface.sectionsLabel", { title: "Settings" })).toBe(
    "Settings sections",
  );
});

test("resolveLocale follows the system language unless a locale is chosen", () => {
  const cases: readonly [LocalePreference, readonly string[], string][] = [
    ["system", ["zh-CN", "en-US"], "zh-CN"],
    ["system", ["zh-Hans-CN"], "zh-CN"],
    ["system", ["en-US", "zh-CN"], "en"],
    ["system", [], "en"],
    ["en", ["zh-CN"], "en"],
    ["zh-CN", ["en-US"], "zh-CN"],
  ];
  for (const [preference, systemLanguages, expected] of cases) {
    expect(resolveLocale(preference, systemLanguages), `${preference} ${systemLanguages}`).toBe(
      expected,
    );
  }
});
