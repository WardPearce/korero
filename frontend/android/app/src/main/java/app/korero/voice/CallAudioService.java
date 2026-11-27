package app.korero.voice;

import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.ResultReceiver;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.IntentCompat;

public class CallAudioService extends Service {
    static final String MICROPHONE = "microphone";
    static final String READY = "ready";
    private static final String CHANNEL = "korero.voice";
    private boolean foreground;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        ResultReceiver ready = IntentCompat.getParcelableExtra(intent, READY, ResultReceiver.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getSystemService(NotificationManager.class).createNotificationChannel(
                    new NotificationChannel(CHANNEL, getString(R.string.call_audio_channel), NotificationManager.IMPORTANCE_LOW));
            }
            Intent openCall = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent open = PendingIntent.getActivity(this, 0, openCall, PendingIntent.FLAG_IMMUTABLE);
            var notification = new NotificationCompat.Builder(this, CHANNEL)
                .setContentTitle(getString(R.string.call_audio_active))
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentIntent(open)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
            if (intent.getBooleanExtra(MICROPHONE, false)) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            ServiceCompat.startForeground(this, 7401, notification, type);
            foreground = true;
            if (ready != null) ready.send(Activity.RESULT_OK, null);
        } catch (RuntimeException error) {
            if (ready != null) ready.send(Activity.RESULT_CANCELED, null);
            // A failed microphone upgrade can leave a listening call running.
            if (!foreground) stopSelf(startId);
        }
        return START_NOT_STICKY;
    }
}
