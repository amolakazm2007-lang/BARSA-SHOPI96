package com.barsa.shopi;

import android.content.*;
import android.net.Uri;
import android.os.*;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.view.WindowManager;
import java.io.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

public final class NativeBridge {
    private static final class ExportSession {
        final File file; final String name; final String mime; final long sourceDateMs; int sequence = 0;
        ExportSession(File file, String name, String mime, long sourceDateMs) { this.file=file; this.name=name; this.mime=mime; this.sourceDateMs=sourceDateMs; }
    }
    private final MainActivity activity;
    private final NativeAiRuntime nativeAi;
    private final Map<String,ExportSession> exports = new ConcurrentHashMap<>();

    NativeBridge(MainActivity activity, NativeAiRuntime nativeAi) { this.activity = activity; this.nativeAi = nativeAi; }

    @JavascriptInterface public String getDeviceInfo() {
        try {
            JSONObject json = new JSONObject();
            json.put("manufacturer", Build.MANUFACTURER); json.put("model", Build.MODEL); json.put("device", Build.DEVICE);
            json.put("sdk", Build.VERSION.SDK_INT); json.put("cores", Runtime.getRuntime().availableProcessors());
            json.put("maxHeapBytes", Runtime.getRuntime().maxMemory()); json.put("nativeShell", true);
            return json.toString();
        } catch (Exception e) { return "{}"; }
    }

    @JavascriptInterface public String getNativeAiInfo() { return nativeAi.capabilities(); }

    @JavascriptInterface public String getThermalInfo() {
        try {
            JSONObject json = new JSONObject();
            PowerManager pm = (PowerManager) activity.getSystemService(Context.POWER_SERVICE);
            int status = Build.VERSION.SDK_INT >= 29 && pm != null ? pm.getCurrentThermalStatus() : -1;
            json.put("status", status);
            json.put("supported", Build.VERSION.SDK_INT >= 29 && pm != null);
            if (Build.VERSION.SDK_INT >= 30 && pm != null) {
                float headroom = pm.getThermalHeadroom(10);
                json.put("headroom", Float.isNaN(headroom) ? JSONObject.NULL : headroom);
            }
            return json.toString();
        } catch (Exception e) { return "{}"; }
    }

    @JavascriptInterface public String runNativeAiSelfTest() { return nativeAi.selfTestBundledSuperResolution(); }

    @JavascriptInterface public void setKeepScreenOn(boolean enabled) {
        activity.runOnUiThread(() -> { if (enabled) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); });
    }

    @JavascriptInterface public void vibrate(int milliseconds) {
        Vibrator vibrator = (Vibrator) activity.getSystemService(Context.VIBRATOR_SERVICE);
        if (vibrator == null) return;
        long ms = Math.max(1, Math.min(500, milliseconds));
        if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)); else vibrator.vibrate(ms);
    }

    @JavascriptInterface public String beginExport(String fileName, String mime, String totalBytes, String sourceDateMs) {
        try {
            String id = UUID.randomUUID().toString();
            File file = new File(activity.getCacheDir(), "barsa-export-" + id + ".part");
            if (file.exists()) file.delete();
            if (!file.createNewFile()) return "";
            long date = 0; try { date = Long.parseLong(sourceDateMs == null ? "0" : sourceDateMs); } catch (Exception ignored) {}
            exports.put(id, new ExportSession(file, safeName(fileName), mime == null ? "video/mp4" : mime, Math.max(0, date)));
            return id;
        } catch (Exception e) { return ""; }
    }

    @JavascriptInterface public boolean appendExportChunk(String id, String base64, int sequence) {
        ExportSession session = exports.get(id); if (session == null || sequence != session.sequence) return false;
        try (FileOutputStream out = new FileOutputStream(session.file, true)) {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT); out.write(bytes); session.sequence++; return true;
        } catch (Exception e) { return false; }
    }

    @JavascriptInterface public String finishExport(String id) {
        ExportSession session = exports.remove(id); if (session == null) return "";
        ContentResolver resolver = activity.getContentResolver(); Uri uri = null;
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Video.Media.DISPLAY_NAME, session.name); values.put(MediaStore.Video.Media.MIME_TYPE, session.mime);
            values.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/BARSA SHOPI");
            if (session.sourceDateMs > 0) { long seconds = session.sourceDateMs / 1000L; values.put(MediaStore.Video.Media.DATE_ADDED, seconds); values.put(MediaStore.Video.Media.DATE_MODIFIED, seconds); }
            values.put(MediaStore.Video.Media.IS_PENDING, 1);
            uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values); if (uri == null) throw new IOException("MediaStore insert failed");
            try (InputStream in = new FileInputStream(session.file); OutputStream out = resolver.openOutputStream(uri, "w")) {
                if (out == null) throw new IOException("MediaStore output failed"); byte[] buffer = new byte[1024 * 1024]; int n; while ((n = in.read(buffer)) >= 0) out.write(buffer,0,n);
            }
            ContentValues ready = new ContentValues(); ready.put(MediaStore.Video.Media.IS_PENDING, 0); resolver.update(uri, ready, null, null);
            session.file.delete(); return uri.toString();
        } catch (Exception e) { if (uri != null) resolver.delete(uri, null, null); session.file.delete(); return ""; }
    }

    @JavascriptInterface public void cancelExport(String id) { ExportSession s=exports.remove(id); if (s!=null) s.file.delete(); }

    private static String safeName(String name) {
        String value = name == null ? "BARSA_EXPORT.mp4" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (!value.toLowerCase(Locale.ROOT).endsWith(".mp4")) value += ".mp4";
        return value.trim().isEmpty() ? "BARSA_EXPORT.mp4" : value;
    }
}
