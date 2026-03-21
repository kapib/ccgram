# ccgram 次の機能アイデア

> 2026-03-21 カピさん × クロスケの会話から

---

## 1. 画像の送受信対応

**優先度: 高**

### 現状
- `processMessage` で `msg.text` が空なら即return → 画像は完全無視
- `sendMessage` はテキスト専用、`multipart/form-data` 非対応

### 受信（Telegram → Claude Code）— 改修: 小（1〜2時間）

- `src/types/telegram.ts`: `TelegramMessage` に `photo?: PhotoSize[]`, `caption?: string` 追加（+10行）
- `workspace-telegram-bot.ts` の `processMessage`（1438行目）:
  - `msg.photo` を検出
  - `getFile` API で `file_path` 取得
  - ローカルにダウンロード（`/tmp/ccgram-images/` 等）
  - `caption` + ローカルパスを `injectAndRespond` に渡す
  - Claude Code はマルチモーダル対応なのでパスを渡すだけで画像を見れる
- 合計: 2ファイル、+80行程度

### 送信（Claude Code → Telegram）— 改修: 中（2〜4時間）

- `sendPhoto(chatId, filePath)` 関数を新規追加（`multipart/form-data`）
- 既存の `http-request.ts` が JSON 専用なので、multipart 対応を追加
- hook 経由で画像パスを受け取り → bot が `sendPhoto`
- 合計: 2〜3ファイル、+100行程度

---

## 2. macOS通知 → Telegram転送

**優先度: 中**

### 概要
Mac側の通知センターに出る通知（Slack, メール, システム等）をTelegramに転送する。
今のccgramはtmux内のClaude Codeの確認ダイアログは拾えるが、macOSネイティブ通知は拾えない。

### 技術調査結果

**取得方法**: 通知センターのSQLite DB直読み（ポーリング）
- DB場所: `~/Library/Group Containers/group.com.apple.usernoted/db2/db`
- 本文はバイナリplist形式 → Pythonの `plistlib` でデコード
- **Full Disk Access** 権限が必要（1回手動付与）
- 既存OSS `notifwd` がベースに使える

### アーキテクチャ

ccgramとは別モジュールとして並列動作、同じTelegramチャンネルに流す：
```
ccgram          → Claude Codeの出力・権限プロンプト → Telegram
mac-notif-agent → システム通知全般                 → Telegram（同チャンネル）
```

### ロードマップ

1. Step 1（1〜2時間）: notifwdベースでPOC。通知→Telegram転送のみ
2. Step 2（半日）: LaunchAgent常駐化 + フィルタリング設定
3. Step 3（1〜2日）: Telegramからコマンド返信（`/open`, `/dismiss`等）

---

## 3. Telegram → macOS操作（双方向）

**優先度: 低（リスクあり）**

### できること

| 操作 | 実現性 | 方法 |
|------|--------|------|
| 通知のボタン押下 | アラートスタイルのみ安定 | AppleScript + System Events |
| パスワード入力 | 技術的に可能だが高リスク | osascript keystroke |
| アプリ切替 | 容易 | `open -a <app>` |
| 通知クローズ | 可能 | AppleScript |

### 注意
- パスワード自動入力は MITRE ATT&CK T1059.002 として登録済みの攻撃パターン
- セキュリティソフトに検知される可能性
- やるなら専用の確認フロー（Telegram上で「本当に入力しますか？」→ 承認）を挟む

---

## 4. スクリーンショット撮影 → Telegram送信

**優先度: 中**

### 概要
Telegramから「スクショ撮って」→ Mac側で `screencapture` → Telegram に画像送信

### 実装
- `screencapture /tmp/screenshot.png` で全画面キャプチャ
- `screencapture -l <windowID>` で特定ウィンドウのみ
- Telegram Bot API の `sendPhoto` で送信（機能2の送信対応と共通）
- Screen Recording 権限が必要（Sequoiaでは月次再プロンプトの可能性）

### 画像送信（機能1）が先に実装されていれば、追加は最小限

---

## 実装の依存関係

```
[1. 画像送受信] ← 他の全機能の土台
      ↓
[4. スクショ送信] ← 画像送信が使える前提
      ↓
[2. 通知転送] ← 独立モジュールだが、画像付き通知も送れると◎
      ↓
[3. 双方向操作] ← 通知転送の上に乗る拡張
```

**→ まず画像送受信（1）から着手するのが正解。**
