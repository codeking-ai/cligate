export const RESOURCE_CATALOG = [
    {
        id: 'openrouter',
        name: 'OpenRouter',
        category: 'free',
        website: 'https://openrouter.ai',
        docsUrl: 'https://openrouter.ai/docs',
        description: 'Aggregated OpenAI-compatible gateway with a rotating set of free models.',
        requirements: ['Signup required', 'Free-tier rate limits apply'],
        limitsSummary: 'Typically 20 req/min and 50 req/day on free models',
        models: [
            'google/gemma-3-12b-it:free',
            'meta-llama/llama-3.3-70b-instruct:free',
            'qwen/qwen3-coder:free'
        ],
        compatibility: {
            protocol: 'openai',
            providerType: 'openai',
            canUseApiKey: true,
            canPresetInProxyPool: true
        },
        accessStatus: 'presettable',
        supportedByProxyPool: true,
        notes: [
            'Good candidate for user-supplied API keys.',
            'Model availability changes frequently.'
        ],
        source: {
            kind: 'manual',
            label: 'Official docs and public model list'
        },
        lastReviewedAt: '2026-03-31'
    },
    {
        id: 'google-ai-studio',
        name: 'Google AI Studio',
        category: 'free',
        website: 'https://aistudio.google.com',
        docsUrl: 'https://ai.google.dev',
        description: 'Google-hosted Gemini and Gemma access with free quotas for API usage.',
        requirements: ['Google account required', 'Regional policy limits may apply'],
        limitsSummary: 'Free daily and per-minute quotas depending on model',
        models: [
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemma-3-27b-it'
        ],
        compatibility: {
            protocol: 'gemini',
            providerType: 'gemini',
            canUseApiKey: true,
            canPresetInProxyPool: false
        },
        accessStatus: 'supported',
        supportedByProxyPool: true,
        notes: [
            'Already aligns with the existing Gemini provider integration.'
        ],
        source: {
            kind: 'manual',
            label: 'Official AI Studio docs'
        },
        lastReviewedAt: '2026-03-31'
    },
    {
        id: 'groq',
        name: 'Groq',
        category: 'free',
        website: 'https://console.groq.com',
        docsUrl: 'https://console.groq.com/docs',
        description: 'Fast inference provider with free quotas on selected open models.',
        requirements: ['Signup required'],
        limitsSummary: 'Model-specific daily request and per-minute token limits',
        models: [
            'llama-3.3-70b',
            'openai/gpt-oss-120b',
            'qwen/qwen3-32b'
        ],
        compatibility: {
            protocol: 'openai',
            providerType: 'openai',
            canUseApiKey: true,
            canPresetInProxyPool: true
        },
        accessStatus: 'presettable',
        supportedByProxyPool: true,
        notes: [
            'Could be configured as an OpenAI-compatible endpoint with user credentials.'
        ],
        source: {
            kind: 'manual',
            label: 'Official Groq console and API docs'
        },
        lastReviewedAt: '2026-03-31'
    },
    {
        id: 'cloudflare-workers-ai',
        name: 'Cloudflare Workers AI',
        category: 'free',
        website: 'https://developers.cloudflare.com/workers-ai',
        docsUrl: 'https://developers.cloudflare.com/workers-ai',
        description: 'Cloudflare-hosted inference catalog with daily free allocation.',
        requirements: ['Cloudflare account required'],
        limitsSummary: 'Free daily neuron allocation',
        models: [
            '@cf/openai/gpt-oss-120b',
            '@cf/qwen/qwen3-30b-a3b-fp8',
            '@cf/zai-org/glm-4.7-flash'
        ],
        compatibility: {
            protocol: 'custom',
            providerType: null,
            canUseApiKey: true,
            canPresetInProxyPool: false
        },
        accessStatus: 'candidate',
        supportedByProxyPool: false,
        notes: [
            'Useful catalog entry, but needs a dedicated adapter before runtime use.'
        ],
        source: {
            kind: 'manual',
            label: 'Official Workers AI docs'
        },
        lastReviewedAt: '2026-03-31'
    },
    {
        id: 'cohere',
        name: 'Cohere',
        category: 'free',
        website: 'https://cohere.com',
        docsUrl: 'https://docs.cohere.com',
        description: 'Hosted API with limited free monthly usage and command models.',
        requirements: ['Signup required'],
        limitsSummary: 'Shared monthly free quota and per-minute request limits',
        models: [
            'command-a-03-2025',
            'command-r-08-2024',
            'c4ai-aya-expanse-32b'
        ],
        compatibility: {
            protocol: 'custom',
            providerType: null,
            canUseApiKey: true,
            canPresetInProxyPool: false
        },
        accessStatus: 'candidate',
        supportedByProxyPool: false,
        notes: [
            'Not directly compatible with the current provider set.'
        ],
        source: {
            kind: 'manual',
            label: 'Official pricing and limits docs'
        },
        lastReviewedAt: '2026-03-31'
    },
    {
        id: 'github-models',
        name: 'GitHub Models',
        category: 'free',
        website: 'https://github.com/marketplace/models',
        docsUrl: 'https://docs.github.com/en/github-models',
        description: 'Model playground and API access tied to GitHub account and Copilot tier.',
        requirements: ['GitHub account required', 'Availability depends on Copilot tier'],
        limitsSummary: 'Restrictive token and request limits',
        models: [
            'OpenAI GPT-4.1',
            'OpenAI gpt-5',
            'Mistral Small 3.1'
        ],
        compatibility: {
            protocol: 'custom',
            providerType: null,
            canUseApiKey: false,
            canPresetInProxyPool: false
        },
        accessStatus: 'catalog_only',
        supportedByProxyPool: false,
        notes: [
            'Good discovery target for users, but not a straightforward runtime provider for this project.'
        ],
        source: {
            kind: 'manual',
            label: 'Official GitHub Models docs'
        },
        lastReviewedAt: '2026-03-31'
    },
    {
        id: 'huggingface-inference',
        name: 'HuggingFace Inference Providers',
        category: 'free',
        website: 'https://huggingface.co',
        docsUrl: 'https://huggingface.co/docs/inference-providers/en/index',
        description: 'Unified inference surface with small monthly credits and provider switching.',
        requirements: ['Hugging Face account required'],
        limitsSummary: 'Small monthly credit allocation',
        models: [
            'Various supported open models'
        ],
        compatibility: {
            protocol: 'custom',
            providerType: null,
            canUseApiKey: true,
            canPresetInProxyPool: false
        },
        accessStatus: 'candidate',
        supportedByProxyPool: false,
        notes: [
            'Could be added later if there is enough demand.'
        ],
        source: {
            kind: 'manual',
            label: 'Official Hugging Face docs'
        },
        lastReviewedAt: '2026-03-31'
    },
    {
        id: 'opencode-zen',
        name: 'OpenCode Zen',
        category: 'free',
        website: 'https://opencode.ai/docs/zen/',
        docsUrl: 'https://opencode.ai/docs/zen/',
        description: 'Gateway-style curated model access with free offerings.',
        requirements: ['Signup may be required'],
        limitsSummary: 'Provider-managed free model access',
        models: [
            'Big Pickle Stealth',
            'MiniMax M2.5 Free',
            'Arcee Large Preview Free'
        ],
        compatibility: {
            protocol: 'custom',
            providerType: null,
            canUseApiKey: true,
            canPresetInProxyPool: false
        },
        accessStatus: 'catalog_only',
        supportedByProxyPool: false,
        notes: [
            'Catalog value is higher than direct runtime reuse for now.'
        ],
        source: {
            kind: 'manual',
            label: 'Official OpenCode Zen docs'
        },
        lastReviewedAt: '2026-03-31'
    },
    {
        id: 'cerebras',
        name: 'Cerebras',
        category: 'free',
        website: 'https://cloud.cerebras.ai',
        docsUrl: 'https://inference-docs.cerebras.ai',
        description: 'Inference API with free limits on selected models.',
        requirements: ['Signup required'],
        limitsSummary: 'Model-specific daily request and token limits',
        models: [
            'gpt-oss-120b',
            'llama-3.1-8b'
        ],
        compatibility: {
            protocol: 'openai',
            providerType: 'openai',
            canUseApiKey: true,
            canPresetInProxyPool: true
        },
        accessStatus: 'presettable',
        supportedByProxyPool: true,
        notes: [
            'Potentially usable through an OpenAI-compatible provider preset.'
        ],
        source: {
            kind: 'manual',
            label: 'Official Cerebras docs'
        },
        lastReviewedAt: '2026-03-31'
    },
    {
        id: 'sambanova-cloud',
        name: 'SambaNova Cloud',
        category: 'trial',
        website: 'https://cloud.sambanova.ai',
        docsUrl: 'https://docs.sambanova.ai',
        description: 'Trial credits for hosted inference across open and proprietary models.',
        requirements: ['Signup required'],
        limitsSummary: '$5 credit for 3 months',
        models: [
            'Llama 3.3 70B',
            'DeepSeek-V3.2',
            'minimax-m2.5'
        ],
        compatibility: {
            protocol: 'openai',
            providerType: 'openai',
            canUseApiKey: true,
            canPresetInProxyPool: true
        },
        accessStatus: 'presettable',
        supportedByProxyPool: true,
        notes: [
            'Trial-only, but still useful as a user-configured upstream.'
        ],
        source: {
            kind: 'manual',
            label: 'Official SambaNova Cloud docs'
        },
        lastReviewedAt: '2026-03-31'
    },
    {
        id: 'hyperbolic',
        name: 'Hyperbolic',
        category: 'trial',
        website: 'https://app.hyperbolic.xyz',
        docsUrl: 'https://docs.hyperbolic.xyz',
        description: 'Hosted API with trial credits for open model access.',
        requirements: ['Signup required'],
        limitsSummary: '$1 trial credit',
        models: [
            'DeepSeek V3',
            'Qwen3 Next 80B',
            'openai/gpt-oss-120b'
        ],
        compatibility: {
            protocol: 'openai',
            providerType: 'openai',
            canUseApiKey: true,
            canPresetInProxyPool: true
        },
        accessStatus: 'presettable',
        supportedByProxyPool: true,
        notes: [
            'Best treated as an optional user-configured upstream.'
        ],
        source: {
            kind: 'manual',
            label: 'Official Hyperbolic docs'
        },
        lastReviewedAt: '2026-03-31'
    },
    {
        id: 'scaleway-generative-apis',
        name: 'Scaleway Generative APIs',
        category: 'trial',
        website: 'https://console.scaleway.com/generative-api/models',
        docsUrl: 'https://www.scaleway.com/en/docs/generative-apis',
        description: 'Trial token allocation for hosted open-model inference.',
        requirements: ['Scaleway account required'],
        limitsSummary: '1,000,000 free tokens',
        models: [
            'Gemma 3 27B Instruct',
            'Llama 3.3 70B Instruct',
            'gpt-oss-120b'
        ],
        compatibility: {
            protocol: 'openai',
            providerType: 'openai',
            canUseApiKey: true,
            canPresetInProxyPool: true
        },
        accessStatus: 'presettable',
        supportedByProxyPool: true,
        notes: [
            'Fits the preset catalog concept well.'
        ],
        source: {
            kind: 'manual',
            label: 'Official Scaleway docs'
        },
        lastReviewedAt: '2026-03-31'
    }
];

export default RESOURCE_CATALOG;
