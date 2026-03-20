# 致命的バグ: CCGRAM_SESSION_NAME 環境変数でClaude Codeが起動不能

## 症状

ccgramが `/new claude-env` でtmuxセッションを作成し、Claude Codeを起動しようとすると即座にクラッシュ。

```
CCGRAM_SESSION_NAME='claude-env' CCGRAM_SESSION_TYPE='tmux' claude
error: An unknown error occurred (Unexpected)
```

Claude Codeが起動できない。tmuxセッション内でシェルが固まる。

## 再現手順

```bash
# これは失敗する
CCGRAM_SESSION_NAME='claude-env' CCGRAM_SESSION_TYPE='tmux' claude

# これは成功する
claude
```

環境変数なしなら正常に起動する。

## 原因

今回の安定化修正（コミット `b0d1402`）で、`buildClaudeLaunchCommand` に `CCGRAM_SESSION_NAME` と `CCGRAM_SESSION_TYPE` 環境変数を追加した。この環境変数がClaude Code本体の起動プロセスに干渉してクラッシュを引き起こしている。

該当コード（`workspace-telegram-bot.ts`）:
```typescript
function buildClaudeLaunchCommand(
  sessionName: string,
  sessionType: 'tmux' | 'pty',
  args: string[] = []
): string {
  const envPrefix = [
    `CCGRAM_SESSION_NAME=${shellEscape(sessionName)}`,
    `CCGRAM_SESSION_TYPE=${shellEscape(sessionType)}`,
  ].join(' ');
  // ...
  return `${envPrefix} claude${escapedArgs ? ` ${escapedArgs}` : ''}`;
}
```

## 影響

- **Telegramからのセッション起動が完全に不能**
- `/new` も `/resume` も全て失敗
- tmuxセッションの残骸が残り、次の `/new` が「already running」で弾かれる
- ccgram経由のリモート操作が全滅

## 修正方針

環境変数をClaude Code起動コマンドのプレフィックスとして渡す方式をやめる。代替案:

**案1: tmux環境変数として設定**
```bash
tmux set-environment -t claude-env CCGRAM_SESSION_NAME claude-env
tmux set-environment -t claude-env CCGRAM_SESSION_TYPE tmux
tmux send-keys -t claude-env 'claude' C-m
```
tmuxのセッション環境変数として設定すれば、その中で起動するプロセスが継承する。Claude Codeの起動コマンド自体には環境変数が含まれない。

**案2: ファイルベースで識別**
環境変数を使わず、session-map.jsonとtmuxセッション名だけで識別する。
enhanced-hook-notifyは `detectSessionName()` でtmuxセッション名を取得し、session-mapと照合する。

**案3: 環境変数注入を一旦外す**
`buildClaudeLaunchCommand` から環境変数プレフィックスを除去して元の動作に戻す。
セッション識別は既存の `detectSessionName()`（tmuxセッション名 or cwd導出）に頼る。

## 推奨

**案1が最も安全。** tmux set-environmentなら Claude Codeの起動コマンドに影響しない。tmux内の子プロセスが環境変数を継承する。

## 暫定復旧

```bash
# 壊れたセッションを掃除
echo '{}' > ~/.ccgram/src/data/session-map.json
tmux kill-session -t claude-env 2>/dev/null
# ccgramを再起動（環境変数注入のバグが残ってるので /new は同じエラーになる）
launchctl kickstart -k gui/$(id -u)/com.ccgram
```

**注意:** 修正がデプロイされるまで、Telegramからのセッション起動は不可能。
