// 1. スクリプトの先頭で、必要なモジュールを import します
import { AudioClassifier, FilesetResolver } from "./task-audio/audio_bundle.mjs";

// 2. p5.jsのスケッチ全体を一つの関数オブジェクトとして定義します (インスタンスモード)
const sketch = (p) => {

    // --- スケッチ内で使う変数を定義 ---
    let fft;
    let spectrumHistory = [];
    
    let flowingIconsHistory = [];
    let groupCooldowns = {};
    let musicScoreData = { targetScore: 0 }; 

    const historyLength = 80;
    const startBin = 10;
    const noiseThreshold = 100;

    const lowGain = 1;
    const midGain = 1.;
    const highGain = 1.;

    const textBlockX = 0;
    const textBlockY = 50;
    const scoreDisplayMax = 0.3;

    const CATEGORIES_HIERARCHY = {
        "Forest & Life": [
            "Bird",
            // "Chirp, tweet",
            "Rustling leave"
        ],
        "Water": [
            "Ocean",
            "Water",
            "Stream"
        ],
        "Atmosphere": [
            "Thunderstorm",  
            "Wind",
            "Fire"
        ],
        "Traffic": [
            "Aircraft",
            "Car",
            "Rail transport"
        ],
        "Music": [
            "Drum machine",
            "Percussion",
            "Synthesizer"
        ]
    };

    const CATEGORY_COLORS = {
        "Forest & Life": 120,
        "Water": 190,
        "Atmosphere": 60,
        "Traffic": 0,
        "Music": 30,
    };

    groupCooldowns = {
        "Forest & Life": 0,
        "Water": 0,
        "Atmosphere": 0,
        "Traffic": 0,
        "Music": 0
    };

    const allTargetCategories = Object.values(CATEGORIES_HIERARCHY).flat();

    // ★★★ 読み込んだ画像を保持するオブジェクトを追加 ★★★
    let iconImages = {};

    let categoryData = {};
    const SCORE_BOOST = 10.;
    const SPECIAL_BOOSTS = {
        "Speech": 0.001,
        "Music": 0.1,
        "Thunderstorm":2,
    };

    let particles = [];
    const numParticles = 120;
    const particleBounds = 5000;

    let bassLevel = 0;
    let smoothedBassLevel = 0;

    let smoothedWaveform = [];
    const waveformSmoothing = 0.1;
    

    let audioClassifier;
    let statusMessage = "Initializing...";
    let isPlaying = false;
    let soundFile;
    let scriptNode;
    let myFont;

    let isBalancedMode = false;
    let activeHues = [];
    const MIN_ACTIVE_CATEGORIES = 3;
    const ACTIVE_CATEGORY_THRESHOLD = 0.1;

    let textLayer;
    let targetHue = 210;
    let currentHue = 210;

    let camEyeX, camEyeY, camEyeZ;

    let birdModel;

    // --- p5.jsのコア関数 ---
    
    p.preload = () => {
        myFont = p.loadFont('Roboto-Regular.ttf');
        soundFile = p.loadSound('music/beat_ambient.mp3');
        birdModel = p.loadModel('bird_blender.obj', true);

        // ★★★ カテゴリに対応する画像をすべて読み込む ★★★
        allTargetCategories.forEach(categoryName => {
            const path = `icons/${categoryName}.png`;
            iconImages[categoryName] = p.loadImage(path,
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
            myFont = await loadFontAsPromise('Roboto-Regular.ttf');
        } catch (error) {
            console.error("フォントの読み込みに失敗しました:", error);
            p.noLoop();
            return;
        }

        p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);

        // camEyeX = -1600;
        // camEyeY = -300;
        // camEyeZ = 300;

        camEyeX = -5000;
        camEyeY = 100;
        camEyeZ = 0;

        p.colorMode(p.HSB, 360, 100, 100, 1.0);

        allTargetCategories.forEach(name => {
            categoryData[name] = {
                displayName: name,
                currentScore: 0,
                targetScore: 0,
                integratedScore: 0
            };
        });

        textLayer = p.createGraphics(0, 0);
        textLayer.textFont(myFont);
        textLayer.colorMode(p.HSB, 360, 100, 100, 1.0);

        for (let i = 0; i < numParticles; i++) {
            particles.push(new Particle());
        }

        await setupMediaPipe();
        
        if (audioClassifier) {
            const audioCtx = p.getAudioContext();

            fft = new p5.FFT(0.3, 512);
            fft.setInput(soundFile);

            scriptNode = audioCtx.createScriptProcessor(16384, 1, 1);
            scriptNode.onaudioprocess = (e) => {
                if (!isPlaying || !audioClassifier || audioCtx.state !== 'running') return;
                const inputData = e.inputBuffer.getChannelData(0);
                const results = audioClassifier.classify(inputData, audioCtx.sampleRate);
                
                for (const name in categoryData) {
                    categoryData[name].targetScore = 0;
                }

                musicScoreData.targetScore = 0;
                
                if (results?.length > 0) {
                    const classifications = results[0].classifications[0].categories;
                    // classifications
                    // .sort((a,b) => b.score - a.score)
                    // .slice(0, 20)
                    // .forEach(c => console.log(c.displayName || c.categoryName, c.score.toFixed(3)));
                    // if (classifications.length > 0) {
                    //     console.table(classifications.slice(0, 50));
                    // }
                    classifications.forEach(category => {
                        const name = category.displayName || category.categoryName;
                        if (categoryData.hasOwnProperty(name)) {
                            categoryData[name].targetScore = category.score;
                        }
                        // 「Music」カテゴリだったら、専用変数にスコアを格納
                        if (name === "Music") {
                            musicScoreData.targetScore = category.score;
                        }
                    });
                }
            };

            soundFile.connect(scriptNode);
            scriptNode.connect(p5.soundOut.audiocontext.destination);
        }

        for (const majorCategory in CATEGORIES_HIERARCHY) {
            groupCooldowns[majorCategory] = 0;
        }

        p.noCursor();
    };


    p.draw = () => {
        p.background(0);
        // p.background("#002853");

        for (const majorCategory in groupCooldowns) {
            if (groupCooldowns[majorCategory] > 0) {
                groupCooldowns[majorCategory]--;
            }
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
        
        // drawCameraHelper();

        p.orbitControl();
        const cam_mode = 0;
        if(cam_mode == 0){
            p.camera(camEyeX, camEyeY, camEyeZ, 0, 0, 0, 0, 1, 0);
        }else if(cam_mode == 1){
            p.camera(camEyeX + p.sin(p.frameCount*0.005)*200,
                    camEyeY + p.sin(p.frameCount*0.001)*1000,
                    camEyeZ + p.sin(p.frameCount*0.001)*1000,
                    0, 0, 0, 0, 1, 0);
        }
        
        if (isPlaying && fft) {
            let spectrum = fft.analyze();
            bassLevel = p.map(fft.getEnergy("bass"), 0, 255, 0, 1) + p.map(fft.getEnergy("mid"), 0, 255, 0, 1) + p.map(fft.getEnergy("treble"), 0, 255, 0, 1);
            //スペクトログラムの描画
            // drawSpectrogram(spectrum);
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
        
        const activeCategoryCount = majorScores.filter(score => score > ACTIVE_CATEGORY_THRESHOLD).length;

        if (activeCategoryCount >= MIN_ACTIVE_CATEGORIES) {
            isBalancedMode = true;
        } else {
            isBalancedMode = false;
        }

        if (totalScore > 0) {
            targetHue = weightedHue / totalScore;
        }
        currentHue = p.lerp(currentHue, targetHue, 0.1);
        
        p.ambientLight(60); 

        // 2. それぞれのアイコンを点光源として設置
        flowingIconsHistory.forEach(iconInfo => {
            const hue = CATEGORY_COLORS[iconInfo.majorCategory];
            // ポイントライトをアイコンの位置に設置
            p.pointLight(hue, 80, 100, iconInfo.pos); 
        });

        drawParticles();
        drawTextOverlay();
        
        // ★★★ テキスト描画関数を画像描画関数に変更 ★★★
        drawFlowingImages();
        
        p.push();
        p.translate(-3300, -1000, -1250);
        p.rotateY(p.PI * 1.5);
        p.image(textLayer, 0, 0);
        p.pop();

        p.push();
        p.translate(0.2000,0);
        p.rotateX(p.frameCount*0.0004);
        p.rotateY(p.frameCount*0.0002);
        p.rotateZ(p.frameCount*0.0001);
        p.noFill();
        p.strokeWeight(5);
        p.stroke(0, 0, 300);
        p.scale(-1, 1, 1);
        p.sphere(6000);
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
        console.log(`Camera Position (eye):\n` +
                `X: ${Math.round(camEyeX)} (A/D keys)\n` +
                `Y: ${Math.round(camEyeY)} (W/S keys)\n` +
                `Z: ${Math.round(camEyeZ)} (Q/E keys)`);
        p.pop();
    }
    
    p.keyPressed = async () => {
        const moveSpeed = 50;
        if (p.key === 'a') camEyeX -= moveSpeed;
        else if (p.key === 'd') camEyeX += moveSpeed;
        else if (p.key === 'w') camEyeY -= moveSpeed;
        else if (p.key === 's') camEyeY += moveSpeed;
        else if (p.key === 'q') camEyeZ -= moveSpeed;
        else if (p.key === 'e') camEyeZ += moveSpeed;

        if (p.keyCode === 32) {
            togglePlay();
        }
    };
    
    p.mousePressed = () => {
        // mouseでの操作
        togglePlay();
    };

    function togglePlay() {
        if (p.getAudioContext().state !== 'running') {
            p.getAudioContext().resume();
        }

        if (soundFile.isPlaying()) {
            soundFile.pause();
            isPlaying = false;
            statusMessage = "Paused. Press Spacebar to play.";
        } else {
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

    function drawFlowingImages() {

        // 後ろからループすることで、安全に要素を削除できます
        for (let i = flowingIconsHistory.length - 1; i >= 0; i--) {
            let iconInfo = flowingIconsHistory[i];

            // 1. 位置を更新する (右に流す)
            iconInfo.pos.z += 8.5; // 流れるスピード
            
            iconInfo.pos.y = iconInfo.default_y + p.sin((p.frameCount + iconInfo.phase)*0.0025) * iconInfo.move_range;
            
            // 2. 寿命を減らす
            iconInfo.lifespan--;

            // 3. 画像を描画する
            p.push();
            p.translate(iconInfo.pos.x, iconInfo.pos.y, iconInfo.pos.z);
            
            // カメラの方を向くように回転
            p.rotateY(-p.PI / 2);

            const img = iconImages[iconInfo.name];
            p.rectMode(p.CENTER);
            if (img) { // 画像が正しく読み込まれているか確認
                const hue = CATEGORY_COLORS[iconInfo.majorCategory];
                const alpha = p.map(iconInfo.lifespan, 0, 100, 0, 1.0, true); // 最後はフェードアウト
                
                // tint()で画像に色と透明度を適用
                // p.tint(hue, 100, 120, alpha); // アイコン自体は白で表示
                p.tint(0, 0, 300, alpha); // アイコン自体は白で表示
                
                p.imageMode(p.CENTER); // 画像の中心を座標に合わせる
                // p.image(img, 0, 0, iconInfo.size + smoothedBassLevel*50, iconInfo.size + smoothedBassLevel*50);
                p.image(img, 0, 0, iconInfo.size, iconInfo.size);
                p.noTint(); // 他の描画に影響が出ないようにtintをリセット

                // 四角い枠の描画
                p.noFill();
                p.stroke(0, 0, 100, alpha); // 枠も白で表示
                // p.rect(0, 0, iconInfo.size + smoothedBassLevel*50, iconInfo.size + smoothedBassLevel*50);
                p.rect(0, 0, iconInfo.size, iconInfo.size);
            }
            p.pop();

            // 4. 寿命が尽きたら配列から削除する
            if (iconInfo.lifespan < 0) {
                flowingIconsHistory.splice(i, 1);
            }
        }

        // アイコン同士を線で結ぶ距離のしきい値
        const connectDistance = 100; 
        p.strokeWeight(1);

        // すべてのアイコンのペアをチェックするための二重ループ
        for (let i = 0; i < flowingIconsHistory.length; i++) {
            for (let j = i + 1; j < flowingIconsHistory.length; j++) {
                
                let iconA = flowingIconsHistory[i];
                let iconB = flowingIconsHistory[j];

                // 1. 同じメジャーカテゴリに属しているかチェック
                if (iconA.majorCategory === iconB.majorCategory) {
                    
                    // 2. 2つのアイコン間の距離を計算
                    let distance = iconA.pos.dist(iconB.pos);

                    // 3. 距離がしきい値より近いかチェック
                    if (distance < connectDistance) {
                        
                        // 4. 線を描画（距離が近いほど不透明にする）
                        const alpha = p.map(distance, 0, connectDistance, 1.0, .1); // 透明度を距離に応じて変化させる
                        const hue = CATEGORY_COLORS[iconA.majorCategory]; // カテゴリの色を取得
                        
                        p.stroke(0, 0, 250, alpha); // カテゴリの色で線を描画
                        p.line(
                            iconA.pos.x, iconA.pos.y, iconA.pos.z,
                            iconB.pos.x, iconB.pos.y, iconB.pos.z
                        );
                    }
                }
            }
        }

    }

    function drawParticles() {
        const connectDistance = 200;
        const minDistance = 20;

        const flockingDistance = 300;
        for (let p1 of particles) {
            if (p1.species === "Animalia") {
                let alignment = p.createVector();
                let cohesion = p.createVector();
                let separation = p.createVector();
                let neighborCount = 0;

                for (let p2 of particles) {
                    if (p1 !== p2 && p2.species === "Animalia") {
                        let d = p1.pos.dist(p2.pos);
                        if (d < flockingDistance) {
                            alignment.add(p2.vel);
                            cohesion.add(p2.pos);
                            if (d < flockingDistance / 2) {
                                let diff = p5.Vector.sub(p1.pos, p2.pos);
                                diff.div(d * d);
                                separation.add(diff);
                            }
                            neighborCount++;
                        }
                    }
                }

                if (neighborCount > 0) {
                    alignment.div(neighborCount).normalize();
                    cohesion.div(neighborCount).sub(p1.pos).normalize();
                    separation.normalize();
                    p1.flockmateInfluence = alignment.add(cohesion).add(separation);
                } else {
                    p1.flockmateInfluence.mult(0);
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

        // ① "Music" カテゴリの現在の生スコアを専用変数から取得
        const musicScore = musicScoreData.targetScore;

        // ② スコアから乗数を計算（1.0が通常時）
        const musicScoreBoost = 10.0; // ← Musicスコアの増幅度合いを調整
        const musicMultiplier = 1.0 + (musicScore * musicScoreBoost);

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

                // 現在処理しているグループが "Music" の場合だけ musicMultiplier を使い、それ以外は 1.0 (影響なし) を使う
                const finalMultiplier = (majorCategory === "Music") ? musicMultiplier : 1.0;

                const targetWithBoost = data.targetScore * boost * finalMultiplier;

                if (targetWithBoost > data.currentScore) {
                    const attack = 0.9; 
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

                // アイコンを出力する閾値を設定
                const detectionThreshold = 0.3; 

                // 閾値のX座標を計算
                const thresholdX = barX + (detectionThreshold * barMaxWidth);

                // 赤い線を引く
                textLayer.stroke(0, 100, 100); // HSBモードなので赤色は (0, 100, 100)
                textLayer.strokeWeight(2); // 線の太さ
                textLayer.line(thresholdX, y - barHeight / 2, thresholdX, y + barHeight / 2);
                textLayer.noStroke(); // 他の描画に影響しないようにstrokeをリセット

                textLayer.fill(255);
                textLayer.textSize(labelSize);
                textLayer.textAlign(p.LEFT, p.CENTER);
                textLayer.text(data.displayName, currentColumnX, y);

                
                // ★★★ スコアがしきい値を超えたら、新しい「アイコン情報」オブジェクトを生成 ★★★
                if (displayScore > detectionThreshold && groupCooldowns[majorCategory] === 0) {
                    const lastIcon = flowingIconsHistory[flowingIconsHistory.length - 1];
                    if (!lastIcon || lastIcon.name !== minorCategoryName) {
                        let def_y = p.random(-1000, 1000);
                        const newIconInfo = { // newText から newIconInfo に名称変更
                            name: minorCategoryName,
                            majorCategory: majorCategory,
                            default_y: def_y,
                            pos: p.createVector(
                                p.random(-3500, -2500),
                                def_y,
                                p.random(-1600,-1400)
                            ),
                            move_range: p.random(50,500),
                            phase: p.random(0,2000),
                            lifespan: 400,
                            size: p.random(50, 150)
                        };
                        // ★★★ アイコン履歴配列に追加 ★★★
                        flowingIconsHistory.push(newIconInfo);
                        groupCooldowns[majorCategory] = 30;
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
                 maxResults: -1, // ← ここを -1 に変更
                scoreThreshold: 0.0001
            });
            console.log(audioClassifier);
            statusMessage = "Press Spacebar to Play";
        } catch (e) {
            console.error("MediaPipe setup failed:", e);
            statusMessage = `Error: Could not load model. ${e.message}`;
        }
    }

    function drawSpectrogram(spectrum) {
        spectrumHistory.push(spectrum);
        if (spectrumHistory.length > historyLength) {
            spectrumHistory.splice(0, 1);
        }
        p.push();
        p.translate(-1500, 0, 0);
        p.rotateZ(p.PI * 0.8);
        p.rotateY(p.PI / 2);
        p.rotateZ(p.PI);
        p.noStroke();

        for (let i = 0; i < spectrumHistory.length; i++) {
            p.beginShape(p.TRIANGLE_STRIP);
            for (let j = startBin; j < spectrumHistory[i].length; j += 8) {
                let x = p.map(i, 0, spectrumHistory.length - 1, 3000, -3000);
                let h = p.map(spectrumHistory[i][j], noiseThreshold, 255, 0, -500, true);
                let z = p.map(p.log(j), p.log(startBin), p.log(spectrumHistory[i].length), 900, -1400);
                let hue = p.map(spectrumHistory[i][j], noiseThreshold, 255, 240, 0);
                let alpha = p.map(i, 0, spectrumHistory.length, 0.5, 3.0, true);
                p.fill(hue, 100, 120, alpha);
                p.vertex(x, 0, z);
                p.vertex(x, h, z);
            }
            p.endShape();
        }
        p.pop();

        const sampleRate = 44100;
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
        if (isPlaying && fft) {
            let waveform = fft.waveform();

            if (smoothedWaveform.length !== waveform.length) {
                smoothedWaveform = Array.from(waveform);
            }
            for (let i = 0; i < waveform.length; i++) {
                smoothedWaveform[i] = p.lerp(smoothedWaveform[i], waveform[i], waveformSmoothing);
            }
            
            p.push();
            p.translate(0,300,-500);
            p.rotateY(p.PI/2);

            const lineAlpha = p.map(smoothedBassLevel, 0, 1.5, 0.1, 5.0, true);
            const weight = p.map(smoothedBassLevel, 0, 1.5, 0.5, 5, true);

            p.strokeWeight(weight);
            p.noFill();
            p.stroke(currentHue, 80, 100, lineAlpha);

            for (let i = 0; i < waveform.length; i++) {
                let x = p.map(i, 0, waveform.length, -p.width * 4, p.width * 4);
                let y = p.map(smoothedWaveform[i], -0.5, 0.5, -4000, 4000);
                if(i%2 == 0){
                    p.point(x, y, 0);
                    p.point(x, -y, 0);
                }
            }
            p.pop();
        }
    }
    
    class Particle {
        constructor() {
            this.individualHue = 0;
            this.displayHue = p.random(360);
            this.hueChangeSpeed = p.random(0.05, 0.1);
            this.species = "Ambience";
            this.flockmateInfluence = p.createVector(0, 0, 0);
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
            this.shapeType = p.floor(p.random(1)); 
            this.rotation = p.createVector(p.random(p.TWO_PI), p.random(p.TWO_PI), p.random(p.TWO_PI));
            this.rotationSpeed = p.createVector(p.random(-0.01, 0.01), p.random(-0.01, 0.01), p.random(-0.01, 0.01));

            if (activeHues && activeHues.length > 0) {
                this.individualHue = p.random(activeHues);
            } else {
                this.individualHue = currentHue;
            }
            
            this.displayHue = (this.pos.mag() * 0.1) % 360;

            const activeMajorCategories = Object.keys(CATEGORIES_HIERARCHY).filter(majorCat => {
                return CATEGORIES_HIERARCHY[majorCat].some(minorCat => categoryData[minorCat]?.currentScore > 0.1);
            });

            if (activeMajorCategories.length > 0) {
                this.species = p.random(activeMajorCategories);
            } else {
                this.species = "Ambience";
            }

            if (this.species === "Artificial") {
                this.vel = p5.Vector.random3D().mult(p.random(1, 3));
            } else {
                this.vel = p.createVector(p.random(-0.5, 0.5), p.random(-0.5, 0.5), p.random(-0.5, 0.5));
            }
            this.baseVel = this.vel.copy();
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
            switch (this.species) {
                case "Forest & Life":
                    let lifeTargetVel = p5.Vector.add(this.baseVel, this.flockmateInfluence);
                    this.vel.lerp(lifeTargetVel, 0.05);
                    break;

                case "Water":
                    this.vel.add(0, 0.01, 0);
                    this.vel.lerp(this.baseVel, 0.02);
                    break;

                case "Atmosphere":
                    let windForce = p.createVector(p.noise(this.pos.x * 0.01, p.frameCount * 0.01) - 0.5, p.noise(this.pos.y * 0.01, p.frameCount * 0.01) - 0.5, 0);
                    windForce.mult(0.1);
                    this.vel.add(windForce);
                    this.vel.limit(1.0);
                    break;
            }

            this.pos.add(this.vel);
            this.rotation.add(this.rotationSpeed);
            this.lifespan--;

            if (this.lifespan < 0 || this.pos.mag() > particleBounds * 1.5) {
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
                targetParticleHue = this.individualHue;
            } else {
                targetParticleHue = currentHue;
            }
            
            this.displayHue = p.lerp(this.displayHue, targetParticleHue, this.hueChangeSpeed);
            
            p.fill( (this.displayHue + this.hueOffset) % 360, 80, brightness, alpha);

            let s = this.size + smoothedBassLevel * 50;

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

new p5(sketch);