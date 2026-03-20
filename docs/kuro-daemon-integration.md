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

## レビュー依頼事項

以下の観点でレビューをお願いしたい。

### 1. inject APIのセキュリティ

- 現状: `INJECT_TOKEN` 環境変数で認証。localhost（127.0.0.1）のみバインド
- 懸念: トークンがハードコードされている（launchd plistとkuro-daemon.shの両方）。ローテーションの仕組みがない
- 質問: これで十分か？ローカル通信のみだから問題ない？

### 2. typing-activeファイルの競合

- 現状: ファイルベースIPC。1ファイルに1セッション名。対象外セッションは触らない
- 懸念: 複数のccgram管理セッションが同時に動いた場合（将来）、typing-activeが上書きされる
- 質問: 現時点ではclaude-envの1セッションだけなので問題ないが、将来的にはセッションIDベースにすべきか？

### 3. process.env.TMUX 依存

- 現状: tmux内かどうかの判定に `process.env.TMUX` を使用
- 懸念: ユーザーがtmux内でClaude Codeを起動し、セッション名が `claude-env` だった場合に競合
- 質問: tmuxセッション名の予約（ccgramが使う名前をユーザーが使わないようにする）を明示すべきか？

### 4. ccgram再起動時の手順

- 現状: 手動でsession-map + typing-active + tmuxセッションをクリアしてから `/new`
- 懸念: 自動化されてない。忘れると「already running」で詰まる
- 質問: ccgram起動時に自動クリーンアップすべきか？

### 5. enhanced-hook-notifyの変更範囲

- 元のccgramの設計: typing-activeの存在だけで判定（シンプル）
- 改造後: 3層判定（process.env.TMUX + session-map + typing-active内容照合）
- 懸念: 元のシンプルな設計から複雑化した。元のccgramがアップデートされた時にコンフリクトする可能性
- 質問: upstream（元のccgram）にPRを出すべきか、forkとして維持すべきか？

## 発生したバグの時系列

| # | 症状 | 原因 | 修正 |
|---|------|------|------|
| 1 | injectしたメッセージがワイのセッション（mac-mini-dev）に注入される | tmux send-keysで `claude-env` を指定 → ワイのtmuxセッションがclaude-envだった | inject APIに切り替え（tmux send-keys廃止） |
| 2 | ワイの発言がTelegramに漏れる | enhanced-hook-notifyがtyping-active存在だけで判定 → 全セッションから送信 | process.env.TMUX + session-mapチェック追加 |
| 3 | inject後にクロスケの応答がTelegramに来ない | `process.env.TMUX`が空の時もdetectSessionNameがcwdから`claude-env`を返す → typing-active照合が誤一致 | tmux外ではtyping-activeを一切見ないように修正 |
| 4 | inject後にクロスケの応答が来たり来なかったり（不安定） | ワイのセッションのhookが先に発火してtyping-activeを削除 → Telegramセッションのhookがファイルを見つけられない | 対象外セッションはtyping-activeを触らないように修正 |
| 5 | tmux attach中にTelegram送信が不安定 | コピーモードONやキー入力がClaude Codeの応答に影響 | `tmux attach -r`（読み取り専用）を使用 |

## テスト結果

| テスト | 結果 |
|--------|------|
| inject → クロスケ応答 → Telegram送信 | ✅（再起動3回連続成功） |
| ワイの発言漏れ防止 | ✅ |
| スマホからTelegram直接送信 → 応答 | ✅ |
| tmux attach -r 中のinject | ✅ |
| ccgram再起動後の復旧 | ✅（session-mapクリア + /new必要） |

## 未テスト・既知のリスク

- MacBookからの同時セッション（Mac miniとMacBookで同時にclaude-envを使う場合）
- node-ptyが使える環境での動作（現在はtmuxモードのみ検証）
- 長時間連続運用（24時間以上）
- kuro-daemon本番版（haiku判断あり）でのinject

## 関連コミット

- `8e9af87` — feat: kuro-daemon用inject APIとTelegram通知セッション分離
- `0536018` — fix: typing-active競合修正 — 対象外セッションがファイルを削除しない
- `c2fdad4` — docs: kuro-daemon連携の改造ドキュメント
