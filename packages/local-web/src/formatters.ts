import { getLanguage, locale, t } from "./i18n";

export const number = (n: number | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(n);

export function compact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (getLanguage() === "en")
    return new Intl.NumberFormat(locale(), {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  return n >= 1e8
    ? `${number(n / 1e8)} 亿`
    : n >= 1e4
      ? `${number(n / 1e4)} 万`
      : number(n);
}

export const duration = (n: number) =>
  n >= 3_600_000
    ? t(
        "{0} 小时 {1} 分",
        Math.floor(n / 3_600_000),
        Math.floor((n % 3_600_000) / 60_000),
      )
    : n > 0
      ? t("{0} 分", Math.max(1, Math.floor(n / 60_000)))
      : t("0 分");

export const month = (n: number) =>
  getLanguage() === "zh"
    ? `${n} 月`
    : new Intl.DateTimeFormat(locale(), {
        month: "short",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2000, n - 1, 1)));

export const day = (value: string) =>
  getLanguage() === "zh"
    ? `${Number(value.slice(5, 7))} 月 ${Number(value.slice(8, 10))} 日`
    : new Intl.DateTimeFormat(locale(), {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${value}T00:00:00Z`));

export const weekday = (index: number) =>
  new Intl.DateTimeFormat(locale(), {
    weekday: "narrow",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2024, 0, 1 + index)));

export const hour = (n: number) =>
  getLanguage() === "zh" ? `${n} 点` : `${n}:00`;
