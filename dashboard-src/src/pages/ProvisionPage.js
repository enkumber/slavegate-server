import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * ProvisionPage.tsx
 * Device provisioning — generates WireGuard config QR code for new devices.
 */
import { useState, useEffect } from "react";
import { api } from "../api/client";
import QRCode from "qrcode";
export function ProvisionPage() {
    const [name, setName] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [result, setResult] = useState(null);
    const [qrDataUrl, setQrDataUrl] = useState(null);
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
            const data = await api.post("/devices/provision", { name: name.trim() });
            setResult(data);
            setName(""); // Clear input for next device
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    };
    const handleReset = () => {
        setResult(null);
        setError(null);
    };
    return (_jsxs("div", { style: styles.container, children: [_jsx("h1", { style: styles.title, children: "\uD83D\uDCF1 Provision New Device" }), !result ? (_jsxs("div", { style: styles.form, children: [_jsx("input", { type: "text", placeholder: "Device name (e.g., OnePlus-Living-Room)", value: name, onChange: (e) => setName(e.target.value), onKeyDown: (e) => e.key === "Enter" && handleProvision(), style: styles.input, disabled: loading, autoFocus: true }), _jsx("button", { onClick: handleProvision, disabled: loading || !name.trim(), style: {
                            ...styles.button,
                            opacity: loading || !name.trim() ? 0.5 : 1,
                        }, children: loading ? "Generating..." : "🔑 Generate QR Code" }), error && _jsx("div", { style: styles.error, children: error })] })) : (_jsxs("div", { style: styles.result, children: [_jsx("div", { style: styles.qrContainer, children: qrDataUrl ? (_jsx("img", { src: qrDataUrl, alt: "WireGuard QR Code", style: styles.qrImage })) : (_jsx("div", { style: styles.qrCode, children: "Generating QR..." })) }), _jsxs("div", { style: styles.info, children: [_jsx("h3", { children: "\uD83D\uDCCB Device Info" }), _jsx("table", { style: styles.table, children: _jsxs("tbody", { children: [_jsxs("tr", { children: [_jsx("td", { style: styles.label, children: "Device ID:" }), _jsx("td", { style: styles.value, children: _jsx("code", { children: result.deviceId }) })] }), _jsxs("tr", { children: [_jsx("td", { style: styles.label, children: "WireGuard IP:" }), _jsx("td", { style: styles.value, children: _jsx("code", { children: result.wireguardIp }) })] }), _jsxs("tr", { children: [_jsx("td", { style: styles.label, children: "Peer ID:" }), _jsx("td", { style: styles.value, children: _jsx("code", { children: result.wireguardPeerId }) })] })] }) })] }), _jsxs("div", { style: styles.instructions, children: [_jsx("h3", { children: "\uD83D\uDCF2 Instructions" }), _jsxs("ol", { children: [_jsx("li", { children: "Open the Phone Network app on the device" }), _jsx("li", { children: "Go to Settings \u2192 Scan WireGuard QR" }), _jsx("li", { children: "Point camera at the QR code above" }), _jsx("li", { children: "Device will connect automatically" })] })] }), _jsxs("details", { style: styles.configDetails, children: [_jsx("summary", { style: styles.configSummary, children: "\uD83D\uDCC4 Raw Config (for manual setup)" }), _jsx("pre", { style: styles.configPre, children: result.config })] }), _jsx("button", { onClick: handleReset, style: styles.resetButton, children: "\u2795 Provision Another Device" })] })), _jsx("a", { href: "/", style: styles.backLink, children: "\u2190 Back to Fleet" })] }));
}
const styles = {
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
