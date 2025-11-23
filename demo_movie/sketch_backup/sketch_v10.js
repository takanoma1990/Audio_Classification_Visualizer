// 1. スクリプトの先頭で、必要なモジュールを import します
import { AudioClassifier, FilesetResolver } from "./task-audio/audio_bundle.mjs";

// 2. p5.jsのスケッチ全体を一つの関数オブジェクトとして定義します (インスタンスモード)
const sketch = (p) => {

    // --- スケッチ内で使う変数を定義 ---
    let fft;
    let spectrumHistory = [];
    
    let flowingIconsHistory = [];
    let textGenerationCooldown = 0;
    const historyLength = 120;
    const startBin = 10;
    const noiseThreshold = 20;

    const lowGain = 1;
    const midGain = 1.;
    const highGain = 1.;

    const textBlockX = 0;
    const textBlockY = 50;
    const scoreDisplayMax = 0.5;

    const CATEGORIES_HIERARCHY = {
        "Forest & Life": [
            "Bird",
            "Bird flight, flapping wings",
            "Forest",
            "Wood"
        ],
        "Water": [
            "Rain",
            "Water",
            "Stream",
            "River",
            "Frog"
        ],
        "Atmosphere": [
            "Wind", "Thunderstorm", "Thunder",
            "Fire", "Crackle"
        ],
        "Traffic": [
            "Traffic noise, roadway noise",
            "Motor vehicle (road)",
            "Car",
            "Vehicle horn, car horn, honking",
            "Skidding"
        ],
        "Music": [
            "Guitar",
            "Synthesizer",
            "Drum machine",
            "Speech",
            "Piano"
        ]
    };

    const CATEGORY_COLORS = {
        "Forest & Life": 120,
        "Water": 190,
        "Atmosphere": 0,
        "Traffic": 60,
        "Music": 30,
    };

    const allTargetCategories = Object.values(CATEGORIES_HIERARCHY).flat();

    // ★★★ 読み込んだ画像を保持するオブジェクトを追加 ★★★
    let iconImages = {};

    let categoryData = {};
    const smoothingFactor = 0.01;
    const SCORE_BOOST = 5.;
    const SPECIAL_BOOSTS = {
        "Speech": 0.001,
        "Music": 0.005
    };

    let particles = [];
    const numParticles = 200;
    // const particleBounds = 3500; // この変数は新しいロジックでは直接使われません

    let bassLevel = 0;
    let smoothedBassLevel = 0;

    let smoothedWaveform = [];
    const waveformSmoothing = 0.2;
    

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
        soundFile = p.loadSound('music/traffic.mp3');
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

        camEyeX = -4050;
        camEyeY = -200;
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

        textLayer = p.createGraphics(p.windowWidth, p.windowHeight);
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
                
                if (results?.length > 0) {
                    const classifications = results[0].classifications[0].categories;
                    if (classifications.length > 0) {
                        // console.table(classifications.slice(0, 10));
                    }
                    classifications.forEach(category => {
                        const name = category.displayName || category.categoryName;
                        if (categoryData.hasOwnProperty(name)) {
                            categoryData[name].targetScore = category.score;
                        }
                    });
                }
            };

            soundFile.connect(scriptNode);
            scriptNode.connect(p5.soundOut.audiocontext.destination);
        }


        p.noCursor();
    };


    p.draw = () => {
        p.background(0);
        if (textGenerationCooldown > 0) {
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
                    camEyeY + p.sin(p.frameCount*0.001)*500,
                    camEyeZ + p.sin(p.frameCount*0.001)*500,
                    0, 0, 0, 0, 1, 0);
        }
        
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

        flowingIconsHistory.forEach(iconInfo => {
            const hue = CATEGORY_COLORS[iconInfo.majorCategory];
            p.pointLight(hue, 80, 100, iconInfo.pos); 
        });

        p.push();
        p.rotateZ(p.PI/2);
        drawParticles();
        p.pop();

        drawTextOverlay();
        
        drawFlowingImages();
        
        p.push();
        p.translate(-p.width, -800, -1250);
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
        p.stroke(255);
        p.sphere(5000);
        p.pop();
    };
    
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
        for (let i = flowingIconsHistory.length - 1; i >= 0; i--) {
            let iconInfo = flowingIconsHistory[i];

            iconInfo.pos.z += 8.5; 
            iconInfo.lifespan--;

            p.push();
            p.translate(iconInfo.pos.x, iconInfo.pos.y, iconInfo.pos.z);
            p.rotateY(-p.PI / 2);

            const img = iconImages[iconInfo.name];
            p.rectMode(p.CENTER);
            if (img) { 
                const hue = CATEGORY_COLORS[iconInfo.majorCategory];
                const alpha = p.map(iconInfo.lifespan, 0, 100, 0, 1.0, true);
                p.tint(hue, 100, 120, alpha); 
                p.imageMode(p.CENTER);
                p.image(img, 0, 0, iconInfo.size, iconInfo.size);
                p.noTint(); 

                p.noFill();
                p.stroke(0, 0, 100, alpha); 
                p.rect(0, 0, iconInfo.size, iconInfo.size);
            }
            p.pop();

            if (iconInfo.lifespan < 0) {
                flowingIconsHistory.splice(i, 1);
            }
        }
        
        const connectDistance = 700; 
        p.strokeWeight(1);

        for (let i = 0; i < flowingIconsHistory.length; i++) {
            for (let j = i + 1; j < flowingIconsHistory.length; j++) {
                
                let iconA = flowingIconsHistory[i];
                let iconB = flowingIconsHistory[j];

                if (iconA.majorCategory === iconB.majorCategory) {
                    let distance = iconA.pos.dist(iconB.pos);
                    if (distance < connectDistance) {
                        const alpha = p.map(distance, 0, connectDistance, 1.0, .1);
                        const hue = CATEGORY_COLORS[iconA.majorCategory]; 
                        p.stroke(0, 0, 250, alpha); 
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
        // 以下のflocking（群れ）の計算は、新しいParticleクラスでは使用されませんが、
        // 他のロジックに影響を与えないため、そのまま残しています。
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

                const detectionThreshold = 0.2;
                
                if (displayScore > detectionThreshold && textGenerationCooldown === 0) {
                    const lastIcon = flowingIconsHistory[flowingIconsHistory.length - 1];
                    if (!lastIcon || lastIcon.name !== minorCategoryName) {
                        const newIconInfo = {
                            name: minorCategoryName,
                            majorCategory: majorCategory,
                            pos: p.createVector(
                                p.random(-3500, -2500),
                                p.random(-200, 1000),
                                p.random(-1600,-1400)
                            ),
                            lifespan: 400,
                            size: p.random(30, 100)
                        };
                        flowingIconsHistory.push(newIconInfo);
                        textGenerationCooldown = 20;
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
        p.translate(500, 1500, 0);
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
            p.translate(3000,300,-500);
            p.rotateY(p.PI/2);

            const lineAlpha = p.map(smoothedBassLevel, 0, 1.5, 0.1, 5.0, true);
            const weight = p.map(smoothedBassLevel, 0, 1.5, 0.1, 4, true);

            p.strokeWeight(weight);
            p.noFill();
            p.stroke(currentHue, 80, 100, lineAlpha);

            for (let i = 0; i < waveform.length; i++) {
                let x = p.map(i, 0, waveform.length, -p.width * 4, p.width * 4);
                let y = p.map(smoothedWaveform[i], -0.5, 0.5, -4000, 4000);
                if(i%2 == 0){
                    p.point(x, y, 0);
                }
            }
            p.pop();
        }
    }
    
    // =================================================================
    // ▼▼▼ ここからが修正されたParticleクラスです ▼▼▼
    // =================================================================
    class Particle {
        constructor() {
            // パーティクルの円運動の半径の範囲を定義
            this.minRadius = 5000;
            this.maxRadius = 5500;

            // 従来のプロパティ
            this.individualHue = 0;
            this.displayHue = p.random(360);
            this.hueChangeSpeed = p.random(0.05, 0.1);
            this.species = "Ambience";
            this.flockmateInfluence = p.createVector(0, 0, 0); // この変数は新しい動きでは使いません

            this.reset();
        }

        reset() {
            // 1. 円運動のためのプロパティを設定
            this.radius = p.random(this.minRadius, this.maxRadius); // このパーティクルの軌道半径
            this.angle = p.random(p.TWO_PI); // 円周上の初期角度
            this.angularVelocity = p.random(-0.005, 0.005); // 回転の速さと向き
            this.yPosition = p.random(-1000, 1000); // Y軸（高さ）方向の初期位置

            // 2. 新しいプロパティに基づいて初期位置を計算 (XZ平面上での円運動)
            this.pos = p.createVector(
                this.radius * p.cos(this.angle),
                this.yPosition,
                this.radius * p.sin(this.angle)
            );

            // 3. その他の外見や寿命に関するプロパティは元と同様に設定
            this.size = p.random(1, 5);
            this.lifespan = p.random(300, 600);
            this.maxLifespan = this.lifespan;
            this.hueOffset = p.random(-15, 15);
            this.shapeType = p.floor(p.random(1)); 
            this.rotation = p.createVector(p.random(p.TWO_PI), p.random(p.TWO_PI), p.random(p.TWO_PI));
            this.rotationSpeed = p.createVector(p.random(-0.01, 0.01), p.random(-0.01, 0.01), p.random(-0.01, 0.01));

            // 色や種族に関するロジックも維持
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
        }

        update() {
            // --- ここからが新しい動きのロジック ---

            // 1. 音楽の低音レベルに応じて回転速度を変化させる
            const speedMultiplier = p.map(smoothedBassLevel, 0, 1.5, 1.0, 3.0, true);
            this.angle += this.angularVelocity * speedMultiplier;

            // 2. ノイズを使って、半径とY座標を滑らかに変化させ、ランダムな動きを表現
            let radiusOffset = (p.noise(this.angle, this.lifespan * 0.01) - 0.5) * 20;
            this.radius += radiusOffset;
            this.radius = p.constrain(this.radius, this.minRadius, this.maxRadius); // 半径が範囲外に出ないように制限

            let yOffset = (p.noise(this.lifespan * 0.01, this.angle) - 0.5) * 20;
            this.yPosition += yOffset;
            this.yPosition = p.constrain(this.yPosition, -1000, 1000); // Y座標も範囲内に制限

            // 3. 回転と揺らぎを反映した新しい座標を計算
            this.pos.x = this.radius * p.cos(this.angle);
            this.pos.y = this.yPosition;
            this.pos.z = this.radius * p.sin(this.angle);

            // 4. さらに微細な3Dノイズを加えて、より有機的な動きにする
            let noiseVec = p5.Vector.fromAngles(
                p.noise(this.pos.x * 0.005, this.lifespan * 0.01) * p.TWO_PI,
                p.noise(this.pos.y * 0.005, this.lifespan * 0.01) * p.TWO_PI
            );
            noiseVec.mult(smoothedBassLevel * 10); // 低音が大きいほどノイズの影響が強まる
            this.pos.add(noiseVec);

            // 5. 自身の回転と寿命を更新
            this.rotation.add(this.rotationSpeed);
            this.lifespan--;

            // 6. 寿命が尽きたらリセット
            if (this.lifespan < 0) {
                this.reset();
            }
        }

        display() {
            // 表示に関するロジックは変更なし
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
    // =================================================================
    // ▲▲▲ Particleクラスの修正はここまでです ▲▲▲
    // =================================================================
};

new p5(sketch);