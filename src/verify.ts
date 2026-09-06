// 风控安全验证共享模块（对应 GeetestService.TryVerifyXrpcChallengeAsync）：
// 请求命中 1034/5003 时自动走 createVerification → 页内极验点选 →
// verifyVerification 换 xrpc-challenge → 带挑战头重试原请求。
import { api, errText, isApiError } from "./api";
import { closeDialog, onDialogCancel, openDialog, toast } from "./ui";

/** 风控拦截错误码（KnownReturnCode: 实时便签 账号有风险 / 暂无数据） */
export function isRiskError(e: unknown): boolean {
  return isApiError(e) && (e.code === 1034 || e.code === 5003);
}

/** 放弃当前未完成的验证对话框（页面被重渲染时调用，避免悬挂的 Promise 卡死后续刷新） */
let abandonGeetest: (() => void) | null = null;
export function abandonActiveGeetest(): void {
  abandonGeetest?.();
  abandonGeetest = null;
}

/** gt.js 只加载一次；后续直接使用 window.initGeetest */
function ensureGtJs(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as unknown as { initGeetest?: unknown }).initGeetest) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://static.geetest.com/static/js/gt.0.5.2.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("gt.js 加载失败"));
    document.head.appendChild(script);
  });
}

interface GeetestObj {
  onReady: (cb: () => void) => void;
  onSuccess: (cb: () => void) => void;
  onError: (cb: () => void) => void;
  verify: () => void;
  getValidate: () => { geetest_challenge: string; geetest_validate: string } | undefined;
}

/**
 * 页内极验滑块（对应 GeetestWebView2ContentProvider 的 NavigateToString 页面）：
 * product=bind 模式 onReady 自动弹出，成功后 resolve getValidate() 结果。
 */
function runGeetest(gt: string, challenge: string): Promise<{ geetest_challenge: string; geetest_validate: string } | null> {
  return new Promise((resolve) => {
    openDialog("安全验证", '<div id="geetest-div"></div><p class="hint">请完成滑块验证以继续</p>', null);
    let settled = false;
    const finish = (v: { geetest_challenge: string; geetest_validate: string } | null): void => {
      if (!settled) {
        settled = true;
        if (abandonGeetest === finishAbandon) {
          abandonGeetest = null;
        }
        closeDialog();
        resolve(v);
      }
    };
    const finishAbandon = (): void => finish(null);
    abandonGeetest = finishAbandon;
    onDialogCancel(() => finish(null));

    void ensureGtJs()
      .then(() => {
        const init = (window as unknown as { initGeetest?: (opts: Record<string, unknown>, cb: (obj: GeetestObj) => void) => void }).initGeetest;
        if (!init) {
          finish(null);
          return;
        }
        init(
          {
            protocol: "https://",
            gt,
            challenge,
            new_captcha: true,
            product: "bind",
            api_server: "api.geetest.com",
          },
          (captchaObj) => {
            captchaObj.onReady(() => {
              captchaObj.verify();
            });
            captchaObj.onSuccess(() => {
              const validate = captchaObj.getValidate();
              if (validate) {
                finish({
                  geetest_challenge: validate.geetest_challenge,
                  geetest_validate: validate.geetest_validate,
                });
              }
            });
            captchaObj.onError(() => {
              toast("验证出错，请稍后重试", "error");
              finish(null);
            });
          },
        );
      })
      .catch(() => {
        toast("极验脚本加载失败，请检查网络", "error");
        finish(null);
      });
  });
}

/**
 * 带风控验证的请求：request 换成实际调用（challenge 参数透传给后端做挑战头重试）。
 * 命中风控 → 申请验证 → 弹滑块 → 换 xrpc-challenge → 重试。
 */
export async function fetchWithVerification<T>(userId: number, request: (challenge?: string) => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (e) {
    if (!isRiskError(e)) {
      throw e;
    }
    console.warn(`[verify] 请求被风控拦截（${errText(e)}），发起极验验证`);
    const verification = await api.cardCreateVerification(userId);
    const validated = await runGeetest(verification.gt, verification.challenge);
    if (!validated) {
      console.warn("[verify] 用户取消或验证未完成");
      throw e;
    }
    const xrpcChallenge = await api.cardVerifyVerification(
      userId,
      validated.geetest_challenge,
      validated.geetest_validate,
    );
    console.info("[verify] 拿到挑战头，携带重试原请求");
    return request(xrpcChallenge);
  }
}
