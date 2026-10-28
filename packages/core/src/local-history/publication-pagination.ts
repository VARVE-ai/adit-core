import { LocalStateError } from "../local-state.js";
export const PUBLICATION_PAGE_SIZE = 50;
export function publicationCursor(cursor?: string | null): { at: number; id: string } | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 300) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!Number.isSafeInteger(value.at) || typeof value.id !== "string" || !/^[\w-]{1,100}$/.test(value.id)) throw new Error();
    return value;
  } catch { throw new LocalStateError("Invalid list cursor"); }
}
export const nextPublicationCursor = (at: number, id: string) => Buffer.from(JSON.stringify({ at, id })).toString("base64url");
