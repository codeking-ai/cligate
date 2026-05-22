export function createSkillsPageModule() {
  return {
    skillsEnabled: true,
    skillsLoading: false,
    skillDetailLoading: false,
    skillImporting: false,
    skillDeletePending: false,
    skillsSearchQuery: '',
    installedSkills: [],
    legacyRepoSkills: [],
    bundledSkills: [],
    skillsRoots: [],
    selectedSkillPath: '',
    selectedSkill: null,
    skillsImportMode: 'directory',
    showSkillImportModal: false,
    skillZipFile: null,
    skillZipName: '',
    skillDirectoryFiles: [],
    skillDirectoryName: '',

    get filteredInstalledSkills() {
      return this.filterSkills(this.installedSkills);
    },

    get filteredLegacyRepoSkills() {
      return this.filterSkills(this.legacyRepoSkills);
    },

    get filteredBundledSkills() {
      return this.filterSkills(this.bundledSkills);
    },

    get selectedSkillSummary() {
      const allSkills = [...this.installedSkills, ...this.legacyRepoSkills, ...this.bundledSkills];
      return allSkills.find((entry) => entry.pathToSkillMd === this.selectedSkillPath) || this.selectedSkill;
    },

    filterSkills(skills = []) {
      const query = this.skillsSearchQuery.trim().toLowerCase();
      if (!query) return skills;
      return skills.filter((skill) => {
        const values = [
          skill.name,
          skill.description,
          skill.shortDescription,
          skill.scope,
          ...(Array.isArray(skill.tags) ? skill.tags : [])
        ].filter(Boolean).map((entry) => String(entry).toLowerCase());
        return values.some((entry) => entry.includes(query));
      });
    },

    skillScopeLabel(scope) {
      if (scope === 'user') return this.t('skillsScopeUser');
      if (scope === 'repo') return this.t('skillsScopeRepoLegacy');
      if (scope === 'bundled') return this.t('skillsScopeBundled');
      return scope || '-';
    },

    skillScopeBadgeClass(scope) {
      if (scope === 'user') return 'bg-neon-green/10 text-neon-green border-neon-green/30';
      if (scope === 'repo') return 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/30';
      if (scope === 'bundled') return 'bg-amber-500/10 text-amber-300 border-amber-500/30';
      return 'bg-space-800/60 text-gray-400 border-space-border/50';
    },

    skillStatusLabel(skill) {
      return skill?.enabled === false ? this.t('disabled') : this.t('enabled');
    },

    skillStatusBadgeClass(skill) {
      return skill?.enabled === false
        ? 'bg-red-500/10 text-red-300 border-red-500/30'
        : 'bg-neon-green/10 text-neon-green border-neon-green/30';
    },

    skillCanManage(skill) {
      return skill?.scope === 'user' || skill?.scope === 'repo';
    },

    resetSkillImportState() {
      this.skillsImportMode = 'directory';
      this.skillZipFile = null;
      this.skillZipName = '';
      this.skillDirectoryFiles = [];
      this.skillDirectoryName = '';
    },

    openSkillImportModal() {
      this.resetSkillImportState();
      this.showSkillImportModal = true;
    },

    closeSkillImportModal() {
      this.showSkillImportModal = false;
      this.skillImporting = false;
      this.resetSkillImportState();
    },

    async loadSkills({ forceReload = false, preserveSelection = true } = {}) {
      this.skillsLoading = true;
      const suffix = forceReload ? '?forceReload=1' : '';
      const { ok, data, error } = await this.api(`/api/assistant/skills${suffix}`);
      this.skillsLoading = false;
      if (!ok || !data?.success) {
        this.showToast(data?.error || error || this.t('skillsLoadFailed'), 'error');
        return;
      }

      this.installedSkills = Array.isArray(data.installedSkills) ? data.installedSkills : [];
      this.legacyRepoSkills = Array.isArray(data.legacyRepoSkills) ? data.legacyRepoSkills : [];
      this.bundledSkills = Array.isArray(data.bundledSkills) ? data.bundledSkills : [];
      this.skillsRoots = Array.isArray(data.roots) ? data.roots : [];
      this.skillsEnabled = data.settings?.enabled !== false;

      const selectedPath = preserveSelection ? this.selectedSkillPath : '';
      const allSkills = [...this.installedSkills, ...this.legacyRepoSkills, ...this.bundledSkills];
      const hasSelection = selectedPath && allSkills.some((entry) => entry.pathToSkillMd === selectedPath);
      const nextPath = hasSelection ? selectedPath : (this.installedSkills[0]?.pathToSkillMd || this.legacyRepoSkills[0]?.pathToSkillMd || this.bundledSkills[0]?.pathToSkillMd || '');
      this.selectedSkillPath = nextPath;

      if (nextPath) {
        await this.loadSkillDetail(nextPath, { silent: true });
      } else {
        this.selectedSkill = null;
      }
    },

    async loadSkillDetail(path, { silent = false } = {}) {
      const targetPath = String(path || '').trim();
      if (!targetPath) {
        this.selectedSkillPath = '';
        this.selectedSkill = null;
        return;
      }
      this.selectedSkillPath = targetPath;
      this.skillDetailLoading = true;
      const { ok, data, error } = await this.api(`/api/assistant/skills/content?path=${encodeURIComponent(targetPath)}`);
      this.skillDetailLoading = false;
      if (ok && data?.success && data.skill) {
        this.selectedSkill = data.skill;
        return;
      }
      if (!silent) {
        this.showToast(data?.error || error || this.t('skillsDetailLoadFailed'), 'error');
      }
    },

    async toggleSkillsEnabled() {
      const { ok, data, error } = await this.api('/api/assistant/skills/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !this.skillsEnabled })
      });
      if (!ok || !data?.success) {
        this.showToast(data?.error || error || this.t('skillsSettingsSaveFailed'), 'error');
        return;
      }
      this.skillsEnabled = data.skills?.enabled !== false;
      this.showToast(this.t('skillsSettingsUpdated'), 'success');
      await this.loadSkills({ forceReload: true });
    },

    async setSkillEnabled(skill, enabled) {
      if (!skill) return;
      const { ok, data, error } = await this.api('/api/assistant/skills/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: skill.pathToSkillMd,
          name: skill.name,
          enabled
        })
      });
      if (!ok || !data?.success) {
        this.showToast(data?.error || error || this.t('skillsSettingsSaveFailed'), 'error');
        return;
      }
      this.showToast(this.t('skillsSettingsUpdated'), 'success');
      await this.loadSkills({ forceReload: true });
      if (this.selectedSkillPath) {
        await this.loadSkillDetail(this.selectedSkillPath, { silent: true });
      }
    },

    setSkillDirectorySelection(fileList) {
      const files = Array.from(fileList || []);
      this.skillDirectoryFiles = files;
      const firstPath = files[0]?.webkitRelativePath || files[0]?.name || '';
      this.skillDirectoryName = firstPath ? firstPath.split('/')[0] : '';
    },

    async importSkillZip() {
      if (!this.skillZipFile) {
        this.showToast(this.t('skillsZipRequired'), 'error');
        return;
      }
      const arrayBuffer = await this.skillZipFile.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      const contentBase64 = btoa(binary);
      return this.api('/api/assistant/skills/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'zip',
          fileName: this.skillZipFile.name || this.skillZipName || 'skill.zip',
          contentBase64
        })
      });
    },

    async importSkillDirectory(inputElement) {
      const files = this.skillDirectoryFiles.length > 0
        ? this.skillDirectoryFiles
        : Array.from(inputElement?.files || []);
      if (files.length === 0) {
        this.showToast(this.t('skillsDirectoryRequired'), 'error');
        return { ok: false, data: { error: this.t('skillsDirectoryRequired') } };
      }

      const payloadFiles = [];
      for (const file of files) {
        const relativePath = file.webkitRelativePath || file.name;
        const text = await file.text();
        payloadFiles.push({
          relativePath,
          content: text,
          encoding: 'utf8'
        });
      }

      const rootName = this.skillDirectoryName || (files[0]?.webkitRelativePath || files[0]?.name || '').split('/')[0] || 'imported-skill';
      return this.api('/api/assistant/skills/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'directory',
          rootName,
          files: payloadFiles
        })
      });
    },

    async submitSkillImport(inputElement = null) {
      if (this.skillImporting) return;
      this.skillImporting = true;
      let result = null;

      if (this.skillsImportMode === 'zip') {
        result = await this.importSkillZip();
      } else {
        result = await this.importSkillDirectory(inputElement);
      }

      this.skillImporting = false;
      if (!result?.ok || !result?.data?.success) {
        this.showToast(result?.data?.error || result?.error || this.t('skillsImportFailed'), 'error');
        return;
      }

      this.showToast(this.t('skillsImported'), 'success');
      this.closeSkillImportModal();
      await this.loadSkills({ forceReload: true, preserveSelection: false });
      if (result.data.skill?.pathToSkillMd) {
        await this.loadSkillDetail(result.data.skill.pathToSkillMd, { silent: true });
      }
    },

    async deleteSkill(skill = this.selectedSkill) {
      if (!skill || !this.skillCanManage(skill) || this.skillDeletePending) return;
      if (!window.confirm(`${this.t('skillsDeleteConfirmPrefix')} ${skill.name}${this.t('confirmDeleteSuffix')}`)) return;
      this.skillDeletePending = true;
      const { ok, data, error } = await this.api('/api/assistant/skills', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: skill.pathToSkillMd })
      });
      this.skillDeletePending = false;
      if (!ok || !data?.success) {
        this.showToast(data?.error || error || this.t('skillsDeleteFailed'), 'error');
        return;
      }
      this.showToast(this.t('skillsDeleted'), 'success');
      this.selectedSkillPath = '';
      this.selectedSkill = null;
      await this.loadSkills({ forceReload: true, preserveSelection: false });
    }
  };
}
