// Image Generation onboarding page. Independent of the API-keys page by design
// (different params, different per-image billing, supports keyless local
// backends later). Talks to /api/image-gen/* and previews via /api/artifacts/:id.
export function createImageGenPageModule() {
  return {
    imageGenLoaded: false,
    imageGenConfigured: false,
    imageGenModels: [],
    imageGenBackendKinds: [],
    imageGenSettings: { requireApproval: true, defaultModelId: '', maxImagesPerCall: 4 },

    showAddImageModel: false,
    imageGenSaving: false,
    newImageModel: {
      displayName: '',
      backendKind: 'openai-images',
      baseUrl: '',
      apiKey: '',
      nativeModel: 'gpt-image-1'
    },

    imageGenTest: {
      prompt: '',
      aspectRatio: '1:1',
      quality: 'standard',
      n: 1,
      modelId: '',
      loading: false,
      results: [],
      notes: [],
      error: ''
    },

    imageGenBackendLabel(kind) {
      const map = {
        'openai-images': 'OpenAI / Compatible (DALL·E · gpt-image)',
        'volcengine-images': '火山引擎方舟 · 即梦 / Seedream',
        'wanxiang': '阿里云百炼 · 通义万相 Wanxiang'
      };
      return map[kind] || kind;
    },

    // Per-backend connection defaults — switching the backend fills in the
    // matching base URL + a sensible model id so users don't have to memorise
    // each vendor's endpoint. They can still edit both fields afterwards.
    imageGenBackendDefaults: {
      'openai-images': { baseUrl: 'https://api.openai.com/v1', nativeModel: 'gpt-image-1' },
      'volcengine-images': { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', nativeModel: 'doubao-seedream-3-0-t2i' },
      'wanxiang': { baseUrl: 'https://dashscope.aliyuncs.com', nativeModel: 'wan2.2-t2i-flash' }
    },

    onImageGenBackendChange() {
      const defaults = this.imageGenBackendDefaults[this.newImageModel.backendKind];
      if (defaults) {
        this.newImageModel.baseUrl = defaults.baseUrl;
        this.newImageModel.nativeModel = defaults.nativeModel;
      }
    },

    async loadImageGenStatus() {
      const { ok, data } = await this.api('/api/image-gen/status');
      if (!ok || !data?.success) {
        this.showToast(data?.error || this.t('imageGenLoadFailed'), 'error');
        return;
      }
      this.imageGenModels = Array.isArray(data.models) ? data.models : [];
      this.imageGenBackendKinds = Array.isArray(data.backendKinds) ? data.backendKinds : [];
      this.imageGenSettings = { ...this.imageGenSettings, ...(data.settings || {}) };
      this.imageGenConfigured = Boolean(data.configured);
      this.imageGenLoaded = true;
    },

    resetNewImageModel() {
      this.newImageModel = { displayName: '', backendKind: 'openai-images', baseUrl: '', apiKey: '', nativeModel: 'gpt-image-1' };
    },

    async addImageGenModel() {
      const body = { ...this.newImageModel };
      if (!String(body.displayName || '').trim() && !String(body.nativeModel || '').trim()) {
        this.showToast(this.t('imageGenModelNameRequired'), 'error');
        return;
      }
      this.imageGenSaving = true;
      const { ok, data } = await this.api('/api/image-gen/models', { method: 'POST', body: JSON.stringify(body) });
      this.imageGenSaving = false;
      if (!ok || !data?.success) {
        this.showToast(data?.error || this.t('imageGenSaveFailed'), 'error');
        return;
      }
      this.showToast(this.t('imageGenSaved'), 'success');
      this.showAddImageModel = false;
      this.resetNewImageModel();
      await this.loadImageGenStatus();
    },

    async toggleImageGenModel(model) {
      const { ok, data } = await this.api(`/api/image-gen/models/${model.id}/enabled`, {
        method: 'POST',
        body: JSON.stringify({ enabled: !model.enabled })
      });
      if (!ok || !data?.success) {
        this.showToast(data?.error || this.t('imageGenSaveFailed'), 'error');
        return;
      }
      await this.loadImageGenStatus();
    },

    async removeImageGenModel(model) {
      if (!window.confirm(this.t('imageGenConfirmRemove'))) return;
      const { ok, data } = await this.api(`/api/image-gen/models/${model.id}`, { method: 'DELETE' });
      if (!ok || !data?.success) {
        this.showToast(data?.error || this.t('imageGenSaveFailed'), 'error');
        return;
      }
      this.showToast(this.t('imageGenRemoved'), 'success');
      await this.loadImageGenStatus();
    },

    async setImageGenDefault(model) {
      await this.saveImageGenSettings({ defaultModelId: model.id });
    },

    async saveImageGenSettings(patch = null) {
      const payload = patch || {
        requireApproval: this.imageGenSettings.requireApproval,
        maxImagesPerCall: this.imageGenSettings.maxImagesPerCall,
        defaultModelId: this.imageGenSettings.defaultModelId
      };
      const { ok, data } = await this.api('/api/image-gen/settings', { method: 'PUT', body: JSON.stringify(payload) });
      if (!ok || !data?.success) {
        this.showToast(data?.error || this.t('imageGenSaveFailed'), 'error');
        return;
      }
      this.imageGenSettings = { ...this.imageGenSettings, ...(data.settings || {}) };
      this.showToast(this.t('imageGenSaved'), 'success');
      await this.loadImageGenStatus();
    },

    async runImageGenTest() {
      const prompt = String(this.imageGenTest.prompt || '').trim();
      if (!prompt) {
        this.showToast(this.t('imageGenPromptRequired'), 'error');
        return;
      }
      this.imageGenTest.loading = true;
      this.imageGenTest.error = '';
      this.imageGenTest.results = [];
      this.imageGenTest.notes = [];
      const body = {
        prompt,
        aspectRatio: this.imageGenTest.aspectRatio,
        quality: this.imageGenTest.quality,
        n: Number(this.imageGenTest.n) || 1,
        ...(this.imageGenTest.modelId ? { model: this.imageGenTest.modelId } : {})
      };
      const { ok, data } = await this.api('/api/image-gen/generate', { method: 'POST', body: JSON.stringify(body) });
      this.imageGenTest.loading = false;
      if (!ok || !data?.success) {
        this.imageGenTest.error = data?.error || this.t('imageGenTestFailed');
        return;
      }
      this.imageGenTest.results = Array.isArray(data.images) ? data.images : [];
      this.imageGenTest.notes = Array.isArray(data.notes) ? data.notes : [];
      this.showToast(this.t('imageGenTestDone'), 'success');
    }
  };
}

export default createImageGenPageModule;
