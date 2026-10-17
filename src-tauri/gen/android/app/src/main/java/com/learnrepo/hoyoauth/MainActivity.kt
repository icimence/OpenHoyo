package com.learnrepo.hoyoauth

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  /** 系统栏/刘海/输入法占用的边距（CSS px），供前端经 window.HoyoAndroid.insets() 读取 */
  @Volatile private var insetsJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // 旧版 WebView 在 edge-to-edge 下 env(safe-area-inset-*) 恒为 0：由原生读取 WindowInsets 交给前端
    webView.addJavascriptInterface(AndroidBridge(), "HoyoAndroid")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val density = view.resources.displayMetrics.density
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      fun dp(px: Int) = Math.round(px / density)
      insetsJson = "{\"top\":${dp(bars.top)},\"right\":${dp(bars.right)},\"bottom\":${dp(maxOf(bars.bottom, ime.bottom))},\"left\":${dp(bars.left)}}"
      view.post { (view as WebView).evaluateJavascript("window.dispatchEvent(new Event('hoyo-insets'))", null) }
      insets
    }
  }

  inner class AndroidBridge {
    @JavascriptInterface
    fun insets(): String = insetsJson

    /** 首页按返回键：退到后台（与系统应用行为一致，不杀进程） */
    @JavascriptInterface
    fun moveToBack() {
      runOnUiThread { moveTaskToBack(true) }
    }
  }
}
