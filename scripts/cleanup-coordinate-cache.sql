-- B3 FIX: Purge contaminated coordinate_cache entries
-- 
-- Problem: coordinate_cache was contaminated with y=0.969 entries for nav.* elements.
-- y=0.969 falls in the Android system nav bar (below 0.94), causing taps on the
-- Android back/home/recents bar instead of the Instagram nav bar.
-- These entries have confidence=0.95 so they win over correct coords.
--
-- Fix: DELETE bad nav entries where y > 0.94 (Instagram nav bar is at y=0.912)
-- Also cleanup low-confidence nav entries that could re-contaminate.
--
-- Run: psql $DATABASE_URL -f scripts/cleanup-coordinate-cache.sql

BEGIN;

-- Show what we're deleting
SELECT element_name, x, y, confidence, learn_method, success_count, fail_count
FROM coordinate_cache
WHERE element_name LIKE 'nav.%'
  AND (y > 0.94 OR confidence < 0.97)
ORDER BY element_name;

-- Delete contaminated nav entries
DELETE FROM coordinate_cache 
WHERE element_name LIKE 'nav.%' 
  AND y > 0.94;

-- Also clean up low-confidence nav entries
DELETE FROM coordinate_cache
WHERE element_name LIKE 'nav.%'
  AND confidence < 0.97;

-- Report
SELECT COUNT(*) AS remaining_nav_entries FROM coordinate_cache WHERE element_name LIKE 'nav.%';

COMMIT;
