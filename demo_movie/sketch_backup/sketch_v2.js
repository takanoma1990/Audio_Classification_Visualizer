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
    let isMicOn = false;
    let micStream;
    let audioSourceNode;
    let scriptNode;
    let myFont;

    let textLayer;
    let targetHue = 210;     // ★ パーティクル全体が目指す目標の色相
    let currentHue = 210;    // ★ 現在の色相（滑らかに変化させるため）

    let peakDetect;
    let camEyeX, camEyeY, camEyeZ;

    p.preload = () => {
        myFont = p.loadFont('Roboto-Regular.ttf');
    };

    // --- p5.jsのコア関数 ---

    p.setup = async () => {
        // ★★★ p5.loadFontをPromiseでラップして、読み込みを強制的に待機させる ★★★
        const loadFontAsPromise = (path) => {
            return new Promise((resolve, reject) => {
                p.loadFont(path, resolve, reject);
            });
        };

        try {
            myFont = await loadFontAsPromise('Roboto-Regular.ttf');
        } catch (error) {
            console.error("フォントの読み込みに失敗しました:", error);
            p.noLoop(); // エラー時はスケッチを停止
            return;
        }
        // ★★★ ここまでが追加・変更部分 ★★★

        p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);

        // ★ カメラ座標の初期値を設定
        camEyeX = -1600;
        camEyeY = -300;
        // camEyeZ = 31;
        camEyeZ = 300;

        p.colorMode(p.HSB, 360, 100, 100, 1.0);

        allTargetCategories.forEach(name => {
            categoryData[name] = {
                displayName: name,
                currentScore: 0,
                targetScore: 0,
                integratedScore: 0 // ★ この行を追加
            };
        });

        textLayer = p.createGraphics(p.windowWidth, p.windowHeight);
        textLayer.textFont(myFont); // ← これでmyFontが確実に読み込まれた状態で実行される
        textLayer.colorMode(p.HSB, 360, 100, 100, 1.0);

        for (let i = 0; i < numParticles; i++) {
            particles.push(new Particle());
        }

        await setupMediaPipe();

        p.noCursor();
    };


    p.draw = () => {
        
        p.background(0);

        drawWaveformLine();

        // ★ WEBGLモードが有効な場合のみ3D関連の処理を実行
        if (!p._renderer.isP3D) {
            p.push();
            p.background(0);
            p.fill(255);
            p.textAlign(p.CENTER, p.CENTER);
            p.text("フォント読み込みに失敗したため、3D表示を停止しました。\nブラウザのコンソールとネットワークタブを確認してください。", p.width / 2, p.height / 2);
            p.pop();
            return; // ここで描画を終了
        }
        
        p.orbitControl();
        // p.camera(camEyeX + p.sin(p.frameCount*0.005)*200,
        //          camEyeY + p.sin(p.frameCount*0.001)*1000,
        //          camEyeZ + p.sin(p.frameCount*0.001)*1000,
        //         0, 0, 0, 0, 1, 0);
        p.camera(camEyeX,
                 camEyeY,
                 camEyeZ,
                0, 0, 0, 0, 1, 0);
        
        // --- ここから下は元の描画処理 ---
        if (isMicOn && fft) {
            let spectrum = fft.analyze();

            bassLevel = p.map(fft.getEnergy("bass"), 0, 255, 0, 1) + p.map(fft.getEnergy("mid"), 0, 255, 0, 1) + p.map(fft.getEnergy("treble"), 0, 255, 0, 1);
            drawSpectrogram(spectrum);
        } else {
            bassLevel *= 0.95;
        }
        
        smoothedBassLevel = p.lerp(smoothedBassLevel, bassLevel, 0.3);

        const scoreDecay = 0.99; // 減衰率 (1.0に近いほどゆっくり減る)
        for (const name in categoryData) {
            categoryData[name].integratedScore *= scoreDecay;
        }

        let totalScore = 0;
        let weightedHue = 0;

        for (const majorCategory in CATEGORIES_HIERARCHY) {
            const minorCategories = CATEGORIES_HIERARCHY[majorCategory];
            let majorCategoryScore = 0;
            minorCategories.forEach(minorName => {
                if (categoryData[minorName]) {
                    majorCategoryScore += categoryData[minorName].currentScore;
                }
            });
            
            if (majorCategoryScore > 0) {
                const categoryHue = CATEGORY_COLORS[majorCategory];
                weightedHue += categoryHue * majorCategoryScore;
                totalScore += majorCategoryScore;
            }
        }
        
        if (totalScore > 0) {
            targetHue = weightedHue / totalScore;
        }
        // 現在の色相を目標の色相にゆっくり近づける
        currentHue = p.lerp(currentHue, targetHue, 0.9);

        

        drawParticles();
        drawTextOverlay();
        
        p.push();
        p.translate(-500, -800, -1000);
        p.rotateY(p.PI * 1.5);
        p.image(textLayer, 0, 0);
        p.pop();

        drawCameraHelper();

        p.translate(0.2000,0);
        p.rotateX(p.frameCount*0.0004);
        p.rotateY(p.frameCount*0.0002);
        p.rotateZ(p.frameCount*0.0001);
        p.noFill();
        p.strokeWeight(5);
        p.stroke(255);
        p.sphere(5000);

    };


    // 画面左上に現在のカメラ座標を描画する関数
    function drawCameraHelper() {
        p.push();
        // 2D描画モードに切り替えて文字を描画
        p.resetMatrix();
        p.fill(255);
        p.textSize(16);
        p.textAlign(p.LEFT, p.TOP);
        let info = `Camera Position (eye):\n` +
                `X: ${Math.round(camEyeX)} (Q/A keys)\n` +
                `Y: ${Math.round(camEyeY)} (W/S keys)\n` +
                `Z: ${Math.round(camEyeZ)} (E/D keys)`;
        p.text(info, 10, 10);
        // console.log(info);
        p.pop();
    }


    p.keyPressed = async () => {

        const moveSpeed = 50; // カメラの移動速度
        if (p.key === 'a') {
            camEyeX -= moveSpeed;
        } else if (p.key === 'd') {
            camEyeX += moveSpeed;
        } else if (p.key === 'w') {
            camEyeY -= moveSpeed;
        } else if (p.key === 's') {
            camEyeY += moveSpeed;
        } else if (p.key === 'e') {
            camEyeZ += moveSpeed;
        } else if (p.key === 'q') {
            camEyeZ -= moveSpeed;
        }

        if (p.keyCode === 32) { // Spacebar
            if (p.getAudioContext().state !== 'running') {
                await p.getAudioContext().resume();
            }
            if (!isMicOn) {
                await startMic();
            } else {
                stopMic();
            }
        }

    };

    p.windowResized = () => {
        p.resizeCanvas(p.windowWidth, p.windowHeight);
        textLayer.resizeCanvas(p.windowWidth, p.windowHeight);
        textLayer.textFont(myFont);
        textLayer.colorMode(p.HSB, 360, 100, 100, 1.0);
    };

    function drawParticles() {
        const connectDistance = 200;
        const minDistance = 20;

        // 全てのパーティクルのペアについてループ
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const p1 = particles[i];
                const p2 = particles[j];

                const d = p1.pos.dist(p2.pos);

                if (d < connectDistance) {
                    const alpha = p.map(d, minDistance, connectDistance, 1.0, 0.1); // 透明度を少し調整

                    // ★★★ グローバルな `currentHue` を使って線の色を決める ★★★
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
    

    // ★★★ 4列表示に対応した新しいdrawTextOverlay関数 ★★★
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
            // 大カテゴリ名を描画
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
                
                // ★★★ ここからが新しいスコア計算ロジック ★★★
                let boost = SCORE_BOOST;
                if (SPECIAL_BOOSTS.hasOwnProperty(minorCategoryName)) {
                    boost = SCORE_BOOST * SPECIAL_BOOSTS[minorCategoryName];
                }
                
                const targetWithBoost = data.targetScore * boost;

                // --- 上昇と減衰の速度を分ける ---
                if (targetWithBoost > data.currentScore) {
                    // スコアが上昇する場合 (アタック) は素早く反応
                    const attack = 0.1; 
                    data.currentScore = p.lerp(data.currentScore, targetWithBoost, attack);
                } else {
                    // スコアが下降する場合 (ディケイ) はゆっくり減衰
                    const decay = 0.98; // 毎フレーム 2% ずつ減少
                    data.currentScore *= decay;
                }
                // ★★★ ここまで ★★★

                // バーの描画
                const barX = currentColumnX + labelWidth;

                // 小さいカテゴリのスコアを少し増幅して表示
                const adjustedScore = data.currentScore * (majorCategory === data.displayName ? 1.0 : 2.5);
                //    mapの上限値も 0.3 から 3.0 など、より大きな値に変更
                const displayScore = p.map(data.currentScore, 0, scoreDisplayMax, 0, 1, true);
                
                const barWidth = displayScore * barMaxWidth;
                
                // バーの背景
                textLayer.fill(0, 0, 100, 0.2);
                textLayer.rect(barX, y - barHeight / 2, barMaxWidth, barHeight, 5);
                
                // バー本体
                const hue = CATEGORY_COLORS[majorCategory];
                textLayer.fill(hue, 80, 95);
                textLayer.rect(barX, y - barHeight / 2, barWidth, barHeight, 5);

                // 小カテゴリ名
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
            statusMessage = "Press Spacebar to turn Mic ON";
        } catch (e) {
            console.error("MediaPipe setup failed:", e);
            statusMessage = `Error: Could not load model. ${e.message}`;
        }
    }

    async function startMic() {
        if (!audioClassifier) return;
        try {
            statusMessage = "Starting Mic...";
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            micStream = stream;
            const audioCtx = p.getAudioContext();
            audioSourceNode = audioCtx.createMediaStreamSource(stream);
            fft = new p5.FFT(0.4, 512);
            fft.setInput(audioSourceNode);

            peakDetect = new p5.PeakDetect(20, 20000, 0.05, 20);

            scriptNode = audioCtx.createScriptProcessor(16384, 1, 1);
            scriptNode.onaudioprocess = (e) => {
                if (!isMicOn || !audioClassifier || audioCtx.state !== 'running') return;
                const inputData = e.inputBuffer.getChannelData(0);
                const results = audioClassifier.classify(inputData, audioCtx.sampleRate);
                
                for (const name in categoryData) {
                    categoryData[name].targetScore = 0;
                }
                
                if (results?.length > 0) {
                    const classifications = results[0].classifications[0].categories;

                    // ★★★ ここにconsole.tableを追加 ★★★
                    // スコア上位10件をテーブル形式でコンソールに表示
                    if (classifications.length > 0) {
                        console.table(classifications.slice(0, 10));
                    }

                    classifications.forEach(category => {
                        const name = category.displayName || category.categoryName;
                        if (categoryData.hasOwnProperty(name)) {
                            categoryData[name].targetScore = category.score;
                        }
                    });
                }
            };

            audioSourceNode.connect(scriptNode);
            scriptNode.connect(audioCtx.destination);
            isMicOn = true;
            statusMessage = "Mic ON. Press Spacebar to turn OFF";
        } catch (e) {
            console.error("Could not start mic:", e);
            statusMessage = `Mic Error: ${e.message}`;
        }
    }

    function stopMic() {
        if (micStream) micStream.getTracks().forEach(track => track.stop());
        if (audioSourceNode) audioSourceNode.disconnect();
        if (scriptNode) scriptNode.disconnect();
        fft = null;
        spectrumHistory = [];
        isMicOn = false;
        statusMessage = "Mic OFF. Press Spacebar to turn ON";
    }

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

        const getVertexInfo = (i, j) => {
            const amp = spectrumHistory[i][j];
            const logAmp = p.log(1 + amp);
            let h = p.map(logAmp, p.log(1 + noiseThreshold), p.log(256), 0, -300, true);

            const totalBins = spectrumHistory[i].length;
            const fadeWidth = 5; 
            let fadeMultiplier = 1.0;

            if (j < startBin + fadeWidth) {
                fadeMultiplier = p.map(j, startBin, startBin + fadeWidth, 0, 1.0);
            } else if (j > totalBins - fadeWidth) {
                fadeMultiplier = p.map(j, totalBins - fadeWidth, totalBins, 1.0, 0);
            }
            h *= fadeMultiplier;

            if (j < 150) h *= lowGain;
            else if (j < 600) h *= midGain;
            else h *= highGain;

            let hue;
            const midAmp = 90;  // 中間点となる音量の閾値 (青から黄色に変わる点)
            const maxAmp = 180; // これ以上の音量で真っ赤になる閾値

            if (amp < midAmp) {
                // noiseThreshold ～ midAmp の間: 青色(240) から 黄色(60) へ変化
                hue = p.map(amp, noiseThreshold, midAmp, 240, 160);
            } else {
                // midAmp ～ maxAmp の間: 黄色(60) から 赤色(0) へ変化
                hue = p.map(amp, midAmp, maxAmp, 160, 0);
            }

            return {
                x: p.map(i, 0, spectrumHistory.length - 1, p.width / 2, -p.width / 2),
                y: h,
                z: p.map(p.log(j), p.log(startBin), p.log(spectrumHistory[i].length), 500, -1000),
                hue: hue,
                amplitude: amp
            };
        };

        /*for (let i = 0; i < spectrumHistory.length - 1; i++) {
            p.beginShape(p.TRIANGLE_STRIP);
            for (let j = startBin; j < spectrumHistory[i].length; j += 8) {
                let v1 = getVertexInfo(i, j);
                let v2 = getVertexInfo(i + 1, j);
                let alpha = p.map(v1.amplitude, noiseThreshold, 200, 0.1, 5.0, true);
                p.fill(v1.hue, 100, 120, alpha);
                p.vertex(v1.x, v1.y, v1.z);
                p.vertex(v2.x, v2.y, v2.z);
            }
            p.endShape();
        }*/

        // フレームごとに区切ったスペクトログラム
        for (let i = 0; i < spectrumHistory.length; i++) {
            p.beginShape(p.TRIANGLE_STRIP);
            for (let j = startBin; j < spectrumHistory[i].length; j += 8) {
                let x = p.map(i, 0, spectrumHistory.length - 1, p.width / 2, -p.width / 2);
                let h = p.map(spectrumHistory[i][j], noiseThreshold, 255, 0, -300, true);
                // if (j < 150) {
                //     h *= lowGain;
                // } else if (j < 600) {
                //     h *= midGain;
                // } else {
                //     h *= highGain;
                // }
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

        const sampleRate = p.getAudioContext().sampleRate;
        const binWidth = sampleRate / fft.bins / 2;
        const labelsToShow = [100, 200, 500, 1000, 2000, 4000, 8000, 16000];
        
        p.textFont(myFont);
        p.textSize(20);
        p.fill(255, 0.7);
        p.textAlign(p.CENTER, p.CENTER);

        // スペクトログラムの最も手前の辺 (i=historyLength-1) にラベルを描画
        const i = spectrumHistory.length - 1;
        const x = p.map(i, 0, spectrumHistory.length - 1, p.width / 2, -p.width / 0.2);

        labelsToShow.forEach(hz => {
            const j = p.round(hz / binWidth); // Hzをビンのインデックスに変換
            if (j >= startBin && j < fft.bins) {
                // z座標を計算
                let z = p.map(p.log(j), p.log(startBin), p.log(fft.bins), 500, -1000);
                
                // テキストを描画
                p.push();
                p.translate(x - 200, 0, z); // 少し上に浮かせる
                
                // ラベルが常にカメラを向くように回転（ビルボード効果）
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

    // ★★★ この関数をまるごと書き換える ★★★
    function drawWaveformLine() {
        // マイクがオンで、FFTオブジェクトが利用可能な場合のみ処理を実行
        if (isMicOn && fft) {
            let waveform = fft.waveform(); // 現在の音の波形データを取得 (-1.0 ~ 1.0の範囲)

            // --- スムージング処理 ---
            if (smoothedWaveform.length !== waveform.length) {
                smoothedWaveform = Array.from(waveform);
            }
            for (let i = 0; i < waveform.length; i++) {
                smoothedWaveform[i] = p.lerp(smoothedWaveform[i], waveform[i], waveformSmoothing);
            }
            // --- スムージング処理ここまで ---

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

            // ★★★ 追加：各パーティクル固有の色相オフセットをここで一度だけ決める ★★★
            this.hueOffset = p.random(-15, 15);
            
            this.shapeType = p.floor(p.random(3)); 

            this.rotation = p.createVector(p.random(p.TWO_PI), p.random(p.TWO_PI), p.random(p.TWO_PI));
            this.rotationSpeed = p.createVector(p.random(-0.01, 0.01), p.random(-0.01, 0.01), p.random(-0.01, 0.01));
        }

        update() {
            // ★★★ 音量に応じて基本速度をスケールアップ ★★★
            // smoothedBassLevelは0.0(無音)〜約3.0(大音量)の値
            const speedMultiplier = p.map(smoothedBassLevel, 0, 1.5, 1.0, 2.0, true);
            let scaledBaseVel = this.baseVel.copy().mult(speedMultiplier);

            let pushForce = this.pos.copy().normalize().mult(smoothedBassLevel * 0.5);
            
            // ★ 現在の速度(this.vel)にではなく、スケールアップした基本速度に力を加える
            let targetVel = p5.Vector.add(scaledBaseVel, pushForce);

            // ★ 現在の速度を、ゆっくりと目標の速度に近づける
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
            
            p.fill( (currentHue + this.hueOffset) % 360, 80, brightness, alpha);
            
            let s = this.size + smoothedBassLevel * 20; // 描画サイズを変数sにまとめる
            
            // ★★★ タイプに応じて描画する図形を8種類に増やす ★★★
            switch (this.shapeType) {
                case 0: p.sphere(s); break;
                case 1: p.box(s * 1.5); break;
                case 2: // カスタムの三角錐
                    p.beginShape(p.TRIANGLES);
                    // 4つの頂点を定義
                    let v0 = p.createVector(0, -s, 0);   // 天辺
                    let v1 = p.createVector(-s, s, s);   // 左下
                    let v2 = p.createVector(s, s, s);    // 右下
                    let v3 = p.createVector(0, s, -s);   // 奥下
                    // 4つの三角形の面を描画
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

new p5(sketch);