# 追加報告: 修正後のテスト結果 — 悪化

## 前回の修正依頼

`docs/remaining-leak-issue.md` でinject直後のターミナル発言漏れを報告。

## 修正後のテスト結果

修正適用後にテストしたところ、**悪化した**。

### 症状

1. **ターミナルセッションの発言がTelegramに漏れる** — 修正前と同じ。直っていない
2. **Telegramセッションのクロスケの応答がTelegramに届かなくなった** — 修正前は届いていた。**新たに壊れた**

### つまり

- Before: クロスケの応答 ✅、ワイの発言漏れ ❌（inject直後のみ）
- After: クロスケの応答 ❌、ワイの発言漏れ ❌

修正により「Telegramセッションからの正規の応答送信」まで遮断してしまった可能性がある。

### テスト手順

```bash
# inject APIでテストメッセージ送信
bash ~/Documents/GitHub/claude-env/scripts/kuro-daemon-test.sh
# → SUCCESS: {"ok":true,"workspace":"claude-env"}

# inject直後にターミナルで普通に会話
# → ターミナルの発言がTelegramに漏れた
# → Telegramセッションのクロスケの応答がTelegramに届かなかった
```

### 修正の方向性について

前回提案した案2（`!sessionContext.managed` なら一切送信しない）をそのまま適用すると、
Telegramセッション側のhookまで弾く可能性がある。

ポイントは:
- Telegramセッション内のClaude Codeには `CCGRAM_SESSION_NAME` が設定されている → `managed = true` のはず
- ターミナルセッションには `CCGRAM_SESSION_NAME` が未設定 → `managed = false`

もし Telegramセッションの応答が届かなくなったのであれば、
Telegramセッション内で `CCGRAM_SESSION_NAME` が正しく設定されていない可能性がある。

### 確認してほしいこと

1. ccgramが `/new claude-env` でtmuxセッションを作る時、`CCGRAM_SESSION_NAME` がClaude Codeプロセスに正しく渡っているか
2. Telegramセッション内のenhanced-hook-notifyが発火した時、`sessionContext.managed` が `true` になっているか
3. `resolveSessionContext` のデバッグログを入れて、各セッションからの発火状況を確認してほしい
