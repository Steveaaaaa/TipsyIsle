package com.xiaoleng.tipsyisle

import android.graphics.Color
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/** Add fullscreen without replacing Wry's dialogs, permissions or file chooser. */
internal class FullscreenChromeClient(
    private val activity: MainActivity,
    private val delegate: WebChromeClient,
) : WebChromeClient() {
    private var fullscreen: FrameLayout? = null
    private var exit: CustomViewCallback? = null
    private val bars = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = onHideCustomView()
    }

    init { activity.onBackPressedDispatcher.addCallback(activity, back) }

    override fun onShowCustomView(view: View, callback: CustomViewCallback) {
        if (fullscreen != null) { callback.onCustomViewHidden(); return }
        val decor = activity.window.decorView as ViewGroup
        val layer = FrameLayout(activity).apply {
            setBackgroundColor(Color.BLACK)
            addView(view, FrameLayout.LayoutParams(-1, -1))
        }
        fullscreen = layer
        exit = callback
        decor.addView(layer, ViewGroup.LayoutParams(-1, -1))
        bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        bars.hide(WindowInsetsCompat.Type.systemBars())
        back.isEnabled = true
    }

    override fun onHideCustomView() {
        val layer = fullscreen ?: return
        fullscreen = null
        val callback = exit
        exit = null
        back.isEnabled = false
        (layer.parent as? ViewGroup)?.removeView(layer)
        layer.removeAllViews()
        bars.show(WindowInsetsCompat.Type.systemBars())
        bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
        callback?.onCustomViewHidden()
    }

    override fun onPermissionRequest(request: PermissionRequest) = delegate.onPermissionRequest(request)
    override fun getDefaultVideoPoster() = delegate.defaultVideoPoster
    override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult) =
        delegate.onJsAlert(view, url, message, result)
    override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult) =
        delegate.onJsConfirm(view, url, message, result)
    override fun onJsPrompt(view: WebView, url: String, message: String, value: String, result: JsPromptResult) =
        delegate.onJsPrompt(view, url, message, value, result)
    override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
        delegate.onGeolocationPermissionsShowPrompt(origin, callback)
    override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri?>?>, params: FileChooserParams) =
        delegate.onShowFileChooser(view, callback, params)
    override fun onConsoleMessage(message: ConsoleMessage) = delegate.onConsoleMessage(message)
    override fun onReceivedTitle(view: WebView, title: String) = delegate.onReceivedTitle(view, title)
}
