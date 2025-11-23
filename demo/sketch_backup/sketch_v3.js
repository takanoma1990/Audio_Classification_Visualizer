// 1. スクリプトの先頭で、必要なモジュールを import します
import { AudioClassifier, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@latest";

// 2. p5.jsのスケッチ全体を一つの関数オブジェクトとして定義します (インスタンスモード)
const sketch = (p) => {

    // --- スケッチ内で使う変数を定義 ---
    let fft;
    let spectrumHistory = [];
    const historyLength = 100;
    const startBin = 10;
    const noiseThreshold = 50;

    const lowGain = 2.;
    const midGain = 2.;
    const highGain = 2.;

    const textBlockX = 0;
    const textBlockY = 50;
    const scoreDisplayMax = 0.5;

    // ★ 絵文字を生成する対象のカテゴリ
    // ★★★ カテゴリの階層構造を新しく定義 ★★★
    // ★★★ カテゴリの階層構造を「発生源」ベースで再定義 ★★★
    const CATEGORIES_HIERARCHY = {
        "Group-1": [
            "Speech",
            "Bird",
            "Violin, fiddle",
            "Singing",
            "Conversation",
            "Walk, footsteps",
            "Run"
        ],
        "Group-2": [
            "Music",
            "Drum machine",
            "Percussion",
            "Happy music",
            "Sad music",
            "Ambient music",
            "Electronic dance music",
        ],
        "Group-3": [
            "Vehicle",
            "Engine",
            "Alarm",
            "Marimba, xylophone",
            "Flute",
            "Harp",
            "Typing"
        ],
        "Group-4": [
            "Insect",
            "Wind",
            "Thunder",
            "Rain",
            "Water",
            "Fire"
        ],
        "Group-5": [
            "Piano",
            "Electric piano",
            "Electric guitar",
            "Saxophone",
            "Synthesizer",
            "Sampler",
            "Chime"
        ]
    };

    // ★★★ 新しい階層に合わせた色の再定義 ★★★
    const CATEGORY_COLORS = {
        "Group-1": 120,          // 青色系
        "Group-2": 0,        // マゼンタ系
        "Group-3": 60, // 黄色系
        "Group-4": 180,       // 緑色系
        "Group-5": 240       // 緑色系
    };

    const allTargetCategories = Object.values(CATEGORIES_HIERARCHY).flat();

    let categoryData = {};
    const smoothingFactor = 0.1;
    const SCORE_BOOST = 50.; // ★ 検出時に与える固定のスコアブースト
    const SPECIAL_BOOSTS = {
        "Speech": 0.001,
        "Music": 0.005
    };

    let particles = [];
    const numParticles = 500;
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

    // --- p5.jsのコア関数 ---
    
    // ★★★ preload関数で音声ファイルを読み込む ★★★
    p.preload = () => {
        myFont = p.loadFont('Roboto-Regular.ttf');
        // 'test.mp3' を読み込み、soundFile変数に格納
        soundFile = p.loadSound('test.mp3'); 
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

        for (let i = 0; i < numParticles; i++) {
            particles.push(new Particle());
        }

        // ★★★ MediaPipeのセットアップを先に行う ★★★
        await setupMediaPipe();
        
        // ★★★ MediaPipeとp5.FFTのセットアップをここで行う ★★★
        if (audioClassifier) {
            const audioCtx = p.getAudioContext();

            // p5.FFTの準備
            fft = new p5.FFT(0.4, 512);
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
        // p.camera(camEyeX, camEyeY, camEyeZ, 0, 0, 0, 0, 1, 0);

        p.camera(camEyeX + p.sin(p.frameCount*0.005)*200,
                 camEyeY + p.sin(p.frameCount*0.001)*1000,
                 camEyeZ + p.sin(p.frameCount*0.001)*1000,
                0, 0, 0, 0, 1, 0);
        
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

    function drawParticles() {
        const connectDistance = 200;
        const minDistance = 20;

        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const p1 = particles[i];
                const p2 = particles[j];
                const d = p1.pos.dist(p2.pos);
                if (d < connectDistance) {
                    const alpha = p.map(d, minDistance, connectDistance, 1.0, 0.1);
                    p.stroke(currentHue, 80, 100, alpha);
                    p.strokeWeight(2);
                    p.line(p1.pos.x, p1.pos.y, p1.pos.z, p2.pos.x, p2.pos.y, p2.pos.z);
                }
            }
        }
        
        p.noStroke();
        for (let particle of particles) {
            particle.display();
            particle.update();
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
            });
            
            currentColumnX += columnWidth;
        }
        
        textLayer.pop();
    }

    async function setupMediaPipe() {
        try {
            statusMessage = "Loading Audio Model...";
            const audioTasks = await FilesetResolver.forAudioTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@latest/wasm");
            audioClassifier = await AudioClassifier.createFromOptions(audioTasks, {
                baseOptions: {
                    modelAssetPath: "https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite",
                    delegate: "GPU"
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
        p.pop();
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
    
    class Particle {
        constructor() {
            // ★★★ プロパティを3つに増やす ★★★
            this.individualHue = 0; // バランスモードで目標となる自分の色
            this.displayHue = p.random(360); // 実際に表示される現在の色
            this.hueChangeSpeed = p.random(0.05, 0.1); // 色の変化速度
            this.reset();
        }



        reset() {
            const radius = p.random(particleBounds * 0.5, particleBounds * 1.2);
            const angle1 = p.random(p.TWO_PI);
            const angle2 = p.random(p.TWO_PI);
            this.pos = p.createVector(
                radius * Math.sin(angle1) * Math.cos(angle2),
                radius * Math.sin(angle1) * Math.sin(angle2),
                radius * Math.cos(angle1)
            );

            this.vel = p.createVector(p.random(-0.5, 0.5), p.random(-0.5, 0.5), p.random(-0.5, 0.5));
            this.baseVel = this.vel.copy();
            this.size = p.random(1, 5);
            this.lifespan = p.random(300, 600);
            this.maxLifespan = this.lifespan;
            this.hueOffset = p.random(-15, 15);
            this.shapeType = p.floor(p.random(3)); 
            this.rotation = p.createVector(p.random(p.TWO_PI), p.random(p.TWO_PI), p.random(p.TWO_PI));
            this.rotationSpeed = p.createVector(p.random(-0.01, 0.01), p.random(-0.01, 0.01), p.random(-0.01, 0.01));

            if (activeHues && activeHues.length > 0) {
                this.individualHue = p.random(activeHues);
            } else {
                this.individualHue = currentHue;
            }
            
            // ★ 表示色をリセット後の位置に基づいて初期化（見た目のため）
            this.displayHue = (this.pos.mag() * 0.1) % 360;
        }

        update() {
            const speedMultiplier = p.map(smoothedBassLevel, 0, 1.5, 1.0, 2.0, true);
            let scaledBaseVel = this.baseVel.copy().mult(speedMultiplier);
            let pushForce = this.pos.copy().normalize().mult(smoothedBassLevel * 0.5);
            let targetVel = p5.Vector.add(scaledBaseVel, pushForce);
            this.vel.lerp(targetVel, 0.1);
            this.pos.add(this.vel);
            this.rotation.add(this.rotationSpeed);
            this.lifespan--;
            if (this.lifespan < 0) {
                this.reset();
            }
        }

        display() {
            p.push();
            p.translate(this.pos.x, this.pos.y, this.pos.z);
            p.rotateX(this.rotation.x);
            p.rotateY(this.rotation.y);
            p.rotateZ(this.rotation.z);
            p.noStroke();
            const alpha = p.map(this.lifespan, 0, this.maxLifespan / 2, 0, 0.8, true);
            let brightness = p.map(smoothedBassLevel, 0, 1, 90, 120, true);
            
            let targetParticleHue;
            if (isBalancedMode) {
                // バランスモードの時は、自分の固有色が目標
                targetParticleHue = this.individualHue;
            } else {
                // 通常モードの時は、全体のブレンドされた色が目標
                targetParticleHue = currentHue;
            }
            
            // lerpを使って、現在の表示色(displayHue)を目標色(targetParticleHue)に近づける
            // ※ 色相(角度)のlerpは単純ではないですが、この実装でも十分滑らかに見えます
            this.displayHue = p.lerp(this.displayHue, targetParticleHue, this.hueChangeSpeed);
            
            // 最終的に表示する色として、滑らかに変化させたdisplayHueを使う
            p.fill( (this.displayHue + this.hueOffset) % 360, 80, brightness, alpha);

            let s = this.size + smoothedBassLevel * 20;
            switch (this.shapeType) {
                case 0: p.sphere(s); break;
                case 1: p.box(s * 1.5); break;
                case 2:
                    p.beginShape(p.TRIANGLES);
                    let v0 = p.createVector(0, -s, 0);
                    let v1 = p.createVector(-s, s, s);
                    let v2 = p.createVector(s, s, s);
                    let v3 = p.createVector(0, s, -s);
                    p.vertex(v0.x, v0.y, v0.z); p.vertex(v1.x, v1.y, v1.z); p.vertex(v2.x, v2.y, v2.z);
                    p.vertex(v0.x, v0.y, v0.z); p.vertex(v2.x, v2.y, v2.z); p.vertex(v3.x, v3.y, v3.z);
                    p.vertex(v0.x, v0.y, v0.z); p.vertex(v3.x, v3.y, v3.z); p.vertex(v1.x, v1.y, v1.z);
                    p.vertex(v1.x, v1.y, v1.z); p.vertex(v3.x, v3.y, v3.z); p.vertex(v2.x, v2.y, v2.z);
                    p.endShape(p.CLOSE);
                    break;
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