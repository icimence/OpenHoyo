// 极验 GT3 滑块（米哈游 App 通道风控，对应原版 GeetestWebView2ContentProvider）。
// gt.js 在 window 上暴露全局 initGeetest；bind 模式下 verify() 弹出官方滑块浮层。

interface GeetestCaptcha {
  onReady(cb: () => void): void;
  onSuccess(cb: () => void): void;
  onError(cb: (e: unknown) => void): void;
  onClose(cb: () => void): void;
  verify(): void;
  getValidate(): GeetestValidate | undefined;
  destroy(): void;
}

export interface GeetestValidate {
  geetest_challenge: string;
  geetest_validate: string;
  geetest_seccode: string;
}

declare global {
  interface Window {
    initGeetest?: (options: Record<string, unknown>, callback: (captcha: GeetestCaptcha) => void) => void;
  }
}

let gtLoading: Promise<void> | null = null;

/** 动态加载极验 SDK（单例；CSP 为 null 不拦截外域脚本） */
function loadGtScript(): Promise<void> {
  if (window.initGeetest) {
    return Promise.resolve();
  }
  gtLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://static.geetest.com/static/js/gt.0.5.2.js";
    s.onload = () => resolve();
    s.onerror = () => {
      gtLoading = null;
      reject(new Error("极验脚本加载失败，请检查网络"));
    };
    document.head.appendChild(s);
  });
  return gtLoading;
}

/**
 * 弹出极验滑块并等待用户完成验证。
 * 用户关闭滑块（onClose，且尚未成功）时 reject，由调用方决定重试或放弃。
 */
export async function geetestVerify(gt: string, challenge: string): Promise<GeetestValidate> {
  await loadGtScript();
  return new Promise<GeetestValidate>((resolve, reject) => {
    let settled = false;
    let captchaObj: GeetestCaptcha | null = null;
    // bind 模式需要一个挂载点（浮层由 SDK fixed 定位渲染，不依赖该容器位置）
    const holder = document.createElement("div");
    document.body.appendChild(holder);
    const cleanup = (): void => {
      try {
        captchaObj?.destroy();
      } catch {
        /* destroy 在部分版本不可用 */
      }
      holder.remove();
    };

    window.initGeetest!(
      {
        protocol: "https://",
        gt,
        challenge,
        new_captcha: true,
        product: "bind",
        api_server: "api.geetest.com",
      },
      (obj) => {
        captchaObj = obj;
        obj.onReady(() => obj.verify());
        obj.onSuccess(() => {
          const validate = obj.getValidate();
          settled = true;
          cleanup();
          if (validate) {
            resolve(validate);
          } else {
            reject(new Error("极验校验结果为空，请重试"));
          }
        });
        obj.onError((e) => {
          settled = true;
          cleanup();
          reject(new Error(`极验验证失败: ${JSON.stringify(e)}`));
        });
        obj.onClose(() => {
          // 用户手动关闭滑块
          window.setTimeout(() => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(new Error("已取消人机验证"));
            }
          }, 300);
        });
      },
    );
  });
}
