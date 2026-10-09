package com.nspector.app;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * NSpector Android shell.
 *
 * The UI and all analysis live on the NSpector server, so the phone stays in
 * sync with the desktop app automatically — every status change, owner
 * assignment and sync push travels over the same WebSocket.
 */
public class MainActivity extends Activity {

    private WebView web;
    private LinearLayout setup;
    private EditText addr;
    private SharedPreferences prefs;
    private static final String PREFS = "nspector";
    private static final String KEY_ADDR = "server";

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String saved = prefs.getString(KEY_ADDR, "");

        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#0b0f14"));
        w.setNavigationBarColor(Color.parseColor("#0b0f14"));
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0b0f14"));

        // ---- first-run connection screen ----
        setup = new LinearLayout(this);
        setup.setOrientation(LinearLayout.VERTICAL);
        setup.setPadding(56, 96, 56, 56);

        TextView title = new TextView(this);
        title.setText("NSpector");
        title.setTextColor(Color.WHITE);
        title.setTextSize(32);
        title.setGravity(Gravity.CENTER);
        setup.addView(title);

        TextView sub = new TextView(this);
        sub.setText("Connect to the NSpector server running on your PC or server machine.\n\n"
                + "Find the address in the desktop app: Help → Server address.\n"
                + "Both must be on the same Wi-Fi network.");
        sub.setTextColor(Color.parseColor("#8b9bb0"));
        sub.setTextSize(14);
        sub.setPadding(0, 20, 0, 36);
        sub.setGravity(Gravity.CENTER);
        setup.addView(sub);

        addr = new EditText(this);
        addr.setHint("192.168.1.10:4173");
        addr.setTextColor(Color.WHITE);
        addr.setHintTextColor(Color.parseColor("#55667a"));
        addr.setText(saved);
        addr.setSingleLine(true);
        setup.addView(addr);

        Button go = new Button(this);
        go.setText("Connect");
        go.setOnClickListener(v -> {
            String value = addr.getText().toString().trim();
            if (value.isEmpty()) {
                Toast.makeText(this, "Enter the server address", Toast.LENGTH_SHORT).show();
                return;
            }
            if (!value.startsWith("http")) value = "http://" + value;
            prefs.edit().putString(KEY_ADDR, value).apply();
            loadApp(value);
        });
        setup.addView(go);

        TextView hint = new TextView(this);
        hint.setText("Already connected? Long-press below to change the address.");
        hint.setTextColor(Color.parseColor("#55667a"));
        hint.setTextSize(12);
        hint.setPadding(0, 28, 0, 0);
        hint.setGravity(Gravity.CENTER);
        hint.setOnLongClickListener(v -> { resetServer(); return true; });
        setup.addView(hint);

        root.addView(setup);

        // ---- the app ----
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        web.setBackgroundColor(Color.parseColor("#0b0f14"));
        web.setWebViewClient(new WebViewClient());
        root.addView(web, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));
        web.setVisibility(View.GONE);

        setContentView(root);
        if (!saved.isEmpty()) loadApp(saved);
    }

    private void loadApp(String base) {
        setup.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(base + "/");
    }

    private void resetServer() {
        setup.setVisibility(View.VISIBLE);
        web.setVisibility(View.GONE);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.getVisibility() == View.VISIBLE && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}