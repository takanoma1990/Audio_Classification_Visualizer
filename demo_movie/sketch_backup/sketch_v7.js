// 1. スクリプトの先頭で、必要なモジュールを import します
import { AudioClassifier, FilesetResolver } from "./task-audio/audio_bundle.mjs";

// 2. p5.jsのスケッチ全体を一つの関数オブジェクトとして定義します (インスタンスモード)
const sketch = (p) => {

    // --- スケッチ内で使う変数を定義 ---
    let fft;
    let spectrumHistory = [];
    let detectedTextHistory = [];
    let textGenerationCooldown = 0;
    const historyLength = 100;
    const startBin = 10;
    const noiseThreshold = 20;

    const lowGain = 2.;
    const midGain = 2.;
    const highGain = 2.;

    const textBlockX = 0;
    const textBlockY = 50;
    const scoreDisplayMax = 0.5;

    // ★ 絵文字を生成する対象のカテゴリ
    // ★★★ カテゴリの階層構造を「自然音」ベースで再定義 ★★★
    const CATEGORIES_HIERARCHY = {
        "Forest & Life": [ // 森と生命 (緑色系)
            "Bird", "Insect", "Cricket", "Frog", "Crow",
            "Rustling leaves", "Forest"
        ],
        "Water": [ // 水 (水色系)
            "Rain", "Raindrop", "Pour",
            "Water", "Stream", "River", "Waterfall",
            "Ocean", "Waves, surf"
        ],
        "Atmosphere": [ // 大気 (紫色・藍色系)
            "Wind", "Wind noise (microphone)",
            "Thunderstorm", "Thunder",
            "Fire" // Fireは自然現象としてこちらに分類
        ],
        "Music": [
            "Music",
            "Drum machine",
            "Percussion",
            "Piano",
            "Electric piano",
            "Electric guitar",
            "Saxophone",
            "Synthesizer"
        ],
    };

    // ★★★ 新しい階層に合わせた色の再定義 ★★★
    const CATEGORY_COLORS = {
        "Forest & Life": 120, // 緑
        "Water": 190,         // 水色
        "Atmosphere": 260,       // 紫・藍色
        "Music":0   
    };

    // 忘れずにallTargetCategoriesも更新します
    const allTargetCategories = Object.values(CATEGORIES_HIERARCHY).flat();

    let categoryData = {};
    const smoothingFactor = 0.1;
    const SCORE_BOOST = 50.; // ★ 検出時に与える固定のスコアブースト
    const SPECIAL_BOOSTS = {
        "Speech": 0.001,
        "Music": 0.005
    };

    let reactiveParticles = [];  // ★★★ この2行に変更 ★★★
    let generatedParticles = []; // ★★★

    const numReactiveParticles = 300; // ★★★ numParticlesから名前を変更
    const particleBounds = 2500;

    let bassLevel = 0;
    let smoothedBassLevel = 0;

    let smoothedWaveform = []; // 滑らかにした波形データを保持する配列
    const waveformSmoothing = 0.3; // 波形の滑らかさ係数 (0.0〜1.0)。小さいほど滑らかになる
    

    let audioClassifier;
    let statusMessage = "Initializing...";
    let isPlaying = false; // ★ isMicOn から isPlaying に変更
    let soundFile; // ★ 音声ファイルオブジェクトを保持する変数を追加
    let scriptNode;
    let myFont;

    let isBalancedMode = false; // ★ バランスモードかどうかを判定するフラグ
    let activeHues = []; // ★ アクティブなカテゴリの色相を格納する配列
    const MIN_ACTIVE_CATEGORIES = 3;    // バランスモードになるために必要な最小カテゴリ数
    const ACTIVE_CATEGORY_THRESHOLD = 0.1; // カテゴリがアクティブだと判断するスコアのしきい値

    let textLayer;
    let targetHue = 210;     // ★ パーティクル全体が目指す目標の色相
    let currentHue = 210;    // ★ 現在の色相（滑らかに変化させるため）

    let camEyeX, camEyeY, camEyeZ;

    let birdModel; 

    // --- p5.jsのコア関数 ---
    
    // ★★★ preload関数で音声ファイルを読み込む ★★★
    p.preload = () => {
        myFont = p.loadFont('Roboto-Regular.ttf');
        // 'test.mp3' を読み込み、soundFile変数に格納
        soundFile = p.loadSound('music/test_v5.mp3'); 
        birdModel = p.loadModel('bird_blender.obj', true); 
    };

    p.setup = async () => {
        const loadFontAsPromise = (path) => {
            return new Promise((resolve, reject) => {
                p.loadFont(path, resolve, reject);
            });
        };

        try {
            myFont = await loadFontAsPromise('Roboto-Regular.ttf');
        } catch (error) {
            console.error("フォントの読み込みに失敗しました:", error);
            p.noLoop();
            return;
        }

        p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);

        camEyeX = -1600;
        camEyeY = -300;
        camEyeZ = 300;

        p.colorMode(p.HSB, 360, 100, 100, 1.0);

        allTargetCategories.forEach(name => {
            categoryData[name] = {
                displayName: name,
                currentScore: 0,
                targetScore: 0,
                integratedScore: 0
            };
        });

        textLayer = p.createGraphics(p.windowWidth, p.windowHeight);
        textLayer.textFont(myFont);
        textLayer.colorMode(p.HSB, 360, 100, 100, 1.0);

         for (let i = 0; i < numReactiveParticles; i++) {
            reactiveParticles.push(new ReactiveParticle());
        }
        // ★★★ MediaPipeのセットアップを先に行う ★★★
        await setupMediaPipe();
        
        // ★★★ MediaPipeとp5.FFTのセットアップをここで行う ★★★
        if (audioClassifier) {
            const audioCtx = p.getAudioContext();

            // p5.FFTの準備
            fft = new p5.FFT(0.8, 512);
            fft.setInput(soundFile);

            // MediaPipeのためのScriptProcessorNodeの準備
            scriptNode = audioCtx.createScriptProcessor(16384, 1, 1);
            scriptNode.onaudioprocess = (e) => {
                if (!isPlaying || !audioClassifier || audioCtx.state !== 'running') return;
                const inputData = e.inputBuffer.getChannelData(0);
                const results = audioClassifier.classify(inputData, audioCtx.sampleRate);
                
                for (const name in categoryData) {
                    categoryData[name].targetScore = 0;
                }
                
                if (results?.length > 0) {
                    const classifications = results[0].classifications[0].categories;
                    if (classifications.length > 0) {
                        // console.table(classifications.slice(0, 10)); // デバッグ用に残す
                    }
                    classifications.forEach(category => {
                        const name = category.displayName || category.categoryName;
                        if (categoryData.hasOwnProperty(name)) {
                            categoryData[name].targetScore = category.score;
                        }
                    });
                }
            };

            // ★ 音声ファイルをScriptNodeに接続し、ScriptNodeをスピーカーに接続
            soundFile.connect(scriptNode);
            scriptNode.connect(p5.soundOut.audiocontext.destination);
        }

        p.noCursor();
    };


    p.draw = () => {
        p.background(0);
        if (textGenerationCooldown > 0) { // ★★★ ここから3行追加 ★★★
            textGenerationCooldown--;
        }
        drawWaveformLine();

        if (!p._renderer.isP3D) {
            p.push();
            p.background(0);
            p.fill(255);
            p.textAlign(p.CENTER, p.CENTER);
            p.text("フォント読み込みに失敗したため、3D表示を停止しました。\nブラウザのコンソールとネットワークタブを確認してください。", p.width / 2, p.height / 2);
            p.pop();
            return;
        }
        
        p.orbitControl();
        const cam_mode = 1;
        if(cam_mode == 0){
            p.camera(camEyeX, camEyeY, camEyeZ, 0, 0, 0, 0, 1, 0);
        }else if(cam_mode == 1){
            p.camera(camEyeX + p.sin(p.frameCount*0.005)*200,
                    camEyeY + p.sin(p.frameCount*0.001)*1000,
                    camEyeZ + p.sin(p.frameCount*0.001)*1000,
                    0, 0, 0, 0, 1, 0);
        }
        
        // ★ isMicOn を isPlaying に変更
        if (isPlaying && fft) {
            let spectrum = fft.analyze();
            bassLevel = p.map(fft.getEnergy("bass"), 0, 255, 0, 1) + p.map(fft.getEnergy("mid"), 0, 255, 0, 1) + p.map(fft.getEnergy("treble"), 0, 255, 0, 1);
            drawSpectrogram(spectrum);
        } else {
            bassLevel *= 0.95;
        }
        
        smoothedBassLevel = p.lerp(smoothedBassLevel, bassLevel, 0.3);

        const scoreDecay = 0.99;
        for (const name in categoryData) {
            categoryData[name].integratedScore *= scoreDecay;
        }

        let totalScore = 0;
        let weightedHue = 0;

        const majorScores = [];
        activeHues = [];

        for (const majorCategory in CATEGORIES_HIERARCHY) {
            const minorCategories = CATEGORIES_HIERARCHY[majorCategory];
            let majorCategoryScore = 0;
            minorCategories.forEach(minorName => {
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
        
        // 【新ロジック】アクティブなカテゴリの数を数える
        const activeCategoryCount = majorScores.filter(score => score > ACTIVE_CATEGORY_THRESHOLD).length;

        // アクティブなカテゴリ数がしきい値以上ならバランスモードON
        if (activeCategoryCount >= MIN_ACTIVE_CATEGORIES) {
            isBalancedMode = true;
        } else {
            isBalancedMode = false;
        }

        if (totalScore > 0) {
            targetHue = weightedHue / totalScore;
        }
        currentHue = p.lerp(currentHue, targetHue, 0.1);
        
        drawParticles();
        drawTextOverlay();
        drawFlowingText();
        
        p.push();
        p.translate(-500, -800, -1000);
        p.rotateY(p.PI * 1.5);
        p.image(textLayer, 0, 0);
        p.pop();

        drawCameraHelper();

        p.push();
        p.translate(0.2000,0);
        p.rotateX(p.frameCount*0.0004);
        p.rotateY(p.frameCount*0.0002);
        p.rotateZ(p.frameCount*0.0001);
        p.noFill();
        p.strokeWeight(5);
        p.stroke(255);
        p.sphere(5000);
        p.pop();
    };

    function drawCameraHelper() {
        p.push();
        p.resetMatrix();
        p.fill(255);
        p.textSize(16);
        p.textAlign(p.LEFT, p.TOP);
        let info = `Camera Position (eye):\n` +
                `X: ${Math.round(camEyeX)} (A/D keys)\n` +
                `Y: ${Math.round(camEyeY)} (W/S keys)\n` +
                `Z: ${Math.round(camEyeZ)} (Q/E keys)`;
        p.text(info, 10, 10);
        p.pop();
    }
    
    // ★★★ keyPressed関数を更新 ★★★
    p.keyPressed = async () => {
        const moveSpeed = 50;
        if (p.key === 'a') camEyeX -= moveSpeed;
        else if (p.key === 'd') camEyeX += moveSpeed;
        else if (p.key === 'w') camEyeY -= moveSpeed;
        else if (p.key === 's') camEyeY += moveSpeed;
        else if (p.key === 'q') camEyeZ -= moveSpeed;
        else if (p.key === 'e') camEyeZ += moveSpeed;

        // Spacebarが押された時の処理
        if (p.keyCode === 32) {
            togglePlay(); // 再生/一時停止を切り替える
        }
    };
    
    // ★★★ 再生/一時停止を切り替える新しい関数 ★★★
    function togglePlay() {
        // AudioContextがユーザー操作によって開始されるようにする
        if (p.getAudioContext().state !== 'running') {
            p.getAudioContext().resume();
        }

        if (soundFile.isPlaying()) {
            soundFile.pause();
            isPlaying = false;
            statusMessage = "Paused. Press Spacebar to play.";
        } else {
            // loop()を使うことで、曲が終了したら自動的に最初から再生します
            soundFile.loop(); 
            isPlaying = true;
            statusMessage = "Playing... Press Spacebar to pause.";
        }
    }


    p.windowResized = () => {
        p.resizeCanvas(p.windowWidth, p.windowHeight);
        textLayer.resizeCanvas(p.windowWidth, p.windowHeight);
        textLayer.textFont(myFont);
        textLayer.colorMode(p.HSB, 360, 100, 100, 1.0);
    };

    function drawFlowingText() {
        // 後ろからループすることで、安全に要素を削除できます
        for (let i = detectedTextHistory.length - 1; i >= 0; i--) {
            let textInfo = detectedTextHistory[i];

            // 1. 位置を更新する (右に流す)
            textInfo.pos.z += 10.0; // 流れるスピード
            
            // 2. 寿命を減らす
            textInfo.lifespan--;

            // 3. テキストを描画する
            p.push();
            p.translate(textInfo.pos.x, textInfo.pos.y, textInfo.pos.z);
            
            // カメラの方を向くように回転させると見やすい
            p.rotateY(-p.PI / 2);

            const hue = CATEGORY_COLORS[textInfo.majorCategory];
            const alpha = p.map(textInfo.lifespan, 0, 100, 0, 1.0, true); // 最後はフェードアウト
            p.fill(hue, 80, 100, alpha);
            p.textSize(60); // テキストのサイズ
            p.textAlign(p.CENTER, p.CENTER);
            p.text(textInfo.name, 0, 0);
            p.pop();

            // 4. 寿命が尽きたら配列から削除する
            if (textInfo.lifespan < 0) {
                detectedTextHistory.splice(i, 1);
            }
        }
    }

    // ★★★ このクラスをまるごと追加 ★★★
    class ReactiveParticle {
        constructor() {
            this.pos = p.createVector(
                p.random(-particleBounds, particleBounds),
                p.random(-particleBounds, particleBounds),
                p.random(-particleBounds, particleBounds)
            );
            this.vel = p5.Vector.random3D().mult(0.5);
            this.size = p.random(2, 6);
        }

        update() {
            // 音のエネルギー(smoothedBassLevel)に応じて速度と反発力を変える
            const speedMultiplier = p.map(smoothedBassLevel, 0, 1.5, 0.5, 3.5, true); // ★最大値を大きく
            const pushForce = this.pos.copy().normalize().mult(smoothedBassLevel * 0.5); // ★係数を0.1から0.5に
            
            this.pos.add(this.vel.copy().mult(speedMultiplier)).add(pushForce);

            // 画面外に出たら反対側から現れる
            if (this.pos.mag() > particleBounds) {
                this.pos.mult(-1);
            }
        }

        display() {
            p.push();
            p.translate(this.pos.x, this.pos.y, this.pos.z);
            
            // 全体の色(currentHue)に反応し、明るさは音量に連動
            const brightness = p.map(smoothedBassLevel, 0, 1.5, 20, 100, true);
            const alpha = p.map(brightness, 20, 100, 0.2, 0.8);
            p.noStroke();
            p.fill(currentHue, 60, brightness, alpha);
            
            p.sphere(this.size);
            p.pop();
        }
    }


    // drawParticles() 関数をまるごと置き換え
    function drawParticles() {
        // 1. 反応するパーティクルを描画
        for (let particle of reactiveParticles) {
            particle.update();
            particle.display();
        }
        
        // 2. 生成されたパーティクルを描画（後ろからループして安全に削除）
        for (let i = generatedParticles.length - 1; i >= 0; i--) {
            let particle = generatedParticles[i];
            particle.update();
            particle.display();
            
            if (particle.isDead) {
                generatedParticles.splice(i, 1);
            }
        }
    }
    
    function drawTextOverlay() {
        textLayer.clear();
        textLayer.push();
        textLayer.translate(textBlockX, textBlockY);

        const numColumns = Object.keys(CATEGORIES_HIERARCHY).length;
        const columnWidth = 2500 / numColumns;
        const barHeight = 50;
        const lineHeight = 50;
        const titleSize = 40;
        const labelSize = 30;
        
        let currentColumnX = 50;

        for (const majorCategory in CATEGORIES_HIERARCHY) {
            textLayer.fill(255);
            textLayer.textSize(titleSize);
            textLayer.textAlign(p.LEFT, p.TOP);
            textLayer.text(majorCategory, currentColumnX, 0);

            const minorCategories = CATEGORIES_HIERARCHY[majorCategory];
            const labelWidth = 80;
            const barMaxWidth = columnWidth - labelWidth - 60;
            
            minorCategories.forEach((minorCategoryName, index) => {
                const data = categoryData[minorCategoryName];
                if (!data) return;

                const y = (titleSize + 50) + (index * lineHeight);
                
                let boost = SCORE_BOOST;
                if (SPECIAL_BOOSTS.hasOwnProperty(minorCategoryName)) {
                    boost = SCORE_BOOST * SPECIAL_BOOSTS[minorCategoryName];
                }
                
                const targetWithBoost = data.targetScore * boost;

                if (targetWithBoost > data.currentScore) {
                    const attack = 0.1; 
                    data.currentScore = p.lerp(data.currentScore, targetWithBoost, attack);
                } else {
                    const decay = 0.98;
                    data.currentScore *= decay;
                }

                const barX = currentColumnX + labelWidth;
                const displayScore = p.map(data.currentScore, 0, scoreDisplayMax, 0, 1, true);
                const barWidth = displayScore * barMaxWidth;
                
                textLayer.fill(0, 0, 100, 0.2);
                textLayer.rect(barX, y - barHeight / 2, barMaxWidth, barHeight, 5);
                
                const hue = CATEGORY_COLORS[majorCategory];
                textLayer.fill(hue, 80, 95);
                textLayer.rect(barX, y - barHeight / 2, barWidth, barHeight, 5);

                textLayer.fill(255);
                textLayer.textSize(labelSize);
                textLayer.textAlign(p.LEFT, p.CENTER);
                textLayer.text(data.displayName, currentColumnX, y);

                const detectionThreshold = 0.2; // テキストを生成するスコアのしきい値
                
                // スコアがしきい値を超えたら、新しいテキストオブジェクトを生成
                if (displayScore > detectionThreshold && textGenerationCooldown === 0) {
                    // 同じテキストが連続で生成されるのを防ぐ簡単なチェック
                    const lastText = detectedTextHistory[detectedTextHistory.length - 1];
                    if (!lastText || lastText.name !== minorCategoryName) {
                        const newText = {
                            name: minorCategoryName,
                            majorCategory: majorCategory,
                            pos: p.createVector(
                                // ★★★ ここをマイナスからプラスに変更 ★★★
                                -500, // 開始位置 (画面右側)
                                p.random(-200, 1000), // y座標をランダムに
                                -1400  // z座標をランダムに
                            ),
                            lifespan: 400
                        };
                        detectedTextHistory.push(newText);
                        textGenerationCooldown = 10;
                        // 一度にたくさん出すぎないように調整
                        if (p.frameCount % 10 === 0) { // 10フレームに1回だけ生成
                            console.log(`Generated a particle for: ${majorCategory}`); 
                            const newParticle = new GeneratedParticle(majorCategory);
                            generatedParticles.push(newParticle);
                        }
                    }
                }
            });
            
            currentColumnX += columnWidth;
        }
        
        textLayer.pop();
    }

    async function setupMediaPipe() {
        try {
            statusMessage = "Loading Audio Model...";
            const audioTasks = await FilesetResolver.forAudioTasks("./task-audio/wasm");
            audioClassifier = await AudioClassifier.createFromOptions(audioTasks, {
                baseOptions: {
                    modelAssetPath: "./models/yamnet.tflite",
                    delegate: "CPU"
                },
                maxResults: 10,
            });
            // ★★★ メッセージを変更 ★★★
            statusMessage = "Press Spacebar to Play";
        } catch (e) {
            console.error("MediaPipe setup failed:", e);
            statusMessage = `Error: Could not load model. ${e.message}`;
        }
    }

    // ★★★ startMic と stopMic 関数は不要になったため削除 ★★★

    function drawSpectrogram(spectrum) {
        spectrumHistory.push(spectrum);
        if (spectrumHistory.length > historyLength) {
            spectrumHistory.splice(0, 1);
        }
        p.push();
        p.translate(0, 700, 300);
        p.rotateZ(p.PI * 0.6);
        p.rotateY(p.PI / 2);
        p.rotateZ(p.PI);
        p.noStroke();

        for (let i = 0; i < spectrumHistory.length; i++) {
            p.beginShape(p.TRIANGLE_STRIP);
            for (let j = startBin; j < spectrumHistory[i].length; j += 8) {
                let x = p.map(i, 0, spectrumHistory.length - 1, p.width / 2, -p.width / 2);
                let h = p.map(spectrumHistory[i][j], noiseThreshold, 255, 0, -300, true);
                let z = p.map(p.log(j), p.log(startBin), p.log(spectrumHistory[i].length), 400, -1000);
                let hue = p.map(spectrumHistory[i][j], noiseThreshold, 255, 240, 0);
                let alpha = p.map(i, 0, spectrumHistory.length, 0.5, 3.0, true);
                p.fill(hue, 100, 120, alpha);
                p.vertex(x, 0, z);
                p.vertex(x, h, z);
            }
            p.endShape();
        }
        p.pop();

        const sampleRate = 44100; // p5.soundのデフォルト値
        const binWidth = sampleRate / fft.bins / 2;
        const labelsToShow = [100, 200, 500, 1000, 2000, 4000, 8000, 16000];
        
        p.textFont(myFont);
        p.textSize(20);
        p.fill(255, 0.7);
        p.textAlign(p.CENTER, p.CENTER);

        const i = spectrumHistory.length - 1;
        const x = p.map(i, 0, spectrumHistory.length - 1, p.width / 2, -p.width / 0.2);

        labelsToShow.forEach(hz => {
            const j = p.round(hz / binWidth);
            if (j >= startBin && j < fft.bins) {
                let z = p.map(p.log(j), p.log(startBin), p.log(fft.bins), 500, -1000);
                p.push();
                p.translate(x - 200, 0, z);
                const cam = p._renderer.camera;
                if (cam) {
                    p.rotateZ(-p.PI);
                    p.rotateY(-p.PI/2);
                    p.rotateZ(-p.PI*0.8);
                    p.rotateY(-cam.pan);
                    p.rotateX(-cam.tilt);
                }
                p.rotateX(p.PI/2);
                let label = `${hz} `;
                p.textSize(50);
                p.text(label, 0, 0);
                p.pop();
            }
        });
    }

    function drawWaveformLine() {
        // ★ isMicOn を isPlaying に変更
        if (isPlaying && fft) {
            let waveform = fft.waveform();

            if (smoothedWaveform.length !== waveform.length) {
                smoothedWaveform = Array.from(waveform);
            }
            for (let i = 0; i < waveform.length; i++) {
                smoothedWaveform[i] = p.lerp(smoothedWaveform[i], waveform[i], waveformSmoothing);
            }
            
            p.push();
            p.translate(1000,300,0);
            p.rotateY(p.PI/2);

            const lineAlpha = p.map(smoothedBassLevel, 0, 1.5, 0.1, 5.0, true);
            const weight = p.map(smoothedBassLevel, 0, 1.5, 2, 8, true);

            p.strokeWeight(weight);
            p.noFill();
            p.stroke(currentHue, 80, 100, lineAlpha);

            for (let i = 0; i < waveform.length; i++) {
                let x = p.map(i, 0, waveform.length, -p.width * 4, p.width * 4);
                let y = p.map(smoothedWaveform[i], -0.5, 0.5, -8000, 8000);
                if(i%2 == 0){
                    p.point(x, y, 0);
                }
            }
            p.pop();
        }
    }
    
    class GeneratedParticle {
        /**
         * @param {string} species - 生成されるパーティクルの種族名 ("Forest & Life", "Water" など)
         */
        constructor(species) {
            // --- 基本的な性質 ---
            this.species = species; // このパーティクルの「種族」を決定
            this.pos = p.createVector(0, 0, 0); // 原点から生成される
            this.vel = p5.Vector.random3D().mult(p.random(8, 15));
            this.size = p.random(5, 15);
            
            // --- 寿命 ---
            this.lifespan = p.random(200, 300); // 200〜300フレーム（約3〜5秒）で消える
            this.maxLifespan = this.lifespan;
            this.isDead = false; // 寿命が尽きたら true になるフラグ

            // --- 見た目（回転） ---
            this.rotation = p.createVector(p.random(p.TWO_PI), p.random(p.TWO_PI), p.random(p.TWO_PI));
            this.rotationSpeed = p.createVector(p.random(-0.02, 0.02), p.random(-0.02, 0.02), p.random(-0.02, 0.02));
            
            // --- 見た目（色） ---
            // 種族に紐づいた固定の色をベースにする
            this.hue = CATEGORY_COLORS[this.species]; 
        }

        /**
         * 毎フレーム呼び出され、パーティクルの位置や状態を更新する
         */
        update() {
            // 寿命を減らす
            this.lifespan--;
            if (this.lifespan < 0) {
                this.isDead = true;
                return; // 死亡したら以降の処理はしない
            }

            // 種族ごとの動きのルールを適用
            switch (this.species) {
                case "Forest & Life":
                    // 少しふわふわと飛ぶような動き
                    this.vel.mult(0.99);
                    break;

                case "Water":
                    // 少し重力を感じて下に落ちる動き
                    this.vel.add(0, -0.02, 0);
                    this.vel.mult(0.995);
                    break;

                case "Atmosphere":
                    // 予測不能な動き
                    let windForce = p.createVector(p.noise(this.pos.x * 0.01) - 0.5, p.noise(this.pos.y * 0.01) - 0.5, p.noise(this.pos.z * 0.01) - 0.5);
                    this.vel.add(windForce.mult(0.1));
                    this.vel.limit(2.0);
                    break;

                case "Music":
                    // リズミカルに脈動するような動き（速度を変化させる）
                    this.vel.mult(1.0 + p.sin(p.frameCount * 0.2) * 0.01);
                    break;

                default:
                    // デフォルトの動き
                    this.vel.mult(0.99);
                    break;
            }

            // 座標と角度を更新
            this.pos.add(this.vel);
            this.rotation.add(this.rotationSpeed);
        }

        /**
         * パーティクルを画面に描画する
         */
        display() {
            p.push();
            p.translate(this.pos.x, this.pos.y, this.pos.z);
            p.rotateX(this.rotation.x);
            p.rotateY(this.rotation.y);
            p.rotateZ(this.rotation.z);

            // --- 色と透明度の設定 ---
            const alpha = p.map(this.lifespan, 0, this.maxLifespan, 0, 1.0, true); // 寿命に応じてフェードアウト
            const brightness = p.map(smoothedBassLevel, 0, 1, 90, 120, true); // 全体の音量で明るさが変わる
            p.noStroke();
            p.fill(this.hue, 80, brightness, alpha);

            // --- 大きさの設定 ---
            let s = this.size + smoothedBassLevel * 10; // 全体の音量で少し大きくなる

            // --- 種族ごとの形状を描画 ---
            if (this.species === "Forest & Life" && birdModel) {
                p.scale(s * 1.5); // モデルの大きさに合わせて調整
                p.rotateZ(p.PI);
                p.model(birdModel);
            } else if (this.species === "Water") {
                p.sphere(s);
            } else if (this.species === "Atmosphere") {
                p.box(s * 0.5, s * 0.5, s * 2);
            } else if (this.species === "Music") {
                // 音楽は脈動する球体にする
                s *= (1.0 + p.sin(p.frameCount * 0.2 + this.pos.x) * 0.2);
                p.sphere(s);
            } else {
                // もしものためのデフォルト表示
                p.sphere(s);
            }
            
            p.pop();
        }
    }
};

function calculateStandardDeviation(arr) {
    if (arr.length === 0) return 0;
    
    // 1. 平均値を計算
    const mean = arr.reduce((acc, val) => acc + val, 0) / arr.length;
    
    // 2. 各要素と平均値との差の2乗の平均を計算（分散）
    const variance = arr.reduce((acc, val) => acc + (val - mean) ** 2, 0) / arr.length;
    
    // 3. 分散の平方根（標準偏差）を返す
    return Math.sqrt(variance);
}

new p5(sketch);