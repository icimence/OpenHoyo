import { api, type DailyNoteData, type UserDto } from "./api";
import { fetchWithVerification } from "./verify";

const cache = new Map<string, DailyNoteData>();
const pending = new Map<string, Promise<DailyNoteData>>();
const key = (userId: number, uid: string) => `${userId}:${uid}`;
export const DAILY_NOTE_TTL = 8 * 60 * 1000;
export function cachedDailyNote(userId: number, uid: string): DailyNoteData | undefined {
  return cache.get(key(userId, uid));
}
export function loadDailyNote(user: UserDto, uid: string, interactive: boolean): Promise<DailyNoteData> {
  const id = key(user.id, uid);
  const existing = pending.get(id);
  if (existing) return existing;
  const task = (interactive ? fetchWithVerification(user.id, ch => api.dailyNote(user.id, uid, ch)) : api.dailyNote(user.id, uid))
    .then(data => { cache.set(id, data); return data; }).finally(() => { pending.delete(id); });
  pending.set(id, task);
  return task;
}
