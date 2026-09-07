# Focus Sanctuary — 3D MAX EDITION

**CHRONO CHRYSALIS — 時間を包む浮遊彫刻（造形名: CLEFT VAULT）**

**公開版: https://focus-sanctuary-3d-max.vercel.app**（WebGL2 が有効なデスクトップ Chrome / Edge 推奨）
ソース: https://github.com/shotaro-nagano/focus-sanctuary-3d-max

> 見どころ: 登場演出（読み込み後 約 3 秒、`REPLAY` で再鑑賞）→ 彫刻をドラッグして回す → `SHORT` / `LONG` でモード変化 →
> [完了演出のプレビュー](https://focus-sanctuary-3d-max.vercel.app/?preview=complete)（25 分待たずに M10 を再生。実績は記録されません）

機能はシンプルなポモドーロタイマー（集中 25 分／短い休憩 5 分／長い休憩 15 分）。
外観は、真っ暗な無限空間に浮かぶ **液体クロームの五枚花弁の繭** です。螺旋状のシームで分割された厚みのある金属殻、斜めに裂けた開口部、赤道の細いスリット、内側の 3 本のブラッシュドメタルのキール、六角プリズムガラスの結晶コアと発光フィラメント、3 本のガラスサッシュ、そして欠けた 3 本の軌道ブレード。時間が進むとシームに光が這い上がり、殻がねじれて締まり、集中が終わると一度完全に閉じてから花のように弾けて次の形へ再構成されます。

- 実行時 3D: **three.js 0.185.1**（WebGL2、MeshPhysicalMaterial の transmission / dispersion / iridescence / clearcoat / anisotropy、独自 onBeforeCompile シェーダー注入、UnrealBloom ＋ 独自グレーディングパス）
- モーション: **GSAP 3.15**（登場・モード変化・完了の 3 つのタイムライン ＋ ポインター／ドラッグのスプリング）
- ビルド: **Vite 6.4 + TypeScript 5.9**、テスト: **Vitest 3.2**
- 3D モデル・HDRI・テクスチャは一切使っていません。造形・環境マップ・ノイズはすべてコードで生成しています。

---

## 1. 起動方法

必要なもの: **Node.js 18 以上**（開発は Node 18.13 / npm 8.19 で確認）。ブラウザは WebGL2 が有効なもの。

```bash
npm install
npm run dev
```

`npm run dev` が表示する URL（既定 `http://localhost:5173/`）をブラウザで開きます。
**`index.html` をダブルクリックしても動きません。** ES モジュールとフォントの読み込みに HTTP 配信が必要です。

```bash
npm run build      # tsc --noEmit → dist/ に静的ファイルを出力（base './' なのでサブディレクトリ配置も可）
npm run preview    # dist/ をローカル配信して確認（http://localhost:4173/）
npm run typecheck  # 型検査のみ
npm test           # Vitest（タイマー状態機械 58 件 ＋ モーション合成規則 12 件）
```

`dist/` は静的ホスティングにそのまま置けます。サーバー処理はありません。

### 品質プリセットと URL オプション（開発・比較用）

| パラメータ | 内容 |
| --- | --- |
| `?quality=ultra\|high\|medium\|low` | 描画品質。既定は PC = `high`、モバイル = `medium`。`ultra` は DPR 2・床の平面反射・フル解像度 transmission。 |
| `?preview=complete` | 登場演出の後に **完了演出（M10）だけを再生**。実績・タイマーは一切書き換えません。`&nointro=1` を付けると即再生。 |
| `?speed=60` | **試験用の時計**。実時間の経過を N 倍にします（例: 60 なら 1 秒で 1 分）。本番の 25／5／15 分は変わりません。画面に `TEST CLOCK ×60` と表示され、保存先は自動的にメモリになります。 |
| `?pose=idle\|focus\|shortBreak\|longBreak\|paused` | 見た目のポーズだけを切り替え（タイマー状態は変更しない）。静止画撮影用。 |
| `?nointro=1` | 登場演出をスキップ。 |
| `?reduce=1` | OS の「動きの低減」相当の動作を強制。 |
| `?storage=local\|session\|memory` | 保存先。既定は `local`（localStorage）。比較検証時は `memory` か `session` を推奨。 |
| `?fps=1` | 画面上部に FPS・ドローコール・三角形数を表示（`window.__fps` にも公開）。 |

保存キーは `focus-sanctuary-3d-max:v1`。他のキーには触れません。

---

## 2. 造形と演出の狙い

### 主役の造形（CLEFT VAULT）

- **外殻**: 高さ 3.2・幅 2.2 の底重心の紡錘形を、螺旋シアー（0.45 rad）の 5 本のシームで不均等な花弁（96/78/60/84/42°）に分割。各花弁は外面・内面・4 つの断面を独立メッシュ化した **厚みのある板** で、赤道スリット、上部の斜めの裂け目（クレフト）、独立した「扉」花弁を持ちます。頂点シェーダーのねじれ（`shellTwist`）でシームの螺旋が締まったり緩んだりします。
- **内部**: ブラッシュド（異方性）仕上げのキール 3 本 ＋ 緯線リング、六角ラス（六角柱）の結晶コアと内側の発光フィラメント ＋ 3 本の逆回転リング。
- **ガラスサッシュ**: 3 本の螺旋帯（先端が尖る）。`ribbonTwist` / `ribbonSpread` が変わると CPU で頂点を再生成し、休憩時にはシームの隙間から外へ出ていきます。
- **軌道ブレード**: 半径・傾き・周期の異なる 3 本の断片。C は **進捗アーク**（残り時間に応じて描画長が伸び、先端が発光）。
- **粒子**: 前景・中景・遠景の 3 層（1 つの ShaderMaterial、渦＋漂い＋コアへの引力場）。
- **床**: 接地影（`ultra` では 512px の平面反射も）。

### 素材と光

- 環境マップは **手続き的なスタジオ**（暗いグラデーションドーム ＋ ソフトボックス ＋ 縦・曲面の白いストリップ ＋ 低いシトロン帯 ＋ 小さなピンク）を PMREM 化。ポインターと時間で `environmentRotation` を動かし、反射が面を滑ります。
- クローム: metalness 1 / roughness 0.025〜0.05（ノイズテクスチャとフラグメント内ノイズで磨きムラ）/ clearcoat 0.5。フレネルのリム発光、モード色を斜め方向の間接反射に混ぜる `envTint`。RectAreaLight のストリップが M04／M07 で横に滑ります。
- ガラス: transmission 1.0、thickness 0.35／0.5、ior 1.55／1.75、dispersion 0.35、iridescence 0.6（縁だけに分光）。**three.js の transmission は透過体同士を屈折させません**（各透過体は不透明バッファだけを見ます）。`low` プリセットでは transmission を切り、フレネル縁光付きの半透明マテリアルに置き換えます（README で明記する約束どおり、これは近似です）。
- ポスト: UnrealBloom（閾値 1.25、発光体だけがにじむ）→ ビネット・端だけの色収差・微細グレイン・一時停止時の減彩 → ACES。ブルーム入力は NaN/Inf をゼロにし 24 でクランプするガードを入れています。

### 12 の演出（M01〜M12）と状態連動

| 状態 | 見た目 |
| --- | --- |
| 待機 | シームが少し開き、内部のガラスとシトロンの核が覗く。90 秒周期の自転と 7／11 秒の浮遊。 |
| 集中 | 殻が閉じ（shellOpen 0.06）、軌道がジャイロ状に整列し 2.3 倍速。進捗 0→100% で **シーム光が下から上へ這い上がり**、ねじれが 0.35→0.95 rad へ締まり、コアが膨らみ、進捗アークが伸びる。低いカメラアングルで上端を意図的に切る。 |
| 短い休憩 | 花弁が滑り出て扉が少し開き、サッシュが隙間から外へ。氷色。 |
| 長い休憩 | 花弁が完全に開いた花の形、サッシュがほどけて垂れる。淡い暖色、広いカメラ。 |
| 一時停止 | シーンの時計（`timeScale`）を 0 へ減速して位相ごと凍結。減彩・ビネット・リム強調で静止画として構成。再開は同じ位相から再加速。 |
| 完了 | 収束（粒子がコアへ、殻が **初めて完全に閉じる**）→ 解放（ねじれの逆回転から花弁が花弁ごとに弾け、扉 90°、ハブ持ち上げ、キール展開、サッシュが殻の外へ、衝撃波リング）→ 文字（FOCUS がバンドワイプ、SESSION／COMPLETE）→ 弾性で次の休憩の形へ再構成。 |

M01 登場（約 3 秒: シーム唇のマクロ → ドリーアウト → FOCUS／SANCTUARY のマスク出現 → 軌道の飛来 → 数字とコンソールの組み上がり。**REPLAY** で再鑑賞、タイマー非干渉）、M02〜M03（複合周期・液体的な表面のうねり）、M04〜M05（ポインター視差 ＋ ドラッグ ±40°／±15°、慣性復帰）、M06〜M09（上表）、M10（完了）、M11（磁力ボタン、押下で殻の呼吸と光の揺れ）、M12（文字単位のマスク・ずれ・入れ替わり）を 1 つの合成規則で統合しています。詳細は `docs/ARCHITECTURE.md` と `docs/ART_PLAN.md`。

---

## 3. 基本機能

- 開始／一時停止／再開／リセット／モード選択（実行中の破棄は小さなクローム板の確認ダイアログ）。
- 時間は **終了予定時刻（epoch）から計算**。タブ切替・再読み込みでも復元。一時停止は残り時間を保持し、再開時に新しい終了時刻を求めます。
- 集中完了だけを 1 回・25 分として記録。4 回目ごとに長い休憩。休憩後は集中へ戻り、**次のモードは待機**（自動連続なし）。
- 放置中に終了時刻を過ぎていた 1 セッションは、復帰時に 1 回だけ完了扱い。完了はセッション ID で管理し、記録と次状態を 1 回の保存に束ねて二重加算を防ぎます。
- 集計は端末のローカル日付（終了予定時刻の日付に計上）。通算回数は日付変更でリセットしません。
- 保存不可（localStorage が使えない）でもメモリ内で動作し、コンソールに短く通知します。入力した作業名は文字列として扱い、HTML として実行しません。
- 完了音は実装していません（任意項目）。

---

## 4. 実際に確認した環境

| 項目 | 内容 |
| --- | --- |
| OS / GPU | Windows 11 Home 10.0.26200 / Intel Iris Xe Graphics（ANGLE D3D11, WebGL 2.0） |
| ブラウザ | Chromium 1223（Playwright 同梱）— 実 GPU での画面確認・録画に使用。Claude Code のアプリ内ブラウザ（Chromium）でも WebGL2 動作を確認 |
| 画面 | 1440×900（DPR 1）、390×844（DPR 2・モバイルエミュレーション） |
| 実測 FPS（`?fps=1`） | `high` 1440×900 DPR 1: **52〜60 fps**（30 秒連続で 51〜55）。`high` DPR 2（アプリ内ブラウザ）: 約 34 fps。`medium` 390×844 DPR 2: 55〜60 fps。DPR 2 の `ultra`（床反射あり）: 約 21 fps。60 fps は DPR 1 の `high` でのみ到達しています。 |
| ドローコール / 三角形 | `high`: 約 90 コール（transmission の不透明パス・ブルームを含む）、約 20 万三角形 |

視覚・機能の確認記録は **`VISUAL_QA.md`** を参照してください。

---

## 5. 素材・フォント・依存

| 種類 | 名称 | ライセンス／出典 |
| --- | --- | --- |
| フォント | Unbounded Variable（ワイドディスプレイ） | SIL OFL 1.1 — `@fontsource-variable/unbounded`（npm 同梱） |
| フォント | Instrument Serif Italic（エディトリアルセリフ） | SIL OFL 1.1 — `public/fonts/`（`instrument-serif-OFL.txt` 同梱） |
| フォント | JetBrains Mono Variable（数字・ラベル） | SIL OFL 1.1 — `@fontsource-variable/jetbrains-mono`（npm 同梱） |
| ライブラリ | three 0.185.1 / gsap 3.15.0 / vite 6.4.3 / typescript 5.9.3 / vitest 3.2.7 | それぞれ MIT（gsap は Standard "no charge" license） |
| 3D 素材 | なし | 造形・環境マップ・ノイズはすべて手続き生成 |

`package-lock.json` を同梱しています。`node_modules` は含めません。

---

## 6. 開発用ツール

```bash
python tools/functional_check.py            # F01〜F06 を実 UI で自動検証（Playwright, 実 GPU, 試験用時計 ×60/×600）
python tools/capture.py --headed shots      # PC／モバイルの各ポーズ静止画 → captures/
python tools/capture.py --headed video      # デモ動画（webm）→ captures/
python tools/capture.py --headed fps        # FPS 計測
```

Python 3.12 ＋ `playwright`（Chromium）が必要です。`--headed` を付けない場合は SwiftShader（ソフトウェア描画）になり、見た目は忠実ですが速度は参考になりません。

`dev/scene.html`（`/dev/scene.html`）は 3D シーンだけを表示する開発ハーネスです（キー 1〜4 でポーズ、g でグレー素材、w でワイヤーフレーム）。

---

## 7. 既知の制限

- transmission の仕様上、ガラス同士は互いを屈折させません。サッシュが結晶の手前を横切る部分は、結晶の直接描画がそのまま見えます。
- `low` プリセットのガラスは近似（背景の歪みなし）。モバイルの既定は `medium`（transmission 半解像度・粒子 40%・床反射なし）。
- WebGL が使えない環境と、描画コンテキスト喪失時は、静的な CSS 構図と「3D UNAVAILABLE」表示に切り替わります。これは 3D 要件の達成ではなく代替表示です。
- 開発サーバー（`npm run dev`）では初回読み込みにモジュール変換の時間がかかります。ビルド版（`npm run preview`）の方が登場演出の直前まで速く到達します。
