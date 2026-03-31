import { RESOURCE_CATALOG } from './catalog-data.js';

function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
}

function matchesQuery(resource, query) {
    if (!query) return true;

    const haystack = [
        resource.name,
        resource.description,
        resource.category,
        resource.accessStatus,
        ...(resource.models || []),
        ...(resource.requirements || []),
        ...(resource.notes || [])
    ].join('\n').toLowerCase();

    return haystack.includes(query);
}

function normalizeResource(resource) {
    return {
        ...resource,
        modelCount: Array.isArray(resource.models) ? resource.models.length : 0
    };
}

export function listResources(filters = {}) {
    const category = normalizeText(filters.category);
    const status = normalizeText(filters.status);
    const query = normalizeText(filters.q);

    return RESOURCE_CATALOG
        .map(normalizeResource)
        .filter(resource => !category || category === 'all' || resource.category === category)
        .filter(resource => !status || status === 'all' || resource.accessStatus === status)
        .filter(resource => matchesQuery(resource, query))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function getResourceSummary() {
    const items = RESOURCE_CATALOG.map(normalizeResource);
    return {
        total: items.length,
        free: items.filter(item => item.category === 'free').length,
        trial: items.filter(item => item.category === 'trial').length,
        supported: items.filter(item => item.accessStatus === 'supported').length,
        presettable: items.filter(item => item.accessStatus === 'presettable').length,
        candidate: items.filter(item => item.accessStatus === 'candidate').length,
        catalogOnly: items.filter(item => item.accessStatus === 'catalog_only').length,
        supportedByProxyPool: items.filter(item => item.supportedByProxyPool).length
    };
}

export function getResourceById(id) {
    const target = normalizeText(id);
    const resource = RESOURCE_CATALOG.find(item => normalizeText(item.id) === target);
    return resource ? normalizeResource(resource) : null;
}

export default {
    listResources,
    getResourceSummary,
    getResourceById
};
