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

## 2026-03-20 安定化修正

### 背景

上の修正で、`/inject` と Telegram への応答返送は概ね動くようになった。
ただし、実装としてはまだ次の不安定要因が残っていた。

- `typing-active` が単一ファイルで、複数セッションが同じ状態を奪い合う
- `enhanced-hook-notify` が `process.env.TMUX` に強く依存しており、tmux / PTY / 直起動で判定が割れやすい
- `active-check.ts` の workspace 対応が後付けで、既存シグネチャ互換を壊していた
- workspace 名ベースの `/tmp/claude_last_msg_time_<workspace>` 生成が衝突しうる

レビュー時点では「今の使い方では動いているが、条件が少しズレると壊れる」状態だったため、
その場しのぎの分岐追加ではなく、通知ルーティングとセッション識別の仕組み自体を整理し直した。

### 今回の修正方針

方針は 3 つ。

1. **単一の `typing-active` ファイルをやめる**
   セッション単位の remote state に置き換え、どの応答を Telegram に返すべきかを session ごとに管理する。

2. **tmux / PTY を同じ識別軸で扱う**
   `TMUX` の有無ではなく、「ccgram が起動した session かどうか」で判定する。
   そのために、Claude 起動時に `CCGRAM_SESSION_NAME` / `CCGRAM_SESSION_TYPE` を埋め込む。

3. **`active-check` を後方互換ありで作り直す**
   既存の `isUserActiveAtTerminal(threshold)` 呼び出しを壊さず、
   workspace 単位ファイルも path hash 付きで衝突しないようにする。

### 具体的な変更

#### 1. セッション単位の remote state を追加

**追加ファイル:** `src/utils/notification-state.ts`

追加した state は以下。

- `routeToTelegram` — この session の応答を Telegram に返すべきか
- `typing` — Telegram 側に typing 表示を出すべきか
- `workspace` — どの workspace に属する state か
- `startedAt` / `updatedAt` — TTL 管理用

これにより、従来の `src/data/typing-active` 1 ファイルに依存しなくなった。
複数 session が同時に動いても、片方の状態をもう片方が消すことがなくなる。

#### 2. セッション識別ユーティリティを追加

**追加ファイル:** `src/utils/session-identity.ts`

`detectSessionName()` / `resolveSessionContext()` をここに集約した。

役割:

- `CCGRAM_SESSION_NAME` があれば最優先で使う
- なければ tmux セッション名取得
- それも無理なら cwd 由来の sanitize 名を使う
- `session-map.json` と `session_id` を突き合わせて、ccgram 管理 session かどうかを判定

これを `enhanced-hook-notify.ts` / `permission-hook.ts` / `question-notify.ts` で共通利用するように変更。

#### 3. Claude 起動時に session 情報を環境変数で注入

**変更ファイル:** `workspace-telegram-bot.ts`, `src/utils/pty-session-manager.ts`

tmux / PTY のどちらで起動する場合も、
Claude プロセスに次の env を渡すようにした。

- `CCGRAM_SESSION_NAME`
- `CCGRAM_SESSION_TYPE`

これにより hook 側は「今のプロセスは ccgram 管理のどの session か」を直接判断できる。
以前のように `process.env.TMUX` の有無だけに頼らなくてよくなった。

#### 4. `enhanced-hook-notify.ts` の判定ロジックを整理

以前は以下のような構造だった。

- `typing-active` の存在を見る
- `TMUX` があるかを見る
- `session-map` と照合する

今回からは次の順にした。

- `resolveSessionContext()` で session を特定
- `notification-state.ts` の remote state を見て Telegram 返送対象か判定
- `active-check.ts` で「ユーザーがその workspace で今 active か」を判定

これで tmux / PTY / 直起動が同じ判定フローに乗る。

#### 5. `active-check.ts` を互換修正

**変更ファイル:** `src/utils/active-check.ts`, `user-prompt-hook.ts`

修正内容:

- `isUserActiveAtTerminal(threshold)` の旧シグネチャ互換を戻した
- `isUserActiveAtTerminal(cwd, threshold)` も使える overload にした
- workspace ごとの timestamp file 名に cwd hash を付与した
- `user-prompt-hook.ts` は per-workspace と global fallback の両方に timestamp を書くようにした

これで従来コードを壊さず、workspace 別抑止もできるようになった。

### なぜこの設計にしたか

ポイントは、「通知を返すべき相手」を **グローバル状態ではなく session に紐づける** こと。

もともとの問題は、`typing-active` が「今どこかで Telegram 起点の処理が走っている」ことしか表現できなかった点にある。
これだと session A の処理と session B の hook が競合した時に、どちらの応答を Telegram に返すべきか判定できない。

今回の修正では、最初から「どの session が Telegram 起点か」を state に持たせた。
そのため、判定は

- どの session の hook か
- その session は remote route 中か

の 2 つだけで済む。

この形にしておくと、将来的に session が増えても構造が崩れにくい。

### テストと確認結果

ローカルで次を確認した。

- `npm run build` — 成功
- `npm test` — 91 tests 全通

追加した test:

- `test/notification-state.test.js`
- `test/session-identity.test.js`

既存 test 更新:

- `test/active-check.test.js`

実機確認:

- `/inject` で `claude-env` へ送信 → Telegram に応答返送
- AskUserQuestion → Telegram に選択肢表示
- PermissionRequest（`/etc/hosts` 読み取り）→ Telegram に permission ボタン表示

### まだ残る制約

今回直したのは **Claude Code / ccgram 内部の通知ルーティング** まで。
macOS ネイティブの TCC 権限ダイアログは別問題で、ここはまだ Telegram 経由では扱えない。

例:

- Automation 権限
- Accessibility 権限
- Full Disk Access
- Screen Recording
- Input Monitoring

この層は Claude hook ではなく OS ダイアログなので、必要なら事前許可や専用実行環境での運用設計が別途必要。

### 関連コミット（安定化）

- `b0d1402` — fix: stabilize ccgram remote routing and hook state
