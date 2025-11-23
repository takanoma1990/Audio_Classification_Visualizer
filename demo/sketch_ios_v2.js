// 1. MediaPipe Audio のモジュールを import
import { AudioClassifier, FilesetResolver } from "./task-audio/audio_bundle.mjs";

// 2. p5.js インスタンスモード
const sketch = (p) => {

  // ==== 定数・データ構造 =========================================

  const CATEGORIES_HIERARCHY = {
    "Forest & Life": ["Bird", "Rustling leave"],
    "Water": ["Ocean", "Water", "Stream"],
    "Atmosphere": ["Thunderstorm", "Wind", "Fire"],
    "Traffic": ["Aircraft", "Car", "Rail transport"],
    "Music": ["Drum machine", "Percussion", "Synthesizer"],
  };

  const CATEGORY_COLORS = {
    "Forest & Life": 120,
    "Water": 190,
    "Atmosphere": 60,
    "Traffic": 0,
    "Music": 30,
  };

  const allTargetCategories = Object.values(CATEGORIES_HIERARCHY).flat();

  const SCORE_BOOST = 10.0;
  const SPECIAL_BOOSTS = {
    "Speech": 0.001,
    "Music": 0.1,
    "Thunderstorm": 2.0,
  };

  // ==== 音・モデルまわり =========================================

  let fft;
  let audioClassifier;
  let soundFile;
  let scriptNode;
  let myFont;

  let isPlaying = false;
  let statusMessage = "Initializing...";

  let bassLevel = 0;
  let smoothedBassLevel = 0;
  const waveformSmoothing = 0.1;
  let smoothedWaveform = [];

  // iOS 向け：処理を軽くするために推論呼び出しを間引く
  let processCounter = 0;

  // カテゴリごとのスコア
  let categoryData = {};
  let musicScoreData = { targetScore: 0 };

  // ==== ビジュアル ===============================================

  // カテゴリアイコン
  let iconImages = {};

  // 2D で流すアイコンの情報
  let flowingIconsHistory = [];
  let groupCooldowns = {};

  // 背景色制御
  let targetHue = 210;
  let currentHue = 210;

  // ==== 初期化 ===================================================

  p.preload = () => {
    myFont = p.loadFont("Roboto-Regular.ttf");
    soundFile = p.loadSound("music/beat_ambient.mp3");

    // カテゴリ名と同じファイル名のアイコン PNG を読み込む
    allTargetCategories.forEach((categoryName) => {
      const path = `icons/${categoryName}.png`;
      iconImages[categoryName] = p.loadImage(
        path,
        () => console.log(`Successfully loaded: ${path}`),
        () => console.error(`Failed to load: ${path}`)
      );
    });
  };

  p.setup = async () => {
    p.createCanvas(p.windowWidth, p.windowHeight); // 2D
    p.colorMode(p.HSB, 360, 100, 100, 1.0);
    p.textFont(myFont);
    p.textAlign(p.CENTER, p.CENTER);

    // カテゴリデータ初期化
    allTargetCategories.forEach((name) => {
      categoryData[name] = {
        displayName: name,
        currentScore: 0,
        targetScore: 0,
      };
    });

    // グループごとのクールダウン（アイコン出し過ぎ防止）
    Object.keys(CATEGORIES_HIERARCHY).forEach((major) => {
      groupCooldowns[major] = 0;
    });

    // FFT セットアップ（音源：読み込んだ soundFile）
    fft = new p5.FFT(0.8, 256);
    fft.setInput(soundFile);

    // MediaPipe Audio セットアップ
    await setupMediaPipe();
    statusMessage = "Tap or press Space to Play";
  };

  // ==== メインループ =============================================

  p.draw = () => {
    // 背景の色をカテゴリスコアから決める
    updateHueFromCategories();

    const bgBrightness = p.map(smoothedBassLevel, 0, 1.5, 12, 35, true);
    p.background(currentHue, 60, bgBrightness);

    // 再生中なら音声解析
    if (isPlaying && fft) {
      let spectrum = fft.analyze();
      bassLevel =
        p.map(fft.getEnergy("bass"), 0, 255, 0, 1) +
        p.map(fft.getEnergy("mid"), 0, 255, 0, 1) +
        p.map(fft.getEnergy("treble"), 0, 255, 0, 1);
    } else {
      bassLevel *= 0.95;
    }

    smoothedBassLevel = p.lerp(smoothedBassLevel, bassLevel, 0.3);

    // カテゴリスコアをターゲットに向かってスムージング
    updateCategoryScores();

    // クールダウンを減らす
    for (const major in groupCooldowns) {
      if (groupCooldowns[major] > 0) groupCooldowns[major]--;
    }

    // 2D 波形ラインの描画
    drawWaveformLine();

    // カテゴリアイコン生成（しきい値を超えたら）
    spawnIconsFromCategories();

    // アイコンを流して描画
    drawFlowingIcons();

    // ステータス表示
    drawStatusText();
  };

  // ==== 入力系（PC / iOS 共通の操作） ============================

  p.keyPressed = () => {
    if (p.keyCode === 32) {
      // Space
      togglePlay();
    }
  };

  p.mousePressed = () => {
    togglePlay();
  };

  // iOS のタップでも確実に拾いたいとき
  p.touchStarted = () => {
    togglePlay();
    // 画面スクロールを防ぐ場合は false を返す
    return false;
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  function togglePlay() {
    const audioContext = p.getAudioContext();
    if (audioContext.state !== "running") {
      audioContext.resume();
    }

    if (soundFile.isPlaying()) {
      soundFile.pause();
      isPlaying = false;
      statusMessage = "Paused. Tap or press Space to Play.";
    } else {
      soundFile.loop();
      isPlaying = true;
      statusMessage = "Playing... Tap or press Space to Pause.";
    }
  }

  // ==== MediaPipe Audio セットアップ =============================

  async function setupMediaPipe() {
    try {
      statusMessage = "Loading Audio Model...";
      const audioTasks = await FilesetResolver.forAudioTasks("./task-audio/wasm");
      audioClassifier = await AudioClassifier.createFromOptions(audioTasks, {
        baseOptions: {
          modelAssetPath: "./models/yamnet.tflite",
          delegate: "CPU",
        },
        maxResults: -1,
        scoreThreshold: 0.0001,
      });

      const audioCtx = p.getAudioContext();

      // iOS向け：バッファを小さめ・推論は間引き
      const bufferSize = 4096;
      scriptNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);

      scriptNode.onaudioprocess = (e) => {
        if (!isPlaying || !audioClassifier || audioCtx.state !== "running") return;

        // 推論を間引く（2 回に 1 回だけ）
        processCounter++;
        if (processCounter % 2 !== 0) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const results = audioClassifier.classify(inputData, audioCtx.sampleRate);

        // 一度ターゲットをリセット
        for (const name in categoryData) {
          categoryData[name].targetScore = 0;
        }
        musicScoreData.targetScore = 0;

        if (results?.length > 0) {
          const classifications = results[0].classifications[0].categories;
          classifications.forEach((category) => {
            const name = category.displayName || category.categoryName;
            if (categoryData.hasOwnProperty(name)) {
              categoryData[name].targetScore = category.score;
            }
            if (name === "Music") {
              musicScoreData.targetScore = category.score;
            }
          });
        }
      };

      soundFile.connect(scriptNode);
      scriptNode.connect(p5.soundOut.audiocontext.destination);

      statusMessage = "Tap or press Space to Play";
      console.log("AudioClassifier ready:", audioClassifier);
    } catch (e) {
      console.error("MediaPipe setup failed:", e);
      statusMessage = `Error: Could not load model. ${e.message}`;
    }
  }

  // ==== カテゴリスコア関連 =======================================

  function updateCategoryScores() {
    const musicScore = musicScoreData.targetScore;
    const musicScoreBoost = 10.0;
    const musicMultiplier = 1.0 + musicScore * musicScoreBoost;

    for (const majorCategory in CATEGORIES_HIERARCHY) {
      const minorCategories = CATEGORIES_HIERARCHY[majorCategory];

      minorCategories.forEach((minorName) => {
        const data = categoryData[minorName];
        if (!data) return;

        let boost = SCORE_BOOST;
        if (SPECIAL_BOOSTS.hasOwnProperty(minorName)) {
          boost *= SPECIAL_BOOSTS[minorName];
        }

        const finalMultiplier = majorCategory === "Music" ? musicMultiplier : 1.0;
        const targetWithBoost = data.targetScore * boost * finalMultiplier;

        if (targetWithBoost > data.currentScore) {
          const attack = 0.9;
          data.currentScore = p.lerp(data.currentScore, targetWithBoost, attack);
        } else {
          const decay = 0.98;
          data.currentScore *= decay;
        }
      });
    }
  }

  function updateHueFromCategories() {
    let totalScore = 0;
    let weightedHue = 0;

    for (const majorCategory in CATEGORIES_HIERARCHY) {
      const minorCategories = CATEGORIES_HIERARCHY[majorCategory];
      let majorScore = 0;

      minorCategories.forEach((minorName) => {
        const data = categoryData[minorName];
        if (!data) return;
        majorScore += data.currentScore;
      });

      if (majorScore > 0.01) {
        const hue = CATEGORY_COLORS[majorCategory];
        weightedHue += hue * majorScore;
        totalScore += majorScore;
      }
    }

    if (totalScore > 0) {
      targetHue = weightedHue / totalScore;
    }
    currentHue = p.lerp(currentHue, targetHue, 0.1);
  }

  // ==== 波形描画（2D） ===========================================

  function drawWaveformLine() {
    if (!fft) return;

    let waveform;
    if (isPlaying) {
      waveform = fft.waveform();
    } else {
      // 停止中は前回値をゆっくりしぼませる
      waveform = smoothedWaveform.length ? smoothedWaveform : fft.waveform();
    }

    if (smoothedWaveform.length !== waveform.length) {
      smoothedWaveform = Array.from(waveform);
    }
    for (let i = 0; i < waveform.length; i++) {
      smoothedWaveform[i] = p.lerp(smoothedWaveform[i], waveform[i], waveformSmoothing);
    }

    const lineAlpha = p.map(smoothedBassLevel, 0, 1.5, 0.2, 0.9, true);
    const weight = p.map(smoothedBassLevel, 0, 1.5, 1, 4, true);
    const amp = p.height * 0.2;

    p.push();
    p.translate(0, p.height / 2);

    p.stroke(currentHue, 80, 100, lineAlpha);
    p.noFill();
    p.strokeWeight(weight);

    p.beginShape();
    for (let i = 0; i < smoothedWaveform.length; i++) {
      const x = p.map(i, 0, smoothedWaveform.length - 1, 0, p.width);
      const y = p.map(smoothedWaveform[i], -1, 1, -amp, amp);
      p.vertex(x, y);
    }
    p.endShape();

    p.pop();
  }

  // ==== アイコン生成・描画 =======================================

  function spawnIconsFromCategories() {
    const spawnThreshold = 0.3; // currentScore ベースのしきい値

    for (const majorCategory in CATEGORIES_HIERARCHY) {
      const minorCategories = CATEGORIES_HIERARCHY[majorCategory];

      // クールダウン中はスキップ
      if (groupCooldowns[majorCategory] > 0) continue;

      // しきい値を超えたマイナーカテゴリを探す
      const candidates = minorCategories.filter((name) => {
        const data = categoryData[name];
        return data && data.currentScore > spawnThreshold;
      });

      if (candidates.length === 0) continue;

      const pickedName = p.random(candidates);
      spawnIcon(pickedName, majorCategory);

      // 次の出現まで少し待つ
      groupCooldowns[majorCategory] = 20;
    }
  }

  function spawnIcon(minorName, majorCategory) {
    const img = iconImages[minorName];
    if (!img) return;

    const size = p.random(40, 100);

    const iconInfo = {
      name: minorName,
      majorCategory,
      x: p.random(size, p.width - size),
      y: -size,
      vy: p.random(1.0, 2.5),
      size,
      alpha: 1.0,
    };

    flowingIconsHistory.push(iconInfo);
  }

  function drawFlowingIcons() {
    for (let i = flowingIconsHistory.length - 1; i >= 0; i--) {
      const icon = flowingIconsHistory[i];
      const img = iconImages[icon.name];

      icon.y += icon.vy;
      icon.alpha -= 0.005;

      if (!img || icon.alpha <= 0 || icon.y - icon.size > p.height + 50) {
        flowingIconsHistory.splice(i, 1);
        continue;
      }

      const hue = CATEGORY_COLORS[icon.majorCategory] ?? currentHue;

      p.push();
      p.imageMode(p.CENTER);

      // ふわっとした背景サークル
      p.noStroke();
      p.fill(hue, 70, 80, icon.alpha * 0.5);
      p.circle(icon.x, icon.y, icon.size * 1.4);

      // アイコン本体
      p.tint(0, 0, 100, icon.alpha); // 白で表示（アイコンの元画像の色を使うなら HSB を変える）
      p.image(img, icon.x, icon.y, icon.size, icon.size);
      p.noTint();

      p.pop();
    }
  }

  // ==== ステータス表示 ===========================================

  function drawStatusText() {
    p.fill(0, 0, 100, 0.9);
    p.textSize(16);
    p.text(statusMessage, p.width / 2, p.height - 30);
  }
};

// p5 起動
new p5(sketch);
