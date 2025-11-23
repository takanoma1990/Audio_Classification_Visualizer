// 1. スクリプトの先頭で、必要なモジュールを import します
import { AudioClassifier, FilesetResolver } from "./task-audio/audio_bundle.mjs";

// 2. p5.jsのスケッチ全体を一つの関数オブジェクトとして定義します (インスタンスモード)
const sketch = (p) => {

    // ★ iOS / モバイルかどうか判定
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    // --- スケッチ内で使う変数を定義 ---
    let fft;
    let spectrumHistory = [];
    
    let flowingIconsHistory = [];
    let groupCooldowns = {};
    let musicScoreData = { targetScore: 0 }; 

    const historyLength = 50;
    const startBin = 10;
    const noiseThreshold = 100;

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

    // 画像
    let iconImages = {};

    let categoryData = {};
    const SCORE_BOOST = 10.;
    const SPECIAL_BOOSTS = {
        "Speech": 0.001,
        "Music": 0.1,
        "Thunderstorm":2,
    };

    // パーティクル関連
    let particles = [];
    const numParticles = isMobile ? 40 : 80;      // iPad では半分
    const particleBounds = isMobile ? 3000 : 5000;

    let bassLevel = 0;
    let smoothedBassLevel = 0;

    let smoothedWaveform = [];
    const waveformSmoothing = 0.1;
    
    // ★ audioClassifier はここで宣言
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

        // カテゴリに対応する画像をすべて読み込む
        allTargetCategories.forEach(categoryName => {
            const path = `icons/${categoryName}.png`;
            iconImages[categoryName] = p.loadImage(
                path,
                () => console.log(`Successfully loaded: ${path}`),
                () => console.error(`Failed to load: ${path}`)
            );
        });
    };

    // ★ async をやめて、失敗しても noLoop しないようにする
    p.setup = () => {
        p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);

        // 高解像度端末で重くなるので 1 に固定
        p.pixelDensity(1);

        if (myFont) {
            p.textFont(myFont);
        } else {
            console.warn("myFont が読み込めなかったのでデフォルトフォントを使用します");
        }

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

        textLayer = p.createGraphics(p.windowWidth, p.windowHeight);
        if (myFont) textLayer.textFont(myFont);
        textLayer.colorMode(p.HSB, 360, 100, 100, 1.0);

        for (let i = 0; i < numParticles; i++) {
            particles.push(new Particle());
        }

        // MediaPipe のロードは裏で進める
        setupMediaPipe();

        for (const majorCategory in CATEGORIES_HIERARCHY) {
            groupCooldowns[majorCategory] = 0;
        }

        p.noCursor();
        statusMessage = "Tap / Click to Play";
    };


    p.draw = () => {
        p.background(0);

        // ★ デバッグ用：必ず左上に赤丸 + status 表示
        p.push();
        p.resetMatrix(); // 3D 変換を解除して 2D 座標に戻す
        p.noStroke();
        p.fill(0, 100, 100);      // 赤系 (HSB)
        p.circle(20, 20, 15);     // ← これが見えたら draw 自体は動いている

        p.fill(0, 0, 100);
        p.textSize(14);
        p.textAlign(p.LEFT, p.TOP);
        p.text(statusMessage, 40, 10);
        p.pop();
        // ★ ここまでデバッグ表示

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
            p.text("3D 表示がサポートされていません。", p.width / 2, p.height / 2);
            p.pop();
            return;
        }
        
        // モバイルではカメラ固定にして軽くする
        if (!isMobile) {
            p.orbitControl();
        }

        const cam_mode = 0;
        if (cam_mode == 0) {
            p.camera(camEyeX, camEyeY, camEyeZ, 0, 0, 0, 0, 1, 0);
        } else if (cam_mode == 1) {
            p.camera(
                camEyeX + p.sin(p.frameCount*0.005)*200,
                camEyeY + p.sin(p.frameCount*0.001)*1000,
                camEyeZ + p.sin(p.frameCount*0.001)*1000,
                0, 0, 0, 0, 1, 0
            );
        }
        
        if (isPlaying && fft) {
            let spectrum = fft.analyze();
            bassLevel =
                p.map(fft.getEnergy("bass"),   0, 255, 0, 1) +
                p.map(fft.getEnergy("mid"),    0, 255, 0, 1) +
                p.map(fft.getEnergy("treble"), 0, 255, 0, 1);
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
        
        const activeCategoryCount =
            majorScores.filter(score => score > ACTIVE_CATEGORY_THRESHOLD).length;

        isBalancedMode = activeCategoryCount >= MIN_ACTIVE_CATEGORIES;

        if (totalScore > 0) {
            targetHue = weightedHue / totalScore;
        }
        currentHue = p.lerp(currentHue, targetHue, 0.1);
        
        p.ambientLight(60); 

        if (!isMobile) {
            flowingIconsHistory.forEach(iconInfo => {
                const hue = CATEGORY_COLORS[iconInfo.majorCategory];
                p.pointLight(hue, 80, 100, iconInfo.pos); 
            });
        }

        drawParticles();
        drawTextOverlay();
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

        if (!isMobile) {
            p.sphere(6000);
        } else {
            p.sphere(6000, 10, 10);
        }

        p.pop();
    };

    // --- MediaPipe セットアップ（audioClassifier ここで生成）---

    async function setupMediaPipe() {
        try {
            statusMessage = "Loading Audio Model...";
            const audioTasks = await FilesetResolver.forAudioTasks("./task-audio/wasm");
            audioClassifier = await AudioClassifier.createFromOptions(audioTasks, {
                baseOptions: {
                    modelAssetPath: "./models/yamnet.tflite",
                    delegate: "CPU"
                },
                maxResults: -1,
                scoreThreshold: 0.0001
            });
            console.log("audioClassifier ready", audioClassifier);

            const audioCtx = p.getAudioContext();

            const fftBins = isMobile ? 256 : 512;
            fft = new p5.FFT(0.3, fftBins);
            fft.setInput(soundFile);   // ★ ここで soundFile を FFT に接続

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
                    classifications.forEach(category => {
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

            statusMessage = "Tap / Click to Play";

        } catch (e) {
            console.error("MediaPipe setup failed:", e);
            statusMessage = `Error: Could not load model. ${e.message}`;
        }
    }

    // --- 波形ライン（3D のまま） ---

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

    // --- 以下、Flowing Images / Particles / TextOverlay は元のまま ---

    function drawFlowingImages() {
        for (let i = flowingIconsHistory.length - 1; i >= 0; i--) {
            let iconInfo = flowingIconsHistory[i];

            iconInfo.pos.z += 8.5;
            iconInfo.pos.y = iconInfo.default_y +
                p.sin((p.frameCount + iconInfo.phase)*0.0025) * iconInfo.move_range;
            iconInfo.lifespan--;

            p.push();
            p.translate(iconInfo.pos.x, iconInfo.pos.y, iconInfo.pos.z);
            p.rotateY(-p.PI / 2);

            const img = iconImages[iconInfo.name];
            p.rectMode(p.CENTER);
            if (img) {
                const alpha = p.map(iconInfo.lifespan, 0, 100, 0, 1.0, true);
                p.tint(0, 0, 300, alpha);
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

        const connectDistance = 100; 
        p.strokeWeight(1);

        for (let i = 0; i < flowingIconsHistory.length; i++) {
            for (let j = i + 1; j < flowingIconsHistory.length; j++) {
                let iconA = flowingIconsHistory[i];
                let iconB = flowingIconsHistory[j];

                if (iconA.majorCategory === iconB.majorCategory) {
                    let distance = iconA.pos.dist(iconB.pos);
                    if (distance < connectDistance) {
                        const alpha = p.map(distance, 0, connectDistance, 1.0, .1);
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

        const musicScore = musicScoreData.targetScore;
        const musicScoreBoost = 10.0;
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
                const displayScore = p.map(
                    data.currentScore, 0, scoreDisplayMax, 0, 1, true
                );
                const barWidth = displayScore * barMaxWidth;
                
                textLayer.fill(0, 0, 100, 0.2);
                textLayer.rect(barX, y - barHeight / 2, barMaxWidth, barHeight, 5);
                
                const hue = CATEGORY_COLORS[majorCategory];
                textLayer.fill(hue, 80, 95);
                textLayer.rect(barX, y - barHeight / 2, barWidth, barHeight, 5);

                const detectionThreshold = 0.3; 
                const thresholdX = barX + (detectionThreshold * barMaxWidth);

                textLayer.stroke(0, 100, 100);
                textLayer.strokeWeight(2);
                textLayer.line(thresholdX, y - barHeight / 2, thresholdX, y + barHeight / 2);
                textLayer.noStroke();

                textLayer.fill(255);
                textLayer.textSize(labelSize);
                textLayer.textAlign(p.LEFT, p.CENTER);
                textLayer.text(data.displayName, currentColumnX, y);

                if (displayScore > detectionThreshold && groupCooldowns[majorCategory] === 0) {
                    const lastIcon = flowingIconsHistory[flowingIconsHistory.length - 1];
                    if (!lastIcon || lastIcon.name !== minorCategoryName) {
                        let def_y = p.random(-1000, 1000);
                        const newIconInfo = {
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
                        flowingIconsHistory.push(newIconInfo);
                        groupCooldowns[majorCategory] = 30;
                    }
                }
            });
            
            currentColumnX += columnWidth;
        }
        
        textLayer.pop();
    }

    // --- 入力系 ---

    p.keyPressed = () => {
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
        togglePlay();
    };

    p.touchStarted = () => {
        togglePlay();
        return false;
    };

    function togglePlay() {
        if (p.getAudioContext().state !== 'running') {
            p.getAudioContext().resume();
        }

        if (soundFile.isPlaying()) {
            soundFile.pause();
            isPlaying = false;
            statusMessage = "Paused. Tap / Click to play.";
        } else {
            soundFile.loop(); 
            isPlaying = true;
            statusMessage = "Playing... Tap / Click to pause.";
        }
    }

    p.windowResized = () => {
        p.resizeCanvas(p.windowWidth, p.windowHeight);
        textLayer.resizeCanvas(p.windowWidth, p.windowHeight);
        if (myFont) textLayer.textFont(myFont);
        textLayer.colorMode(p.HSB, 360, 100, 100, 1.0);
    };

    // --- Particle クラスは元のまま ---

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

            this.vel = p.createVector(
                p.random(-0.5, 0.5),
                p.random(-0.5, 0.5),
                p.random(-0.5, 0.5)
            );
            this.baseVel = this.vel.copy();
            this.size = p.random(1, 5);
            this.lifespan = p.random(300, 600);
            this.maxLifespan = this.lifespan;
            this.hueOffset = p.random(-15, 15);
            this.shapeType = p.floor(p.random(1)); 
            this.rotation = p.createVector(
                p.random(p.TWO_PI),
                p.random(p.TWO_PI),
                p.random(p.TWO_PI)
            );
            this.rotationSpeed = p.createVector(
                p.random(-0.01, 0.01),
                p.random(-0.01, 0.01),
                p.random(-0.01, 0.01)
            );

            if (activeHues && activeHues.length > 0) {
                this.individualHue = p.random(activeHues);
            } else {
                this.individualHue = currentHue;
            }
            
            this.displayHue = (this.pos.mag() * 0.1) % 360;

            const activeMajorCategories = Object.keys(CATEGORIES_HIERARCHY).filter(majorCat => {
                return CATEGORIES_HIERARCHY[majorCat].some(
                    minorCat => categoryData[minorCat]?.currentScore > 0.1
                );
            });

            if (activeMajorCategories.length > 0) {
                this.species = p.random(activeMajorCategories);
            } else {
                this.species = "Ambience";
            }

            if (this.species === "Artificial") {
                this.vel = p5.Vector.random3D().mult(p.random(1, 3));
            } else {
                this.vel = p.createVector(
                    p.random(-0.5, 0.5),
                    p.random(-0.5, 0.5),
                    p.random(-0.5, 0.5)
                );
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
                    let windForce = p.createVector(
                        p.noise(this.pos.x * 0.01, p.frameCount * 0.01) - 0.5,
                        p.noise(this.pos.y * 0.01, p.frameCount * 0.01) - 0.5,
                        0
                    );
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
            
            p.fill((this.displayHue + this.hueOffset) % 360, 80, brightness, alpha);

            let s = this.size + smoothedBassLevel * 50;

            switch (this.shapeType) {
                case 0: p.sphere(s); break;
                case 1: p.box(s * 1.5); break;
            }
            p.pop();
        }
    }
};

new p5(sketch);
