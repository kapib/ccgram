# kuro-daemon連携 — ccgram改造ドキュメント

## 概要

kuro-daemon（クロスケの自律的バックグラウンドプロセス）から、ccgram経由でTelegramセッションのClaude Codeにメッセージを注入する仕組み。

```
kuro-daemon.sh → curl POST /inject → ccgram → tmux/PTY → Claude Code → 応答 → Telegram
```

## 改造箇所

### 1. inject APIエンドポイント追加

**ファイル:** `workspace-telegram-bot.ts` の `startHealthServer` 関数内

**変更内容:** `/inject` エンドポイントを追加。外部スクリプトからHTTP POST経由でTelegramセッションにメッセージを注入できる。

**エンドポイント仕様:**
```
POST http://127.0.0.1:<HEALTH_PORT>/inject
Content-Type: application/json

{
  "workspace": "claude-env",
  "command": "注入するメッセージ",
  "token": "<INJECT_TOKEN>"
}

Response: {"ok": true, "workspace": "claude-env"}
```

**必要な環境変数:**
- `HEALTH_PORT` — HTTPサーバーのポート番号（例: `9199`）
- `INJECT_TOKEN` — 認証トークン（例: `kuro-daemon-2026`）

**設定場所:** launchdのplist（`~/Library/LaunchAgents/com.ccgram.plist`）の EnvironmentVariables に追加。

### 2. startTypingIndicator にセッション名引数追加

**ファイル:** `workspace-telegram-bot.ts`

**変更内容:**
```typescript
// Before
function startTypingIndicator(): void {
  fs.writeFileSync(TYPING_SIGNAL_PATH, String(Date.now()));

// After
function startTypingIndicator(sessionName?: string): void {
  fs.writeFileSync(TYPING_SIGNAL_PATH, sessionName || 'unknown');
```

typing-activeファイルにtmuxセッション名を書き込む。enhanced-hook-notifyが「どのセッションからの応答か」を判別するために必要。

**影響箇所:** injectAndRespond内 + コールバックボタン処理（パーミッション承認等）の計4箇所で引数を渡すように変更。

### 3. enhanced-hook-notify のTelegram送信セッション分離

**ファイル:** `enhanced-hook-notify.ts`

**変更内容:** 3つのチェックを追加。

#### (a) process.env.TMUX チェック
```typescript
const isInsideTmuxForTyping = !!process.env.TMUX;
```
tmux外で動くセッション（ユーザーが直接起動したClaude Code）はtyping-activeを一切見ない。
これにより、同じcwd（claude-env）でも確実に区別できる。

**なぜこれで区別できるか:**
- ccgramが作ったtmuxセッション内のClaude Code → `process.env.TMUX` が設定される
- ユーザーがGhosttyから直接起動したClaude Code → `process.env.TMUX` が空

#### (b) session-map チェック
```typescript
let isCcgramSession = false;
if (isInsideTmux) {
  // session-map.jsonを読んで、tmuxSessionが登録されてるかチェック
}
```
tmux内でも、ccgramが管理してるセッションからの発火だけTelegram送信を許可。

#### (c) typing-active 競合削除防止
```typescript
if (!isCcgramSession && !isTelegramInjected) {
  // Do NOT delete typing-active here — it belongs to another session
  return;
}
```
対象外セッションがtyping-activeファイルを削除しない。
これが無いと、ワイのセッションのhookが先に発火した時にtyping-activeを消してしまい、
後から発火するTelegramセッションのhookがファイルを見つけられず送信失敗する。

## 問題の経緯と学び

### typing-active競合問題

**症状:** inject経由でクロスケが応答してるのに、Telegramに届いたり届かなかったりする。

**原因:** Claude Codeの同じcwd（claude-env）で複数セッションが動いている場合、Stop hookが複数セッションから発火する。先に発火したセッション（ユーザー直接起動）がtyping-activeを削除してしまい、後から発火するセッション（ccgram管理）がファイルを見つけられない。

**解決:** 3層の判定ロジック:
1. `process.env.TMUX` — tmux内かどうか
2. session-map照合 — ccgram管理セッションかどうか
3. typing-active削除の禁止 — 対象外セッションはファイルを触らない

### デバッグの学び

- **観測可能な状態を先に作る:** `tmux attach -t claude-env -r` でTelegramセッションの画面を見ながらデバッグすべき
- **hook-debug.log:** enhanced-hook-notifyにデバッグログを入れて、各セッションからの発火状況を確認する
- `detectSessionName(cwd)` はtmux外からも値を返す（cwdから導出）ため、`process.env.TMUX` の有無が唯一の確実な区別点

## 安定運用の条件

- ユーザーがGhosttyから直接Claude Codeを起動する → 問題なし
- ユーザーがtmuxでセッション名 `claude-env` 以外を使う → 問題なし
- ユーザーがtmuxでセッション名 `claude-env` を使う → **ccgramのセッションと競合する可能性あり**
- ccgram再起動時はsession-map + typing-active + tmux claude-envをクリアしてから `/new claude-env`

## 関連コミット

- `8e9af87` — feat: kuro-daemon用inject APIとTelegram通知セッション分離
- `0536018` — fix: typing-active競合修正 — 対象外セッションがファイルを削除しない
