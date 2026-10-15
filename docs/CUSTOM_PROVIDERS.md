# Custom API-Key Providers

Add an OpenAI-compatible vendor **without touching the code**: describe it in
`~/.cligate/provider-presets.json` and it becomes a first-class provider —
selectable in the add-key form, visible on the model-mapping page with its own
tier map, included in model discovery, protocol compatibility, and pricing.

## Quick start

`~/.cligate/provider-presets.json` (full file, not a merge — include every
custom provider you want):

```json
[
  {
    "id": "clinepass",
    "label": "ClinePass",
    "baseUrl": "https://api.clinepass.example/v1",
    "models": ["vendor-x", "vendor-y"],
    "tiers": {
      "flagship": "vendor-x",
      "standard": "vendor-y",
      "fast": "vendor-y",
      "reasoning": "vendor-x"
    },
    "nativeModelPrefixes": ["vendor-"]
  }
]
```

Restart the server. The new type appears in the dashboard's **Add API Key**
form; keys you add with it route through the generic OpenAI-compatible
provider. `nativeModelPrefixes` keeps ids the caller explicitly chose
(`vendor-x`) from being tier-remapped; everything else (e.g. an incoming
`claude-sonnet-4-6` from Claude Code) resolves through the tier map.

## Fields

Same schema as the built-in presets in `src/providers/provider-presets.js`:

| Field                | Required | Meaning |
|----------------------|----------|---------|
| `id`                 | yes      | Provider type key. Lowercase letters/digits/`.`/`_`/`-`; must not collide with a built-in id (`qwen`, `openrouter`, `zhipu`, `moonshot`, `minimax`, `clinepass`, `ollama-cloud`, `openai`, `anthropic`, `gemini`, `azure-openai`, `vertex-ai`, `deepseek`). |
| `baseUrl`            | yes      | Upstream API base URL (chat-completions compatible). |
| `label`, `badge`     | no       | Display name (defaults to `id`) and short UI tag (defaults to first two chars uppercased). `labelKey` adds i18n. |
| `apiFormat`          | no       | `openai_chat` (default) \| `openai_responses` \| `anthropic` \| `gemini_native`. `openai_chat` vendors serve all three gateway surfaces (chat, Codex Responses fallback, Claude Code bridge). |
| `website`, `keyHint` | no       | Console link and key placeholder shown in the add-key form. |
| `models`             | no       | Static model ids for UI dropdowns and tier auto-fill (supplemented by discovery when the vendor serves `/models`). |
| `tiers`              | no       | `{ flagship, standard, fast, reasoning }` → model id. Unknown tier keys are rejected. |
| `nativeModelPrefixes`| no       | Model ids starting with any prefix pass through without tier remap. |
| `passthroughModelMatch` | no    | Model ids containing this substring pass through verbatim (e.g. `"/"` for `vendor/model` slugs). |
| `pricing`            | no       | `{ "<model>": { input, output, cacheRead?, cacheWrite? } }` in USD / 1M tokens. |
| `validateModel`      | no       | For vendors without `GET /models` (e.g. Zhipu): "test key" probes a 1-token chat request with this model instead. |

## Validation and error handling

The loader runs at server start. A bad file never blocks startup — each
invalid entry is skipped with a console warning explaining why:

- collides with a built-in id → skipped (built-ins always win),
- invalid id shape / missing `baseUrl` / unknown `apiFormat` / unknown tier key → skipped,
- duplicate ids → first entry wins.

The file must be a JSON array (or `{"presets": [...]}`).

## Limitations

- Only `openai_chat` user presets are wired into the protocol-compatibility
  sets today (`openai_responses` / `anthropic` / `gemini_native` formats are
  accepted but only serve the surfaces the generic provider implements).
- Model discovery probes one provider per type; with a custom `id` your vendor
  is always probed — the limitation only affects two keys of the *same* type
  with different base URLs.
