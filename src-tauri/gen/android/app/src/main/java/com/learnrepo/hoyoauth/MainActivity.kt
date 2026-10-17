package com.learnrepo.hoyoauth

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

class MainActivity : TauriActivity() {
  /** 系统栏/刘海/输入法占用的边距（CSS px），供前端经 window.HoyoAndroid.insets() 读取 */
  @Volatile private var insetsJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onResume() {
    super.onResume()
    // 从「安装未知应用」设置页返回时让前端重新判断权限，继续安装流程
    webView?.evaluateJavascript("window.dispatchEvent(new Event('hoyo-resume'))", null)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
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

    /** 是否已获准安装应用内下载的更新包（「安装未知应用」权限） */
    @JavascriptInterface
    fun canInstallPackages(): Boolean = packageManager.canRequestPackageInstalls()

    /** 打开本应用的「安装未知应用」设置页 */
    @JavascriptInterface
    fun openInstallSettings() {
      runOnUiThread {
        startActivity(
          Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
        )
      }
    }

    /**
     * 拉起系统安装器安装更新包。只接受缓存目录 updates/ 下的文件
     * （由后端 android_update_download 写入），防止页面借此安装任意文件。
     */
    @JavascriptInterface
    fun installApk(path: String): Boolean {
      val updates = File(cacheDir, "updates").canonicalFile
      val apk = File(path).canonicalFile
      if (apk.parentFile != updates || !apk.isFile || !apk.name.endsWith(".apk")) {
        return false
      }
      val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", apk)
      runOnUiThread {
        startActivity(
          Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
      }
      return true
    }
  }
}
