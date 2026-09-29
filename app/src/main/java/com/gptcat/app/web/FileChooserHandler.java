package com.gptcat.app.web;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;

/** 每次文件选择回调恰好完成一次，包括取消、找不到选择器、Activity 销毁。 */
public final class FileChooserHandler {
    private static final int REQUEST = 100;
    private final Activity activity;
    private ValueCallback<Uri[]> callback;

    public FileChooserHandler(Activity activity) { this.activity = activity; }

    public boolean show(ValueCallback<Uri[]> next, WebChromeClient.FileChooserParams params) {
        cancel();
        callback = next;
        try {
            activity.startActivityForResult(params.createIntent(), REQUEST);
        } catch (ActivityNotFoundException | SecurityException e) {
            cancel();
        }
        return true;
    }

    public boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST) return false;
        Uri[] values = null;
        if (resultCode == Activity.RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                values = new Uri[clip.getItemCount()];
                for (int i = 0; i < values.length; i++) values[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                values = new Uri[] { data.getData() };
            }
        }
        complete(values);
        return true;
    }

    public void cancel() { complete(null); }

    private void complete(Uri[] values) {
        ValueCallback<Uri[]> pending = callback;
        callback = null;
        if (pending != null) pending.onReceiveValue(values);
    }
}
