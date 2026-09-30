package com.gptcat.app.download;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * DownloadManager 完成后的记账清理：把 prefs 里的文件名记录删掉，避免记录无限增长。
 *
 * 这里刻意**不发**「下载完成 / 下载失败」通知，两个原因：
 * 1) enqueue 已经设了 {@code VISIBILITY_VISIBLE_NOTIFY_COMPLETED}，系统自己会通知，
 *    我们再发一条就是重复通知；
 * 2) 用户在系统通知里取消或删除任务时同样会收到 DOWNLOAD_COMPLETE，
 *    此时数据库里已经没有这条记录，任何"按状态推断"的通知都会误报「下载失败」。
 *
 * 网页生成的 blob/data 文件不经过这里，它们走 ImageBridge.notifySaved 的「已保存到 下载/佐助」通知。
 */
public final class DownloadCompleteReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null
                || !DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) {
            return;
        }

        long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
        if (id < 0) return;

        try {
            // 与 DownloadCenter 共用同一个 prefs 文件和同一个键；
            // 历史上这里写的是 "gptcat_downloads"（下划线），与 DownloadCenter 的
            // "gptcat-downloads"（连字符）不是同一个文件，导致整个接收器从来不生效。
            DownloadCenter.sharedPrefs(context)
                    .edit()
                    .remove(DownloadCenter.nameKey(id))
                    .apply();
        } catch (RuntimeException ignored) {
        }
    }
}
