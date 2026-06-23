// Desktop mascot character picker + local import. Switching writes
// mascot.character and the server broadcasts a reload to the live mascot window.
export function createMascotPageModule() {
  return {
    mascotChars: [],
    mascotActiveChar: 'placeholder',
    mascotUserDir: '',
    mascotImportPath: '',
    mascotBusy: false,

    mascotRendererLabel(r) {
      return ({
        placeholder: 'Built-in (CSS)',
        live2d: 'Live2D',
        lottie: 'Lottie',
        sprite: 'Sprite / GIF'
      })[r] || r;
    },

    async loadMascotCharacters() {
      const { ok, data } = await this.api('/api/mascot/characters');
      if (!ok || !data?.success) {
        this.showToast(data?.error || this.t('mascotLoadFailed'), 'error');
        return;
      }
      this.mascotChars = Array.isArray(data.characters) ? data.characters : [];
      this.mascotActiveChar = data.active || 'placeholder';
      this.mascotUserDir = data.userDir || '';
    },

    async setMascotCharacter(id) {
      if (id === this.mascotActiveChar) return;
      const { ok, data } = await this.api('/api/mascot/character', {
        method: 'POST',
        body: JSON.stringify({ character: id })
      });
      if (!ok || !data?.success) {
        this.showToast(data?.error || this.t('mascotSwitchFailed'), 'error');
        return;
      }
      this.mascotActiveChar = data.config?.character || id;
      this.showToast(this.t('mascotSwitched'), 'success');
      await this.loadMascotCharacters();
    },

    async importMascotCharacter() {
      const path = String(this.mascotImportPath || '').trim();
      if (!path) { this.showToast(this.t('mascotImportPathRequired'), 'error'); return; }
      this.mascotBusy = true;
      const { ok, data } = await this.api('/api/mascot/characters/import', {
        method: 'POST',
        body: JSON.stringify({ path })
      });
      this.mascotBusy = false;
      if (!ok || !data?.success) {
        this.showToast(data?.error || this.t('mascotImportFailed'), 'error');
        return;
      }
      this.mascotImportPath = '';
      this.showToast(this.t('mascotImported'), 'success');
      await this.loadMascotCharacters();
    }
  };
}

export default createMascotPageModule;
