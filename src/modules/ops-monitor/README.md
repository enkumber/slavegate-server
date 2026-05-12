# ops-monitor — P3

Monitorizează health-ul tehnic al flotei. Detectează probleme. Scrie în DB.

## Definiție

```yaml
agent: ops_monitor
tip: Spawned
ierarhie: Kraken
trigger:
  - cron: la fiecare oră
  - threshold: fail rate > 30% în ultimele 50 acțiuni
face_exit: da, după fiecare rulare
```

## Ce analizează

- **UI failures** (din navigation_logs):
  - vision_fallback_rate per app
  - element_not_found_rate per element

- **Device health** (din devices):
  - online_count vs total
  - crash_recovery_count per device

- **App issues** (din execution_logs):
  - rate_limit_hits per account
  - soft_blocks per account
  - app_crashes

- **Mapping quality** (din mapping_reports):
  - unmapped_elements per app
  - elements_failed per mapping run

## Thresholds

```yaml
vision_fallback_rate:
  warning: 20%
  critical: 40%  # → scrie skill_update_jobs

device_offline:
  warning: 10min
  critical: 30min  # → scrie devices.flags.needs_attention
```

## Ce scrie în DB

1. `devices.flags` — offline_since, needs_attention, last_health_check
2. `accounts.flags` — soft_blocked_until, rate_limited_until
3. `skill_update_jobs` — când vision_fallback_rate > critical

## Flow

1. Citește execution_logs + navigation_logs + mapping_reports din ultima oră
2. Calculează metrics
3. Compară cu thresholds
4. Scrie flags în DB
5. Dacă UI change detectat → scrie skill_update_jobs (pending)
6. Exit
