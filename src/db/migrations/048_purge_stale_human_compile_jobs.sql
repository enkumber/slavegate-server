DELETE FROM human_workflow_compile_jobs AS job
WHERE job.request_key = 'ad535072dfd1b00ec3750f25'
   OR (
     job.status = 'ready'
     AND NULLIF(BTRIM(COALESCE(job.cache_key, job.result->>'cacheKey', '')), '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM generated_workflow_plan_cache AS cache
       WHERE cache.cache_key = COALESCE(job.cache_key, job.result->>'cacheKey')
     )
   );
