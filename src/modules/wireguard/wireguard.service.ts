/**
 * modules/wireguard/wireguard.service.ts
 * Integration with wg-easy API running on Umbrel.
 * 
 * wg-easy provides WireGuard management via REST API without authentication
 * (secured by Docker network isolation).
 * 
 * Endpoints used:
 * - GET  /api/wireguard/client — list all clients
 * - POST /api/wireguard/client — create client {name: string}
 * - DELETE /api/wireguard/client/:id — delete client
 * - GET /api/wireguard/client/:id/qrcode.svg — QR code image
 * - GET /api/wireguard/client/:id/configuration — config text
 */

const WG_EASY_API = process.env.WG_EASY_API || 'http://wireguard_app_1:51821';
const WG_PUBLIC_ENDPOINT = process.env.WG_PUBLIC_ENDPOINT || 'enkzoned.asuscomm.com:41820';

/**
 * Fix WireGuard config:
 * - Replace endpoint with public address
 * - Use split tunneling (only route server traffic through VPN)
 */
function fixConfig(config: string): string {
  return config
    // Fix endpoint
    .replace(/Endpoint\s*=\s*[^\n]+/g, `Endpoint = ${WG_PUBLIC_ENDPOINT}`)
    // TRUE split tunneling: ONLY VPN subnet + server local network through tunnel.
    // NO DNS override — let Android use WiFi's default DNS.
    // This ensures only our server traffic goes through WG, everything else is direct.
    .replace(/AllowedIPs\s*=\s*[^\n]+/g, `AllowedIPs = 10.8.0.0/24, 192.168.50.0/24`)
    // Remove DNS line — no DNS override, system DNS stays on WiFi default
    .replace(/DNS\s*=\s*[^\n]+\n?/g, '')
    // PersistentKeepalive = 25s — required for NAT traversal on mobile networks.
    .replace(/PersistentKeepalive\s*=\s*[^\n]+/g, `PersistentKeepalive = 25`);
}

export interface WireGuardClient {
  id: string;
  name: string;
  enabled: boolean;
  address: string;
  publicKey: string;
  createdAt: string;
  updatedAt: string;
  persistentKeepalive: string;
  latestHandshakeAt: string | null;
  transferRx: number;
  transferTx: number;
}

/**
 * List all WireGuard peers
 */
export async function listWireGuardPeers(): Promise<WireGuardClient[]> {
  const res = await fetch(`${WG_EASY_API}/api/wireguard/client`);
  if (!res.ok) {
    throw new Error(`wg-easy list failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<WireGuardClient[]>;
}

/**
 * Create a new WireGuard peer
 * Returns the created client object
 */
export async function createWireGuardPeer(name: string): Promise<WireGuardClient> {
  // Create the peer
  const createRes = await fetch(`${WG_EASY_API}/api/wireguard/client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  
  if (!createRes.ok) {
    const error = await createRes.text();
    throw new Error(`wg-easy create failed: ${createRes.status} ${error}`);
  }

  // wg-easy returns the new client directly
  const newClient = await createRes.json() as Partial<WireGuardClient>;
  
  // If it doesn't return the full object, fetch from list
  if (!newClient.id) {
    const clients = await listWireGuardPeers();
    const found = clients.find(c => c.name === name);
    if (!found) {
      throw new Error(`Created peer '${name}' but couldn't find it in list`);
    }
    return found;
  }
  
  return newClient as WireGuardClient;
}

/**
 * Delete a WireGuard peer
 */
export async function deleteWireGuardPeer(clientId: string): Promise<void> {
  const res = await fetch(`${WG_EASY_API}/api/wireguard/client/${clientId}`, {
    method: 'DELETE'
  });
  
  if (!res.ok && res.status !== 404) {
    throw new Error(`wg-easy delete failed: ${res.status} ${res.statusText}`);
  }
}

/**
 * Get QR code SVG for a peer
 */
export async function getWireGuardQR(clientId: string): Promise<string> {
  const res = await fetch(`${WG_EASY_API}/api/wireguard/client/${clientId}/qrcode.svg`);
  if (!res.ok) {
    throw new Error(`wg-easy QR failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Get WireGuard config text for a peer (with fixed public endpoint)
 */
export async function getWireGuardConfig(clientId: string): Promise<string> {
  const res = await fetch(`${WG_EASY_API}/api/wireguard/client/${clientId}/configuration`);
  if (!res.ok) {
    throw new Error(`wg-easy config failed: ${res.status} ${res.statusText}`);
  }
  const config = await res.text();
  return fixConfig(config);
}

/**
 * Find peer by name
 */
export async function findWireGuardPeerByName(name: string): Promise<WireGuardClient | null> {
  const clients = await listWireGuardPeers();
  return clients.find(c => c.name === name) ?? null;
}

/**
 * Check if wg-easy API is reachable
 */
export async function checkWireGuardHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${WG_EASY_API}/api/wireguard/client`, {
      signal: AbortSignal.timeout(5000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const wireGuardService = {
  list: listWireGuardPeers,
  create: createWireGuardPeer,
  delete: deleteWireGuardPeer,
  getQR: getWireGuardQR,
  getConfig: getWireGuardConfig,
  findByName: findWireGuardPeerByName,
  healthCheck: checkWireGuardHealth,
};
