# instagram parser — Phase 3

Implements `PlatformParser` for Instagram (com.instagram.android).

## Files

- `parser.ts` — main class: implements PlatformParser
- `elements.ts` — known UI elements by app version (resource IDs, content descriptions)
- `config.json` — `{ "version": "1.0.0", "compatibleAppVersions": ["300+", "301+"] }`

## Known elements to implement

| Element | Primary strategy | Fallback |
|---------|-----------------|---------|
| like_button | resource-id: like_button | content-description: "Like" |
| comment_button | resource-id: comment_button | content-description: "Comment" |
| follow_button | text: "Follow" / "Following" | content-description |
| feed_post | class: com.instagram.feedcomponent.FeedItemView | position |
| story_ring | content-description contains "story" | class |

## Extracted content types

- `post` — photo/video post with caption, likes, comments count
- `story` — story viewing (limited data available)
- `profile` — profile page: follower count, bio, post count
- `reel` — reel with views, likes, audio info

## Parser brittleness notes

Instagram updates frequently. Version pinning via `pm disable-user` on Play Store.
Canary device monitors parser health (extraction rate < 50% → alert).
