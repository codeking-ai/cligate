const I18N = {
    en: {
        brandEyebrow: 'CliGate',
        brandTitle: 'Resources Catalog',
        pageEyebrow: 'Curated Directory',
        pageTitle: 'Resources Catalog',
        pageSubtle: 'A curated catalog of free and trial LLM API resources. This page is read-only and does not change routing behavior.',
        topbarNote: 'Language and theme follow the main dashboard.',
        back: 'Back to Dashboard',
        dashboard: 'Dashboard',
        resources: 'Resources',
        total: 'Total',
        free: 'Free',
        trial: 'Trial',
        supported: 'Supported',
        category: 'Category',
        status: 'Status',
        search: 'Search',
        all: 'All',
        presettable: 'Presettable',
        candidate: 'Candidate',
        catalogOnly: 'Catalog Only',
        searchPlaceholder: 'Search providers, models, notes',
        providers: 'Providers',
        items: 'items',
        selectProvider: 'Select a provider',
        selectProviderText: 'Pick any resource card to inspect its limits, models, and compatibility notes.',
        openWebsite: 'Open Website',
        limits: 'Limits',
        compatibility: 'Compatibility',
        requirements: 'Requirements',
        representativeModels: 'Representative Models',
        notes: 'Notes',
        source: 'Source',
        models: 'Models',
        proxypool: 'ProxyPool',
        supportedByProxyPool: 'Supported',
        notYet: 'Not yet',
        website: 'Website',
        noMatch: 'No resources match the current filters.',
        requestFailed: 'Request failed',
        reviewed: 'reviewed',
        proxyPoolSupportedSuffix: 'supported by CliGate'
    },
    zh: {
        brandEyebrow: 'CliGate',
        brandTitle: '资源目录',
        pageEyebrow: '精选目录',
        pageTitle: '资源目录',
        pageSubtle: '这里集中展示免费和试用型 LLM API 资源。本页面为只读目录，不会改变现有代理路由行为。',
        topbarNote: '语言和主题跟随主仪表盘设置。',
        back: '返回仪表盘',
        dashboard: '仪表盘',
        resources: '资源目录',
        total: '总数',
        free: '免费',
        trial: '试用',
        supported: '已支持',
        category: '类别',
        status: '状态',
        search: '搜索',
        all: '全部',
        presettable: '可预设',
        candidate: '候选',
        catalogOnly: '仅目录',
        searchPlaceholder: '搜索服务、模型、备注',
        providers: '服务列表',
        items: '项',
        selectProvider: '请选择一个服务',
        selectProviderText: '点击左侧卡片查看它的限额、模型和兼容性说明。',
        openWebsite: '打开官网',
        limits: '限额',
        compatibility: '兼容性',
        requirements: '要求',
        representativeModels: '代表模型',
        notes: '备注',
        source: '来源',
        models: '模型',
        proxypool: 'ProxyPool',
        supportedByProxyPool: '已支持',
        notYet: '尚未支持',
        website: '官网',
        noMatch: '当前筛选条件下没有匹配资源。',
        requestFailed: '请求失败',
        reviewed: '校验时间',
        proxyPoolSupportedSuffix: '已被 CliGate 支持'
    }
};

const state = {
    items: [],
    selectedId: '',
    summary: null,
    lang: localStorage.getItem('proxy-lang') || 'en',
    darkMode: localStorage.getItem('proxy-theme') !== 'light',
    filters: {
        category: 'all',
        status: 'all',
        q: ''
    }
};

const els = {
    list: document.getElementById('resource-list'),
    resultCount: document.getElementById('result-count'),
    category: document.getElementById('filter-category'),
    status: document.getElementById('filter-status'),
    query: document.getElementById('filter-query'),
    detailEmpty: document.getElementById('detail-empty'),
    detailContent: document.getElementById('detail-content'),
    detailCategory: document.getElementById('detail-category'),
    detailName: document.getElementById('detail-name'),
    detailWebsite: document.getElementById('detail-website'),
    detailDescription: document.getElementById('detail-description'),
    detailLimits: document.getElementById('detail-limits'),
    detailStatus: document.getElementById('detail-status'),
    detailCompatibility: document.getElementById('detail-compatibility'),
    detailRequirements: document.getElementById('detail-requirements'),
    detailModels: document.getElementById('detail-models'),
    detailNotes: document.getElementById('detail-notes'),
    detailSource: document.getElementById('detail-source'),
    summaryTotal: document.getElementById('summary-total'),
    summaryFree: document.getElementById('summary-free'),
    summaryTrial: document.getElementById('summary-trial'),
    summarySupported: document.getElementById('summary-supported')
};

function t(key) {
    const dict = I18N[state.lang] || I18N.en;
    return dict[key] ?? I18N.en[key] ?? key;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function applyTheme() {
    document.documentElement.classList.toggle('light', !state.darkMode);
    document.documentElement.classList.toggle('dark', state.darkMode);
}

function applyI18nChrome() {
    document.documentElement.lang = state.lang === 'zh' ? 'zh' : 'en';

    const mappings = {
        'brand-eyebrow': 'brandEyebrow',
        'brand-title': 'brandTitle',
        'page-eyebrow': 'pageEyebrow',
        'page-title': 'pageTitle',
        'page-subtle': 'pageSubtle',
        'topbar-note': 'topbarNote',
        'back-link': 'back',
        'nav-dashboard': 'dashboard',
        'nav-resources': 'resources',
        'summary-label-total': 'total',
        'summary-label-free': 'free',
        'summary-label-trial': 'trial',
        'summary-label-supported': 'supported',
        'filter-label-category': 'category',
        'filter-label-status': 'status',
        'filter-label-search': 'search',
        'option-category-all': 'all',
        'option-category-free': 'free',
        'option-category-trial': 'trial',
        'option-status-all': 'all',
        'option-status-supported': 'supported',
        'option-status-presettable': 'presettable',
        'option-status-candidate': 'candidate',
        'option-status-catalog-only': 'catalogOnly',
        'providers-title': 'providers',
        'detail-empty-title': 'selectProvider',
        'detail-empty-text': 'selectProviderText',
        'detail-label-limits': 'limits',
        'detail-label-status': 'status',
        'detail-label-compatibility': 'compatibility',
        'detail-section-requirements': 'requirements',
        'detail-section-models': 'representativeModels',
        'detail-section-notes': 'notes',
        'detail-section-source': 'source'
    };

    Object.entries(mappings).forEach(([id, key]) => {
        const node = document.getElementById(id);
        if (node) node.textContent = t(key);
    });

    els.detailWebsite.textContent = t('openWebsite');
    els.query.placeholder = t('searchPlaceholder');
}

function renderSummary(summary) {
    els.summaryTotal.textContent = summary.total;
    els.summaryFree.textContent = summary.free;
    els.summaryTrial.textContent = summary.trial;
    els.summarySupported.textContent = summary.supported + summary.presettable;
}

function renderList() {
    els.resultCount.textContent = `${state.items.length} ${t('items')}`;

    if (state.items.length === 0) {
        els.list.innerHTML = `<article class="resource-card"><p>${escapeHtml(t('noMatch'))}</p></article>`;
        return;
    }

    els.list.innerHTML = state.items.map(item => {
        const activeClass = item.id === state.selectedId ? ' active' : '';
        return `
            <article class="resource-card${activeClass}" data-resource-id="${escapeHtml(item.id)}">
                <div class="resource-top">
                    <div>
                        <h3>${escapeHtml(item.name)}</h3>
                        <p>${escapeHtml(item.description)}</p>
                    </div>
                    <span class="pill ${escapeHtml(item.category)}">${escapeHtml(item.category)}</span>
                </div>
                <div class="resource-meta">
                    <div>
                        <span>${escapeHtml(t('limits'))}</span>
                        <strong>${escapeHtml(item.limitsSummary)}</strong>
                    </div>
                    <div>
                        <span>${escapeHtml(t('models'))}</span>
                        <strong>${escapeHtml(item.modelCount)}</strong>
                    </div>
                    <div>
                        <span>${escapeHtml(t('proxypool'))}</span>
                        <strong>${item.supportedByProxyPool ? escapeHtml(t('supportedByProxyPool')) : escapeHtml(t('notYet'))}</strong>
                    </div>
                </div>
                <div class="resource-footer">
                    <span class="status-text">${escapeHtml(item.accessStatus)}</span>
                    <a class="ghost-link" href="${escapeHtml(item.website)}" target="_blank" rel="noreferrer">${escapeHtml(t('website'))}</a>
                </div>
            </article>
        `;
    }).join('');

    els.list.querySelectorAll('[data-resource-id]').forEach(node => {
        node.addEventListener('click', () => selectResource(node.getAttribute('data-resource-id')));
    });
}

function renderListItems(list, target) {
    target.innerHTML = (list || []).map(item => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderDetail(item) {
    if (!item) {
        els.detailEmpty.classList.remove('hidden');
        els.detailContent.classList.add('hidden');
        return;
    }

    els.detailEmpty.classList.add('hidden');
    els.detailContent.classList.remove('hidden');
    els.detailCategory.textContent = item.category;
    els.detailName.textContent = item.name;
    els.detailWebsite.href = item.website;
    els.detailWebsite.textContent = t('openWebsite');
    els.detailDescription.textContent = item.description;
    els.detailLimits.textContent = item.limitsSummary;
    els.detailStatus.textContent = `${item.accessStatus}${item.supportedByProxyPool ? ` · ${t('proxyPoolSupportedSuffix')}` : ''}`;
    els.detailCompatibility.textContent = `${item.compatibility.protocol}${item.compatibility.providerType ? ` · ${item.compatibility.providerType}` : ''}`;
    renderListItems(item.requirements, els.detailRequirements);
    renderListItems(item.models, els.detailModels);
    renderListItems(item.notes, els.detailNotes);
    els.detailSource.textContent = `${item.source.label} · ${t('reviewed')} ${item.lastReviewedAt}`;
}

async function fetchJson(url) {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data?.error || 'Request failed');
    }
    return data;
}

async function loadResources() {
    const params = new URLSearchParams();
    if (state.filters.category && state.filters.category !== 'all') params.set('category', state.filters.category);
    if (state.filters.status && state.filters.status !== 'all') params.set('status', state.filters.status);
    if (state.filters.q.trim()) params.set('q', state.filters.q.trim());

    const data = await fetchJson(`/api/resources?${params.toString()}`);
    state.items = data.items || [];
    state.summary = data.summary || null;

    if (state.summary) {
        renderSummary(state.summary);
    }

    if (!state.items.some(item => item.id === state.selectedId)) {
        state.selectedId = state.items[0]?.id || '';
    }

    renderList();
    renderDetail(state.items.find(item => item.id === state.selectedId) || null);
}

async function selectResource(id) {
    state.selectedId = id;
    renderList();

    const data = await fetchJson(`/api/resources/${encodeURIComponent(id)}`);
    renderDetail(data.item || null);
}

function bindFilters() {
    els.category.addEventListener('change', async (event) => {
        state.filters.category = event.target.value;
        await loadResources();
    });

    els.status.addEventListener('change', async (event) => {
        state.filters.status = event.target.value;
        await loadResources();
    });

    let searchTimer = null;
    els.query.addEventListener('input', (event) => {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(async () => {
            state.filters.q = event.target.value;
            await loadResources();
        }, 180);
    });
}

function bindChrome() {
    window.addEventListener('storage', (event) => {
        if (event.key === 'proxy-lang') {
            state.lang = localStorage.getItem('proxy-lang') || 'en';
            applyI18nChrome();
            renderSummary(state.summary || {
                total: '-',
                free: '-',
                trial: '-',
                supported: 0,
                presettable: 0
            });
            renderList();
            renderDetail(state.items.find(item => item.id === state.selectedId) || null);
        }

        if (event.key === 'proxy-theme') {
            state.darkMode = localStorage.getItem('proxy-theme') !== 'light';
            applyTheme();
        }
    });
}

async function main() {
    state.lang = localStorage.getItem('proxy-lang') || 'en';
    state.darkMode = localStorage.getItem('proxy-theme') !== 'light';
    bindChrome();
    bindFilters();
    applyI18nChrome();
    applyTheme();
    await loadResources();
}

main().catch((error) => {
    els.list.innerHTML = `<article class="resource-card"><p>${escapeHtml(error.message || t('requestFailed'))}</p></article>`;
});
