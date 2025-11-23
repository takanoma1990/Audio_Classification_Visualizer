import { AudioClassifier, FilesetResolver } from "./task-audio/audio_bundle.mjs";

const sketch = (p) => {
  // ==== 定数 =========================================
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
    Speech: 0.001,
    Music: 0.1,
    Thunderstorm: 2.0,
  };

  // ==== 音・分類まわり ===============================
  let fft = null;
  let audioClassifier = null;
  let soundFile;
  let scriptNode;
  let myFont;

  let isPlaying = false;
  let statusMessage = "Initializing...";

  let bassLevel = 0;
  let smoothedBassLevel = 0;
  const waveformSmoothing = 0.1;
  let smoothedWaveform = [];

  let processCounter = 0; // 推論間引き用

  let categoryData = {};
  let musicScoreData = { targetScore: 0 };

  // ==== ビジュアル状態 ===============================
  let iconImages = {};
  let flowingIconsHistory = [];
  let groupCooldowns = {};
  let targetHue = 210;
  let currentHue = 210;

  // ==== preload ======================================
  p.preload = () => {
    myFont = p.loadFont("Roboto-Regular.ttf");
    soundFile = p.loadSound("music/beat_ambient.mp3");

    allTargetCategories.forEach((categoryName) => {
      const path = `icons/${categoryName}.png`;
      iconImages[categoryName] = p.loadImage(
        path,
        () => console.log(`Loaded icon: ${path}`),
        () => console.warn(`Failed to load icon: ${path}`)
      );
    });
  };

  // ==== setup ========================================
  p.setup = async () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 1.0);
    p.textFont(myFont);
    p.textAlign(p.CENTER, p.CENTER);

    // カテゴリ初期化
    allTargetCategories.forEach((name) => {
      categoryData[name] = {
        displayName: name,
        currentScore: 0,
        targetScore: 0,
      };
    });

    Object.keys(CATEGORIES_HIERARCHY).forEach((major) => {
      groupCooldowns[major] = 0;
    });

    // FFT が使えるかチェック
    if (typeof p5 !== "undefined" && typeof p5.FFT === "function") {
      fft = new p5.FFT(0.8, 256);
      fft.setInput(soundFile);
      console.log("FFT ready");
    } else {
      console.warn("p5.FFT is not available. Waveform will be dummy.");
      fft = null;
    }

    await setupMediaPipe();
    statusMessage = "Tap or press Space to Play";
  };

  // ==== draw =========================================
  p.draw = () => {
    updateHueFromCategories();

    const bgBrightness = p.map(smoothedBassLevel, 0, 1.5, 12, 35, true);
    p.background(currentHue, 60, bgBrightness);

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
    updateCategoryScores();

    for (const major in groupCooldowns) {
      if (groupCooldowns[major] > 0) groupCooldowns[major]--;
    }

    drawWaveformLine();
    spawnIconsFromCategories();
    drawFlowingIcons();
    drawStatusText();
  };

  // ==== 入力 =========================================
  p.keyPressed = () => {
    if (p.keyCode === 32) togglePlay();
  };

  p.mousePressed = () => {
    togglePlay();
  };

  p.touchStarted = () => {
    togglePlay();
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

  // ==== MediaPipe Audio ==============================
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
      const bufferSize = 4096;
      const script = audioCtx.createScriptProcessor(bufferSize, 1, 1);

      script.onaudioprocess = (e) => {
        if (!isPlaying || !audioClassifier || audioCtx.state !== "running") return;

        processCounter++;
        if (processCounter % 2 !== 0) return; // 2回に1回だけ

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

      soundFile.connect(script);
      // p5.soundOut が使えない環境でも落ちないように try/catch
      try {
        script.connect(p5.soundOut.audiocontext.destination);
      } catch (e) {
        console.warn("Could not connect scriptNode to p5.soundOut:", e);
        script.connect(audioCtx.destination);
      }

      scriptNode = script;
      statusMessage = "Tap or press Space to Play";
      console.log("AudioClassifier ready");
    } catch (e) {
      console.error("MediaPipe setup failed:", e);
      statusMessage = `Error: Could not load model. ${e.message}`;
    }
  }

  // ==== カテゴリスコア ==================================
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

  // ==== 波形描画（必ず何か描く） =========================
  function drawWaveformLine() {
    let waveform;

    if (fft && isPlaying) {
      waveform = fft.waveform();
    } else if (fft && smoothedWaveform.length === 0) {
      // 再生前・停止後でも一度は取得しておく
      waveform = fft.waveform();
    } else if (smoothedWaveform.length > 0) {
      waveform = smoothedWaveform.slice();
    } else {
      // FFT が無い or 初期状態 → ダミー波形
      waveform = [];
      const len = 128;
      for (let i = 0; i < len; i++) {
        waveform.push(Math.sin((i / len) * Math.PI * 2));
      }
    }

    if (smoothedWaveform.length !== waveform.length) {
      smoothedWaveform = Array.from(waveform);
    }
    for (let i = 0; i < waveform.length; i++) {
      smoothedWaveform[i] = p.lerp(smoothedWaveform[i], waveform[i], waveformSmoothing);
    }

    const lineAlpha = p.map(smoothedBassLevel, 0, 1.5, 0.3, 1.0, true);
    const weight = p.map(smoothedBassLevel, 0, 1.5, 1, 4, true);
    const amp = p.height * 0.25;

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

  // ==== アイコン生成・描画 =============================
  function spawnIconsFromCategories() {
    const spawnThreshold = 0.25; // 少し低めに

    for (const majorCategory in CATEGORIES_HIERARCHY) {
      if (groupCooldowns[majorCategory] > 0) continue;

      const minorCategories = CATEGORIES_HIERARCHY[majorCategory];
      const candidates = minorCategories.filter((name) => {
        const data = categoryData[name];
        return data && data.currentScore > spawnThreshold;
      });

      if (candidates.length === 0) continue;

      const pickedName = p.random(candidates);
      spawnIcon(pickedName, majorCategory);
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

      p.noStroke();
      p.fill(hue, 70, 80, icon.alpha * 0.5);
      p.circle(icon.x, icon.y, icon.size * 1.4);

      p.tint(0, 0, 100, icon.alpha);
      p.image(img, icon.x, icon.y, icon.size, icon.size);
      p.noTint();

      p.pop();
    }
  }

  // ==== ステータス =====================================
  function drawStatusText() {
    p.fill(0, 0, 100, 0.9);
    p.textSize(16);
    p.text(statusMessage, p.width / 2, p.height - 30);
  }
};

new p5(sketch);
