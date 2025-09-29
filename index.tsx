/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Modality, Type, Part } from "@google/genai";

// A stricter type for the DOM elements collection for improved type safety
interface DomElements {
    imageInput: HTMLInputElement;
    previewImage: HTMLImageElement;
    uploadPlaceholder: HTMLElement;
    dropZone: HTMLElement;
    expressionSelect: HTMLSelectElement;
    generateButton: HTMLButtonElement;
    clearButton: HTMLButtonElement;
    failureCountDisplay: HTMLElement;
    lightbox: HTMLElement;
    lightboxImage: HTMLImageElement;
    closeLightbox: HTMLElement;
    generatedImage: HTMLImageElement;
    placeholder: HTMLElement;
    loading: HTMLElement;
    statusText: HTMLElement;
    timer: HTMLElement;
    terminate: HTMLButtonElement;
    downloadBtn: HTMLButtonElement;
    regenerateBtn: HTMLButtonElement;
    isCartoonCheckbox: HTMLInputElement;
    cartoonDescriptionContainer: HTMLElement;
    cartoonDescriptionInput: HTMLInputElement;
    removeGlassesCheckbox: HTMLInputElement;
    usageContainer: HTMLElement;
    usageCount: HTMLElement;
    usageLimit: HTMLElement;
    rateLimitTimer: HTMLElement;
}

class PortraitGeneratorApp {
    private dom: DomElements;
    private ai: GoogleGenAI;

    private uploadedBase64Image: string | null = null;
    private failureCount = 0;
    private successfulImageData: string | null = null;
    private timerInterval: number | null = null;
    private isGenerationTerminated = false;
    private isCartoonMode = false;
    
    private generationTimestamps: number[] = [];
    private readonly RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
    private readonly RATE_LIMIT_MAX_GENERATIONS = 5;
    private rateLimitTimerInterval: number | null = null;
    private readonly TIMESTAMP_STORAGE_KEY = 'portraitGeneratorTimestamps';

    private readonly ESTIMATED_TIME_PER_VIEW = 20; // seconds

    constructor() {
        this.ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        this.dom = this.cacheDOMElements();
        this.loadRateLimitData();
        this.addEventListeners();
        this.updateFailureCountDisplay();
    }

    private cacheDOMElements(): DomElements {
        const ids = [
            'imageInput', 'previewImage', 'uploadPlaceholder', 'dropZone', 'expressionSelect',
            'generateButton', 'clearButton', 'failureCountDisplay',
            'lightbox', 'lightboxImage', 'closeLightbox',
            'generatedImage', 'placeholder', 'loading', 'statusText', 'timer',
            'terminate', 'downloadBtn', 'regenerateBtn',
            'isCartoonCheckbox', 'cartoonDescriptionContainer', 'cartoonDescriptionInput',
            'removeGlassesCheckbox', 'usageContainer', 'usageCount', 'usageLimit', 'rateLimitTimer'
        ];
        const elements: { [key: string]: HTMLElement } = {};
        ids.forEach(id => elements[id] = document.getElementById(id)!);
        return elements as unknown as DomElements;
    }

    private addEventListeners(): void {
        this.dom.dropZone.addEventListener('click', () => this.dom.imageInput.click());
        this.dom.imageInput.addEventListener('change', (event) => this.handleFile(event.target && (event.target as HTMLInputElement).files?.[0]));
        this.dom.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); this.dom.dropZone.classList.add('bg-blue-50', 'border-blue-400'); });
        this.dom.dropZone.addEventListener('dragleave', () => this.dom.dropZone.classList.remove('bg-blue-50', 'border-blue-400'));
        this.dom.dropZone.addEventListener('drop', (e) => { e.preventDefault(); this.dom.dropZone.classList.remove('bg-blue-50', 'border-blue-400'); this.handleFile((e as DragEvent).dataTransfer?.files[0]); });
        
        this.dom.isCartoonCheckbox.addEventListener('change', (e) => {
            this.isCartoonMode = (e.target as HTMLInputElement).checked;
            this.dom.cartoonDescriptionContainer.classList.toggle('hidden', !this.isCartoonMode);
        });

        this.dom.generateButton.addEventListener('click', () => this.handleGenerationClick('generate'));
        this.dom.regenerateBtn.addEventListener('click', () => this.handleGenerationClick('regenerate'));
        this.dom.clearButton.addEventListener('click', () => this.resetUI());

        this.dom.terminate.addEventListener('click', (e) => {
            e.stopPropagation();
            this.isGenerationTerminated = true;
            this.dom.statusText.textContent = "正在終止...";
        });
        this.dom.downloadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.downloadImage('id_photo', true)
        });
        
        this.dom.generatedImage.addEventListener('click', (e) => {
            const img = e.target as HTMLImageElement;
            if (img.src && !img.classList.contains('hidden')) this.openLightbox(img.src);
        });

        this.dom.closeLightbox.addEventListener('click', () => this.closeLightboxHandler());
        this.dom.lightbox.addEventListener('click', (e) => {
             if (e.target === this.dom.lightbox) this.closeLightboxHandler();
        });
    }

    // --- Usage Tracking ---
    private loadRateLimitData() {
        const storedData = localStorage.getItem(this.TIMESTAMP_STORAGE_KEY);
        const now = Date.now();
    
        let validTimestamps: number[] = [];
        if (storedData) {
            try {
                const timestamps = JSON.parse(storedData);
                if (Array.isArray(timestamps)) {
                    // Sort to ensure the oldest is always first, then filter
                    validTimestamps = timestamps.sort((a, b) => a - b)
                                                .filter(ts => (now - ts) < this.RATE_LIMIT_WINDOW_MS);
                }
            } catch (e) {
                console.error("Failed to parse timestamps, resetting.", e);
                validTimestamps = [];
            }
        }
        this.generationTimestamps = validTimestamps;
        this.saveTimestamps(); // Save the cleaned list back
        this.updateUsageDisplay();
        this.startRateLimitTimer();
    }
    
    private saveTimestamps() {
        localStorage.setItem(this.TIMESTAMP_STORAGE_KEY, JSON.stringify(this.generationTimestamps));
    }

    private handleGenerationClick(type: 'generate' | 'regenerate') {
        this.loadRateLimitData(); // Always refresh state before checking

        if (this.generationTimestamps.length >= this.RATE_LIMIT_MAX_GENERATIONS) {
            alert('您已達到10分鐘內5次的生成上限，請稍後再試。');
            return;
        }

        this.generationTimestamps.push(Date.now());
        this.saveTimestamps();
        this.updateUsageDisplay();
        this.startRateLimitTimer();

        if (type === 'generate') {
            this.startGenerationProcess();
        } else {
            this.generateSingleView(true);
        }
    }

    // --- Timer Functions ---
    private stopRateLimitTimer = () => {
        if (this.rateLimitTimerInterval) {
            clearInterval(this.rateLimitTimerInterval);
            this.rateLimitTimerInterval = null;
        }
    };

    private startRateLimitTimer = () => {
        this.stopRateLimitTimer();

        if (this.generationTimestamps.length === 0) {
            this.dom.rateLimitTimer.textContent = '';
            this.dom.rateLimitTimer.classList.add('hidden');
            return;
        }

        this.dom.rateLimitTimer.classList.remove('hidden');

        const updateTimer = () => {
            if(this.generationTimestamps.length === 0) {
                this.stopRateLimitTimer();
                this.loadRateLimitData(); // Final refresh to clean up UI
                return;
            }

            const oldestTimestamp = this.generationTimestamps[0]; // Assumes sorted
            const expiryTime = oldestTimestamp + this.RATE_LIMIT_WINDOW_MS;
            const remainingMs = Math.max(0, expiryTime - Date.now());

            if (remainingMs === 0) {
                this.stopRateLimitTimer();
                this.dom.rateLimitTimer.textContent = '一個額度已重置';
                // Reload data, which will filter out the expired timestamp and restart the timer for the next one if it exists.
                setTimeout(() => this.loadRateLimitData(), 1000);
            } else {
                const totalSeconds = Math.ceil(remainingMs / 1000);
                const minutes = Math.floor(totalSeconds / 60);
                const seconds = totalSeconds % 60;
                this.dom.rateLimitTimer.textContent = `下一額度將於 ${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')} 後重置`;
            }
        };
        
        updateTimer();
        this.rateLimitTimerInterval = window.setInterval(updateTimer, 1000);
    };

    private stopTimer = () => {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    };
    
    private updateTimer = () => {
        this.stopTimer();
        let timeLeft = this.ESTIMATED_TIME_PER_VIEW;
        
        const updateText = () => {
             this.dom.timer.textContent = timeLeft > 0 ? `預估剩餘：${timeLeft} 秒` : `仍在處理中...`;
        };

        updateText();

        this.timerInterval = window.setInterval(() => {
            timeLeft--;
            updateText();
            if (timeLeft <= 0) {
                this.stopTimer();
            }
        }, 1000);
    };

    // --- Lightbox Logic ---
    private openLightbox = (src: string) => {
        this.dom.lightboxImage.src = src;
        this.dom.lightbox.classList.remove('hidden');
        this.dom.lightbox.classList.add('flex');
    };

    private closeLightboxHandler = () => {
        this.dom.lightbox.classList.add('hidden');
        this.dom.lightbox.classList.remove('flex');
        this.dom.lightboxImage.src = '';
    };
    
    // --- UI Update Functions ---
    private updateFailureCountDisplay = () => {
        if (this.failureCount > 0) {
            this.dom.failureCountDisplay.textContent = this.failureCount.toString();
            this.dom.failureCountDisplay.classList.remove('hidden');
        } else {
            this.dom.failureCountDisplay.classList.add('hidden');
        }
    };
    
    private updateUsageDisplay() {
        const generationsUsed = this.generationTimestamps.length;
        this.dom.usageCount.textContent = generationsUsed.toString();
        this.dom.usageLimit.textContent = this.RATE_LIMIT_MAX_GENERATIONS.toString();

        const generateButtonTextSpan = this.dom.generateButton.querySelector('span:first-child') as HTMLElement;
        const limitReached = generationsUsed >= this.RATE_LIMIT_MAX_GENERATIONS;

        this.dom.generateButton.disabled = limitReached || !this.uploadedBase64Image;
        
        if (limitReached) {
            if (generateButtonTextSpan) generateButtonTextSpan.textContent = '已達上限';
            this.dom.usageContainer.classList.add('text-red-500', 'font-semibold');
        } else {
            if (generateButtonTextSpan) generateButtonTextSpan.textContent = '生成證件照';
            this.dom.usageContainer.classList.remove('text-red-500', 'font-semibold');
        }
    }

    private _updateUIState(state: 'idle' | 'loading' | 'success' | 'failure' | 'terminating', isRegen: boolean = false): void {
        const originalRegenText = '重新生成';
        const spinner = this.dom.loading.querySelector('.animate-spin') as HTMLElement;
        const limitReached = this.generationTimestamps.length >= this.RATE_LIMIT_MAX_GENERATIONS;

        // Reset all states before applying the new one
        this.dom.loading.classList.add('hidden');
        this.dom.terminate.classList.add('hidden');
        this.dom.placeholder.classList.add('hidden');
        this.dom.generatedImage.classList.add('hidden');
        this.dom.downloadBtn.classList.add('hidden');
        this.dom.regenerateBtn.disabled = true;
        this.dom.statusText.classList.remove('text-green-600');
        if (spinner) spinner.style.display = 'block';

        switch(state) {
            case 'idle':
                this.dom.placeholder.classList.remove('hidden');
                this.dom.regenerateBtn.classList.add('hidden');
                break;
            case 'loading':
                this.dom.loading.classList.remove('hidden');
                this.dom.terminate.classList.remove('hidden');
                if (!isRegen) this.dom.regenerateBtn.classList.add('hidden');
                break;
            case 'success':
                this.dom.generatedImage.classList.remove('hidden');
                this.dom.downloadBtn.classList.remove('hidden');
                this.dom.regenerateBtn.classList.remove('hidden');
                this.dom.regenerateBtn.disabled = limitReached;
                this.dom.statusText.textContent = '生成成功！';
                this.dom.statusText.classList.add('text-green-600');
                if (spinner) spinner.style.display = 'none';
                this.dom.loading.classList.remove('hidden'); // Keep parent visible to show status text

                setTimeout(() => {
                    this.dom.loading.classList.add('hidden');
                    this.dom.statusText.classList.remove('text-green-600');
                    if (spinner) spinner.style.display = 'block';
                }, 2000);
                break;
            case 'failure':
                this.dom.placeholder.classList.remove('hidden');
                this.dom.regenerateBtn.classList.remove('hidden');
                this.dom.regenerateBtn.disabled = limitReached;
                this.dom.regenerateBtn.textContent = '生成失敗';
                setTimeout(() => { this.dom.regenerateBtn.textContent = originalRegenText; }, 2000);
                break;
             case 'terminating':
                this.dom.loading.classList.add('hidden');
                this.dom.terminate.classList.add('hidden');
                if (this.dom.generatedImage.src && this.dom.generatedImage.src.startsWith('data:image')) {
                    this.dom.generatedImage.classList.remove('hidden');
                } else {
                    this.dom.placeholder.classList.remove('hidden');
                }
                this.dom.regenerateBtn.classList.remove('hidden');
                this.dom.regenerateBtn.disabled = limitReached;
                this.dom.regenerateBtn.textContent = originalRegenText;
                break;
        }
    }
        
    private resetUI = () => {
        this.uploadedBase64Image = null;
        this.successfulImageData = null;
        this.dom.imageInput.value = '';
        this.dom.previewImage.style.display = 'none';
        this.dom.uploadPlaceholder.style.display = 'block';
        this.dom.expressionSelect.selectedIndex = 0;
        this.dom.removeGlassesCheckbox.checked = false;
        
        this.isCartoonMode = false;
        this.dom.isCartoonCheckbox.checked = false;
        this.dom.cartoonDescriptionContainer.classList.add('hidden');
        this.dom.cartoonDescriptionInput.value = '';

        this.dom.generatedImage.src = '';
        this._updateUIState('idle');
        
        this.failureCount = 0;
        this.updateFailureCountDisplay();
        this.dom.generateButton.disabled = true; // Disabled until an image is uploaded
    };
    
    // --- File Handling ---
    private handleFile = (file?: File | null) => {
        if (file && file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const result = e.target?.result as string;
                if (result) {
                    if (result.includes(',')) {
                       this.uploadedBase64Image = result.split(',')[1];
                    }
                    this.dom.previewImage.src = result;
                    this.dom.previewImage.style.display = 'block';
                    this.dom.uploadPlaceholder.style.display = 'none';
                    this.failureCount = 0;
                    this.updateFailureCountDisplay();
                    this.updateUsageDisplay(); // Check rate limit and enable button if possible
                }
            };
            reader.readAsDataURL(file);
        } else if (file) {
            alert('請上傳有效的圖片檔。');
        }
    };
    
    private _constructPrompt(): string {
        const expressionValue = this.dom.expressionSelect.value;
        const removeGlasses = this.dom.removeGlassesCheckbox.checked;

        const expressionInstruction = (expressionValue === 'preserve')
            ? 'You MUST preserve the exact same facial expression from the original photo. Do NOT change it.'
            : `The person must have ${expressionValue}.`;

        if (this.isCartoonMode) {
            const cartoonDescription = this.dom.cartoonDescriptionInput.value.trim();
            const characterIdInstruction = cartoonDescription 
                ? `Use this description to guide your interpretation: '${cartoonDescription}'.`
                : `Analyze the image to identify the character's key features.`;
            const glassesInstruction = removeGlasses 
                ? "If the character is wearing glasses, do NOT include them in the final realistic image." 
                : "If the character is wearing accessories like glasses, render a realistic version of them.";

            return `**Primary Task: Cartoon to Realism Conversion for a 2-inch ID Photo.**
Your base is a cartoon/anime image. Your goal is to generate a new, photorealistic image of what this character would look like as a real human, styled as a professional ID photo.

**Strict Rules:**
1.  **Preserve Core Features**: You MUST preserve the character's core recognizable features (like hair color, eye color) but render them in a realistic, human style.
2.  **Clothing**: Interpret the character's clothing and hairstyle from the cartoon and render a realistic, simple version suitable for an ID photo. If the original clothing is overly complex or inappropriate (e.g., armor, costume), generate a simple, professional-looking top like a collared shirt or blouse.
3.  **Expose Facial Features**: In the final realistic portrait, you MUST ensure the person's full face, both eyes, and both ears are clearly and fully visible.
4.  **Medical Devices**: If the cartoon character appears to have medical tubes (like a nasogastric tube), do NOT include them in the final realistic portrait.
5.  **Facial Reconstruction**: If the cartoon character's face is partially obscured (e.g., by a mask, heavy shadows, or censorship), you MUST imagine and render a complete, realistic, and unobstructed human face for the final portrait. When reconstructing a face from a mosaic or blur, prioritize using East Asian facial features. Do not include the obstruction in the realistic version.
6.  **Accessories**: ${glassesInstruction}
7.  **Character Identification**: ${characterIdInstruction}
8.  **Style & Framing**: Create a high-quality, **photorealistic**, front-facing **half-body portrait (from the chest up)** of the character as a real human. The final image must be a vertical portrait with an aspect ratio of approximately 7:9, suitable for a 2-inch ID photo.
9.  **Pose**: The person must have excellent posture: standing perfectly straight, facing forward, with head held up, chin level, and shoulders back and squared. The pose should be static and neutral, suitable for an official ID.
10. **Expression**: ${expressionInstruction}
11. **Studio Environment**: The final image must be indistinguishable from a high-end professional headshot taken in a real-world photography studio.
    *   **Background**: Place the person against a seamless, plain, solid **pure white** background.
    *   **Lighting**: Re-light the person with a professional three-point studio lighting setup. This should create soft, flattering light on the face, define their features, and add a subtle rim light to separate them from the background.
    *   **Integration**: The integration must be seamless. Create subtle, soft cast shadows on the background where appropriate to ground the subject in the environment. The final image MUST NOT look like a digital cutout placed on a white background. The entire scene must feel like a single, cohesive photograph.`;
        }

        const glassesInstruction = removeGlasses 
            ? "The person may be wearing glasses in the original photo. You MUST remove the glasses completely and realistically reconstruct the eye area underneath."
            : "If the person is wearing accessories like glasses, keep them.";

        return `**Image Modification Task:** Your base is a provided photograph. Your goal is to adjust this image to meet professional 2-inch ID photo standards.

**Primary Goal:** Make the person suitable for an official ID photo by ensuring key facial features are visible, correcting posture, and ensuring clothing is appropriate.

**Strict Rules:**
1.  **Preserve Identity & Hairstyle:** You MUST perfectly preserve the person's face, likeness, identity, and **original hairstyle** from the base image. Do NOT change their hair color/style.
2.  **Clothing Modification:** Your first priority is to use the person's original clothing. If the original clothing is unsuitable for a formal ID photo (e.g., a tank top, a very low-cut shirt, a shirt with large logos, or a hoodie), you MUST realistically modify it into a more appropriate, simple top (like a crew-neck shirt or a simple blouse), preserving the original color and texture where possible. If the original clothing is completely absent or impossible to adapt, generate a standard, neutral-colored collared shirt or blouse.
3.  **Automatic Medical Device Removal:** First, carefully examine the person in the photo. If you detect any medical tubes or lines on their face (such as a nasogastric tube or oxygen cannula), you MUST remove them completely. Realistically reconstruct the underlying facial features (like the nose and cheek) to look natural and complete, as if the device was never there. If no such devices are present, ignore this rule.
4.  **Automatic Facial Reconstruction:** Next, analyze the face for any obstructions. If the person's mouth and nose are covered by a mask, or if their eyes are obscured by heavy sunglasses, digital mosaics, or other forms of censorship, you MUST attempt to realistically reconstruct the hidden facial features. Simulate a natural-looking nose, mouth, and/or eyes that are consistent with the visible parts of the face. When reconstructing a face from a mosaic or blur, prioritize using East Asian facial features. The goal is to create a complete, unobstructed portrait. If the face is already clear, ignore this rule.
5.  **Expose Facial Features:** You MUST ensure the person's full face, both eyes, and both ears are clearly and fully visible. If the hair in the original photo is slightly covering the eyes or ears, you must subtly adjust the hair (e.g., tuck it behind the ears) to expose these features naturally.
6.  **Accessories:** ${glassesInstruction}
7.  **Pose & Posture Correction:** You MUST completely disregard any body pose, gestures (like hand signs), or head tilting from the original photo. The final image must depict the person with perfect posture: standing perfectly straight, facing the camera directly, with their head held up, chin level, and shoulders back and squared. The pose should be static and neutral, suitable for an official ID.
8.  **Expression:** ${expressionInstruction}
9.  **Studio Environment & Background:** The entire scene must be re-rendered to be indistinguishable from a high-end professional **half-body portrait (from the chest up)** taken in a real-world photography studio. The final image must be a vertical portrait with an aspect ratio of approximately 7:9, suitable for a 2-inch ID photo.
    *   **Background Replacement**: Completely replace the original background with a seamless, plain, solid **pure white** background.
    *   **Lighting Correction**: Re-light the person with a professional three-point studio lighting setup. This should correct any harsh or uneven lighting from the original photo, creating soft, flattering light on the face, defining their features, and adding a subtle rim light to separate them from the background.
    *   **Seamless Integration**: The integration must be absolutely seamless. Create subtle, soft cast shadows on the background where appropriate to ground the subject in the environment. The final image MUST NOT look like a digital cutout placed on a white background. The entire scene must feel like a single, cohesive photograph.`;
    }

    // --- API Call Functions ---
    private async verifyImageMatch(originalImage: string, generatedImage: string): Promise<boolean> {
        this.dom.statusText.textContent = '正在驗證圖像相似度...';
        const parts: Part[] = [
            { text: "Do these two images show the exact same person? Look closely at the facial features. Answer with only YES or NO." },
            { inlineData: { mimeType: "image/jpeg", data: originalImage } },
            { inlineData: { mimeType: "image/jpeg", data: generatedImage } }
        ];

        try {
            const response = await this.ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: { parts }
            });
            const textResponse = response.text?.trim().toUpperCase() ?? "";
            console.log('圖像驗證結果:', textResponse);
            return textResponse === 'YES';
        } catch (error) {
            console.error('圖像驗證 API 呼叫失敗:', error);
            return false;
        }
    }

    private async generateSingleView(isRegeneration = false): Promise<{ success: boolean, base64Data: string | null, terminated: boolean }> {
        this._updateUIState('loading', isRegeneration);
        
        let success = false;
        let successfulBase64Data: string | null = null;
        const MAX_ATTEMPTS = 5;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (this.isGenerationTerminated) {
                this._updateUIState('terminating');
                return { success: false, base64Data: null, terminated: true };
            }
            
            this.dom.statusText.textContent = `生成中... (${attempt}/${MAX_ATTEMPTS})`;
            
            try {
                const response = await this.ai.models.generateContent({
                    model: 'gemini-2.5-flash-image-preview',
                    contents: { parts: [
                        { text: this._constructPrompt() },
                        { inlineData: { mimeType: "image/png", data: this.uploadedBase64Image! } }
                    ]},
                    config: {
                        responseModalities: [Modality.IMAGE, Modality.TEXT],
                    }
                });

                const base64Data = response?.candidates?.[0]?.content?.parts
                    .find(part => part.inlineData?.data)?.inlineData?.data ?? null;
                
                if (base64Data) {
                    if (this.isCartoonMode || await this.verifyImageMatch(this.uploadedBase64Image!, base64Data)) {
                        successfulBase64Data = base64Data;
                        success = true;
                        break; 
                    }
                } else {
                    throw new Error('模型未返回影像數據。');
                }
            } catch (error) {
                console.error(`生成失敗 (嘗試 ${attempt}):`, error);
            }
        }
        
        if (success) {
            this.dom.generatedImage.src = `data:image/jpeg;base64,${successfulBase64Data}`;
            this.successfulImageData = successfulBase64Data;
            this._updateUIState('success');
        } else {
            this._updateUIState('failure', isRegeneration);
            if (!isRegeneration) {
                this.failureCount++;
                this.updateFailureCountDisplay();
            }
        }
        
        return { success, base64Data: successfulBase64Data, terminated: false };
    }
    
    // --- Main Logic ---
    private async startGenerationProcess() {
        if (!this.uploadedBase64Image) {
            alert('請先上傳照片！');
            return;
        }

        this.isGenerationTerminated = false;
        this.dom.generateButton.disabled = true;
        this.failureCount = 0;
        this.updateFailureCountDisplay();
        this.successfulImageData = null; 
        
        try {
            this.updateTimer();
            await this.generateSingleView(false);
        } finally {
            this.stopTimer();
            this.updateUsageDisplay();
            
            if (this.successfulImageData) {
                this.dom.regenerateBtn.disabled = this.generationTimestamps.length >= this.RATE_LIMIT_MAX_GENERATIONS;
            }
        }
    }

    private async downloadImage(viewName: string, useShareApi = true) {
        if (!this.successfulImageData) {
            console.warn(`No image data found for download.`);
            return;
        }
        const imgSrc = `data:image/jpeg;base64,${this.successfulImageData}`;
        const fileName = `id_photo_${viewName}.jpg`;

        if (useShareApi && navigator.share && navigator.canShare) {
            try {
                const response = await fetch(imgSrc);
                const blob = await response.blob();
                const file = new File([blob], fileName, { type: 'image/jpeg' });

                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({
                        files: [file],
                        title: '我的證件照',
                        text: '這是我用證件照生成器製作的照片！',
                    });
                    return;
                }
            } catch (error) {
                console.error('Web Share API failed, falling back to direct download:', error);
            }
        }

        try {
            const response = await fetch(imgSrc);
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);

            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(objectUrl);
        } catch (error) {
             console.error('Failed to trigger automatic download:', error);
             alert('自動下載失敗。圖片將在新分頁中開啟，請您手動儲存。');
             const newTab = window.open();
             if (newTab) {
                 newTab.document.write(`<body style="margin:0; background: #222;"><img src="${imgSrc}" style="max-width:100%; height:auto; display:block; margin:auto;" alt="請長按或右鍵點擊以儲存圖片"></body>`);
             }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new PortraitGeneratorApp();
});