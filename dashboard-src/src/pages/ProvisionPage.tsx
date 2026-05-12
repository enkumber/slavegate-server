/**
 * ProvisionPage.tsx
 * Device provisioning — generates WireGuard config QR code for new devices.
 */

import { useState, useEffect } from "react";
import { api } from "../api/client";
import QRCode from "qrcode";

interface ProvisionResult {
  deviceId: string;
  wireguardPeerId: string;
  wireguardIp: string;
  qrSvg: string;
  config: string;
}

export function ProvisionPage() {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Generate QR code from config when result changes
  useEffect(() => {
    if (result?.config) {
      QRCode.toDataURL(result.config, { width: 300, margin: 2 })
        .then(setQrDataUrl)
        .catch(console.error);
    }
  }, [result?.config]);

  const handleProvision = async () => {
    if (!name.trim()) {
      setError("Device name is required");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await api.post<ProvisionResult>("/devices/provision", { name: name.trim() });
      setResult(data);
      setName(""); // Clear input for next device
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setResult(null);
    setError(null);
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>📱 Provision New Device</h1>

      {!result ? (
        <div style={styles.form}>
          <input
            type="text"
            placeholder="Device name (e.g., OnePlus-Living-Room)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleProvision()}
            style={styles.input}
            disabled={loading}
            autoFocus
          />
          <button
            onClick={handleProvision}
            disabled={loading || !name.trim()}
            style={{
              ...styles.button,
              opacity: loading || !name.trim() ? 0.5 : 1,
            }}
          >
            {loading ? "Generating..." : "🔑 Generate QR Code"}
          </button>
          {error && <div style={styles.error}>{error}</div>}
        </div>
      ) : (
        <div style={styles.result}>
          <div style={styles.qrContainer}>
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="WireGuard QR Code" style={styles.qrImage} />
            ) : (
              <div style={styles.qrCode}>Generating QR...</div>
            )}
          </div>

          <div style={styles.info}>
            <h3>📋 Device Info</h3>
            <table style={styles.table}>
              <tbody>
                <tr>
                  <td style={styles.label}>Device ID:</td>
                  <td style={styles.value}><code>{result.deviceId}</code></td>
                </tr>
                <tr>
                  <td style={styles.label}>WireGuard IP:</td>
                  <td style={styles.value}><code>{result.wireguardIp}</code></td>
                </tr>
                <tr>
                  <td style={styles.label}>Peer ID:</td>
                  <td style={styles.value}><code>{result.wireguardPeerId}</code></td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style={styles.instructions}>
            <h3>📲 Instructions</h3>
            <ol>
              <li>Open the Phone Network app on the device</li>
              <li>Go to Settings → Scan WireGuard QR</li>
              <li>Point camera at the QR code above</li>
              <li>Device will connect automatically</li>
            </ol>
          </div>

          <details style={styles.configDetails}>
            <summary style={styles.configSummary}>📄 Raw Config (for manual setup)</summary>
            <pre style={styles.configPre}>{result.config}</pre>
          </details>

          <button onClick={handleReset} style={styles.resetButton}>
            ➕ Provision Another Device
          </button>
        </div>
      )}

      <a href="/" style={styles.backLink}>← Back to Fleet</a>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 600,
    margin: "40px auto",
    padding: 20,
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  title: {
    textAlign: "center",
    marginBottom: 30,
    color: "#333",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 15,
  },
  input: {
    padding: "12px 16px",
    fontSize: 16,
    border: "2px solid #ddd",
    borderRadius: 8,
    outline: "none",
    transition: "border-color 0.2s",
  },
  button: {
    padding: "12px 24px",
    fontSize: 16,
    fontWeight: 600,
    color: "#fff",
    backgroundColor: "#4CAF50",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    transition: "background-color 0.2s",
  },
  error: {
    padding: 12,
    backgroundColor: "#ffebee",
    color: "#c62828",
    borderRadius: 8,
    textAlign: "center",
  },
  result: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
    position: "relative",
  },
  qrContainer: {
    display: "flex",
    justifyContent: "center",
    padding: 20,
    backgroundColor: "#fff",
    borderRadius: 12,
    boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
    marginBottom: 20,
    minHeight: 340,
  },
  qrCode: {
    width: 300,
    height: 300,
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  qrImage: {
    width: 300,
    height: 300,
  },
  info: {
    padding: 16,
    backgroundColor: "#f5f5f5",
    borderRadius: 8,
    marginTop: 20,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
  },
  label: {
    padding: "8px 0",
    color: "#666",
    fontWeight: 500,
  },
  value: {
    padding: "8px 0",
    textAlign: "right",
  },
  instructions: {
    padding: 16,
    backgroundColor: "#e3f2fd",
    borderRadius: 8,
  },
  configDetails: {
    padding: 16,
    backgroundColor: "#fff3e0",
    borderRadius: 8,
  },
  configSummary: {
    cursor: "pointer",
    fontWeight: 500,
  },
  configPre: {
    marginTop: 12,
    padding: 12,
    backgroundColor: "#263238",
    color: "#aed581",
    borderRadius: 4,
    overflow: "auto",
    fontSize: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  resetButton: {
    padding: "12px 24px",
    fontSize: 16,
    fontWeight: 600,
    color: "#fff",
    backgroundColor: "#2196F3",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  backLink: {
    display: "block",
    marginTop: 30,
    textAlign: "center",
    color: "#666",
    textDecoration: "none",
  },
};
