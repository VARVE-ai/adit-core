import { useSyncExternalStore } from "react";
import { messages, type MessageKey } from "./messages";
import { systemMessagePatterns } from "./system-messages";

export type Language = "en" | "zh";
const storageKey = "adit-language";
export function readLanguage(storage?: Pick<Storage, "getItem">): Language {
  try {
    return storage?.getItem(storageKey) === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}
function storedLanguage(): Language {
  try {
    return readLanguage(window.localStorage);
  } catch {
    return "en";
  }
}
let language: Language = storedLanguage();
const listeners = new Set<() => void>();
export const getLanguage = () => language;
export const locale = () => (language === "zh" ? "zh-CN" : "en-US");
export function setLanguage(next: Language) {
  language = next;
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    /* Storage may be disabled. */
  }
  syncDocumentLanguage();
  listeners.forEach((listener) => listener());
}
export function syncDocumentLanguage() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale();
  document.title = `ADIT · ${t("设置")}`;
}
export function useLanguage() {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getLanguage,
    () => "en" as Language,
  );
  return [value, setLanguage] as const;
}
export function translate(
  lang: Language,
  key: MessageKey,
  ...values: (string | number)[]
): string {
  const template = lang === "zh" ? key : messages[key];
  return template.replace(/\{(\d+)\}/g, (placeholder, i) =>
    values[Number(i)] === undefined ? placeholder : String(values[Number(i)]),
  );
}
export const t = (key: MessageKey, ...values: (string | number)[]) =>
  translate(language, key, ...values);

// Applied only to system messages, never to native user content.
export function systemMessage(value: string): string {
  if (Object.hasOwn(messages, value)) return t(value as MessageKey);
  return systemMessagePatterns.reduce((result, entry) => {
    const template = language === "zh" ? entry.zh : entry.en;
    const pattern = language === "zh" ? entry.enPattern : entry.zhPattern;
    return result.replace(pattern, (...match) =>
      template.replace(/\{(\d+)\}/g, (_, i) => String(match[Number(i) + 1])),
    );
  }, value);
}

if (typeof window !== "undefined") {
  syncDocumentLanguage();
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    language = event.newValue === "zh" ? "zh" : "en";
    syncDocumentLanguage();
    listeners.forEach((listener) => listener());
  });
}
