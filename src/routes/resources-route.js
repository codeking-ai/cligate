import { getResourceById, getResourceSummary, listResources } from '../resources/catalog-service.js';

export function handleListResources(req, res) {
    const { category = '', status = '', q = '' } = req.query || {};
    const items = listResources({ category, status, q });
    res.json({
        success: true,
        filters: { category, status, q },
        summary: getResourceSummary(),
        items
    });
}

export function handleGetResourceSummary(req, res) {
    res.json({
        success: true,
        summary: getResourceSummary()
    });
}

export function handleGetResourceById(req, res) {
    const item = getResourceById(req.params.id);
    if (!item) {
        return res.status(404).json({
            success: false,
            error: 'Resource not found'
        });
    }

    res.json({
        success: true,
        item
    });
}

export default {
    handleListResources,
    handleGetResourceSummary,
    handleGetResourceById
};
