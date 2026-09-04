package com.barsa.shopi;

import android.app.*;
import android.os.Bundle;
import android.content.*;
import android.net.Uri;
import android.provider.Settings;
import android.webkit.*;
import android.view.*;
import android.graphics.Color;
import android.content.res.Configuration;
import java.io.IOException;

public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER = 9049;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private AssetServer assetServer;
    private NativeAiRuntime nativeAi;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(2,4,11)); getWindow().setNavigationBarColor(Color.rgb(2,4,11));
        webView = new WebView(this); setContentView(webView);
        nativeAi = new NativeAiRuntime(this);
        configureWebView();
        try { assetServer = new AssetServer(getAssets(), nativeAi, getCacheDir()); webView.loadUrl("http://127.0.0.1:" + assetServer.port() + "/index.html"); }
        catch (IOException e) { webView.loadData("<h2>BARSA SHOPI runtime failed</h2>", "text/html", "UTF-8"); }
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true); s.setAllowContentAccess(true); s.setMediaPlaybackRequiresUserGesture(false); s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE); s.setSupportZoom(false); s.setBuiltInZoomControls(false); s.setDisplayZoomControls(false);
        webView.setBackgroundColor(Color.rgb(2,4,11));
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        }
        webView.addJavascriptInterface(new NativeBridge(this, nativeAi), "BarsaAndroid");
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null); fileCallback = callback;
                Intent intent = params.createIntent(); intent.addCategory(Intent.CATEGORY_OPENABLE);
                try { startActivityForResult(intent, FILE_CHOOSER); } catch (Exception e) { fileCallback=null; return false; }
                return true;
            }
        });
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data); if (request != FILE_CHOOSER || fileCallback == null) return;
        Uri[] resultUris = WebChromeClient.FileChooserParams.parseResult(result, data); fileCallback.onReceiveValue(resultUris); fileCallback = null;
    }

    @Override public void onBackPressed() { if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed(); }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) { webView.onResume(); webView.resumeTimers(); }
    }

    @Override protected void onPause() {
        if (webView != null) { webView.onPause(); webView.pauseTimers(); }
        super.onPause();
    }

    @Override protected void onDestroy() {
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback=null; }
        if (webView != null) { webView.removeJavascriptInterface("BarsaAndroid"); webView.destroy(); }
        if (assetServer != null) try { assetServer.close(); } catch (Exception ignored) {}
        if (nativeAi != null) try { nativeAi.close(); } catch (Exception ignored) {}
        super.onDestroy();
    }
}
