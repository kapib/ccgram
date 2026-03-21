# 画像受信（Telegram → Claude Code）実装計画

> 2026-03-21 作成

## 概要

Telegramから送信した画像をClaude Codeが認識できるようにする。
ccgramの画像送受信対応の第一歩であり、他の画像関連機能（スクショ送信等）の土台となる。

## 現状の問題

- `processMessage` で `msg.text` が空なら即return → 画像メッセージは完全に無視される
- `TelegramMessage` 型に `photo`, `caption` フィールドが存在しない
- バイナリファイルのダウンロード機能がない

## 変更対象ファイル

| ファイル | 変更内容 | 追加行数（目安） |
|----------|----------|------------------|
| `src/types/telegram.ts` | PhotoSize型追加、TelegramMessageにphoto/caption追加 | +15行 |
| `workspace-telegram-bot.ts` | 画像ダウンロード関数、processMessage拡張 | +70行 |

合計: 2ファイル、約+85行

## 実装ステップ

### Step 1: 型定義の拡張 — `src/types/telegram.ts`

```typescript
export interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}
```

`TelegramMessage` に以下を追加:

```typescript
photo?: PhotoSize[];
caption?: string;
```

### Step 2: 画像ダウンロード関数 — `workspace-telegram-bot.ts`

新関数 `downloadTelegramPhoto(fileId: string): Promise<string>` を追加。

処理フロー:
1. `telegramAPI('getFile', { file_id })` でファイル情報取得
2. レスポンスの `file_path` を使い `https://api.telegram.org/file/bot{TOKEN}/{file_path}` からダウンロード
3. `/tmp/ccgram-images/{timestamp}-{file_unique_id}.jpg` に保存
4. ローカルファイルパスを返す

補足:
- ダウンロードはNode.js標準の `https.get` でバイナリ受信（既存の `httpJSON` はJSON専用なので使わない）
- `/tmp/ccgram-images/` ディレクトリは存在しなければ `mkdirSync` で作成

### Step 3: processMessage の拡張 — `workspace-telegram-bot.ts`

既存の早期リターン `if (!text) return;` の**前**に画像チェックを挿入:

```
if (msg.photo && msg.photo.length > 0) {
  // 1. 最大サイズの画像を選択: msg.photo[msg.photo.length - 1]
  // 2. downloadTelegramPhoto(fileId) でローカルに保存
  // 3. caption があればそれを使用、なければ「この画像を確認してください」
  // 4. テキストとして組み立て: "{caption}\n\n画像: {localPath}"
  // 5. ワークスペース解決 → injectAndRespond() に渡す
  return;
}
```

### Claude Code側の動作

- Claude Codeはマルチモーダル対応 — `Read` ツールで画像ファイルパスを渡せば画像を認識できる
- つまりccgram側で特別な画像エンコード等は不要。パスをテキストとして渡すだけでOK

## ワークスペース解決の課題

画像メッセージにはテキストコマンドがないため、どのワークスペースに送るかの判定が必要:

- **reply_to_message がある場合**: そのメッセージのワークスペースを使用（既存ロジックと同じ）
- **reply_to_message がない場合**: アクティブなワークスペースが1つならそこへ、複数なら選択を促す

## リスク・注意点

- Telegram Bot APIのファイルサイズ上限は **20MB**（Bot APIの制限）
- 大きい画像は圧縮されて複数サイズで届く（PhotoSize配列）ので最大サイズを選べばOK
- `/tmp` は再起動で消えるが、一時ファイルなので問題なし
- GIF/動画は今回スコープ外（`animation`, `video` フィールドは別対応）

## 今回スコープ外

- 画像送信（Claude Code → Telegram）: multipart/form-data対応が必要で別タスク
- ドキュメント/ファイル受信: `document` フィールド対応は次フェーズ
- 画像の永続保存: 今回は `/tmp` で十分
