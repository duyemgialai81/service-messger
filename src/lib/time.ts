import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";

export const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";

function parseVietnamLocalString(value: string) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/
  );
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", fraction = "0"] = match;
  const ms = Number(fraction.slice(0, 3).padEnd(3, "0"));
  return new Date(Date.UTC(
    Number(y), Number(mo) - 1, Number(d),
    Number(h) - 7, Number(mi), Number(s),
    Number.isFinite(ms) ? ms : 0,
  ));
}

export function parseAppDate(value: unknown) {
  if (!value) return new Date();
  if (Array.isArray(value)) {
    const [year, month = 1, day = 1, hour = 0, minute = 0, second = 0] = value.map(Number);
    return new Date(Date.UTC(year, month - 1, day, hour - 7, minute, second));
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date() : value;
  }
  const raw = String(value).trim();
  if (!raw) return new Date();
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const parsed = hasExplicitZone ? new Date(raw) : parseVietnamLocalString(raw);
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
}

export function formatVietnamTime(value: unknown) {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: VIETNAM_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(parseAppDate(value));
}

export function formatVietnamDateTime(value: unknown) {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: VIETNAM_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parseAppDate(value));
}

export function formatVietnamDistance(value: unknown, addSuffix = true) {
  return formatDistanceToNow(parseAppDate(value), { addSuffix, locale: vi });
}
