package app.korero.audio

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.ResultReceiver
import androidx.core.app.NotificationCompat

class VoiceService : Service() {
    private val audio by lazy { getSystemService(AudioManager::class.java) }
    private val focusListener = AudioManager.OnAudioFocusChangeListener { }
    private var focus: AudioFocusRequest? = null
    private var previousMode: Int? = null

    override fun onBind(intent: Intent?): IBinder? = null

    @Suppress("DEPRECATION")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val ready = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra("ready", ResultReceiver::class.java)
        } else {
            intent?.getParcelableExtra<ResultReceiver>("ready")
        }

        try {
            val channel = "korero.voice"
            if (Build.VERSION.SDK_INT >= 26) {
                getSystemService(NotificationManager::class.java).createNotificationChannel(
                    NotificationChannel(channel, "Kōrero voice", NotificationManager.IMPORTANCE_LOW)
                )
            }
            val notification = NotificationCompat.Builder(this, channel)
                .setContentTitle("Kōrero voice is active")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
            packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
                notification.setContentIntent(PendingIntent.getActivity(this, 0, launch,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            }
            startForeground(7401, notification.build())
            if (previousMode == null) {
                previousMode = audio.mode
                audio.mode = AudioManager.MODE_IN_COMMUNICATION
                if (Build.VERSION.SDK_INT >= 26) {
                    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                        .setAudioAttributes(AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                        .setOnAudioFocusChangeListener(focusListener)
                        .build()
                    focus = request
                    audio.requestAudioFocus(request)
                } else {
                    audio.requestAudioFocus(focusListener, AudioManager.STREAM_VOICE_CALL,
                        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                }
            }
            ready?.send(Activity.RESULT_OK, null)
        } catch (failure: RuntimeException) {
            val result = Bundle().apply { putString("error", failure.message) }
            ready?.send(Activity.RESULT_CANCELED, result)
            stopSelf(startId)
        }
        return START_NOT_STICKY
    }

    @Suppress("DEPRECATION")
    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= 26) {
            focus?.let(audio::abandonAudioFocusRequest)
        } else {
            audio.abandonAudioFocus(focusListener)
        }
        previousMode?.let { audio.mode = it }
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
