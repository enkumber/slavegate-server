# Business Analyst — P6

Agent spawnat de Nautilus la 02:25. Analizează performanța conturilor.

## Definiție

```yaml
agent: business_analyst
tip: Spawned
ierarhie: Nautilus
trigger: Nautilus la 02:25 (pre-nightly)
timeout: 30 minute
face_exit: da
```

## Flow

```
1. COLLECT
   └── accounts (status != banned/deleted)
   └── execution_logs (ultimele 24h)

2. ANALYZE (per account)
   ├── success_rate = successful / total
   ├── check flags (rate_limit, soft_block)
   ├── collect recent errors
   └── determine health_status

3. CLASSIFY
   ├── healthy:   success >= 80%, no flags
   ├── warning:   success 50-80% OR minor flags
   ├── critical:  success < 50% OR soft_blocked
   └── suspended: manual intervention needed

4. REPORT
   └── INSERT INTO reports (type='daily_performance')

5. UPDATE FLAGS
   └── accounts.flags.ba_reviewed_at
   └── accounts.flags.needs_attention (if critical)

6. EXIT
   └── return summary string
```

## Input

| Table | Ce citește |
|-------|-----------|
| accounts | username, platform, metrics, flags, status |
| execution_logs | success/fail, errors, task_type |

## Output

| Table | Ce scrie |
|-------|---------|
| reports | Raport complet cu summary și alerts |
| accounts | flags.ba_reviewed_at, flags.needs_attention |

## Thresholds

```yaml
healthy_success_rate: 0.80    # >= 80%
warning_success_rate: 0.50    # >= 50%
# Below 50% = critical
```

## Alerts generate

- Overall success rate < 70%
- Soft block activ pe orice cont
- > 30% conturi în stare critică

## Usage

```typescript
import { runBusinessAnalyst } from './ba.service';

const result = await runBusinessAnalyst({
  lookback_hours: 24,
  timeout_minutes: 30
});

console.log(result.summary);
// "Analyzed 15 accounts: 10 healthy, 3 warning, 2 critical"
```
