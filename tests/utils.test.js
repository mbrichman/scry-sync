import { describe, it, expect } from 'vitest';
import utils from '../chrome/utils.js';

const {
  getCurrentBranch,
  inferModel,
  formatModelName,
  getModelBadgeClass,
  DEFAULT_MODEL_TIMELINE,
  getImageExtension,
  imageAssetName,
  imageAssetUrl,
  collectImageFiles,
} = utils;

// Regression coverage for the bug fixed in v1.9.1: bash/web_search/repl
// tool_use entries used to slip through as fake artifacts. Now gated on
// `tool_use.name === 'artifacts'`.
describe('getCurrentBranch', () => {
  it('returns empty array when there are no messages', () => {
    expect(getCurrentBranch({ chat_messages: [], current_leaf_message_uuid: 'x' })).toEqual([]);
  });

  it('returns empty array when leaf uuid is missing', () => {
    expect(getCurrentBranch({ chat_messages: [{ uuid: 'a' }] })).toEqual([]);
  });

  it('walks from leaf back to root in chronological order', () => {
    const data = {
      current_leaf_message_uuid: 'm3',
      chat_messages: [
        { uuid: 'm1', parent_message_uuid: 'root', text: 'first' },
        { uuid: 'm2', parent_message_uuid: 'm1', text: 'second' },
        { uuid: 'm3', parent_message_uuid: 'm2', text: 'third' },
      ],
    };
    const branch = getCurrentBranch(data);
    expect(branch.map(m => m.uuid)).toEqual(['m1', 'm2', 'm3']);
  });

  it('only includes messages on the current branch (ignores siblings)', () => {
    // m1 → m2a → m3 (current leaf), m1 → m2b is a sibling branch and should be excluded
    const data = {
      current_leaf_message_uuid: 'm3',
      chat_messages: [
        { uuid: 'm1', parent_message_uuid: 'root', text: 'first' },
        { uuid: 'm2a', parent_message_uuid: 'm1', text: 'kept' },
        { uuid: 'm2b', parent_message_uuid: 'm1', text: 'sibling' },
        { uuid: 'm3', parent_message_uuid: 'm2a', text: 'leaf' },
      ],
    };
    const branch = getCurrentBranch(data);
    expect(branch.map(m => m.uuid)).toEqual(['m1', 'm2a', 'm3']);
  });
});

describe('formatModelName — new format (claude-{type}-{major}[-{minor}][-{date}])', () => {
  it('renders major-only with date suffix correctly (regression)', () => {
    expect(formatModelName('claude-opus-4-20250514')).toBe('Claude Opus 4');
    expect(formatModelName('claude-sonnet-4-20250514')).toBe('Claude Sonnet 4');
  });

  it('renders major.minor with date suffix', () => {
    expect(formatModelName('claude-sonnet-4-5-20250929')).toBe('Claude Sonnet 4.5');
    expect(formatModelName('claude-opus-4-5-20251101')).toBe('Claude Opus 4.5');
  });

  it('renders major.minor without date suffix', () => {
    expect(formatModelName('claude-sonnet-4-6')).toBe('Claude Sonnet 4.6');
    expect(formatModelName('claude-opus-4-7')).toBe('Claude Opus 4.7');
  });

  it('renders major-only without date', () => {
    expect(formatModelName('claude-haiku-5')).toBe('Claude Haiku 5');
  });
});

describe('formatModelName — old format (claude-{major}[-{minor}]-{type}-{date})', () => {
  it('renders major-only old format', () => {
    expect(formatModelName('claude-3-sonnet-20240229')).toBe('Claude Sonnet 3');
  });

  it('renders major.minor old format', () => {
    expect(formatModelName('claude-3-5-sonnet-20240620')).toBe('Claude Sonnet 3.5');
    expect(formatModelName('claude-3-7-sonnet-20250219')).toBe('Claude Sonnet 3.7');
  });
});

describe('formatModelName — edge cases', () => {
  it('returns "Unknown" for null/undefined/empty', () => {
    expect(formatModelName(null)).toBe('Unknown');
    expect(formatModelName(undefined)).toBe('Unknown');
    expect(formatModelName('')).toBe('Unknown');
  });

  it('returns input unchanged when not a claude- model', () => {
    expect(formatModelName('gpt-4')).toBe('gpt-4');
  });

  it('returns input unchanged when claude- prefix but unparseable', () => {
    expect(formatModelName('claude-nonsense')).toBe('claude-nonsense');
  });
});

// Coverage matrix for the three documented shapes (per Anthropic's model-ids docs):
//   1. Dateless 4.6+: `claude-{name}-{major}-{minor}` (canonical snapshot)
//   2. Dated pre-4.6: `claude-{name}-{major}-{minor}-{YYYYMMDD}`
//   3. Convenience alias pre-4.6: `claude-{name}-{major}-{minor}` (looks identical to #1, semantic difference only)
// Verified across all known families. Bedrock/Vertex prefixes intentionally omitted —
// claude.ai never serves those.
describe('formatModelName — full family × shape matrix', () => {
  const families = [
    ['sonnet', 'Sonnet'],
    ['opus', 'Opus'],
    ['haiku', 'Haiku'],
  ];

  for (const [family, label] of families) {
    it(`renders ${family} dateless (4.6+ canonical)`, () => {
      expect(formatModelName(`claude-${family}-4-6`)).toBe(`Claude ${label} 4.6`);
    });

    it(`renders ${family} dated (pre-4.6)`, () => {
      expect(formatModelName(`claude-${family}-4-5-20250929`)).toBe(`Claude ${label} 4.5`);
    });

    it(`renders ${family} alias (pre-4.6 dateless — same shape as #1, different semantics)`, () => {
      expect(formatModelName(`claude-${family}-4-5`)).toBe(`Claude ${label} 4.5`);
    });
  }
});

describe('formatModelName — minor-version regex boundary (\\d{1,2})', () => {
  it('accepts two-digit minors', () => {
    expect(formatModelName('claude-sonnet-5-10')).toBe('Claude Sonnet 5.10');
    expect(formatModelName('claude-opus-4-99')).toBe('Claude Opus 4.99');
  });

  it('falls through on three-digit minors (would need regex bump)', () => {
    expect(formatModelName('claude-sonnet-5-100')).toBe('claude-sonnet-5-100');
  });
});

// Documented behavior for unknown families (e.g. a hypothetical future "Mythos").
// Current regex hardcodes `(sonnet|opus|haiku)` — anything else falls through to
// raw display. These tests pin that behavior so the day Anthropic ships a new
// family, we get a heads-up via test failure rather than ugly UI.
describe('formatModelName — unknown family fallthrough', () => {
  it('returns raw ID for new family with non-numeric version (e.g. -preview)', () => {
    expect(formatModelName('claude-mythos-preview')).toBe('claude-mythos-preview');
  });

  it('returns raw ID for new family with numeric version', () => {
    expect(formatModelName('claude-mythos-1-0')).toBe('claude-mythos-1-0');
  });

  it('returns raw ID for new family with dated version', () => {
    expect(formatModelName('claude-mythos-1-0-20260101')).toBe('claude-mythos-1-0-20260101');
  });
});

describe('inferModel', () => {
  it('returns conversation.model when set, regardless of date', () => {
    expect(inferModel({ model: 'claude-opus-4-7', created_at: '2024-01-01T00:00:00Z' }))
      .toBe('claude-opus-4-7');
  });

  it('falls back to timeline lookup when model is null', () => {
    // Mid-2024 → claude-3-5-sonnet-20240620
    expect(inferModel({ model: null, created_at: '2024-08-01T00:00:00Z' }))
      .toBe('claude-3-5-sonnet-20240620');
  });

  it('returns the most recent timeline entry for current dates', () => {
    expect(inferModel({ model: null, created_at: '2026-04-01T00:00:00Z' }))
      .toBe('claude-sonnet-4-6');
  });

  it('returns the earliest timeline entry for pre-timeline dates', () => {
    expect(inferModel({ model: null, created_at: '2023-06-01T00:00:00Z' }))
      .toBe('claude-3-sonnet-20240229');
  });

  it('uses correct model on timeline boundaries', () => {
    // 2024-06-20 is the first day of claude-3-5-sonnet-20240620
    expect(inferModel({ model: null, created_at: '2024-06-20T00:00:00Z' }))
      .toBe('claude-3-5-sonnet-20240620');
    // One second before that boundary should still be the prior model
    expect(inferModel({ model: null, created_at: '2024-06-19T23:59:59Z' }))
      .toBe('claude-3-sonnet-20240229');
  });
});

describe('DEFAULT_MODEL_TIMELINE', () => {
  it('has all valid Date objects (no NaN dates)', () => {
    for (const entry of DEFAULT_MODEL_TIMELINE) {
      expect(entry.date instanceof Date).toBe(true);
      expect(Number.isNaN(entry.date.getTime())).toBe(false);
    }
  });

  it('is sorted in chronological order', () => {
    for (let i = 1; i < DEFAULT_MODEL_TIMELINE.length; i++) {
      expect(DEFAULT_MODEL_TIMELINE[i].date.getTime())
        .toBeGreaterThan(DEFAULT_MODEL_TIMELINE[i - 1].date.getTime());
    }
  });

  // Catches typos when adding a new default — e.g. `claude-sonnett-4-7` would
  // silently fall through to raw display in the UI; this test makes it loud.
  it('every entry parses cleanly through formatModelName (no fallthrough to raw ID)', () => {
    for (const entry of DEFAULT_MODEL_TIMELINE) {
      const formatted = formatModelName(entry.model);
      expect(formatted, `entry "${entry.model}" failed to format`).toMatch(/^Claude (Sonnet|Opus|Haiku) /);
    }
  });
});

describe('getModelBadgeClass', () => {
  it('returns family name when model contains it', () => {
    expect(getModelBadgeClass('claude-sonnet-4-5-20250929')).toBe('sonnet');
    expect(getModelBadgeClass('claude-opus-4-7')).toBe('opus');
    expect(getModelBadgeClass('claude-haiku-3-5')).toBe('haiku');
  });

  it('returns empty string for unknown family', () => {
    expect(getModelBadgeClass('gpt-4')).toBe('');
  });

  it('returns empty string for new claude family without a registered badge', () => {
    expect(getModelBadgeClass('claude-mythos-preview')).toBe('');
    expect(getModelBadgeClass('claude-mythos-1-0')).toBe('');
  });

  it('handles null/empty input without throwing', () => {
    expect(getModelBadgeClass(null)).toBe('');
    expect(getModelBadgeClass('')).toBe('');
    expect(getModelBadgeClass(undefined)).toBe('');
  });
});

describe('image file handling', () => {
  const imageFile = {
    file_kind: 'image',
    file_uuid: 'fae994b8-5bd3-492a-9a2e-0245f5ec5e7a',
    file_name: 'shot 1.png',
    thumbnail_url: '/api/ORG/files/fae994b8/thumbnail',
    preview_url: '/api/ORG/files/fae994b8/preview',
  };

  it('derives extension from file name, defaulting to .png', () => {
    expect(getImageExtension('a.PNG')).toBe('.png');
    expect(getImageExtension('a.jpeg')).toBe('.jpeg');
    expect(getImageExtension('noext')).toBe('.png');
    expect(getImageExtension(undefined)).toBe('.png');
  });

  it('names the asset by uuid so renderer and zip entry always agree', () => {
    expect(imageAssetName(imageFile)).toBe('fae994b8-5bd3-492a-9a2e-0245f5ec5e7a.png');
  });

  it('prefers the full-size preview url and makes it absolute', () => {
    expect(imageAssetUrl(imageFile)).toBe('https://claude.ai/api/ORG/files/fae994b8/preview');
    expect(imageAssetUrl({ thumbnail_url: '/api/x/thumbnail' }))
      .toBe('https://claude.ai/api/x/thumbnail');
    expect(imageAssetUrl({ preview_url: 'https://cdn.example/p.png' }))
      .toBe('https://cdn.example/p.png');
    expect(imageAssetUrl({})).toBe(null);
  });

  it('collects (deduped) images across the current branch', () => {
    const data = {
      current_leaf_message_uuid: 'm1',
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          content: [{ type: 'text', text: 'look' }],
          files: [imageFile, imageFile], // same file twice → one entry
          parent_message_uuid: '00000000-0000-0000-0000-000000000000',
        },
      ],
    };
    const imgs = collectImageFiles(data);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].name).toBe('fae994b8-5bd3-492a-9a2e-0245f5ec5e7a.png');
    expect(imgs[0].url).toContain('/preview');
    expect(imgs[0].fileName).toBe('shot 1.png');
  });

  it('ignores non-image files and entries without a usable url', () => {
    const data = {
      current_leaf_message_uuid: 'm1',
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          content: [{ type: 'text', text: 'x' }],
          files: [
            { file_kind: 'document', file_uuid: 'd1', file_name: 'a.pdf', preview_url: '/api/x/preview' },
            { file_kind: 'image', file_uuid: 'i1', file_name: 'b.png' }, // no url
          ],
          parent_message_uuid: '00000000-0000-0000-0000-000000000000',
        },
      ],
    };
    expect(collectImageFiles(data)).toHaveLength(0);
  });
});
