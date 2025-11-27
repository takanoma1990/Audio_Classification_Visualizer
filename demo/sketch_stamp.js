// 1. スクリプトの先頭で、必要なモジュールを import します
import { AudioClassifier, FilesetResolver } from "./task-audio/audio_bundle.mjs";

// 2. p5.jsのスケッチ全体を一つの関数オブジェクトとして定義します (インスタンスモード)
const sketch = (p) => {
  // --- 追加: アイコン用キャンバスの参照 ---
  let iconCanvas = null;
  let iconCtx = null;

  // --- スケッチ内で使う変数を定義 ---
  let fft;

  // ★ タイムラインのスタンプ
  let timelineStamps = [];
  let trackDuration = 1.0; // 秒（setupで更新）

  // ★ 積分ウィンドウ（秒）: 5 or 10 などお好みで
  const INTEGRATION_WINDOW = 5.0;

  // 各小カテゴリごとの積分状態
  let integrationData = {}; // { [minorName]: { windowIndex, sumScore, sampleCount, lastStampWindow } }

  // ★ 縦位置ランダム用パラメータ
  const Y_TOP_NORM = 0.25;
  const Y_BOTTOM_NORM = 0.75;
  const Y_SEPARATION_NORM = 0.1;     // このくらい縦に離したい（0〜1）
  const TIME_NEIGHBORHOOD = 2.0;      // この秒数以内のスタンプとは縦位置を少しずらす

  // ★ Ripple 用
  let ripples = [];

  let groupCooldowns = {};
  let musicScoreData = { targetScore: 0 };

  const scoreDisplayMax = 0.3;

  const CATEGORIES_HIERARCHY = {
    "Forest & Life": ["Bird", "Rustling leave", "Outside, rural or natural", "Forest", "Insect"],
    Water: ["Ocean", "Water", "Stream"],
    Atmosphere: ["Thunderstorm", "Wind", "Fire", "Rain"],
    Traffic: ["Aircraft", "Car", "Rail transport", "Motor vehicle (road)", "Speech"],
    Music: ["Drum machine", "Percussion", "Rattle (instrument)", "Synthesizer", "Guitar", "Piano", "Hands"],
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
  const waveformSmoothing = 0.02;

  let audioClassifier;
  let statusMessage = "Initializing...";
  let isPlaying = false;
  let soundFile;
  let scriptNode;
  let myFont;

  let isBalancedMode = false;
  let activeHues = [];
  const MIN_ACTIVE_CATEGORIES = 3;
  const ACTIVE_CATEGORY_THRESHOLD = 0.01;

  let targetHue = 210;
  let currentHue = 210;

  // --- p5.jsのコア関数 ---

  p.preload = () => {
    myFont = p.loadFont("Roboto-Regular.ttf");
    soundFile = p.loadSound("music/simple_beat.mp3");

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

    // カテゴリデータ初期化
    allTargetCategories.forEach((name) => {
      categoryData[name] = {
        displayName: name,
        currentScore: 0,
        targetScore: 0,
        integratedScore: 0,
      };
    });

    // 積分データ初期化
    allTargetCategories.forEach((name) => {
      integrationData[name] = {
        windowIndex: 0,
        sumScore: 0,
        sampleCount: 0,
        lastStampWindow: -1,
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

    if (audioClassifier) {
      const audioCtx = p.getAudioContext();

      fft = new p5.FFT(0.1, 512);
      fft.setInput(soundFile);

      scriptNode = audioCtx.createScriptProcessor(16384, 1, 1);
      scriptNode.onaudioprocess = (e) => {
        if (!isPlaying || !audioClassifier || audioCtx.state !== "running") return;
        const inputData = e.inputBuffer.getChannelData(0);
        const results = audioClassifier.classify(inputData, audioCtx.sampleRate);

        for (const name in categoryData) {
          categoryData[name].targetScore = 0;
        }

        musicScoreData.targetScore = 0;

        if (results?.length > 0) {
          const classifications = results[0].classifications[0].categories;
          if (classifications.length >= 2) {
            console.log(classifications);
          }
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
    }

    // ★ 楽曲の総時間（秒）を取得
    if (soundFile && soundFile.isLoaded()) {
      trackDuration = soundFile.duration() || 1.0;
    }

    p.noCursor();
    statusMessage = "Tap / Click / Space to Play";
  };

  p.draw = () => {
    // カテゴリスコアに応じて色相を更新
    updateHueAndMode();

    // 背景
    p.background(0);

    // クールダウン更新
    for (const majorCategory in groupCooldowns) {
      if (groupCooldowns[majorCategory] > 0) {
        groupCooldowns[majorCategory]--;
      }
    }

    // FFT からエネルギー取得
    if (isPlaying && fft) {
      fft.analyze();
      bassLevel =
        p.map(fft.getEnergy("bass"), 0, 255, 0, 1) +
        p.map(fft.getEnergy("mid"), 0, 255, 0, 1) +
        p.map(fft.getEnergy("treble"), 0, 255, 0, 1);
    } else {
      bassLevel *= 0.95;
    }

    smoothedBassLevel = p.lerp(smoothedBassLevel, bassLevel, 0.1);

    // 統合スコア減衰
    const scoreDecay = 0.99;
    for (const name in categoryData) {
      categoryData[name].integratedScore *= scoreDecay;
    }

    // カテゴリスコア更新 & スタンプ生成（積分ベース）
    updateCategoryScoresAndSpawnStamps();

    // パーティクル描画（p5キャンバス）
    drawParticles();

    // 波形ライン（2D 版）
    drawWaveformLine2D();

    // タイムライン上のスタンプと再生バー（icon-layer に描画）
    drawTimelineStamps();
    drawTimelineCursor();

    // ステータス表示
    drawStatusText();
  };

  // --- 入力系（クリック / タップ / キー） ---

  p.keyPressed = async () => {
    if (p.keyCode === 32) {
      togglePlay();
    }
  };

  p.mousePressed = () => {
    togglePlay();
  };

  p.touchStarted = () => {
    togglePlay();
    return false;
  };

  function togglePlay() {
    if (p.getAudioContext().state !== "running") {
      p.getAudioContext().resume();
    }

    if (soundFile.isPlaying()) {
      soundFile.pause();
      isPlaying = false;
      statusMessage = "Paused. Tap / Click / Space to play.";
    } else {
      soundFile.loop();
      isPlaying = true;

      // 再生開始時に duration を再取得（念のため）
      if (soundFile && soundFile.isLoaded()) {
        trackDuration = soundFile.duration() || trackDuration;
      }

      statusMessage = "Playing... Tap / Click / Space to pause.";
    }
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
        scoreThreshold: 0.01,
      });
      console.log(audioClassifier);
      statusMessage = "Tap / Click / Space to Play";
    } catch (e) {
      console.error("MediaPipe setup failed:", e);
      statusMessage = `Error: Could not load model. ${e.message}`;
    }
  }

  // --- 波形ライン（2D 版） ---

  function drawWaveformLine2D() {
    if (!fft) return;

    if (isPlaying) {
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
    const weight = p.map(smoothedBassLevel, 0, 1.5, 1.0, 1.0, true);

    p.strokeWeight(weight);
    p.noFill();
    p.noStroke();
    p.fill(currentHue, 80, 100, lineAlpha);

    p.beginShape();
    for (let i = 0; i < smoothedWaveform.length; i += 3) {
      let x = p.map(i, 0, smoothedWaveform.length, 0, p.width);
      let y = p.map(
        smoothedWaveform[i],
        -0.1,
        0.1,
        -p.height * 0.6,
        p.height * 0.6
      );
      p.ellipse(x, y, weight * 2 + 3);
      p.ellipse(x, -y, weight * 2 + 3);
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

  // --- カテゴリスコア更新＆スタンプ生成（積分ベース） ---

  function updateCategoryScoresAndSpawnStamps() {
    if (!soundFile || !soundFile.isLoaded()) return;

    const currentTime = soundFile.currentTime();
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

        // --- ここから積分処理 ---
        const integ = integrationData[minorCategoryName];
        const winIndex = Math.floor(currentTime / INTEGRATION_WINDOW);

        // 窓が変わったら、その窓の結果からスタンプ生成
        if (integ.windowIndex !== winIndex) {
          if (
            integ.sampleCount > 0 &&
            integ.lastStampWindow !== integ.windowIndex
          ) {
            const avgScore = integ.sumScore / integ.sampleCount; // 0〜1想定
            const strength = p.constrain(avgScore, 0, 1);
            const windowCenterTime =
              (integ.windowIndex + 0.5) * INTEGRATION_WINDOW;

            // 閾値を超えるときだけスタンプ生成
            const stampThreshold = 0.05; // 小さすぎるものは捨てる
            if (strength > stampThreshold) {
              addTimelineStamp(
                minorCategoryName,
                majorCategory,
                windowCenterTime,
                strength
              );
              integ.lastStampWindow = integ.windowIndex;
            }
          }

          // 新しい窓へリセット
          integ.windowIndex = winIndex;
          integ.sumScore = 0;
          integ.sampleCount = 0;
        }

        // 現在の窓に積分
        integ.sumScore += displayScore;
        integ.sampleCount += 1;
      });
    }
  }

  // --- 縦位置をランダムに決める（近い時間帯とは少しずらす） ---
  function pickRandomYNorm(timeSec) {
    let chosen = p.random(Y_TOP_NORM, Y_BOTTOM_NORM);

    for (let attempt = 0; attempt < 10; attempt++) {
      let conflict = false;
      for (const st of timelineStamps) {
        if (Math.abs(st.time - timeSec) < TIME_NEIGHBORHOOD) {
          if (Math.abs(st.yNorm - chosen) < Y_SEPARATION_NORM) {
            conflict = true;
            break;
          }
        }
      }
      if (!conflict) {
        return chosen;
      }
      // かぶっていたら別の候補を再抽選
      chosen = p.random(Y_TOP_NORM, Y_BOTTOM_NORM);
    }

    // 10回試してもダメなら最後の値を採用（多少の重なりは許容）
    return chosen;
  }

  // --- Ripple 生成（スタンプに紐づく） ---
  function createRippleForStamp(stamp) {
    ripples.push({
      stamp,
      radius: 0,
      maxRadius: stamp.size * 2,
      growthSpeed: 2,
    });
  }

  // --- スタンプ追加（時間軸に固定） ---
  // strength: 0〜1 でサイズを決定
  function addTimelineStamp(minorCategoryName, majorCategory, timeSec, strength) {
    const duration = trackDuration || 1.0;
    const clampedTime = p.constrain(timeSec, 0, duration);

    // 縦位置（0〜1）のランダム値（近い時間帯と少しだけ重ならないよう調整）
    const yNorm = pickRandomYNorm(clampedTime);

    // strength からサイズを決定
    const minSize = 10;
    const maxSize = 100;
    const size = p.map(strength, 0, 1, minSize, maxSize, true);

    // ★ 横方向のランダムオフセット（ピクセル）
    const xJitter = p.random(-20, 80);

    const stamp = {
      name: minorCategoryName,
      majorCategory,
      time: clampedTime, // 秒
      yNorm,
      size,
      strength,
      xJitter,
    };

    timelineStamps.push(stamp);

    // ★ スタンプ生成と同時に ripple 生成
    createRippleForStamp(stamp);
  }

  // --- Ripple 描画（icon-layer に描画） ---
  function drawRipples2D() {
    if (!iconCtx || !iconCanvas) return;
    if (ripples.length === 0) return;

    const duration = trackDuration || 1.0;

    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      const st = r.stamp;

      if (!st) {
        ripples.splice(i, 1);
        continue;
      }

      // スタンプと同じロジックで座標を求める
      let cx = p.map(st.time, 0, duration, 0, p.width) + (st.xJitter || 0);
      cx = p.constrain(cx, 0, p.width);
      const cy = st.yNorm * p.height;

      const progress = r.radius / r.maxRadius;
      const alpha = p.map(1 - progress, 0, 1, 0, 0.6, true);
      const lineWidth = p.map(1 - progress, 0, 1, 0.5, 3, true);

      const col = `rgba(255, 255, 255, ${alpha})`;

      iconCtx.save();
      iconCtx.lineWidth = lineWidth;
      iconCtx.strokeStyle = col;
      iconCtx.beginPath();
      iconCtx.arc(cx, cy, r.radius, 0, Math.PI * 2);
      iconCtx.stroke();
      iconCtx.restore();

      r.radius += r.growthSpeed;

      if (r.radius > r.maxRadius) {
        ripples.splice(i, 1);
      }
    }
  }

  // --- タイムライン上のスタンプ描画（icon-layer に描画） ---

  function drawTimelineStamps() {
    if (!iconCtx || !iconCanvas) return;

    // icon-layer 全体クリア
    iconCtx.clearRect(0, 0, iconCanvas.width, iconCanvas.height);

    const duration = trackDuration || 1.0;

    // ★ 先に ripple を描画（その上にスタンプを乗せる）
    drawRipples2D();

    for (let i = 0; i < timelineStamps.length; i++) {
      const st = timelineStamps[i];
      const img = iconImages[st.name];
      if (!img) continue;

      // 時刻 → X 座標 ＋ ランダムオフセット
      let x = p.map(st.time, 0, duration, 0, p.width) + (st.xJitter || 0);
      x = p.constrain(x, 0, p.width);

      // ランダムに決まった縦位置 → Y 座標
      const y = st.yNorm * p.height;

      iconCtx.save();
      iconCtx.translate(x, y);

      const src = img.canvas || img.elt || img;
      const w = st.size;
      const h = st.size;

      // アイコンのみ描画
      iconCtx.globalAlpha = 1.0;
      iconCtx.drawImage(src, -w / 2, -h / 2, w, h);

      iconCtx.restore();
    }
  }

  // --- 再生バー（縦線）の描画 ---

  function drawTimelineCursor() {
    if (!iconCtx || !iconCanvas || !soundFile) return;

    const duration = trackDuration || 1.0;
    const currentTime = soundFile.currentTime();
    const x = p.map(currentTime, 0, duration, 0, p.width);

    iconCtx.save();
    iconCtx.strokeStyle = "rgba(255,255,255,0.9)";
    iconCtx.lineWidth = 2;
    iconCtx.beginPath();
    iconCtx.moveTo(x, 0);
    iconCtx.lineTo(x, p.height);
    iconCtx.stroke();
    iconCtx.restore();
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

  function drawStatusText() {
    // icon-layer が準備できていないときは何もしない
    if (!iconCtx || !iconCanvas) return;

    iconCtx.save();

    iconCtx.fillStyle = "rgba(255, 255, 255, 0.9)";
    iconCtx.textAlign = "center";
    iconCtx.textBaseline = "middle";
    iconCtx.font = '16px "Roboto", sans-serif';

    // 画面下中央に表示
    iconCtx.fillText(statusMessage, p.width / 2, p.height - 30);

    iconCtx.restore();
  }

};

new p5(sketch);
