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

## 追加情報（2026-03-20 20:00）

- ビルド+rsyncで全distコピー済み。MODULE_NOT_FOUNDは解消。
- しかしtmuxセッション内で `claude`（環境変数なし）を打っても同じエラー。
- **Ghosttyから直接 `claude` を打つと正常に起動する。**
- つまりtmuxセッション内の環境に問題がある。
- `tmux show-environment` にはCCGRAM_*は無い。
- ccgramが `tmux new-session` で作ったセッション内でだけ起動不能。シェル環境かPATHか何かが壊れてる可能性。

## 最終的に分かったこと（2026-03-20 夜）

### 原因1: `CCGRAM_SESSION_*` を Claude 起動コマンドに前置すると壊れる

これは最初の報告どおり事実だった。
`CCGRAM_SESSION_NAME=... CCGRAM_SESSION_TYPE=... claude` は Claude Code の起動に干渉する。

対策:

- `buildClaudeLaunchCommand()` から `CCGRAM_SESSION_*` 前置を削除
- ccgram 内部で必要な識別用 env は `CCGRAM_MANAGED_SESSION_*` に変更
- ただし **tmux 起動経路では env 注入自体をやめた**
- PTY 経路だけ `CCGRAM_MANAGED_SESSION_*` を使う

### 原因2: 問題は tmux 一般ではなく、default tmux server 側にあった

実機で切り分けた結果:

- `tmux` の default server 上で作った session では `claude -p "reply only ok"` が `Unexpected` で失敗
- しかし隔離した tmux server（例: `tmux -L ccgram -f /dev/null`）では同じ cwd でも成功
- 対話起動 `claude` も dedicated server では正常起動

つまり、壊れていたのは ccgram の session 名ではなく、
**既存の default tmux server にぶら下がっていたこと** が本質だった。

### 原因3: hook 側の managed 判定が cwd の大文字小文字差で落ちていた

`claude-env` 内で観測した実値:

```bash
pwd            -> /Users/kapi/Documents/Github/claude-env
/bin/pwd -P    -> /Users/kapi/Documents/GitHub/claude-env
```

tmux 内の shell は `Github` 表記、実パスは `GitHub` 表記になっていた。
`resolveSessionContext()` は `candidate.cwd !== resolvedCwd` の完全一致だったため、

- session-map 上は `/Users/kapi/Documents/Github/claude-env`
- hook payload 側は `/Users/kapi/Documents/GitHub/claude-env`

となると managed 判定が落ち、Telegram に返送されなかった。

対策:

- `workspace-router.ts` で `cwd` を `realpathSync.native()` で正規化して保存
- `session-identity.ts` でも `cwd` 比較前に正規化
- これで `Github` / `GitHub` の表記ゆれを吸収

## 最終修正

### 1. ccgram の tmux session を dedicated socket に分離

ccgram が作る tmux session は default server ではなく、専用 socket に載せる:

```bash
tmux -L ccgram -f /dev/null new-session -d -s claude-env -c /path/to/project
```

その後の `send-keys` / `capture-pane` / `has-session` も、

- まず `tmux -L ccgram`
- 見つからなければ `tmux` default server

の順に見るようにした。これで:

- 新規の ccgram session は dedicated server で安定起動
- 既存の古い session には fallback で触れる

### 2. session-map の `cwd` を canonical path に統一

保存時も照合時も `realpathSync.native()` で正規化する。
これで hook 判定が安定し、Telegram 返送が復活した。

### 3. 読み取り専用 attach も dedicated server 前提に変更

```bash
tmux -L ccgram attach -t claude-env -r
```

default server に attach しても ccgram session は見えない。

## その後の確認結果

実施した確認:

- `npm run build` 成功
- `npm test` 成功
- dedicated tmux server 上で `claude -p "reply only ok"` 成功
- dedicated tmux server 上で対話起動 `claude` 成功
- `claude-env` session 内で Telegram 経由メッセージに応答
- session-map が `starting` -> `completed` に更新
- `sessionId` が保存されることを確認

最終的に、pane 上では:

```text
❯ 一言だけで ok と返して
⏺ ok
```

を確認できた。

## 今後また壊れにくい理由

- Claude 起動コマンドに危ない env を前置しない
- default tmux server の汚染や設定差分を踏まない
- `cwd` 比較を文字列完全一致ではなく canonical path ベースにした
- session-map と hook 側の解決ロジックが同じ正規化を使う

## それでも残るリスク

### 1. dedicated tmux server を手で壊した場合

`tmux -L ccgram kill-server` すると ccgram 管理 session は全部消える。
その場合は `/new` で作り直しになる。

### 2. PTY 経路の実運用テストは tmux ほど厚くない

PTY 側は今回の主戦場ではなかった。
識別用 env を `CCGRAM_MANAGED_SESSION_*` に変えてあるが、
運用で長時間回した検証はまだ薄い。

### 3. 他のコードが default tmux server 前提で直接 `tmux ...` を叩くと再発余地がある

今回の `/new` `/resume` `/inject` の経路は dedicated socket 対応済み。
ただし別ファイルの古いユーティリティが将来 default server を前提に叩くと、
そこだけ挙動差が出る余地はある。

## 障害時の確認コマンド

### session 一覧

```bash
tmux -L ccgram ls
```

### 読み取り専用で覗く

```bash
tmux -L ccgram attach -t claude-env -r
```

### pane の末尾を見る

```bash
tmux -L ccgram capture-pane -pt claude-env -S -80
```

### session-map を見る

```bash
cat ~/.ccgram/src/data/session-map.json
```

### bot のログを見る

```bash
tail -n 200 ~/.ccgram/logs/bot-stdout.log
tail -n 200 ~/.ccgram/logs/bot-stderr.log
```
