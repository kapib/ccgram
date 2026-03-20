# 残存バグ: inject直後にターミナルセッションの発言がTelegramに漏れる

## 症状

kuro-daemon-test.sh（またはkuro-daemon.sh）がinject APIを呼んだ直後に、
ターミナルセッション（ユーザーが直接起動したClaude Code）で応答が発生すると、
その応答がTelegramに送信されてしまう。

具体例:
1. `kuro-daemon-test.sh` → inject API → ccgram → Telegramセッションのクロスケが応答 ✅
2. **ほぼ同時に** ターミナルセッションで「来た？漏れてない？」と発言
3. ターミナルセッションのStop hookが発火
4. **この発言がTelegramに送信されてしまう** ❌

## 原因

`enhanced-hook-notify.ts` の79行目:
```typescript
if (!sessionContext.managed && !isTelegramInjected) {
    return;
}
```

`managed = false`（ターミナルセッションにはCCGRAM_SESSION_NAME未設定）だが、
`isTelegramInjected = true` になるため、returnせず送信に進む。

### なぜ isTelegramInjected = true になるか

```typescript
const isTelegramInjected = !!(tmuxSession && isRemoteSessionActive(tmuxSession));
```

1. inject時に `startTypingIndicator("claude-env")` が呼ばれる
2. remote stateに `claude-env` キーでエントリが登録される
3. ターミナルセッションのStop hookが発火
4. `detectSessionName(cwd)` → `CCGRAM_SESSION_NAME` 未設定 → cwdから `claude-env` を導出
5. `isRemoteSessionActive("claude-env")` → **true**（Telegramセッション用のstateがまだ残ってる）
6. `isTelegramInjected = true`

**根本原因:** ターミナルセッションとTelegramセッションのセッション名が
同じ `claude-env`（cwdから導出）になるため、remote stateの照合で誤一致する。

## 再現条件

- ターミナルセッション（CCGRAM_SESSION_NAME未設定）とTelegramセッション（ccgram管理）が同じcwdで動いている
- inject APIが呼ばれた直後（remote stateが残っている間）に、ターミナルセッションでStop hookが発火する
- kuro-daemonが5分おきに走る運用では、inject直後にターミナルで作業していれば毎回漏れる可能性がある

## 提案する修正方針

`isTelegramInjected` の判定で、`managed` でないセッションは除外すべき。

```typescript
// 案1: managedでなければisTelegramInjectedも強制false
const isTelegramInjected = sessionContext.managed
    && !!(tmuxSession && isRemoteSessionActive(tmuxSession));

// 案2: 条件を AND に変更
if (!sessionContext.managed) {
    return;  // ccgram管理外セッションは一切送信しない
}
```

案2の方がシンプルで安全。ccgram管理外セッションからTelegramに送信するケースは存在しないはず。

## 影響範囲

- `enhanced-hook-notify.ts` の判定ロジック1箇所
- 既存のTelegramからの操作（スマホからメッセージ送信、パーミッション承認等）には影響なし
  （それらはccgram管理セッション内で発火するため `managed = true`）

## テスト方法

1. ターミナルで直接Claude Codeを起動（claude-envディレクトリ）
2. Telegramから `/new claude-env` でセッション立ち上げ
3. inject APIでTelegramセッションにメッセージ送信
4. inject直後にターミナルセッションで何か操作
5. ターミナルセッションの応答がTelegramに**漏れない**ことを確認
6. Telegramセッションの応答は**ちゃんと届く**ことを確認
