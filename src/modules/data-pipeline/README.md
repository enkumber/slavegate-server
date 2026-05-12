# data-pipeline — Phase 3

Platform parsers, data normalization, deduplication, storage, export API.

## What goes here

- `pipeline.service.ts` — orchestrates parse → normalize → dedup → store
- `parsers/instagram.ts` — extracts structured data from Instagram UI trees
- `parsers/tiktok.ts` — TikTok UI tree parser
- `parsers/reddit.ts` — Reddit UI tree parser
- `normalizer.ts` — platform-agnostic output format
- `dedup.ts` — content hash computation and dedup check

## Normalized output format

```ts
{
  platform: string,
  contentType: string,      // post | video | comment | story
  author: string,
  text: string,
  engagementMetrics: {
    likes?: number,
    comments?: number,
    shares?: number,
    views?: number,
  },
  mediaUrls: string[],
  extractedAt: string,      // ISO 8601 UTC
  contentHash: string,      // SHA-256 of (platform+author+text) — dedup key
}
```

## Storage

- Metadata → `extracted_data` table (PostgreSQL)
- Media files → Object storage (MinIO/S3) — Phase 3+
- Retention policy → configurable via env, default 90 days
