# 依頼: ccgram に画像送受信を追加

## 概要

ccgram に Telegram ↔ Claude Code 間の画像送受信機能を追加したい。
Claude Code 公式の Channels Telegram プラグインが参考になる。

## 参考ソース

**`anthropics/claude-plugins-official/external_plugins/telegram/`**

https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram

公式プラグインの画像処理の仕組み：

### 受信（Telegram → Claude）
- 写真（photo）: 最高解像度版を inbox ディレクトリに自動ダウンロード → `image_path` 属性で通知に含める → Claude が `Read` ツールで読める
- ドキュメント（document）: `attachment_file_id` を通知に含める → Claude が `download_attachment` ツールで遅延取得
- 音声/ビデオ/スタンプも同様に `attachment_file_id` で対応

### 送信（Claude → Telegram）
- `reply` ツールの `files` パラメータで絶対パスを渡す
- `.jpg/.jpeg/.png/.gif/.webp` → `sendPhoto`（インラインプレビュー）
- それ以外 → `sendDocument`（生ファイル）
- 上限 50MB

## ccgram への適用案

### 受信（Telegram → ccgram → Claude Code）
1. Telegram Bot API の `getFile` で画像をダウンロード
2. 一時ディレクトリ（例: `/tmp/ccgram-images/`）に保存
3. tmux send-keys で Claude Code に画像パスを渡す
   - 例: `「/Users/kapi/tmp/ccgram/IMG_xxx.jpg を見て」` 的なメッセージとして注入
   - Claude Code の Read ツールは画像を読める

### 送信（Claude Code → ccgram → Telegram）
- tmux capture-pane で Claude の出力を監視
- 出力中に画像パス（`.jpg`, `.png` 等）が含まれていたら、そのファイルを Telegram の `sendPhoto` で送信
- または ccgram の inject API に「画像送信」エンドポイントを追加

## 注意点

- 公式プラグインは MCP 経由だが、ccgram は tmux 経由なので仕組みは違う
- 画像の受け渡し方法は ccgram 独自に設計する必要がある
- 公式ソースの grammy（Telegram Bot フレームワーク）の使い方は参考になるはず
- 食事写真ログ（`/Pictures/meals/`）との連携も視野に入れると良い

## ファイル

- 参考: `anthropics/claude-plugins-official/external_plugins/telegram/server.ts`
- 変更先: ccgram のソースコード

---

## 実装結果メモ

> 2026-03-21

今回の対応では、まず優先度の高い受信側

`Telegram -> ccgram -> Claude Code`

を実装した。

### 実装した内容

- Telegram の `photo` メッセージを受信
- 最大サイズの画像を選択
- `getFile` で取得して `/tmp/ccgram-images/` に保存
- 既存の reply-to routing / default workspace routing に乗せて Claude Code へ注入
- caption がある場合は caption も一緒に渡す

Claude Code 側には、画像そのものを変換して渡すのではなく、
ローカルファイルパスを含むテキストとして注入する方式を採用した。

### 確認結果

- ビルド通過
- 実機で Telegram から画像送信し、Claude Code 側で画像を見えることを確認

### 今回やっていないこと

- `Claude Code -> Telegram` の画像送信
- `document`, `video`, `animation` など photo 以外の添付対応
- 一時保存画像の自動クリーンアップ
