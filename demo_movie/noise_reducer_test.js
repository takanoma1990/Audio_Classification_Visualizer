// HTML要素が読み込まれた後に実行
document.addEventListener('DOMContentLoaded', () => {
    const startButton = document.getElementById('startButton');
    const audioPlayer = document.getElementById('audioPlayer');
    const logElement = document.getElementById('log');

    let isInitialized = false;
    let model = null;

    const log = (message) => {
        console.log(message);
        logElement.textContent += message + '\n';
    };

    // AIモデルをロードし、WASMバックエンドを準備する関数
    async function initializeAI() {
        if (isInitialized) return;

        log('WASMバックエンドのパスを設定します...');
        try {
            // グローバルに読み込まれたtfオブジェクトを使用
            await tf.setWasmPaths(`https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@3.11.0/dist/`);
            await tf.setBackend('wasm');
            log('WASMバックエンドの準備が完了しました。');

            log('AI TFLiteモデルを読み込んでいます...');
            const modelUrl = 'https://tfhub.dev/google/speech_enhancement/denoise_16k/1';
            // グローバルに読み込まれたtfliteオブジェクトを使用
            model = await tflite.loadTFLiteModel(modelUrl);

            isInitialized = true;
            log('✅ AIモデルの準備が完了しました！');

        } catch (error) {
            log(`❌ AIモデルの初期化に失敗しました: ${error}`);
            console.error(error);
        }
    }

    // オーディオ処理のパイプラインを構築する関数
    function setupAudioProcessing() {
        log('オーディオ処理のパイプラインを構築します...');
        
        // Web Audio APIのコンテキストを作成
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        
        // HTMLの<audio>要素を音源として接続
        const source = audioCtx.createMediaElementSource(audioPlayer);
        
        // リアルタイムで音声データを処理するためのノードを作成
        const scriptNode = audioCtx.createScriptProcessor(16384, 1, 1);

        // 音声データが流れてくるたびに、このイベントが発生
        scriptNode.onaudioprocess = (audioProcessingEvent) => {
            if (!isInitialized) return; // AIの準備ができていなければ何もしない

            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
            const outputData = audioProcessingEvent.outputBuffer.getChannelData(0);

            // AIモデルでノイズ除去を実行
            const cleanData = tf.tidy(() => {
                const inputTensor = tf.tensor(inputData);
                const outputTensor = model.predict(inputTensor);
                return outputTensor.dataSync();
            });

            // 処理後のデータをスピーカーに出力
            for (let i = 0; i < outputData.length; i++) {
                outputData[i] = cleanData[i];
            }
        };
        
        // ノードを接続: 音源 -> AI処理ノード -> スピーカー
        source.connect(scriptNode);
        scriptNode.connect(audioCtx.destination);
        
        log('オーディオパイプラインの準備完了。');
    }

    // スタートボタンがクリックされた時の処理
    startButton.addEventListener('click', async () => {
        startButton.disabled = true;
        startButton.textContent = '処理中...';

        // 1. AIモデルを初期化（完了するまで待つ）
        await initializeAI();

        // 2. AIの準備が成功した場合のみ、オーディオ処理を開始
        if (isInitialized) {
            setupAudioProcessing();
            // 音声の再生を開始
            audioPlayer.play();
            log('▶️ 音声再生とノイズ除去を開始しました。');
        } else {
            startButton.textContent = '初期化失敗';
        }
    }, { once: true });
});