package com.xiaoleng.tipsyisle

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class UpdateInstallerArgs {
    lateinit var path: String
}

@TauriPlugin
class UpdateInstaller(private val activity: Activity) : Plugin(activity) {
    @Command
    fun install(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                val file = File(invoke.parseArgs(UpdateInstallerArgs::class.java).path).canonicalFile
                val directory = File(activity.cacheDir, "updates").canonicalFile
                if (file.parentFile != directory || !file.name.endsWith("-android-arm64.apk") || !file.isFile) {
                    invoke.reject("找不到已下载的更新包，请重新下载。")
                    return@runOnUiThread
                }
                if (!activity.packageManager.canRequestPackageInstalls()) {
                    activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.fromParts("package", activity.packageName, null)))
                    invoke.resolveObject("permission")
                    return@runOnUiThread
                }
                val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
                activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                })
                invoke.resolveObject("opened")
            } catch (_: Exception) {
                invoke.reject("系统没有打开安装界面，请重试。")
            }
        }
    }
}
