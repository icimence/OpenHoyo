// 全局选中的游戏角色（localStorage 持久化；各页面统一从这里取当前角色）
import type { GameRoleDto, UserDto } from "./api";

export const ROLE_KEY = "hoyo-selected-role";

export function currentRoleOf(u: UserDto | undefined): GameRoleDto | undefined {
  if (!u || u.game_roles.length === 0) {
    return undefined;
  }
  const selected = localStorage.getItem(ROLE_KEY);
  return (
    u.game_roles.find((r) => r.game_uid === selected) ??
    u.game_roles.find((r) => r.game_biz.includes("hk4e_cn")) ??
    u.game_roles[0]
  );
}

export function selectRole(uid: string): void {
  localStorage.setItem(ROLE_KEY, uid);
}

export function selectedRoleUid(): string | null {
  return localStorage.getItem(ROLE_KEY);
}
