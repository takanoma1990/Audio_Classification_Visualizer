// 1. スクリプトの先頭で、必要なモジュールを import します
import { AudioClassifier, FilesetResolver } from "./task-audio/audio_bundle.mjs";

// 2. p5.jsのスケッチ全体を一つの関数オブジェクトとして定義します (インスタンスモード)
const sketch = (p) => {
  // --- 追加: アイコン用キャンバスの参照 ---
  let iconCanvas = null;
  let iconCtx = null;

  // --- スケッチ内で使う変数を定義 ---
  let fft;

  let flowingIconsHistory = [];
  let groupCooldowns = {};
  let musicScoreData = { targetScore: 0 };

  const scoreDisplayMax = 0.3;

  const CATEGORIES_HIERARCHY = {
    "Forest & Life": ["Bird", "Rustling leave", "Speech"],
    Water: ["Ocean", "Water", "Stream"],
    Atmosphere: ["Thunderstorm", "Wind", "Fire"],
    Traffic: ["Aircraft", "Car", "Rail transport"],
    Music: ["Drum machine", "Percussion", "Synthesizer"],
  };

  const CATEGORY_COLORS = {
    "Forest & Life": 120,
    Water: 190,
    Atmosphere: 60,
    Traffic: 0,
    Music: 30,
  };

  groupCooldowns = {
    "Forest & Life": 0,
    Water: 0,
    Atmosphere: 0,
    Traffic: 0,
    Music: 0,
  };

  const allTargetCategories = Object.values(CATEGORIES_HIERARCHY).flat();

  // 読み込んだ画像を保持するオブジェクト
  let iconImages = {};

  let categoryData = {};
  const SCORE_BOOST = 10.0;
  const SPECIAL_BOOSTS = {
    Speech: 0.001,
    Music: 0.1,
    Thunderstorm: 2,
  };

  // パーティクル
  let particles = [];
  const numParticles = 120;
  const particleBounds = 600; // 2D用

  let bassLevel = 0;
  let smoothedBassLevel = 0;

  let smoothedWaveform = [];
  const waveformSmoothing = 0.1;

  // ★ ここから音周り
  let audioClassifier;
  let statusMessage = "Initializing...";
  let myFont;

  let mic;                  // ★ マイク
  let isListening = false;  // ★ 今マイクを可視化・分類に使うかどうか
  let scriptNode;           // ★ MediaPipe に渡すためのノード

  let isBalancedMode = false;
  let activeHues = [];
  const MIN_ACTIVE_CATEGORIES = 3;
  const ACTIVE_CATEGORY_THRESHOLD = 0.01;

  let targetHue = 210;
  let currentHue = 210;

  // --- p5.jsのコア関数 ---

  p.preload = () => {
    myFont = p.loadFont("Roboto-Regular.ttf");

    // ★ ファイル再生はやめるので loadSound は削除
    // soundFile = p.loadSound("music/beat_ambient.mp3");

    // カテゴリに対応する画像をすべて読み込む
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
    const loadFontAsPromise = (path) => {
      return new Promise((resolve, reject) => {
        p.loadFont(path, resolve, reject);
      });
    };

    try {
      myFont = await loadFontAsPromise("Roboto-Regular.ttf");
    } catch (error) {
      console.error("フォントの読み込みに失敗しました:", error);
      p.noLoop();
      return;
    }

    // ★ 2D キャンバス + 親要素指定（CSSフィルタは HTML で設定）
    const c = p.createCanvas(p.windowWidth, p.windowHeight);
    c.parent("p5-holder");

    p.colorMode(p.HSB, 360, 100, 100, 1.0);
    p.textFont(myFont);

    // ★ アイコン用キャンバスの取得
    iconCanvas = document.getElementById("icon-layer");
    if (iconCanvas) {
      iconCtx = iconCanvas.getContext("2d");
      resizeIconCanvas();
    }

    allTargetCategories.forEach((name) => {
      categoryData[name] = {
        displayName: name,
        currentScore: 0,
        targetScore: 0,
        integratedScore: 0,
      };
    });

    // クールダウン初期化
    for (const majorCategory in CATEGORIES_HIERARCHY) {
      groupCooldowns[majorCategory] = 0;
    }

    // パーティクル初期化（2D版）
    for (let i = 0; i < numParticles; i++) {
      particles.push(new Particle());
    }

    await setupMediaPipe();

    // ★ FFT は準備だけしておく（入力はマイク開始時にセット）
    fft = new p5.FFT(0.9, 512);

    // ★ マイクインスタンスもここで生成（startは後でユーザー操作時）
    mic = new p5.AudioIn();

    p.noCursor();
    statusMessage = "Tap / Click / Space to enable mic";
  };

  p.draw = () => {
    // カテゴリスコアに応じて色相を更新
    updateHueAndMode();

    // 背景（ここには CSS フィルタがかかる）
    const bgBrightness = p.map(smoothedBassLevel, 0, 1.5, 8, 20, true);
    // p.background(0, 80, bgBrightness);
    p.background(0);

    // クールダウン更新
    for (const majorCategory in groupCooldowns) {
      if (groupCooldowns[majorCategory] > 0) {
        groupCooldowns[majorCategory]--;
      }
    }

    // FFT からエネルギー取得（マイク使用）
    if (isListening && fft) {
      fft.analyze();
      bassLevel =
        p.map(fft.getEnergy("bass"), 0, 255, 0, 1) +
        p.map(fft.getEnergy("mid"), 0, 255, 0, 1) +
        p.map(fft.getEnergy("treble"), 0, 255, 0, 1);
    } else {
      bassLevel *= 0.95;
    }

    smoothedBassLevel = p.lerp(smoothedBassLevel, bassLevel, 0.3);

    // 統合スコア減衰
    const scoreDecay = 0.99;
    for (const name in categoryData) {
      categoryData[name].integratedScore *= scoreDecay;
    }

    // カテゴリスコア更新 & アイコン生成
    updateCategoryScoresAndSpawnIcons();

    // パーティクル描画（p5キャンバス＝フィルタあり）
    drawParticles();

    // 波形ライン（2D 版）
    drawWaveformLine2D();

    // アイコン描画（こちらは icon-layer に描くのでフィルタ無し）
    drawFlowingImages2D();

    // ステータス表示
    drawStatusText();
  };

  // --- 入力系（クリック / タップ / キー） ---

  p.keyPressed = async () => {
    if (p.keyCode === 32) {
      toggleListen();
    }
  };

  p.mousePressed = () => {
    toggleListen();
  };

  p.touchStarted = () => {
    toggleListen();
    return false;
  };

  // ★ マイク ON/OFF トグル
  function toggleListen() {
    const audioCtx = p.getAudioContext();
    if (audioCtx.state !== "running") {
      audioCtx.resume();
    }

    if (!isListening) {
      // --- 初回：マイク開始＆接続 ---
      startMicChain();
    } else {
      // --- 可視化・分類だけ止める（マイクストリーム自体は開いたままにしておく） ---
      isListening = false;
      statusMessage = "Mic paused. Tap / Click / Space to resume.";
    }
  }

  // ★ マイク・FFT・MediaPipe をつなぐ処理
  function startMicChain() {
    if (!mic) {
      statusMessage = "Mic not ready.";
      return;
    }

    // mic.start はコールバック形式なので Promise ラップしてもよいけど、
    // ここではそのまま使う
    mic.start(
      () => {
        const audioCtx = p.getAudioContext();

        // FFT の入力をマイクに
        if (fft) {
          fft.setInput(mic);
        }

        // MediaPipe 用の ScriptProcessor を作る（まだ無ければ）
        if (!scriptNode && audioClassifier) {
          scriptNode = audioCtx.createScriptProcessor(16384, 1, 1);
          scriptNode.onaudioprocess = (e) => {
            if (!isListening || !audioClassifier || audioCtx.state !== "running") return;
            const inputData = e.inputBuffer.getChannelData(0);
            const results = audioClassifier.classify(inputData, audioCtx.sampleRate);

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

          // p5.AudioIn の中にある MediaStream から AudioNode を作成
          if (mic.stream) {
            const src = audioCtx.createMediaStreamSource(mic.stream);
            src.connect(scriptNode);
          } else if (mic.input) {
            // 古い p5 では input (GainNode) 経由でも可
            mic.input.connect(scriptNode);
          }

          // ScriptProcessor はどこかに接続しないと動かないので、
          // 音を出さないダミーの destination に接続
          scriptNode.connect(audioCtx.destination);
        }

        isListening = true;
        statusMessage = "Listening from mic... Tap / Click / Space to pause.";
      },
      (err) => {
        console.error("Mic start error:", err);
        statusMessage = "Mic permission denied.";
      }
    );
  }

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
    resizeIconCanvas();
  };

  // --- icon-layer のリサイズ（デバイスピクセル比考慮） ---
  function resizeIconCanvas() {
    if (!iconCanvas || !iconCtx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;

    iconCanvas.width = w * dpr;
    iconCanvas.height = h * dpr;
    iconCanvas.style.width = w + "px";
    iconCanvas.style.height = h + "px";
    iconCtx.setTransform(dpr, 0, 0, dpr, 0, 0); // 座標系を CSS ピクセルにそろえる
  }

  // --- MediaPipe セットアップ ---

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
        scoreThreshold: 0.1,
      });
      console.log(audioClassifier);
      statusMessage = "Tap / Click / Space to enable mic";
    } catch (e) {
      console.error("MediaPipe setup failed:", e);
      statusMessage = `Error: Could not load model. ${e.message}`;
    }
  }

  // --- 波形ライン（2D 版） ---

  function drawWaveformLine2D() {
    if (!fft) return;

    if (isListening) {
      let waveform = fft.waveform();

      if (smoothedWaveform.length !== waveform.length) {
        smoothedWaveform = Array.from(waveform);
      }
      for (let i = 0; i < waveform.length; i++) {
        smoothedWaveform[i] = p.lerp(
          smoothedWaveform[i],
          waveform[i],
          waveformSmoothing
        );
      }
    }

    if (smoothedWaveform.length === 0) return;

    p.push();
    p.translate(0, p.height / 2);

    const lineAlpha = p.map(smoothedBassLevel, 0, 1.5, 0.2, 1.0, true);
    const weight = p.map(smoothedBassLevel, 0, 1.5, 1.0, 4.0, true);

    p.strokeWeight(weight);
    p.noFill();
    p.stroke(currentHue, 80, 100, lineAlpha);

    p.beginShape();
    for (let i = 0; i < smoothedWaveform.length; i++) {
      let x = p.map(i, 0, smoothedWaveform.length, 0, p.width);
      let y = p.map(
        smoothedWaveform[i],
        -0.5,
        0.5,
        -p.height * 0.25,
        p.height * 0.25
      );
      p.vertex(x, y);
    }
    p.endShape();

    p.pop();
  }

  // --- カテゴリから色相／モードを決める ---

  function updateHueAndMode() {
    let totalScore = 0;
    let weightedHue = 0;

    const majorScores = [];
    activeHues = [];

    for (const majorCategory in CATEGORIES_HIERARCHY) {
      const minorCategories = CATEGORIES_HIERARCHY[majorCategory];
      let majorCategoryScore = 0;
      minorCategories.forEach((minorName) => {
        if (categoryData[minorName]) {
          majorCategoryScore += categoryData[minorName].currentScore;
        }
      });

      majorScores.push(majorCategoryScore);

      if (majorCategoryScore > 0.01) {
        const categoryHue = CATEGORY_COLORS[majorCategory];
        weightedHue += categoryHue * majorCategoryScore;
        totalScore += majorCategoryScore;

        if (!activeHues.includes(categoryHue)) {
          activeHues.push(categoryHue);
        }
      }
    }

    const activeCategoryCount = majorScores.filter(
      (score) => score > ACTIVE_CATEGORY_THRESHOLD
    ).length;
    isBalancedMode = activeCategoryCount >= MIN_ACTIVE_CATEGORIES;

    if (totalScore > 0) {
      targetHue = weightedHue / totalScore;
    }
    currentHue = p.lerp(currentHue, targetHue, 0.1);
  }

  // --- カテゴリスコア更新＆アイコン生成（バー表示なし） ---

  function updateCategoryScoresAndSpawnIcons() {
    const musicScore = musicScoreData.targetScore;
    const musicScoreBoost = 10.0;
    const musicMultiplier = 1.0 + musicScore * musicScoreBoost;

    for (const majorCategory in CATEGORIES_HIERARCHY) {
      const minorCategories = CATEGORIES_HIERARCHY[majorCategory];

      minorCategories.forEach((minorCategoryName) => {
        const data = categoryData[minorCategoryName];
        if (!data) return;

        let boost = SCORE_BOOST;
        if (SPECIAL_BOOSTS.hasOwnProperty(minorCategoryName)) {
          boost = SCORE_BOOST * SPECIAL_BOOSTS[minorCategoryName];
        }

        // Music グループだけ乗数をかける
        const finalMultiplier = majorCategory === "Music" ? musicMultiplier : 1.0;

        const targetWithBoost = data.targetScore * boost * finalMultiplier;

        if (targetWithBoost > data.currentScore) {
          const attack = 0.9;
          data.currentScore = p.lerp(data.currentScore, targetWithBoost, attack);
        } else {
          const decay = 0.98;
          data.currentScore *= decay;
        }

        // スコアを 0〜1 にクリップ
        const displayScore = p.map(
          data.currentScore,
          0,
          scoreDisplayMax,
          0,
          1,
          true
        );

        const detectionThreshold = 0.5;

        // アイコン生成
        if (
          displayScore > detectionThreshold &&
          groupCooldowns[majorCategory] === 0
        ) {
          const lastIcon = flowingIconsHistory[flowingIconsHistory.length - 1];
          if (!lastIcon || lastIcon.name !== minorCategoryName) {
            spawnIcon(minorCategoryName, majorCategory);
            groupCooldowns[majorCategory] = 50;
          }
        }
      });
    }
  }

  function spawnIcon(minorCategoryName, majorCategory) {
    let y = p.random(p.height * 0.2, p.height * 0.8);
    const newIconInfo = {
      name: minorCategoryName,
      majorCategory,
      x: -100, // 左端の外から流れてくる
      y,
      vy: p.random(-0.5, 0.5),
      vx: p.random(3, 6),
      lifespan: 400,
      size: p.random(50, 120),
      wobblePhase: p.random(0, 1000),
      wobbleRange: p.random(10, 60),
    };
    flowingIconsHistory.push(newIconInfo);
  }

  // --- アイコンの 2D 描画（icon-layer に描画） ---

  function drawFlowingImages2D() {
    if (!iconCtx || !iconCanvas) return;

    // icon-layer 全体クリア
    iconCtx.clearRect(0, 0, iconCanvas.width, iconCanvas.height);

    // アイコン本体
    for (let i = flowingIconsHistory.length - 1; i >= 0; i--) {
      let iconInfo = flowingIconsHistory[i];

      iconInfo.x += iconInfo.vx;
      iconInfo.y += iconInfo.vy;
      iconInfo.y +=
        Math.sin((p.frameCount + iconInfo.wobblePhase) * 0.02) *
        0.5 *
        (iconInfo.vx / 4);

      iconInfo.lifespan--;

      const img = iconImages[iconInfo.name];
      const alpha = p.map(iconInfo.lifespan, 0, 100, 0, 1.0, true);

      // 画面外 or 寿命切れで削除
      if (
        iconInfo.lifespan < 0 ||
        iconInfo.x - iconInfo.size > p.width + 100 ||
        iconInfo.y < -200 ||
        iconInfo.y > p.height + 200
      ) {
        flowingIconsHistory.splice(i, 1);
        continue;
      }

      iconCtx.save();
      iconCtx.translate(iconInfo.x, iconInfo.y);

      // 背景の光る丸
      iconCtx.fillStyle = `rgba(255,255,255,${alpha * 0.15})`;
      iconCtx.beginPath();
      iconCtx.fill();

      // アイコン画像
      if (img) {
        const src = img.canvas || img.elt || img;
        const w = iconInfo.size;
        const h = iconInfo.size;

        iconCtx.globalAlpha = alpha;
        iconCtx.drawImage(src, -w / 2, -h / 2, w, h);
        iconCtx.globalAlpha = 1.0;
      }

      // 枠
      iconCtx.strokeStyle = `rgba(255,255,255,${alpha})`;
      iconCtx.lineWidth = 2;
      iconCtx.strokeRect(
        -iconInfo.size * 0.55,
        -iconInfo.size * 0.55,
        iconInfo.size * 1.1,
        iconInfo.size * 1.1
      );

      iconCtx.restore();
    }

    // 近いアイコン同士を線で結ぶ
    const connectDistance = 160;
    iconCtx.lineWidth = 1;

    for (let i = 0; i < flowingIconsHistory.length; i++) {
      for (let j = i + 1; j < flowingIconsHistory.length; j++) {
        let iconA = flowingIconsHistory[i];
        let iconB = flowingIconsHistory[j];

        if (iconA.majorCategory === iconB.majorCategory) {
          let dx = iconA.x - iconB.x;
          let dy = iconA.y - iconB.y;
          let distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < connectDistance) {
            const alpha = p.map(distance, 0, connectDistance, 1.0, 0.1);
            iconCtx.strokeStyle = `rgba(255,255,255,${alpha})`;
            iconCtx.beginPath();
            iconCtx.moveTo(iconA.x, iconA.y);
            iconCtx.lineTo(iconB.x, iconB.y);
            iconCtx.stroke();
          }
        }
      }
    }
  }

  // --- パーティクル（2D 版） ---

  function drawParticles() {
    p.noStroke();
    for (let particle of particles) {
      particle.display();
      particle.update();
    }
  }

  class Particle {
    constructor() {
      this.individualHue = 0;
      this.displayHue = p.random(360);
      this.hueChangeSpeed = p.random(0.05, 0.1);
      this.species = "Ambience";
      this.reset();
    }

    reset() {
      this.pos = p.createVector(
        p.random(-particleBounds, particleBounds),
        p.random(-particleBounds, particleBounds)
      );

      this.vel = p.createVector(p.random(-0.5, 0.5), p.random(-0.5, 0.5));
      this.baseVel = this.vel.copy();
      this.size = p.random(2, 6);
      this.lifespan = p.random(300, 600);
      this.maxLifespan = this.lifespan;
      this.hueOffset = p.random(-15, 15);
      this.shapeType = p.floor(p.random(1)); // circle or square
      this.rotation = p.random(p.TWO_PI);
      this.rotationSpeed = p.random(-0.02, 0.02);

      if (activeHues && activeHues.length > 0) {
        this.individualHue = p.random(activeHues);
      } else {
        this.individualHue = currentHue;
      }

      // アクティブなメジャーカテゴリから species を決定
      const activeMajorCategories = Object.keys(CATEGORIES_HIERARCHY).filter(
        (majorCat) => {
          return CATEGORIES_HIERARCHY[majorCat].some(
            (minorCat) => categoryData[minorCat]?.currentScore > 0.1
          );
        }
      );

      if (activeMajorCategories.length > 0) {
        this.species = p.random(activeMajorCategories);
      } else {
        this.species = "Ambience";
      }
    }

    update() {
      const speedMultiplier = p.map(smoothedBassLevel, 0, 1.5, 1.0, 2.0, true);
      let scaledBaseVel = this.baseVel.copy().mult(speedMultiplier);

      // 中心から外に押し出す
      let pushForce = this.pos.copy().normalize().mult(smoothedBassLevel * 0.3);
      let targetVel = p5.Vector.add(scaledBaseVel, pushForce);
      this.vel.lerp(targetVel, 0.1);

      // species による違い
      if (this.species === "Water") {
        this.vel.y += 0.01;
      } else if (this.species === "Atmosphere") {
        const n =
          p.noise(this.pos.x * 0.01, this.pos.y * 0.01, p.frameCount * 0.01) -
          0.5;
        this.vel.x += n * 0.1;
      }

      this.pos.add(this.vel);
      this.rotation += this.rotationSpeed;
      this.lifespan--;

      // 画面外か寿命切れでリセット
      if (this.lifespan < 0 || this.pos.mag() > particleBounds * 1.5) {
        this.reset();
      }
    }

    display() {
      p.push();
      const sx = this.pos.x + p.width / 2;
      const sy = this.pos.y + p.height / 2;
      p.translate(sx, sy);
      p.rotate(this.rotation);

      const alpha = p.map(
        this.lifespan,
        0,
        this.maxLifespan / 2,
        0,
        0.7,
        true
      );
      let brightness = p.map(smoothedBassLevel, 0, 1, 60, 100, true);

      let targetParticleHue;
      if (isBalancedMode) {
        targetParticleHue = this.individualHue;
      } else {
        targetParticleHue = currentHue;
      }

      this.displayHue = p.lerp(
        this.displayHue,
        targetParticleHue,
        this.hueChangeSpeed
      );

      p.fill(
        (this.displayHue + this.hueOffset) % 360,
        80,
        brightness,
        alpha
      );

      let s = this.size + smoothedBassLevel * 10;

      if (this.shapeType === 0) {
        p.circle(0, 0, s * 2);
      } else {
        p.rectMode(p.CENTER);
        p.rect(0, 0, s * 2, s * 2);
      }

      p.pop();
    }
  }

  // --- ステータス文字（アイコンと同じレイヤーでフィルタなし） ---
  function drawStatusText() {
    if (!iconCtx || !iconCanvas) return;

    iconCtx.save();

    iconCtx.fillStyle = "rgba(255, 255, 255, 0.9)";
    iconCtx.textAlign = "center";
    iconCtx.textBaseline = "middle";
    iconCtx.font = '16px "Roboto", sans-serif';

    iconCtx.fillText(statusMessage, p.width / 2, p.height - 30);

    iconCtx.restore();
  }
};

new p5(sketch);
