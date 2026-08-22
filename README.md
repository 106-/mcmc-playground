![Metropolis-Hastings Playground header](assets/readme-header.svg)

# Metropolis-Hastings Playground

好きな確率分布をキャンバスに描き、その分布の形を元にMetropolis-Hastings法でデータサンプルを作り、そのデータのヒストグラムと見比べるためのサイトです。

## 使う

[Metropolis-Hastings Playground](https://106-.github.io/metropolis-hastings-playground/)

## 操作

- 上段左のグラフをドラッグして目標分布を変更
- サンプル数と正規ランダムウォークの歩幅 `σ` を調整
- 「サンプリング開始」で実行、`+1` で1ステップ、`↺` で結果だけリセット
- 「一様」「ふた山」「かたより」からプリセットを選択

分布は未正規化の相対的な高さとして扱います。区間外の提案は目標密度 0 として棄却し、最初の100ステップをバーンインとして除外します。
