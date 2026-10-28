import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { api, errText, type DailyNoteData, type UserDto } from "./api";
import { escapeHtml as esc } from "./html";
import { isMobile, openNotificationSettings } from "./platform";
import { currentRoleOf } from "./role";
import { bindSelect, selectTrigger } from "./select";
import { closeDialog, onDialogCancel, onDialogOk, openDialog, toast } from "./ui";
import { fetchWithVerification } from "./verify";

interface Threshold { value: number; enabled: boolean }
interface ResourceRule { enabled: boolean; thresholds: Threshold[] }
interface ReminderSettings { resin: ResourceRule; home_coin: ResourceRule; expeditions: boolean }
interface ReminderJob { id: number; kind: string; value: number; due_at_ms: number; delivered: boolean }
interface ReminderStatus { settings: ReminderSettings; snapshot: DailyNoteData | null; jobs: ReminderJob[]; error: string | null }
type Resource = "resin" | "home_coin";
const names = { resin: "原粹树脂", home_coin: "洞天宝钱" };
const BELL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4M10 2h4"/></svg>`;
const CHEVRON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg>`;
function toggle(label: string, checked: boolean, action: string, value?: number): string {
  return `<button type="button" class="rm-switch" role="switch" aria-label="${esc(label)}" aria-checked="${checked}" data-action="${action}" ${value === undefined ? "" : `data-value="${value}"`}><span></span></button>`;
}
function timeText(ms: number): string {
  const d = new Date(ms);
  const day = d.toDateString() === new Date().toDateString() ? "今天" : `${d.getMonth()+1}月${d.getDate()}日`;
  return `${day} ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}
async function permit(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) granted = await requestPermission() === "granted";
  console.info(`[reminder] 通知权限：${granted ? "已允许" : "未允许"}`);
  if (!granted) toast("未获得通知权限，请在系统设置中允许通知", "error");
  return granted;
}

/** 返回系统设置后重新核对权限、恢复手机端的未来提醒。只注册一次。 */
export function initReminderLifecycle(): void {
  window.addEventListener("hoyo-resume", () => {
    void invoke("reminder_resume").then(() => {
      document.getElementById("reminder-settings")?.dispatchEvent(new Event("reminder-resume"));
    }).catch(e => console.warn(`[reminder] 恢复提醒失败：${errText(e)}`));
  });
}

export async function renderReminderSettings(root: HTMLElement, user: UserDto | undefined): Promise<void> {
  const roles = user?.game_roles.filter(r => r.game_biz.startsWith("hk4e")) ?? [];
  if (!user || !roles.length) {
    root.innerHTML = `<div class="rm-empty">${BELL}<h3>为你的角色设置提醒</h3><p>登录并绑定原神角色后，即可设置树脂、洞天宝钱和派遣提醒。</p></div>`;
    return;
  }
  const account = user;
  let uid = currentRoleOf(user)?.game_uid ?? roles[0].game_uid;
  if (!roles.some(r=>r.game_uid===uid)) uid=roles[0].game_uid;
  let status: ReminderStatus | undefined;
  let permission = false;
  let busy = false;
  let request = 0;
  const maxValue = (kind: Resource): number => kind === "resin" ? status?.snapshot?.max_resin || 200 : status?.snapshot?.max_home_coin || 2400;
  const options = roles.map(r=>({value:r.game_uid,label:`${r.nickname} · ${r.game_uid}`}));

  function render(): void {
    if (!root.isConnected || !status) return;
    const focused=document.activeElement as HTMLElement | null;
    const focusAction=root.contains(focused) ? focused?.dataset.action : undefined;
    const focusValue=focused?.dataset.value;
    const s=status.settings, n=status.snapshot;
    const next=status.jobs.filter(j=>!j.delivered && j.due_at_ms>Date.now()).sort((a,b)=>a.due_at_ms-b.due_at_ms)[0];
    const summary = next ? `下一次 · ${timeText(next.due_at_ms)}，${next.kind === "expeditions" ? "全部派遣完成" : `${names[next.kind as Resource]}达到 ${next.value}`}` : "开启提醒后，只通知接下来达到的节点";
    root.innerHTML=`
      <div class="rm-heading"><div><h3>资源提醒</h3><p>每个节点独立开关，修改后自动保存。</p></div>${BELL}</div>
      <div class="rm-system ${permission ? "allowed" : ""}"><div class="rm-system-copy"><strong>${permission ? "系统通知已就绪" : "允许系统通知"}</strong><span>${permission ? (isMobile() ? "提醒会出现在手机通知栏" : "应用运行时，提醒会出现在通知中心") : "开启后才能收到资源恢复提醒"}</span></div><button type="button" id="rm-permission">${permission ? "测试通知" : "开启通知"}</button></div>
      <div class="rm-role"><div><label id="rm-role-label" for="rm-role-select">当前角色</label>${selectTrigger("rm-role-select",options,uid)}</div><button type="button" class="rm-sync" id="rm-sync" aria-label="同步当前角色数据"><svg><use href="#i-refresh"/></svg>同步</button></div>
      <div class="rm-overview"><span>${n ? `数据更新于 ${timeText(n.fetched_at_ms)}` : "尚未同步角色数据"}</span><p>${esc(summary)}</p></div>
      ${status.error ? `<div class="rm-warning" role="status">${esc(status.error)}</div>` : ""}
      ${(["resin","home_coin"] as const).map(kind=>resourceHtml(kind,s[kind])).join("")}
      <section class="rm-group" aria-labelledby="rm-exp-title"><div class="rm-group-head"><div class="rm-resource-icon expedition"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5 5-3Z"/></svg></div><div class="rm-group-title"><h4 id="rm-exp-title">探索派遣</h4><p>全部完成时提醒一次</p></div>${toggle("探索派遣全部完成提醒",s.expeditions,"expeditions")}</div></section>
      <div class="rm-footnote"><p>${isMobile() ? "提醒会按最近同步的数据提前安排。系统省电限制可能使提醒延迟。" : "最小化或切换页面后仍会提醒；关闭应用后停止提醒。"}</p><p>应用运行时每 8 分钟同步一次。游戏内消耗资源、领取宝钱或重新派遣后，记得回来同步，更新预计时间。</p>${isMobile() ? '<button type="button" class="rm-system-link" id="rm-system-settings">在系统设置中管理通知</button>' : ""}</div>`;
    root.setAttribute("aria-busy",String(busy)); root.classList.toggle("rm-busy",busy);
    bindSelect(root.querySelector<HTMLButtonElement>("#rm-role-select")!,options,uid,value=>{
      if (busy) return; uid=value; status=undefined; void load();
    });
    root.querySelector("#rm-sync")?.addEventListener("click",()=>void sync());
    root.querySelector("#rm-permission")?.addEventListener("click",()=>void test());
    root.querySelector("#rm-system-settings")?.addEventListener("click",openNotificationSettings);
    if (focusAction) [...root.querySelectorAll<HTMLButtonElement>("[data-action]")].find(b=>b.dataset.action===focusAction && b.dataset.value===focusValue)?.focus({preventScroll:true});
  }
  function resourceHtml(kind: Resource, rule: ResourceRule): string {
    const n=status?.snapshot;
    const current = kind==="resin" ? n?.current_resin : n?.current_home_coin;
    const unavailable = kind==="home_coin" && n?.max_home_coin===0;
    return `<section class="rm-group ${rule.enabled ? "" : "is-off"}" data-resource="${kind}" aria-labelledby="rm-${kind}-title">
      <div class="rm-group-head"><div class="rm-resource-icon"><img src="/icons/ui/UI_ItemIcon_${kind==="resin" ? "106" : "204"}.png" alt=""/></div><div class="rm-group-title"><h4 id="rm-${kind}-title">${names[kind]}</h4><p>${unavailable ? "尚未解锁尘歌壶" : current === undefined ? `可设置 1～${maxValue(kind)}` : `上次同步 ${current} / ${maxValue(kind)}`}</p></div>${toggle(`${names[kind]}提醒`,rule.enabled,`${kind}-category`)}</div>
      <div class="rm-nodes">${rule.thresholds.length ? rule.thresholds.map(node=>{
        const job=status?.jobs.find(j=>j.kind===kind && j.value===node.value && !j.delivered && j.due_at_ms>Date.now());
        const label = node.value>maxValue(kind) ? "超出当前上限，请编辑数值" : !node.enabled ? "此节点已暂停" : !rule.enabled ? "开启本类提醒后生效" : unavailable ? "解锁尘歌壶后生效" : job ? `预计 ${timeText(job.due_at_ms)}` : current!==undefined && current>=node.value ? "已达到，下次恢复时提醒" : "同步数据后安排提醒";
        return `<div class="rm-node"><button type="button" class="rm-node-edit" data-action="${kind}-edit" data-value="${node.value}" aria-label="编辑${names[kind]} ${node.value} 提醒"><span><strong>${node.value}<small>${node.value===maxValue(kind) ? "满额" : "达到时提醒"}</small></strong><span>${esc(label)}</span></span>${CHEVRON}</button>${toggle(`${names[kind]} ${node.value} 提醒`,node.enabled,`${kind}-node`,node.value)}</div>`;
      }).join("") : '<p class="rm-no-nodes">还没有提醒节点，添加一个试试。</p>'}</div>
      <button type="button" class="rm-add" data-action="${kind}-add" ${rule.thresholds.length>=12 ? "disabled" : ""}><span aria-hidden="true">＋</span>${rule.thresholds.length>=12 ? "已添加 12 个提醒节点" : "添加提醒节点"}</button></section>`;
  }
  function working(on: boolean): void {
    busy=on; root.classList.toggle("rm-busy",on); root.setAttribute("aria-busy",String(on));
    root.querySelectorAll<HTMLButtonElement>("#rm-sync, #rm-permission, #rm-role-select").forEach(b=>b.disabled=on);
  }
  async function load(): Promise<void> {
    const serial=++request, selected=uid;
    root.innerHTML='<div class="rm-loading" role="status">正在读取提醒设置…</div>';
    try {
      const [data,granted]=await Promise.all([invoke<ReminderStatus>("reminder_status",{userId:account.id,gameUid:selected}),isPermissionGranted()]);
      if (!root.isConnected || serial!==request) return;
      status=data; permission=granted; render();
    } catch(e) {
      if (!root.isConnected || serial!==request) return;
      console.warn(`[reminder] 读取设置失败：${errText(e)}`);
      root.innerHTML=`<div class="rm-empty"><h3>暂时无法读取提醒设置</h3><p>${esc(errText(e))}</p><button id="rm-retry">重试</button></div>`;
      root.querySelector("#rm-retry")?.addEventListener("click",()=>void load());
    }
  }
  async function persist(next: ReminderSettings, enabling=false): Promise<boolean> {
    if (busy) return false;
    working(true);
    try {
      if (enabling) {
        permission=await permit(); if (!permission) { render(); return false; }
        if (!status?.snapshot || Date.now()-status.snapshot.fetched_at_ms>8*60*1000) {
          await fetchWithVerification(account.id,ch=>api.dailyNote(account.id,uid,ch));
        }
      }
      status=await invoke<ReminderStatus>("reminder_save",{userId:account.id,gameUid:uid,settings:next});
      console.info(`[reminder] 已保存角色 ${uid} 的提醒设置`);
      render(); return true;
    } catch(e) { console.warn(`[reminder] 保存设置失败：${errText(e)}`); toast(`保存失败：${errText(e)}`,"error"); render(); return false; }
    finally { working(false); }
  }
  async function sync(): Promise<void> {
    if (busy) return; working(true);
    try {
      await fetchWithVerification(account.id,ch=>api.dailyNote(account.id,uid,ch));
      status=await invoke<ReminderStatus>("reminder_status",{userId:account.id,gameUid:uid});
      render(); toast("数据与提醒时间已更新","success");
    } catch(e) { toast(`同步失败：${errText(e)}`,"error"); }
    finally { working(false); }
  }
  async function test(): Promise<void> {
    if (busy) return; working(true);
    try {
      permission=await permit();
      if (permission) { await invoke("reminder_resume"); await invoke("reminder_test"); toast("已发送测试通知，请查看系统通知栏","success"); }
      render();
    } catch(e) { toast(`通知发送失败：${errText(e)}`,"error"); }
    finally { working(false); }
  }
  function edit(kind: Resource, original?: number): void {
    if (!status || busy) return;
    const rule=status.settings[kind], max=maxValue(kind);
    const presets=(kind==="resin" ? [80,100,160,180,max] : [1200,1800,2000,max]).filter((n,i,a)=>n<=max && a.indexOf(n)===i);
    const suggested=presets.find(n=>!rule.thresholds.some(t=>t.value===n)) ?? 1;
    let focusNode=original;
    const returnFocus=():void=>root.querySelector<HTMLButtonElement>(`[data-action="${kind}-${focusNode===undefined ? "add" : "edit"}"]${focusNode===undefined ? "" : `[data-value="${focusNode}"]`}`)?.focus({preventScroll:true});
    const close=():void=>{closeDialog();returnFocus();};
    openDialog(original===undefined ? `添加${names[kind]}提醒` : `编辑${names[kind]}提醒`,`
      <p class="rm-editor-description">${names[kind]}预计达到这个数值时，发送一条系统通知。</p>
      <form id="rm-node-form" novalidate><label for="rm-node-value">提醒数值</label><div class="rm-value-field"><input id="rm-node-value" type="text" inputmode="numeric" autocomplete="off" maxlength="6" value="${original??suggested}" aria-describedby="rm-node-hint rm-node-error"/><span>/ ${max}</span></div><p id="rm-node-hint">输入 1～${max} 之间的整数</p><p id="rm-node-error" role="alert"></p></form>
      <div class="rm-presets" aria-label="常用提醒数值">${presets.map(n=>`<button type="button" data-preset="${n}">${n}${n===max ? " · 满额" : ""}</button>`).join("")}</div>
      ${original===undefined ? "" : '<button type="button" class="rm-delete" id="rm-node-delete">删除这个提醒节点</button>'}`,"保存",{lightDismiss:true});
    const dialog=document.getElementById("dialog")!; dialog.classList.add("reminder-node-dialog");
    const input=document.getElementById("rm-node-value") as HTMLInputElement;
    const error=document.getElementById("rm-node-error")!;
    input.addEventListener("input",()=>{error.textContent="";input.removeAttribute("aria-invalid");});
    dialog.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach(b=>b.addEventListener("click",()=>{input.value=b.dataset.preset!;error.textContent="";input.removeAttribute("aria-invalid");}));
    let saving=false;
    const submit=async ():Promise<void>=>{
      if (saving || !status) return;
      const raw=input.value.trim(), value=Number(raw);
      const message=!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value<1 || value>max ? `请输入 1～${max} 之间的整数` : rule.thresholds.some(t=>t.value===value && t.value!==original) ? `已经有 ${value} 的提醒，请换一个数值` : "";
      if (message) {error.textContent=message;input.setAttribute("aria-invalid","true");input.focus();return;}
      const next=structuredClone(status.settings);
      const enabled=rule.thresholds.find(t=>t.value===original)?.enabled ?? true;
      next[kind].thresholds=next[kind].thresholds.filter(t=>t.value!==original);
      next[kind].thresholds.push({value,enabled});
      saving=true; dialog.querySelectorAll<HTMLButtonElement>("button").forEach(b=>b.disabled=true);
      if (await persist(next,rule.enabled && enabled)) { if(original!==undefined)focusNode=value;close(); }
      else {saving=false;dialog.querySelectorAll<HTMLButtonElement>("button").forEach(b=>b.disabled=false);}
    };
    onDialogOk(submit); onDialogCancel(close);
    document.getElementById("rm-node-form")?.addEventListener("submit",e=>{e.preventDefault();void submit();});
    document.getElementById("rm-node-delete")?.addEventListener("click",()=>void (async()=>{
      if (saving || !status) return;
      saving=true;
      const next=structuredClone(status.settings);next[kind].thresholds=next[kind].thresholds.filter(t=>t.value!==original);
      if(await persist(next)) {focusNode=undefined;close();} else saving=false;
    })());
    // 弹层内循环焦点，安卓返回键/遮罩/Esc 统一走取消。
    dialog.addEventListener("keydown",e=>{
      if(e.key!=="Tab")return;
      const focusable=[...dialog.querySelectorAll<HTMLElement>('input,button:not(:disabled)')];
      if(e.shiftKey && document.activeElement===focusable[0]){e.preventDefault();focusable.at(-1)?.focus();}
      else if(!e.shiftKey && document.activeElement===focusable.at(-1)){e.preventDefault();focusable[0]?.focus();}
    });
    if (isMobile()) document.getElementById("dialog-ok")?.focus();
    else { input.focus(); input.select(); }
  }
  root.addEventListener("click",event=>{
    const button=(event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
    if(!button || !status || busy)return;
    const action=button.dataset.action!,value=Number(button.dataset.value),next=structuredClone(status.settings);
    if(action==="expeditions") {next.expeditions=!next.expeditions;void persist(next,next.expeditions);return;}
    const kind:Resource=action.startsWith("resin-") ? "resin" : "home_coin";
    if(action.endsWith("-edit") || action.endsWith("-add")) {edit(kind,action.endsWith("-edit") ? value : undefined);return;}
    if(action.endsWith("-category")){next[kind].enabled=!next[kind].enabled;void persist(next,next[kind].enabled);}
    else if(action.endsWith("-node")){
      const node=next[kind].thresholds.find(t=>t.value===value);if(!node)return;node.enabled=!node.enabled;
      void persist(next,next[kind].enabled && node.enabled);
    }
  });
  root.addEventListener("reminder-resume",()=>{ if(!busy)void load(); });
  await load();
}
