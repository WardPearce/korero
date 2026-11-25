package app.korero.audio

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ResultReceiver
import androidx.core.content.ContextCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@TauriPlugin(permissions = [
    Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")
])
class VoicePlugin(private val host: Activity) : Plugin(host) {
    private external fun initializeRtc(context: Context): Boolean

    @Command
    fun start(invoke: Invoke) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startService(invoke)
        } else {
            requestPermissionForAlias("microphone", invoke, "microphoneResult")
        }
    }

    @PermissionCallback
    fun microphoneResult(invoke: Invoke) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startService(invoke)
        } else {
            invoke.reject("Microphone permission was denied")
        }
    }

    private fun startService(invoke: Invoke) {
        try {
            val context = host.applicationContext
            val contextUtils = Class.forName("org.webrtc.ContextUtils")
            contextUtils.getMethod("initialize", Context::class.java).invoke(null, context)
            if (!initializeRtc(context)) {
                invoke.reject("The native WebRTC audio device could not initialize")
                return
            }
            val receiver = object : ResultReceiver(Handler(Looper.getMainLooper())) {
                override fun onReceiveResult(resultCode: Int, resultData: Bundle?) {
                    if (resultCode == Activity.RESULT_OK) invoke.resolve()
                    else invoke.reject(resultData?.getString("error") ?: "Could not start Android voice")
                }
            }
            ContextCompat.startForegroundService(context, Intent(context, VoiceService::class.java)
                .putExtra("ready", receiver))
        } catch (failure: ReflectiveOperationException) {
            invoke.reject("The matching Android WebRTC Java classes are unavailable")
        } catch (failure: RuntimeException) {
            invoke.reject(failure.message ?: "Could not start the microphone service")
        } catch (failure: LinkageError) {
            invoke.reject(failure.message ?: "Could not load the native WebRTC runtime")
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        val context = host.applicationContext
        context.stopService(Intent(context, VoiceService::class.java))
        invoke.resolve()
    }
}
