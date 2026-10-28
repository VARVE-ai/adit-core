import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLanguage,
  readLanguage,
  setLanguage,
  systemMessage,
  t,
  translate,
} from "./i18n";
import { messages } from "./messages";
import { compact, day, duration, month, weekday } from "./formatters";

afterEach(() => {
  setLanguage("en");
  vi.unstubAllGlobals();
});

describe("local UI language", () => {
  it("defaults to English regardless of the OS language, including blocked storage", () => {
    expect(readLanguage()).toBe("en");
    expect(readLanguage({ getItem: () => null })).toBe("en");
    expect(readLanguage({ getItem: () => "invalid" })).toBe("en");
    expect(
      readLanguage({
        getItem: () => {
          throw Error("blocked");
        },
      }),
    ).toBe("en");
    expect(readLanguage({ getItem: () => "zh" })).toBe("zh");
  });

  it("persists the choice and translates without modifying interpolation values", () => {
    const storage = new Map<string, string>();
    const local = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    };
    vi.stubGlobal("localStorage", local);
    setLanguage("zh");
    expect(readLanguage(local)).toBe("zh");
    expect(t("开始整理")).toBe("开始整理");
    setLanguage("en");
    expect(getLanguage()).toBe("en");
    expect(readLanguage(local)).toBe("en");
    expect(t("开始整理")).toBe("Start organizing");
    const name = "账号中文 {1} $& <script>";
    expect(t("通过云端账号 {0} 存储", name)).toBe(
      `Stored through cloud account ${name}`,
    );
  });

  it("has English copy and matching interpolation slots for every message", () => {
    for (const [key, value] of Object.entries(messages)) {
      expect(value, key).not.toMatch(/\p{Script=Han}/u);
      expect(
        [...value.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort(),
        key,
      ).toEqual([...key.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort());
      expect(translate("zh", key as keyof typeof messages)).toBe(key);
    }
  });

  it("localizes numbers, dates, weekdays and durations", () => {
    expect(compact(12500)).toBe("12.5K");
    expect(compact(125000000)).toBe("125M");
    expect(day("2026-10-19")).toBe("Oct 19");
    expect(month(10)).toBe("Oct");
    expect(weekday(0)).toBe("M");
    expect(duration(3660000)).toBe("1 h 1 min");
    setLanguage("zh");
    expect(compact(12500)).toBe("1.3 万");
    expect(day("2026-10-19")).toBe("10 月 19 日");
    expect(month(10)).toBe("10 月");
    expect(weekday(0)).toBe("一");
    expect(duration(3660000)).toBe("1 小时 1 分");
  });

  it("translates stored service messages while retaining their paths and numbers", () => {
    const coverage =
      "缺少时间的写入记录 3 条；无法读取的备份 2 个。缺失部分不推断归属。";
    expect(systemMessage(coverage)).toBe(
      "3 write records have no timestamp; 2 backups could not be read. Missing evidence is not used to infer authorship.",
    );
    expect(
      systemMessage(
        "D:\\中文项目: 请先为该仓库配置 Git user.email，才能只整理自己的提交",
      ),
    ).toBe(
      "D:\\中文项目: Configure Git user.email for this repository to organize only your own commits",
    );
    setLanguage("zh");
    expect(systemMessage("Error: Unauthorized")).toBe(
      "Error: 未授权，请通过 adit serve 打开此页面。",
    );
    expect(
      systemMessage(
        "3 write records have no timestamp; 2 backups could not be read. Missing evidence is not used to infer authorship.",
      ),
    ).toBe(coverage);
    expect(systemMessage("ENOENT: D:\\中文项目")).toBe("ENOENT: D:\\中文项目");
  });
});
