# ws-relay — WebSocket Relay for Umbrel

Relay-ul expune portul 18791 al containerului OpenClaw pe host-ul Umbrel, astfel încât telefoanele să se poată conecta.

## Problema

La fiecare reboot Umbrel, containerul `openclaw_gateway_1` primește un IP nou. Un socat cu IP hardcodat se rupe. Scriptul rezolvă asta în două moduri.

---

## Metoda recomandată: Docker network DNS (Option B)

Scriptul detectează automat rețeaua Docker a containerului și folosește DNS intern. `openclaw_gateway_1` se rezolvă mereu corect, fără să depindă de IP.

```bash
sudo bash scripts/ws-relay.sh
```

Asta face:
1. Detectează rețeaua containerului `openclaw_gateway_1`
2. Pornește `ws-relay` pe aceeași rețea cu `-p 18791:18791`
3. socat ascultă pe `0.0.0.0:18791` → forwardează la `openclaw_gateway_1:18791` via DNS

Container-ul are `--restart=always` → supraviețuiește reboot-ul Umbrel fără intervenție.

---

## Restart manual (după update/reboot cu IP schimbat)

```bash
sudo docker rm -f ws-relay && sudo bash scripts/ws-relay.sh
```

---

## Fallback: IP dinamic (Option A)

Dacă network sharing nu e posibil sau DNS-ul Docker nu funcționează:

### Comandă manuală (recomandată pentru debugging)

```bash
# 1. Află IP-ul containerului OpenClaw
docker inspect openclaw_gateway_1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
# SAU din interiorul containerului: hostname -I

# 2. Pornește ws-relay cu IP-ul obținut (înlocuiește X.X.X.X)
docker rm -f ws-relay
docker run -d --name ws-relay --restart=always --network=host alpine/socat TCP-LISTEN:18791,fork,reuseaddr TCP:X.X.X.X:18791
```

**Exemplu concret:**
```bash
docker rm -f ws-relay
docker run -d --name ws-relay --restart=always --network=host alpine/socat TCP-LISTEN:18791,fork,reuseaddr TCP:10.21.0.6:18791
```

### Sau folosește scriptul:
```bash
sudo bash scripts/ws-relay.sh --ip
```

**⚠️ IMPORTANT:** IP-ul containerului se schimbă la fiecare reboot! Trebuie verificat și actualizat de fiecare dată.

---

## Verificare

```bash
# Trebuie să returneze 401 (nu 000)
curl -s -o /dev/null -w "%{http_code}" http://192.168.50.57:18791/api/devices

# Status relay
sudo docker ps | grep ws-relay
sudo docker logs ws-relay
```

---

## Cum funcționează Option B

```
[Telefon] → host:18791 → [ws-relay container] → DNS:openclaw_gateway_1:18791 → [OpenClaw]
```

Ambele containere sunt pe aceeași rețea Docker → DNS intern funcționează.

---

## Troubleshooting

**`ERROR: Cannot find container openclaw_gateway_1`**
→ Verifică că OpenClaw e pornit: `docker ps | grep openclaw`

**`WARNING: Cannot detect network`**
→ Rulează cu `--ip` ca fallback

**Relay pornit dar curl returnează 000**
→ Verifică că phone-network-server rulează: `pm2 status`
→ Verifică portul: `ss -tlnp | grep 18791`
