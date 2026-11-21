package com.xiaoleng.tipsyisle

import android.os.Bundle
import android.webkit.WebView
import android.view.ViewGroup
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
    private var discoveryLock: android.net.wifi.WifiManager.MulticastLock? = null
    private var appWebView: WebView? = null
    private var fullscreenClient: FullscreenChromeClient? = null
    private var foreground = false
    private var needsForegroundFrame = false
    private val restoreForegroundFrame = Runnable {
        val webView = appWebView
        if (webView != null && foreground && hasWindowFocus() && needsForegroundFrame) {
            needsForegroundFrame = false
            // The activity's focus and IME insets can arrive after WebView.onResume().
            ViewCompat.requestApplyInsets(webView)
            webView.requestLayout()
            webView.postInvalidateOnAnimation()
        }
    }
    private fun scheduleForegroundFrame() {
        appWebView?.let { webView ->
            webView.removeCallbacks(restoreForegroundFrame)
            webView.postOnAnimation(restoreForegroundFrame)
        }
    }
    override fun onResume() {
        super.onResume()
        foreground = true
        if (needsForegroundFrame && hasWindowFocus()) scheduleForegroundFrame()
        val wifi = applicationContext.getSystemService(android.content.Context.WIFI_SERVICE) as android.net.wifi.WifiManager
        discoveryLock = wifi.createMulticastLock("tipsy-lan-discovery").apply { setReferenceCounted(false); acquire() }
    }
    override fun onPause() {
        foreground = false
        needsForegroundFrame = true
        appWebView?.removeCallbacks(restoreForegroundFrame)
        discoveryLock?.let { if (it.isHeld) it.release() }
        discoveryLock = null
        super.onPause()
    }
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && foreground && needsForegroundFrame) scheduleForegroundFrame()
    }
    override fun onDestroy() {
        fullscreenClient?.onHideCustomView()
        fullscreenClient = null
        appWebView?.removeCallbacks(restoreForegroundFrame)
        appWebView = null
        super.onDestroy()
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }
    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        appWebView = webView
        // Wry installs its ChromeClient immediately after onWebViewCreate returns.
        webView.post {
            if (appWebView === webView) webView.webChromeClient?.let { client ->
                FullscreenChromeClient(this, client).also { fullscreenClient = it; webView.webChromeClient = it }
            }
        }
        // Let WebView handle native text selection and the copy/paste action toolbar.
        webView.setOnLongClickListener(null)
        webView.isLongClickable = true
        // Resize the viewport around the IME and system bars instead of covering the composer.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val params = view.layoutParams as? ViewGroup.MarginLayoutParams
            if (params != null) {
                val bottom = maxOf(bars.bottom, if (insets.isVisible(WindowInsetsCompat.Type.ime())) ime.bottom else 0)
                if (params.leftMargin != bars.left || params.topMargin != bars.top || params.rightMargin != bars.right || params.bottomMargin != bottom) {
                    params.setMargins(bars.left, bars.top, bars.right, bottom)
                    view.layoutParams = params
                }
            }
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(webView)
        if (foreground && needsForegroundFrame && hasWindowFocus()) scheduleForegroundFrame()
    }
}
