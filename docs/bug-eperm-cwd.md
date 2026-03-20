# バグ報告: enhanced-hook-notify が EPERM: process.cwd failed でクラッシュ

## 症状

ccgramのTelegramセッションで買い物リスト書き込み等の操作中に、enhanced-hook-notifyがクラッシュ。
その後ccgram全体が応答しなくなった。

## エラーメッセージ

```
Stop hook error: Failed with non-blocking status code:
node:internal/bootstrap/switches/does_own_process_state:142
    cachedCwd = rawMethods.cwd();
                           ^

Error: EPERM: process.cwd failed with error operation not permitted, uv_cwd
    at process.wrappedCwd [as cwd]
(node:internal/bootstrap/switches/does_own_process_state:142:28)
    at Object.configDotenv
(/Users/kapi/.ccgram/node_modules/dotenv/lib/main.js:249:43)
    at Object.config
(/Users/kapi/.ccgram/node_modules/dotenv/lib/main.js:331:25)
    at Object.<anonymous>
(/Users/kapi/.ccgram/dist/enhanced-hook-notify.js:23:19)
```

## 原因推測

`enhanced-hook-notify.js` の23行目で `dotenv.config()` を呼ぶ時に `process.cwd()` が呼ばれるが、
hookが発火した時点でカレントディレクトリが既に削除されている（または権限がない）。

考えられるシナリオ:
- ccgramがtmuxセッションを作成 → Claude Codeがファイル操作 → 一時ディレクトリが消える → Stop hook発火 → `process.cwd()` 失敗
- tmuxセッションのcwdが無効になっている

## 修正提案

`dotenv.config()` の呼び出しで `process.cwd()` に依存しないようにする。
既に `path` を明示指定してるから、`cwd` のフォールバックが要るだけ。

```typescript
// Before (23行目)
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

// pathを明示指定してるのに、dotenvが内部でprocess.cwd()を呼んでクラッシュ。
// try-catchで囲むか、dotenvのオプションでcwd依存を回避する。
```

簡単な修正:
```typescript
try {
  require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });
} catch {
  // cwd が消えてる場合は .env なしで続行（環境変数は launchd から来てる）
}
```

## 再現条件

- ccgramのTelegramセッションでファイル操作（買い物リスト書き込み等）を行う
- 操作中にStop hookが発火
- cwdが無効な状態になっている

## 追加バグ: Claude Code起動時に Unexpected エラー

ccgramが `/new claude-env` でtmuxセッションを作り、Claude Codeを起動しようとした時に：

```
CCGRAM_SESSION_NAME='claude-env' CCGRAM_SESSION_TYPE='tmux' claude
error: An unknown error occurred (Unexpected)
```

Claude Code自体が起動できずクラッシュ。その後tmuxセッションは残り、session-mapには「running」として残るため、次の `/new` が「already running」で弾かれる。

**原因推測:** `CCGRAM_SESSION_NAME` 環境変数がClaude Codeの起動に干渉している可能性。あるいは前回のクラッシュで不整合な状態が残っている。

## 復旧手順

```bash
echo '{}' > ~/.ccgram/src/data/session-map.json
tmux kill-session -t claude-env 2>/dev/null
launchctl kickstart -k gui/$(id -u)/com.ccgram
# → Telegramから /new claude-env
```
