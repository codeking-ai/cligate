export function createSkillsPageModule() {
  return {
    skillsEnabled: true,
    skillsLoading: false,
    skillDetailLoading: false,
    skillImporting: false,
    skillDeletePending: false,
    skillsSearchQuery: '',
    skillsScopeFilter: 'all',
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

    get allSkills() {
      return [...this.installedSkills, ...this.legacyRepoSkills, ...this.bundledSkills];
    },

    get filteredSkills() {
      const scope = this.skillsScopeFilter;
      const scopedSkills = scope === 'all'
        ? this.allSkills
        : this.allSkills.filter((skill) => skill.scope === scope);
      return this.filterSkills(scopedSkills);
    },

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
      return this.allSkills.find((entry) => entry.pathToSkillMd === this.selectedSkillPath) || this.selectedSkill;
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

    skillFilterOptions() {
      return [
        { key: 'all', label: this.t('skillsFilterAll'), color: '#111827' },
        { key: 'user', label: this.t('skillsScopeUser'), color: '#22c55e' },
        { key: 'repo', label: this.t('skillsScopeRepoLegacy'), color: '#06b6d4' },
        { key: 'bundled', label: this.t('skillsScopeBundled'), color: '#f59e0b' }
      ];
    },

    skillInitials(skill = {}) {
      const name = String(skill?.name || '').trim();
      if (!name) return 'SK';
      const parts = name
        .replace(/[_-]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
      const initials = parts.length > 1
        ? `${parts[0][0] || ''}${parts[1][0] || ''}`
        : name.slice(0, 2);
      return initials.toUpperCase();
    },

    skillCardSubtitle(skill = {}) {
      const tags = Array.isArray(skill?.tags) ? skill.tags.filter(Boolean) : [];
      if (tags.length > 0) return tags.slice(0, 3).join(' / ');
      return this.skillScopeLabel(skill?.scope);
    },

    skillCardFeatureLabels(skill = {}) {
      const labels = [];
      const tags = Array.isArray(skill?.tags) ? skill.tags.filter(Boolean) : [];
      labels.push(...tags.slice(0, 4));
      if (skill?.whenToUse) labels.push(this.t('skillsWhenToUseLabel'));
      if (labels.length === 0 && skill?.scope) labels.push(this.skillScopeLabel(skill.scope));
      while (labels.length < 4) {
        labels.push([
          this.t('skillsContent'),
          this.t('skillsPath'),
          this.t('skillsScopeLabel'),
          this.t('skillsWhenToUseLabel')
        ][labels.length]);
      }
      return labels.slice(0, 4);
    },

    skillCardTone(skill = {}) {
      if (skill?.scope === 'user') return 'skill-tone-user';
      if (skill?.scope === 'repo') return 'skill-tone-repo';
      if (skill?.scope === 'bundled') return 'skill-tone-bundled';
      return 'skill-tone-neutral';
    },

    skillRelativeSource(skill = {}) {
      const path = String(skill?.pathToSkillMd || '');
      const parts = path.split(/[\\/]+/).filter(Boolean);
      if (parts.length <= 2) return path || '-';
      return parts.slice(-3).join('/');
    },

    skillRelationTokens(skill = {}) {
      const stopWords = new Set([
        'skill', 'skills', 'use', 'uses', 'using', 'when', 'with', 'from', 'this',
        'that', 'the', 'and', 'for', 'you', 'your', 'into', 'any', 'all', 'can',
        'will', 'file', 'files', 'work', 'workflow'
      ]);
      return new Set([
        skill.name,
        skill.shortDescription,
        skill.description,
        skill.whenToUse,
        ...(Array.isArray(skill.tags) ? skill.tags : [])
      ]
        .filter(Boolean)
        .flatMap((value) => String(value).toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/))
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !stopWords.has(token)));
    },

    relatedSkills() {
      const selected = this.selectedSkill || this.selectedSkillSummary;
      if (!selected) return [];
      const selectedTags = new Set(Array.isArray(selected.tags) ? selected.tags.map((tag) => String(tag).toLowerCase()) : []);
      const selectedTokens = this.skillRelationTokens(selected);
      const selectedConflicts = new Set(
        Array.isArray(selected.conflictsWith)
          ? selected.conflictsWith.map((name) => String(name).toLowerCase())
          : []
      );
      const selectedName = String(selected.name || '').toLowerCase();
      return this.allSkills
        .filter((skill) => skill.pathToSkillMd !== selected.pathToSkillMd)
        .map((skill) => {
          const tags = Array.isArray(skill.tags) ? skill.tags.map((tag) => String(tag).toLowerCase()) : [];
          const tagScore = tags.filter((tag) => selectedTags.has(tag)).length;
          const skillTokens = this.skillRelationTokens(skill);
          const tokenScore = [...skillTokens].filter((token) => selectedTokens.has(token)).length;
          const skillName = String(skill.name || '').toLowerCase();
          const conflictScore = selectedConflicts.has(skillName)
            || (Array.isArray(skill.conflictsWith) && skill.conflictsWith.map((name) => String(name).toLowerCase()).includes(selectedName))
            ? 2
            : 0;
          return { skill, score: tagScore * 4 + conflictScore * 3 + tokenScore };
        })
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
        .slice(0, 6)
        .map((entry) => entry.skill);
    },

    clearSkillSelection() {
      this.selectedSkillPath = '';
      this.selectedSkill = null;
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
      const hasSelection = selectedPath && this.allSkills.some((entry) => entry.pathToSkillMd === selectedPath);
      const nextPath = hasSelection ? selectedPath : '';
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
